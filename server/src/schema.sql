-- Cluster Pulse — MySQL schema (the MySQL subject deliverable)
--
-- Design notes:
--   * 1 Hz telemetry is NOT stored row-per-second. The ingest API rolls up every
--     10 s, so a 24 h day costs 8,640 rows/node instead of 86,400.
--   * Times are stored as DATETIME in IST. The collector's ingest_ts is
--     authoritative; the nodes' own clocks run ~11 min behind (measured).
--   * `job` upserts on job id: PBS reuses the same job through R -> F, we keep
--     the latest state plus first_seen/last_seen to compute queue wait.

CREATE DATABASE IF NOT EXISTS cluster_pulse
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE cluster_pulse;

CREATE TABLE IF NOT EXISTS node_metric (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node        VARCHAR(32)     NOT NULL,
  ts          DATETIME        NOT NULL,
  load_1m     DECIMAL(8,2)    NULL,
  load_5m     DECIMAL(8,2)    NULL,
  load_15m    DECIMAL(8,2)    NULL,
  cores       SMALLINT        NULL,
  mem_used_kb BIGINT          NULL,
  mem_total_kb BIGINT         NULL,
  gpu_count   TINYINT         NULL,
  cpu_pct     DECIMAL(5,1)    NULL,   -- real utilisation from /proc/stat delta
  PRIMARY KEY (id),
  UNIQUE KEY uq_node_ts (node, ts),
  KEY idx_node_ts (node, ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS gpu_metric (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  node          VARCHAR(32)     NOT NULL,
  gpu_index     TINYINT         NOT NULL,
  ts            DATETIME        NOT NULL,
  util_pct      TINYINT         NULL,
  mem_used_mib  INT             NULL,
  mem_total_mib INT             NULL,
  temp_c        SMALLINT        NULL,
  power_w       DECIMAL(7,2)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gpu_ts (node, gpu_index, ts),
  KEY idx_gpu_ts (ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cluster_metric (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts          DATETIME        NOT NULL,
  gpus_total  TINYINT         NULL,
  gpus_alloc  TINYINT         NULL,
  cores_total SMALLINT        NULL,
  cores_alloc SMALLINT        NULL,
  mem_kb      BIGINT          NULL,
  mem_alloc_kb BIGINT         NULL,
  jobs_running SMALLINT       NULL,
  jobs_queued  SMALLINT       NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cluster_ts (ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job (
  job_id        VARCHAR(32)  NOT NULL,
  name          VARCHAR(128) NULL,
  owner         VARCHAR(64)  NULL,
  queue         VARCHAR(32)  NULL,
  state         CHAR(1)      NULL,
  ncpus         SMALLINT     NULL,
  ngpus         TINYINT      NULL,
  mem           VARCHAR(16)  NULL,
  walltime_limit VARCHAR(16) NULL,
  walltime_used  VARCHAR(16) NULL,
  exec_host     VARCHAR(128) NULL,
  cpupercent    SMALLINT     NULL,   -- resources_used.cpupercent, can exceed 100
  mem_used_kb   BIGINT       NULL,   -- resources_used.mem
  cput          VARCHAR(16)  NULL,
  first_seen    DATETIME     NULL,
  last_seen     DATETIME     NULL,
  PRIMARY KEY (job_id),
  KEY idx_state (state),
  KEY idx_queue (queue)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS job_event (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id    VARCHAR(32)  NOT NULL,
  ts        DATETIME     NOT NULL,
  from_state CHAR(1)     NULL,
  to_state   CHAR(1)     NULL,
  PRIMARY KEY (id),
  KEY idx_job (job_id, ts)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS alert (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts      DATETIME     NOT NULL,
  kind    VARCHAR(32)  NOT NULL,
  node    VARCHAR(32)  NULL,
  subject VARCHAR(64)  NULL,
  message VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_alert_ts (ts)
) ENGINE=InnoDB;

-- Convenience view for the dashboard's Overview chart: last hour, one point per 10 s.
CREATE OR REPLACE VIEW v_recent_cluster AS
SELECT ts,
       cores_alloc / NULLIF(cores_total, 0) * 100 AS cpu_pct,
       mem_alloc_kb / NULLIF(mem_kb, 0) * 100      AS ram_pct,
       gpus_alloc, gpus_total, jobs_running, jobs_queued
FROM cluster_metric
-- NOW() is UTC in the container while ts is IST, so offset it.
WHERE ts >= DATE_SUB(DATE_ADD(NOW(), INTERVAL 330 MINUTE), INTERVAL 1 HOUR);
