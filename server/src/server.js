// Cluster Pulse — ingest API + WebSocket fan-out.
//
// Endpoints
//   GET  /health                 liveness + db state (the reach test hits this)
//   POST /api/ingest/cluster     collector on mgmt01 pushes full snapshots here
//   POST /api/ingest/node        a single node_sample (used if a compute node is
//                                ever routed to the laptop; normally unused)
//   GET  /api/snapshot           latest in-memory snapshot (initial page load)
//   GET  /api/history?minutes=5  rolled-up history from MySQL (503 if DB is absent)
//   GET  /api/jobs               recent jobs from MySQL
//   WS   /stream                 live push, one message per ingest
//
// Design rule that comes from the cluster probe, not from taste:
//   gpu util is NODE-WIDE and includes every user's work, so alerts and the UI
//   must never attribute it to a job. There is no job->GPU mapping on this PBS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  initDb, dbStatus, persistSnapshot, history, nodeGpuHistory, perGpuHistory,
  recentJobs, recentLogs,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const ROLLUP_SECONDS = Number(process.env.ROLLUP_SECONDS || 10);
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '8mb' }));

// CORS: the Angular dev server runs on another port.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const state = {
  startedAt: Date.now(),
  lastSnapshotAt: 0,
  snapshot: null,
  nodes: {},
  lastPersistAt: 0,
  lastAlertAt: new Map(),
  ingestCount: 0,
  pendingJobs: null,
  pendingAlerts: [],
  jobUsage: new Map(),
};

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/stream' });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
  return wss.clients.size;
}

// ---------- alert derivation (measured thresholds, not invented) ----------
// gpu01 was observed at 1.64-1.78x its core count while gpu02 sat at 0.21x,
// so a 100%-capped load scale is wrong. These are ratios, not percentages.
function deriveAlerts(snapshot) {
  const alerts = [];
  for (const sample of snapshot.nodes || []) {
    if (!sample) continue;
    const cores = sample.cpu?.logical || 0;
    const load1 = sample.loadavg?.[0];
    if (cores && typeof load1 === 'number' && load1 / cores > 1.5) {
      alerts.push({
        kind: 'node_overload',
        node: sample.node,
        subject: `${sample.node}.load`,
        message: `load ${load1.toFixed(2)} on ${cores} cores (${(load1 / cores).toFixed(2)}x)`,
      });
    }
    for (const gpu of sample.gpus || []) {
      if (typeof gpu.temp_c === 'number' && gpu.temp_c >= 80) {
        alerts.push({
          kind: 'gpu_temp',
          node: sample.node,
          subject: `${sample.node}.gpu${gpu.index}`,
          message: `GPU ${gpu.index} at ${gpu.temp_c}C (node-wide, all users)`,
        });
      }
    }
  }
  const queued = Object.values(snapshot.queues || {}).reduce(
    (sum, q) => sum + (q.queued || 0),
    0,
  );
  if (queued >= 20) {
    alerts.push({
      kind: 'queue_depth',
      node: null,
      subject: 'cluster.queue',
      message: `${queued} jobs queued across queues`,
    });
  }
  return alerts;
}

function throttleAlerts(alerts) {
  const now = Date.now();
  const fresh = [];
  for (const alert of alerts) {
    const key = `${alert.kind}:${alert.subject}`;
    const last = state.lastAlertAt.get(key) || 0;
    if (now - last < ALERT_COOLDOWN_MS) continue;
    state.lastAlertAt.set(key, now);
    fresh.push({ ...alert, ts: new Date().toISOString() });
  }
  return fresh;
}

// ---------- routes ----------

// Browser proof that live data is arriving (and the visual reference for the
// Angular build): served straight from the API, no build step.
app.get('/live', (req, res) => {
  res.sendFile(path.join(__dirname, 'live.html'));
});

app.get('/health', (req, res) => {
  const db = dbStatus();
  res.json({
    ok: true,
    service: 'cluster-pulse-api',
    uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
    db: db.ready ? 'connected' : `unavailable (${db.lastError || 'not initialised'})`,
    clients: wss.clients.size,
    ingest_count: state.ingestCount,
    last_snapshot_ago_s: state.lastSnapshotAt
      ? Math.round((Date.now() - state.lastSnapshotAt) / 1000)
      : null,
    gpu_attribution: 'node-wide; PBS does not isolate GPUs on this cluster',
  });
});

app.post('/api/ingest/cluster', async (req, res) => {
  const snapshot = req.body;
  if (!snapshot || snapshot.type !== 'cluster_snapshot') {
    return res.status(400).json({ error: 'expected a cluster_snapshot payload' });
  }

  // Collector contract: "jobs": null means "unchanged since last tick" — the
  // job list is expensive (61% of a payload) and only re-sent on change.
  // Capture the previous list BEFORE overwriting state.snapshot.
  const previousJobs = Array.isArray(state.snapshot?.jobs) ? state.snapshot.jobs : [];
  const jobsUnchanged = !Array.isArray(snapshot.jobs);
  if (jobsUnchanged) {
    snapshot.jobs = previousJobs;
    snapshot.jobs_state = 'inherited';
  }

  state.snapshot = snapshot;
  state.lastSnapshotAt = Date.now();
  state.ingestCount += 1;

  // Job consumption arrives as compact deltas: [[id, cpupercent, mem_kb], ...].
  // Merge into a live map so every push carries current stress per job.
  const usageRows = Array.isArray(snapshot.job_usage) ? snapshot.job_usage : null;
  if (usageRows) {
    if (snapshot.usage_full) state.jobUsage.clear();
    for (const row of usageRows) {
      if (Array.isArray(row) && row.length >= 3) {
        state.jobUsage.set(String(row[0]), { cpupercent: row[1], mem_used_kb: row[2] });
      }
    }
  }
  if (Array.isArray(snapshot.jobs) && state.jobUsage.size) {
    snapshot.jobs = snapshot.jobs.map((job) => {
      const usage = state.jobUsage.get(String(job.id));
      return usage ? { ...job, ...usage } : job;
    });
  }

  for (const sample of snapshot.nodes || []) {
    if (sample?.node) state.nodes[sample.node] = sample;
  }

  const alerts = throttleAlerts(deriveAlerts(snapshot));
  const message = { type: 'snapshot', snapshot, alerts, received_at: new Date().toISOString() };
  const clients = broadcast(message);

  // A job list arriving on a non-rollup tick must not be lost: the collector
  // only sends jobs on change (plus a 60s forced refresh), so hold it until the
  // next DB write instead of dropping it with the skipped tick.
  if (!jobsUnchanged) state.pendingJobs = snapshot.jobs;
  if (alerts.length) state.pendingAlerts.push(...alerts);

  // Skip rollups whose PBS data has not arrived yet: the first snapshot after a
  // collector restart has totals 0/0, which draws a bogus dip to zero in the
  // history charts (seen as a NULL cpu/ram row at 21:01:58).
  const pbsReady = (snapshot.totals?.cores ?? 0) > 0;

  if (pbsReady && Date.now() - state.lastPersistAt >= ROLLUP_SECONDS * 1000) {
    state.lastPersistAt = Date.now();
    const jobsForPersist = !jobsUnchanged ? snapshot.jobs : state.pendingJobs;
    const alertsForPersist = state.pendingAlerts;
    state.pendingJobs = null;
    state.pendingAlerts = [];
    persistSnapshot({
      ...snapshot,
      jobs: jobsForPersist || [],
      alerts: alertsForPersist,
      jobUsage: usageRows,
      skipJobs: !jobsForPersist || jobsForPersist.length === 0,
    }).catch(() => {});
  }

  res.json({ ok: true, clients, alerts: alerts.length });
});

app.post('/api/ingest/node', (req, res) => {
  const sample = req.body;
  if (!sample || sample.type !== 'node_sample') {
    return res.status(400).json({ error: 'expected a node_sample payload' });
  }
  state.nodes[sample.node] = sample;
  state.lastSnapshotAt = Date.now();
  state.ingestCount += 1;
  // A lone node sample still reaches the browser; the cluster view is unchanged.
  const clients = broadcast({
    type: 'node_sample',
    sample,
    received_at: new Date().toISOString(),
  });
  res.json({ ok: true, clients });
});

app.get('/api/snapshot', (req, res) => {
  if (!state.snapshot && Object.keys(state.nodes).length === 0) {
    return res.status(503).json({ error: 'no data yet', hint: 'start the collector on mgmt01' });
  }
  res.json({
    snapshot: state.snapshot,
    nodes: Object.values(state.nodes),
    last_snapshot_ago_s: state.lastSnapshotAt
      ? Math.round((Date.now() - state.lastSnapshotAt) / 1000)
      : null,
  });
});

app.get('/api/history', async (req, res) => {
  const minutes = Math.min(Number(req.query.minutes || 5), 60);
  try {
    const rows = await history(minutes);
    if (!rows) {
      return res.status(503).json({
        error: 'history unavailable — MySQL not connected',
        db: dbStatus(),
      });
    }
    res.json({ minutes, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/nodes', async (req, res) => {
  const minutes = Math.min(Number(req.query.minutes || 5), 60);
  try {
    const rows = await nodeGpuHistory(minutes);
    if (!rows) return res.status(503).json({ error: 'MySQL not connected' });
    res.json({ minutes, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/gpus', async (req, res) => {
  const minutes = Math.min(Number(req.query.minutes || 5), 60);
  try {
    const rows = await perGpuHistory(minutes);
    if (!rows) return res.status(503).json({ error: 'MySQL not connected' });
    res.json({ minutes, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 120), 500);
  try {
    const rows = await recentLogs(limit);
    if (!rows) return res.status(503).json({ error: 'MySQL not connected' });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const rows = await recentJobs(Math.min(Number(req.query.limit || 50), 200));
    if (!rows) return res.status(503).json({ error: 'MySQL not connected' });
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

wss.on('connection', (socket) => {
  console.log('[ws] client connected (%d total)', wss.clients.size);
  socket.send(
    JSON.stringify({
      type: 'hello',
      snapshot: state.snapshot,
      nodes: Object.values(state.nodes),
      clock_note: 'node_ts is sampler time (~11min behind mgmt01); chart on ingest_ts',
    }),
  );
  socket.on('close', () => console.log('[ws] client left (%d total)', wss.clients.size));
});

// ---------- boot ----------
await initDb();
server.listen(PORT, '0.0.0.0', () => {
  console.log('[api] listening on 0.0.0.0:%d', PORT);
  console.log('[api] health:   http://localhost:%d/health', PORT);
  console.log('[api] ingest:   POST /api/ingest/cluster');
  console.log('[api] stream:   ws://localhost:%d/stream', PORT);
  console.log('[api] rollup:   every %ds (1Hz telem is never stored raw)', ROLLUP_SECONDS);
});
