-- Cluster Pulse - demo queries for the MySQL viva.
-- Run all of them with:   sql -f queries.sql
-- Or open a console with: sql     and paste one statement at a time.

-- 0. What is in the database
SELECT table_name AS tbl, table_rows AS approx_rows
  FROM information_schema.tables
 WHERE table_schema = 'cluster_pulse'
 ORDER BY table_name;

-- 1. The history window the wave chart reads (1 point per 10 s)
SELECT ts,
       ROUND(cores_alloc / cores_total * 100, 1) AS cpu_alloc_pct,
       ROUND(mem_alloc_kb / mem_kb * 100, 1)     AS ram_alloc_pct,
       gpus_alloc, gpus_total, jobs_running, jobs_queued
  FROM cluster_metric
 ORDER BY ts DESC
 LIMIT 20;

-- 2. Who consumed the most CPU (PBS resources_used, cumulative per job)
SELECT owner,
       COUNT(*)          AS jobs,
       SUM(cpupercent)   AS total_cpu_pct,
       ROUND(SUM(mem_used_kb) / 1048576, 1) AS total_rams_gb
  FROM job
 WHERE cpupercent IS NOT NULL
 GROUP BY owner
 ORDER BY total_cpu_pct DESC
 LIMIT 5;

-- 3. How often does a GPU run hot (alert history)
SELECT node, subject, kind, COUNT(*) AS hits, MAX(ts) AS last_seen
  FROM alert
 GROUP BY node, subject, kind
 ORDER BY hits DESC;

-- 4. Job state transitions - this is what the Logs screen shows
SELECT e.ts, e.job_id, j.name, j.owner, e.from_state, e.to_state
  FROM job_event e
  LEFT JOIN job j ON j.job_id = e.job_id
 ORDER BY e.ts DESC
 LIMIT 15;

-- 5. Per-node averages over the last hour (GROUP BY + aggregation demo)
SELECT node,
       COUNT(*)                        AS samples,
       ROUND(AVG(load_1m), 2)          AS avg_load,
       ROUND(AVG(cpu_pct), 1)          AS avg_cpu_used_pct,
       ROUND(AVG(mem_used_kb) / 1048576, 1) AS avg_ram_used_gb
  FROM node_metric
 WHERE ts >= DATE_SUB(DATE_ADD(NOW(), INTERVAL 330 MINUTE), INTERVAL 60 MINUTE)
 GROUP BY node;

-- 6. GPU utilisation per device, last 10 minutes
SELECT node, gpu_index,
       ROUND(AVG(util_pct), 1) AS avg_util,
       MAX(temp_c)             AS max_temp
  FROM gpu_metric
 WHERE ts >= DATE_SUB(DATE_ADD(NOW(), INTERVAL 330 MINUTE), INTERVAL 10 MINUTE)
 GROUP BY node, gpu_index
 ORDER BY node, gpu_index;
