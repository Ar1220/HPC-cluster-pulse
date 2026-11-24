# LEARN THE PROJECT — Cluster Pulse

Live monitoring dashboard for the UPES HPC cluster (`mgmt01`, `gpu01`, `gpu02`), built as one
college project covering four subjects:

| Subject | What satisfies it |
|---|---|
| Web technology (Angular / jQuery / Node) | Angular 22 SPA + Node/Express API + a jQuery polling table |
| MySQL | `cluster_pulse` database: 6 tables, 10-second rollups, a SQL view, upserts |
| MongoDB | *(separate second project — not built yet)* |
| Embedded / IoT | *(ESP32 sensor node — not built yet)* |

---

## 1. The problem this solves

The cluster's own tools are fine for one question at a time (`qstat`, `pbsnodes`, `nvidia-smi`),
but there is no single live picture: how loaded the nodes are, what each GPU is doing right now,
who is consuming the CPU, and what changed in the last hour. This project collects that data
every second, stores it, and renders it in a browser.

Two hard constraints shaped the whole design:

1. **You cannot install an agent on the cluster's login node and expose it to the internet.**
   It has no inbound reachability, and heavy or long-running work on a login node is against
   cluster policy.
2. **The network between the laptop and the cluster is unreliable.** SSH handshakes are dropped
   roughly 1 in 3, and the laptop's VPN address changes almost every reconnect.

Everything below is a consequence of those two facts.

---

## 2. Architecture

```
   gpu01 / gpu02  (compute nodes, inside a PBS job)
        │
        │  sampler.py, every 1 second
        │    /proc/stat  → real CPU busy %
        │    /proc/meminfo → real RAM used
        │    nvidia-smi  → 8 × H100: util %, memory, temp, power
        │    nvidia-smi  → which processes hold GPU memory, and whose
        ▼
   ~/monitor/latest-<node>.json     (atomic overwrite, one file per node)
   ~/monitor/metrics-<node>-YYYYMMDD.log  (append, pruned after 7 days)
        │
        │  $HOME is shared Lustre — visible on the login node
        ▼
   mgmt01 (login node) — collector.py, every 1 second
        │    reads both latest-*.json
        │    caches `qstat -f` + `pbsnodes -av` (refreshed every 5 s)
        │    builds one cluster_snapshot
        │    POSTs → laptop API        ← this is the only outbound link
        │    if the POST fails → appends to ~/monitor/outbox.jsonl and retries
        ▼
   laptop — Node/Express API :3000
        │    validates, merges per-job usage deltas
        │    broadcasts over WebSocket /stream  (1 message/second)
        │    every 10 s writes rollups to MySQL
        ├──────────────► MySQL (Docker)  cluster_pulse
        └──────────────► browser (Angular :4200)
```

**Why the compute nodes do not POST directly:** they live on `10.17.1.0/24` and have no route to
the laptop's `10.22.x` VPN address (measured: `curl rc=7`). Only `mgmt01` can reach the laptop
(measured: `HTTP 200`). The compute nodes therefore only *write files*; the login node does all
the network talking.

---

## 3. What happens in one second

| Time | Where | What |
|---|---|---|
| 0.00 s | gpu01, gpu02 | `sampler.py` wakes, reads `/proc/stat` + `/proc/meminfo`, runs two `nvidia-smi` queries, writes `latest-<node>.json` (~3 KB, tmp file then rename so a reader never sees a half-written file), appends one line to the daily metrics log |
| ~0.05 s | Lustre → mgmt01 | the new file is visible on the login node (shared filesystem) |
| 0.10 s | mgmt01 | `collector.py` tick: reads both node files, uses the cached PBS data (jobs/nodes are refreshed only every 5 s because `qstat -f` and `pbsnodes -av` are expensive), assembles `cluster_snapshot` (~3.5 KB), POSTs it |
| 0.15 s | laptop | Express accepts `/api/ingest/cluster`, merges the compact job-usage deltas into the job list, broadcasts to every WebSocket client, keeps the latest snapshot in memory |
| 0.16 s | browser | Angular receives the message, updates signals, and re-renders on push (no polling, no 1-second timer) |
| every 10 s | laptop | the same snapshot is written to MySQL as a rollup row (never one row per second) |

**Measured end-to-end latency: ~1.2 s typical, ~3 s worst case.** The physical floor is about 1 s
because `nvidia-smi` averages GPU utilisation over a ~1-second window — sampling faster would
repeat the same number, not produce newer data.

---

## 4. HPC side — files and their purpose (all in `~/monitor`)

| File | Purpose |
|---|---|
| `sampler.py` | Runs **inside a PBS job** on a GPU node. Every second: all 8 GPUs (utilisation, memory used/total, temperature, power), the processes holding GPU memory and their owners, load average, real CPU utilisation from a `/proc/stat` delta, and RAM from `/proc/meminfo`. Writes `latest-<node>.json` atomically and appends to the daily log, which it prunes after 7 days. Optional direct POST (unused — compute nodes have no route to the laptop). |
| `sampler.pbs` | PBS wrapper: `-q gpu`, 24 h walltime, 1 CPU, 1 GB, no `#PBS -o`. Submitted once per node with an explicit host pin. |
| `collector.py` | Runs on `mgmt01`. The ETL stage: merges the two node files with scheduler state, builds the snapshot, POSTs it, and buffers to an outbox when the laptop is unreachable. Also slims the payload (job list only on change + a 60 s forced refresh, per-job usage as deltas, `apps[]` every 15 s). |
| `start_collector.sh` | Idempotent starter — no-ops if a collector is already running (anchored `pgrep -f "^python3 collector.py"`). |
| `pulse.sh` | Control panel for the HPC side: `status` (6 green/red checks), `start`, `stop`, `restart`. |
| `post_url.txt` | The laptop endpoint. Re-read by the collector every 30 s, so a changed VPN address needs no restart. |
| `latest-gpu01.json`, `latest-gpu02.json` | Newest sample per node — the source of truth. |
| `latest-snapshot.json` | Newest merged snapshot (for local inspection). |
| `metrics-<node>-YYYYMMDD.log` | Append-only history at 1 Hz (~24 MB/day/node). The only record of any window the API missed. |
| `outbox.jsonl` | Bounded buffer (50 MB) used while the laptop is unreachable; drains in slices of 20 snapshots / 2 s per tick. |
| `collector.log` | Collector stdout: POST failures, backfills, target changes. |

**Crontab (unattended operation):**

```
SHELL=/bin/bash
PATH=/opt/pbs/bin:/usr/local/bin:/usr/bin:/bin
@reboot cd ~/monitor && nohup python3 collector.py --post "$(cat post_url.txt)" >> collector.log 2>&1 &
*/5 * * * * pgrep -f "^python3 collector.py" >/dev/null || bash ~/monitor/start_collector.sh
*/2 * * * * qstat -f | grep -q "Job_Name = cp_sampler_gpu01" || qsub -N cp_sampler_gpu01 -q gpu -l select=1:ncpus=1:mem=1gb:host=gpu01 ~/monitor/sampler.pbs
*/2 * * * * qstat -f | grep -q "Job_Name = cp_sampler_gpu02" || qsub -N cp_sampler_gpu02 -q gpu -l select=1:ncpus=1:mem=1gb:host=gpu02 ~/monitor/sampler.pbs
```

Every part now self-heals: the collector restarts within 5 minutes, a dead sampler is resubmitted
within 2 minutes, both sampler jobs are distinct by name so each watchdog can only be satisfied by
its own node.

---

## 5. Laptop side — files and their purpose (`D:\hermes\workspace\test1\project`)

### API — `server/`

| File | Purpose |
|---|---|
| `src/server.js` | Express app + WebSocket server. Endpoints: `GET /health`, `POST /api/ingest/cluster`, `POST /api/ingest/node`, `GET /api/snapshot`, `GET /api/history`, `GET /api/history/nodes`, `GET /api/history/gpus`, `GET /api/jobs`, `GET /api/logs`, `GET /live` (standalone HTML twin of the dashboard), `WS /stream`. Holds the latest snapshot in memory, derives alerts, merges job-usage deltas, and writes rollups every 10 s. |
| `src/db.js` | MySQL layer. Creates the schema on boot, applies idempotent `ALTER`s, persists rollups, and serves history queries. Fails soft: if MySQL is missing the API still serves live data. |
| `src/schema.sql` | The database design: `node_metric`, `gpu_metric`, `cluster_metric`, `job`, `job_event`, `alert`, plus the `v_recent_cluster` view. |
| `src/live.html` | Plain-HTML live page served at `:3000/live` — a dependency-free fallback if the Angular dev server is down. |
| `.env` | Port, rollup interval, MySQL credentials. |
| `run_api.cmd` | Detached launcher used by the control script. |

### Dashboard — `cluster-pulse/` (Angular 22, standalone components, signals, OnPush)

| File | Purpose |
|---|---|
| `src/app/core/models.ts` | TypeScript interfaces for the wire format (`NodeSample`, `GpuSample`, `Job`, `ClusterSnapshot`, `UsagePoint`). |
| `src/app/core/cluster-pulse.service.ts` | The single source of live state: opens the WebSocket, reconnects with backoff, seeds history from MySQL on load, exposes computed signals (CPU used, RAM used, GPU average, job counts), tracks staleness. |
| `src/app/overview/overview.*` | Main screen: 6 KPI cards, active alerts, per-node GPU fabric (8 tiles each), utilisation chart, running-jobs table. |
| `src/app/overview/usage-chart.*` | SVG multi-line chart: cluster CPU, RAM and average GPU utilisation per node over a rolling window. |
| `src/app/overview/gpu-sparklines.*` | 16 sparklines (one per GPU, 8 per node) over the last 60 s. |
| `src/app/nodes/nodes.*` | Per-node table: cores, RAM, GPUs, load ratio colouring, real CPU used, uptime. |
| `src/app/jobs/jobs.*` | Full job table with state/queue filters and search, sorted by live CPU; stress bars. |
| `src/app/jobs/jquery-job-table.*` | The jQuery half of the requirement: independent `$.ajax` poll every 5 s, DOM-built table, ignores the WebSocket entirely. |
| `src/app/logs/logs.*` | Event log from MySQL (`job_event` + `alert`) with source filters and 10 s auto-refresh. |
| `src/app/app.*`, `app.routes.ts` | Shell: header with connection dot and staleness, navigation, routes. |
| `src/styles.css` | Design tokens (dark control-room palette, single blue accent). |

### Operations — project root

| File | Purpose |
|---|---|
| `pulse.ps1` / `pulse.cmd` | Laptop control: `status` (green/red dots for MySQL, API, feed, UI), `start`, `stop`, `restart`, `logs`. Also **self-heals the VPN address**: compares the laptop's current `10.22.x` IP with `post_url.txt` on mgmt01 over SSH and rewrites it when it changed. |
| `sql.cmd` | MySQL console wrapper: `sql` (interactive), `sql "SELECT ...;"`, `sql -f queries.sql`. Reads the password from `server\.env`. |
| `queries.sql` | Seven ready-made demo queries for the MySQL viva. |
| `ui/` | The Figma Make prototype (React) — kept only as the visual reference; the graded app is the Angular one. |

---

## 6. What the web UI shows, screen by screen

**Overview** — `GPUs allocated / free + average utilisation`, `GPU utilisation`, `jobs running`,
`jobs queued`, `CPU used % (real)`, `RAM used (real)`, live alerts, per-node GPU tiles with
utilisation/memory/temperature, the four-line utilisation chart, 16 per-GPU sparklines, and the
running-jobs table sorted by CPU.

**Nodes** — one row per node: state, cores used/allocated, RAM used/total, GPUs allocated/total,
load average with a ×core-count ratio (green < 0.7, amber ≤ 1.0, red above), real CPU used %, uptime.

**Jobs** — every job with id, name, owner, queue, state, cpus, gpus, stress (PBS `cpupercent`),
memory, host, walltime; filters by state and queue, free-text search; plus the jQuery table below.

**Logs** — job state transitions and fired alerts from MySQL, filterable, auto-refreshing.

A header on every screen shows a connection dot and either `live · updated Ns ago` or
`stale — last push Ns ago`, so a dead feed is visible instead of silently showing old numbers.

---

## 7. Database (MySQL) — the memory of the dashboard

| Table | Written | Purpose |
|---|---|---|
| `node_metric` | every 10 s | load (1/5/15 m), real CPU `cpu_pct`, RAM used/total, GPU count, per node |
| `gpu_metric` | every 10 s | per GPU: utilisation, memory used/total, temperature, power |
| `cluster_metric` | every 10 s | cluster totals: cores/GPUs allocated, memory, jobs running/queued |
| `job` | on change | one row per job id, upserted: owner, queue, state, resources, walltime, PBS CPU% and memory |
| `job_event` | on state change | `from_state → to_state` transitions — this is what the Logs screen shows |
| `alert` | on threshold | fired alerts (GPU ≥ 80 °C, load > 1.5× cores, queue ≥ 20) |
| `v_recent_cluster` | view | last hour of cluster rollups, ready for the chart |

1 Hz telemetry is **never** stored raw — 10 s rollups keep a 24-hour day at 8,640 rows instead of
86,400, and the live screen does not need the database at all.

---

## 8. Measured facts about this cluster (not assumptions)

1. **PBS Pro**, binaries in `/opt/pbs/bin`. The environment-modules system is broken
   (`_module_raw: command not found`) — never call `module load`.
2. Queues are `workq` (default) and `gpu`. A GPU request still lands in `workq` unless you pass
   `-q gpu`.
3. 2 nodes × 104 cores (208 total), ~1 TB RAM each, 8 × **NVIDIA H100 80GB HBM3** each = 16 GPUs.
4. `CUDA_VISIBLE_DEVICES` is **empty** inside jobs: PBS does not isolate GPUs here. A 1-GPU job
   sees all 8, so utilisation is node-wide and includes every user's work. **There is no
   job → GPU mapping**, and the UI says so.
5. The compute nodes' clocks run **~11–12 minutes behind** `mgmt01`. The collector stamps
   `ingest_ts` from its own clock; everything in the UI charts on that, never on `node_ts`.
6. Guest/home is Lustre (166 TB, 41 % used). `quota -s` returns rc=1 with **empty output** — that
   is not "unlimited". Use `lfs quota -u <user> /home`.
7. `#PBS -o <path>` silently lost its output file on one job — default naming only.
8. Job CPU stress comes from PBS accounting and refreshes only every few **minutes**, not every
   second. The Jobs screen labels it as such.

---

## 9. Bugs found and fixed (the honest list)

| Symptom | Cause | Fix |
|---|---|---|
| `totals` all zero, `queues {}` while GPU files still parsed | the collector's PATH lacked `/opt/pbs/bin` (interactive shell and cron differ) | resolve `qstat`/`pbsnodes` by absolute path, fall back to the bare name |
| Job table always empty | job list only sent on change, so an API restart left no list to inherit; and a list that arrived on a non-rollup tick was discarded | force a full job refresh every 60 s; hold `pendingJobs` until the next rollup |
| Sampler duplicated every 10 minutes | the watchdog grep never matched: `qstat` truncates job names to 10 chars, and `qstat -f -u $USER` **ignores `-f`** (short table, no `Job_Name`) | unique job names per node + plain `qstat -f \| grep "Job_Name = cp_sampler_gpu0N"` |
| Collector stalled ~30 s, alive but not writing | `drain()` POSTed the entire 800-snapshot backlog in one tick | bound it: 20 items / 2 s per tick |
| Chart empty until data arrived; history missing | `INTERVAL ? MINUTE` with a bound parameter was not applied, and MySQL's `NOW()` is UTC while timestamps are IST | interpolate a validated integer; compare against `DATE_ADD(NOW(), INTERVAL 330 MINUTE)` |
| KPI cards frozen | they plotted **allocation** (only changes when jobs start/stop) | plot real usage from the samplers; keep allocation as subtext |
| Whole dashboard frozen | laptop VPN address changed and the collector kept posting to the old one | `post_url.txt` re-read every 30 s + `pulse` rewrites it automatically |
| Fake dip to zero in history | first snapshot after a collector restart had empty PBS data | skip rollups where `totals.cores === 0` |
| `pulse start` hung, or reported a healthy UI as down | pipe inheritance from child processes; .NET `TcpClient` cannot connect to the IPv6-only `[::1]:4200` listener | detached launchers; readiness judged by `netstat` |

---

## 10. How to run it

**Laptop** (`D:\hermes\workspace\test1\project`):

```
pulse            # status: MySQL / API / collector feed / UI, green or red
pulse start      # start everything (MySQL left running on purpose when stopping)
pulse restart
sql              # MySQL console;  sql -f queries.sql for the demo queries
```

**HPC** (on `mgmt01`):

```
bash ~/monitor/pulse.sh status     # 6 checks, green or red
bash ~/monitor/pulse.sh start|stop|restart
```

Dashboards: `http://localhost:4200` (Angular) and `http://localhost:3000/live` (fallback page).

---

## 11. Honest limits

- The laptop side is **not** self-starting — after a reboot, run `pulse start`.
- The cluster's raw 1 Hz logs are the only record of any window the API missed; they are not
  imported into MySQL automatically.
- MySQL has **no retention policy yet** — tables grow forever (~17k `node_metric` rows/day).
- Job stress is PBS accounting (~5 min granularity), not a live per-job sample.
- The MongoDB project and the ESP32/IoT node are **not built yet**; they are the remaining two
  subjects.

---

## 12. Quick facts for a viva

- 1 Hz sampling, 5 s scheduler refresh, 10 s database rollups, ~1.2 s end-to-end latency.
- 2 nodes, 208 cores, ~2 TB RAM, 16 × H100 80GB.
- 6 MySQL tables + 1 view; telemetry stored at 1/10th the sample rate.
- GPU numbers are node-wide (no GPU isolation on this PBS) — the dashboard states this rather
  than pretending to attribute GPU use per job.
- Everything runs from files and HTTP: nothing is installed on the cluster beyond three Python
  files and a crontab.
