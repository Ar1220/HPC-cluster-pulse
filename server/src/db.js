// MySQL layer — optional by design.
//
// The dashboard must run (and be demonstrable) even if MySQL is not installed
// yet, so every function here fails soft: the API keeps serving live data over
// WebSocket, and only the history endpoints degrade.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;
let ready = false;
let lastError = null;

export function dbReady() {
  return ready;
}

export function dbStatus() {
  return { ready, lastError };
}

export async function initDb() {
  const cfg = {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'cluster_pulse',
    waitForConnections: true,
    connectionLimit: 5,
    dateStrings: true,
    multipleStatements: false,
  };

  try {
    // Connect without a database first so we can create it if missing.
    const bootstrap = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      multipleStatements: true,
    });

    const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await bootstrap.query(schema);

    // Existing installs predate these columns; add them idempotently.
    // Qualified with the database because this bootstrap connection has none
    // selected, and must run BEFORE the connection is closed.
    const dbName = cfg.database;
    const alters = [
      `ALTER TABLE \`${dbName}\`.job ADD COLUMN cpupercent SMALLINT NULL`,
      `ALTER TABLE \`${dbName}\`.job ADD COLUMN mem_used_kb BIGINT NULL`,
      `ALTER TABLE \`${dbName}\`.job ADD COLUMN cput VARCHAR(16) NULL`,
      `ALTER TABLE \`${dbName}\`.node_metric ADD COLUMN cpu_pct DECIMAL(5,1) NULL`,
    ];
    for (const stmt of alters) {
      try {
        await bootstrap.query(stmt);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') throw err;
      }
    }

    await bootstrap.end();
    pool = mysql.createPool(cfg);
    await pool.query('SELECT 1');
    ready = true;
    lastError = null;
    console.log('[db] MySQL ready (%s:%s/%s)', cfg.host, cfg.port, cfg.database);
  } catch (err) {
    ready = false;
    lastError = err.code || err.message;
    console.warn('[db] MySQL unavailable (%s) — running live-only', lastError);
  }
  return ready;
}

// The container runs in UTC but every timestamp is written in IST (see
// toSqlDate). Comparing stored IST values against UTC NOW() shifts the window by
// 5.5 hours — that made "last 5 minutes" return everything since 16:44.
const NOW_IST = "DATE_ADD(NOW(), INTERVAL 330 MINUTE)";

function toSqlDate(isoString) {
  // '2026-11-20T16:18:07+05:30' -> '2026-11-20 16:18:07' in IST.
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}

export async function persistSnapshot(snapshot) {
  if (!ready) return { written: 0, skipped: true };
  const ts = toSqlDate(snapshot.ingest_ts) || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const written = { node: 0, gpu: 0, cluster: 0, jobs: 0 };
  const t = snapshot.totals || {};

  try {
    for (const sample of snapshot.nodes || []) {
      if (!sample) continue;
      const mem = sample.mem || {};
      const load = sample.loadavg || [null, null, null];
      await pool.query(
        `INSERT INTO node_metric
           (node, ts, load_1m, load_5m, load_15m, cores, mem_used_kb, mem_total_kb,
            gpu_count, cpu_pct)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           load_1m=VALUES(load_1m), load_5m=VALUES(load_5m), load_15m=VALUES(load_15m),
           cores=VALUES(cores), mem_used_kb=VALUES(mem_used_kb),
           mem_total_kb=VALUES(mem_total_kb), gpu_count=VALUES(gpu_count),
           cpu_pct=VALUES(cpu_pct)`,
        [
          sample.node,
          ts,
          load[0] ?? null,
          load[1] ?? null,
          load[2] ?? null,
          sample.cpu?.logical ?? null,
          mem.used_kb ?? null,
          mem.total_kb ?? null,
          (sample.gpus || []).length,
          sample.cpu?.used_pct ?? null,
        ],
      );
      written.node += 1;

      for (const gpu of sample.gpus || []) {
        await pool.query(
          `INSERT INTO gpu_metric
             (node, gpu_index, ts, util_pct, mem_used_mib, mem_total_mib, temp_c, power_w)
           VALUES (?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             util_pct=VALUES(util_pct), mem_used_mib=VALUES(mem_used_mib),
             mem_total_mib=VALUES(mem_total_mib), temp_c=VALUES(temp_c),
             power_w=VALUES(power_w)`,
          [
            sample.node,
            gpu.index,
            ts,
            gpu.util_pct ?? null,
            gpu.mem_used_mib ?? null,
            gpu.mem_total_mib ?? null,
            gpu.temp_c ?? null,
            gpu.power_w ?? null,
          ],
        );
        written.gpu += 1;
      }
    }

    const queues = snapshot.queues || {};
    const running = Object.values(queues).reduce((sum, q) => sum + (q.running || 0), 0);
    const queued = Object.values(queues).reduce((sum, q) => sum + (q.queued || 0), 0);

    await pool.query(
      `INSERT INTO cluster_metric
         (ts, gpus_total, gpus_alloc, cores_total, cores_alloc, mem_kb, mem_alloc_kb,
          jobs_running, jobs_queued)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         gpus_total=VALUES(gpus_total), gpus_alloc=VALUES(gpus_alloc),
         cores_total=VALUES(cores_total), cores_alloc=VALUES(cores_alloc),
         mem_kb=VALUES(mem_kb), mem_alloc_kb=VALUES(mem_alloc_kb),
         jobs_running=VALUES(jobs_running), jobs_queued=VALUES(jobs_queued)`,
      [
        ts,
        t.gpus ?? null,
        t.gpus_alloc ?? null,
        t.cores ?? null,
        t.cores_alloc ?? null,
        t.mem_kb ?? null,
        t.mem_alloc_kb ?? null,
        running,
        queued,
      ],
    );
    written.cluster = 1;

    if (!snapshot.skipJobs) {
      for (const job of snapshot.jobs || []) {
      const [rows] = await pool.query('SELECT state FROM job WHERE job_id = ?', [job.id]);
      const previous = rows[0]?.state ?? null;

      await pool.query(
        `INSERT INTO job
           (job_id, name, owner, queue, state, ncpus, ngpus, mem, walltime_limit,
            walltime_used, exec_host, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           name=VALUES(name), queue=VALUES(queue), state=VALUES(state),
           ncpus=VALUES(ncpus), ngpus=VALUES(ngpus), mem=VALUES(mem),
           walltime_limit=VALUES(walltime_limit), walltime_used=VALUES(walltime_used),
           exec_host=VALUES(exec_host), last_seen=VALUES(last_seen)`,
        [
          job.id,
          job.name ?? null,
          job.owner ?? null,
          job.queue ?? null,
          job.state ?? null,
          job.ncpus ?? null,
          job.ngpus ?? null,
          job.mem ?? null,
          job.walltime_limit ?? null,
          job.walltime_used ?? null,
          job.exec_host ?? null,
          ts,
          ts,
        ],
      );
      written.jobs += 1;

      if (previous !== job.state) {
        await pool.query(
          'INSERT INTO job_event (job_id, ts, from_state, to_state) VALUES (?,?,?,?)',
          [job.id, ts, previous, job.state ?? null],
        );
      }
      }
    }

    // Per-job consumption deltas -> UPDATE on the existing job rows, so stress
    // stays fresh without re-inserting the whole job list every tick.
    for (const row of snapshot.jobUsage || []) {
      if (!Array.isArray(row) || row.length < 3) continue;
      await pool.query(
        'UPDATE job SET cpupercent = ?, mem_used_kb = ?, last_seen = ? WHERE job_id = ?',
        [row[1] ?? null, row[2] ?? null, ts, String(row[0])],
      );
    }

    for (const alert of snapshot.alerts || []) {
      await pool.query(
        'INSERT INTO alert (ts, kind, node, subject, message) VALUES (?,?,?,?,?)',
        [ts, alert.kind, alert.node ?? null, alert.subject ?? null, alert.message],
      );
    }
  } catch (err) {
    ready = false;
    lastError = err.code || err.message;
    console.warn('[db] write failed (%s) — continuing live-only', lastError);
  }
  return written;
}

export async function history(minutes = 5) {
  if (!ready) return null;
  const window = Math.max(1, Math.min(Number(minutes) || 5, 60));
  const [rows] = await pool.query(
    `SELECT ts, cpu_pct, ram_pct, gpus_alloc, gpus_total, jobs_running, jobs_queued
       FROM v_recent_cluster
      WHERE ts >= DATE_SUB(${NOW_IST}, INTERVAL ${window} MINUTE)
      ORDER BY ts`,
  );
  return rows;
}

export async function nodeGpuHistory(minutes = 5) {
  if (!ready) return null;
  const window = Math.max(1, Math.min(Number(minutes) || 5, 60));
  const [rows] = await pool.query(
    `SELECT n.ts, n.node, n.cpu_pct, n.mem_used_kb, n.mem_total_kb,
            g.avg_util, g.max_util
       FROM node_metric n
       LEFT JOIN (
         SELECT ts, node, ROUND(AVG(util_pct), 1) AS avg_util, MAX(util_pct) AS max_util
           FROM gpu_metric
          WHERE ts >= DATE_SUB(${NOW_IST}, INTERVAL ${window + 1} MINUTE)
          GROUP BY ts, node
       ) g ON g.ts = n.ts AND g.node = n.node
      WHERE n.ts >= DATE_SUB(${NOW_IST}, INTERVAL ${window} MINUTE)
      ORDER BY n.ts, n.node`,
  );
  return rows;
}

export async function perGpuHistory(minutes = 5) {
  if (!ready) return null;
  const window = Math.max(1, Math.min(Number(minutes) || 5, 60));
  const [rows] = await pool.query(
    `SELECT ts, node, gpu_index, util_pct
       FROM gpu_metric
      WHERE ts >= DATE_SUB(${NOW_IST}, INTERVAL ${window} MINUTE)
      ORDER BY ts, node, gpu_index`,
  );
  return rows;
}

export async function recentLogs(limit = 120) {
  if (!ready) return null;
  const [rows] = await pool.query(
    `(SELECT e.ts, 'job_event' AS source, e.job_id AS ref,
             CONCAT('job ', COALESCE(j.name, e.job_id), ' ', COALESCE(e.from_state,'?'),
                    ' -> ', COALESCE(e.to_state,'?')) AS message,
             j.owner AS detail
        FROM job_event e
        LEFT JOIN job j ON j.job_id = e.job_id
       ORDER BY e.ts DESC LIMIT ?)
     UNION ALL
     (SELECT a.ts, 'alert' AS source, COALESCE(a.subject, '-') AS ref,
             a.message, CONCAT(a.kind, IFNULL(CONCAT(' on ', a.node), '')) AS detail
        FROM alert a
       ORDER BY a.ts DESC LIMIT ?)
     ORDER BY ts DESC
     LIMIT ?`,
    [limit, limit, limit],
  );
  return rows;
}

export async function recentJobs(limit = 50) {
  if (!ready) return null;
  const [rows] = await pool.query(
    `SELECT job_id, name, owner, queue, state, ncpus, ngpus, exec_host, last_seen
       FROM job ORDER BY last_seen DESC LIMIT ?`,
    [limit],
  );
  return rows;
}
