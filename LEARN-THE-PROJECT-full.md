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

---

# PART B — the HPC side, as built and verified by the cluster agent

Everything here comes from my own probes and sweeps on mgmt01, run on 20 November 2026 (IST).
The numbers are the ones I read back out of the machine. Where I never measured something, I say
so instead of filling the gap.

## B1. What I probed before writing anything

- **Where PBS lives.** `command -v qsub qstat pbsnodes` -> all under `/opt/pbs/bin`. The
  environment-modules system on this cluster is broken (`module avail` / `module load` fail with
  `_module_raw: command not found`), so nothing in this project ever calls `module load`. Every
  scheduler call uses an absolute `/opt/pbs/bin/...` path, because the interactive shell and
  cron's shell do not share a PATH.
- **Queues.** `qstat -Q` -> `workq` (the default) and `gpu`. A GPU request submitted without
  `-q gpu` still lands in `workq`, which is why every `qsub` in this project passes `-q gpu`
  explicitly.
- **Hardware.** `pbsnodes -aSj`, then `pbsnodes -av`, then `nvidia-smi` from inside a real job
  (node metadata gives counts, not models). 2 nodes x 104 cores = 208 cores, ~1.05 TB RAM each
  (the collector's own `totals` reports `mem_kb: 2112097032`, i.e. ~2.11 TB across the pair),
  8 x NVIDIA H100 80GB HBM3 per node = 16 GPUs, 81559 MiB usable per card.
- **Filesystem and quota.** `df -hT ~` then `lfs quota -u $USER /home`: Lustre home, 166 TB
  filesystem, 400 GB soft / 500 GB hard per-user quota. `quota -s` on this mount exits rc=1 with
  EMPTY output — an empty read there is a failed read, never "no limit".
- **GPU isolation.** A CPU-only allocation still sees all 8 GPUs. Confirmed twice: once with
  `nvidia-smi` inside a job that requested no `ngpus`, and permanently thereafter in the payload
  itself, where every node sample carries `"cuda_visible_devices": ""`. There is no job-to-GPU
  mapping to be had on this cluster, so every GPU figure is node-wide and includes other users'
  work. The dashboard says so on screen instead of implying attribution.

## B2. The pipeline as deployed

- **`sampler.py`** — runs INSIDE a PBS job, one per GPU node, under `sampler.pbs` (`-q gpu`,
  `walltime=24:00:00`, `select=1:ncpus=1:mem=1gb`, and deliberately **no** `#PBS -o`, which
  silently lost its output on this cluster). At 1 Hz it writes `latest-<node>.json` by atomic
  rename and appends `metrics-<node>-YYYYMMDD.log` with a 7-day prune. It measures real CPU
  utilisation from a `/proc/stat` delta (`cpu.used_pct`), RAM from `/proc/meminfo`, load average,
  and per-GPU util/mem/temp/power plus the processes holding GPU memory. Verified live: gpu01
  reported `used_pct: 19.7`, gpu02 `61.0`, both genuine floats rather than null.
- **`collector.py`** — runs on mgmt01, 1 Hz. Merges both `latest-*.json` files with
  `qstat -f` + `pbsnodes -av` (refreshed every 5 s), writes `latest-snapshot.json`, POSTs to the
  laptop, and buffers to `outbox.jsonl` when the laptop is unreachable. Slimming keeps the
  payload small: the job list goes out only on change (with a forced full refresh), per-job
  consumption goes out as compact deltas `[[id, cpupercent, mem_kb], ...]`, and `apps[]` every
  15 s. A slim snapshot is ~4 KB (3994 bytes measured); a forced-full one carrying the job list
  is ~27 KB (27783 bytes measured).
- **`start_collector.sh`** — idempotent starter, anchored on `pgrep -f "^python3 collector.py"`
  so it cannot mistake its own command line for a running daemon.
- **`pulse.sh`** — the control script (`status|start|stop|restart`), 49 lines, mirrors the laptop
  side: collector instances, both samplers, snapshot age, outbox bytes, and an HTTP 200 check on
  the laptop `/health` derived from `post_url.txt`.
- **`post_url.txt` hot-reload** — the collector re-reads this file every 30 s and logs
  `post target changed: old -> new`, so a laptop VPN address change needs no restart. Proven
  twice on this cluster: `.98 -> .163`, then `.163 -> .227`, with the collector pid unchanged
  (1523974) and its original `--post` argument still naming the old address.

## B3. Traps that were not obvious

1. **`-v NODE_HOST=<node>` does not pin a job to a node.** PBS passes it as an environment
   variable and the scheduler still chooses. Pinning requires
   `-l select=1:ncpus=1:mem=1gb:host=<node>`, and it must be verified afterwards in
   `qstat -f <id> | grep exec_host`.
2. **`qstat` short table truncates job names to 10 characters.** `cp_sampler_gpu01` prints as
   `cp_sample*`. Any name-based check must read `Job_Name` from `qstat -f`, never from the table.
   My own first sweep keyed on the wrong column and returned nothing — the fix was to read
   `Job_Name` from `-f`.
3. **`qstat -f -u <user>` ignores `-f` entirely.** It prints the short table instead, so a
   watchdog written as `qstat -f -u $USER | grep -q "Job_Name = ..."` never matches and resubmits
   a duplicate every interval. The shipped watchdog uses plain `qstat -f`.
4. **The node-blind watchdog.** `qstat -u $USER | grep -q cp_sampler` matches *any* sampler, so
   with two nodes each line is satisfied by the other node's job and neither would ever resubmit.
   The shipped version greps for `Job_Name = cp_sampler_gpu01` / `_gpu02` specifically; I tested
   both predicates under cron's exact environment and each matched exactly once.
5. **PBS refresh of `resources_used`.** Per-job CPU and memory figures lag by minutes, so a job's
   live consumption is a coarse number, not a 1 Hz one. This is documented in Part A; I did not
   independently re-measure the interval in my sweeps — treat the exact figure as reported, and
   the lag itself as certain.
6. **A 0-byte file read lies during a channel outage.** While the SSH channel was down, both
   `read_file` and a plain read returned "File is empty (0 bytes)" for `post_url.txt` *and* for
   `pulse.sh`, which is 1881 bytes on disk. An empty read during a flaky connection is a failed
   read, not an empty file. I discarded it and re-read over a live channel.

## B4. Verification sweeps, with the numbers

Three full sweeps plus spot checks, all read-only, all on 20 Nov 2026.

**Sweep 1 — deploy integrity (12 items).**
- `sha256sum`: sampler `c90713f259dc266f0dfeb5c60fb977c013a11a73a4804e126a602b2a358a1226`,
  collector `7a88072fc0bd4cda9c94a51dcd3ee3f141834c7ad1e9346fb667d82d97a54370` — both matched
  the expected pair exactly.
- `pgrep -cf "^python3 collector.py"` -> `1` (pid 1290879).
- `qstat -u $USER` -> exactly 2 `cp_sampler` jobs in state R, `exec_host = gpu01/15` and
  `gpu02/0` — one per node.
- `post_url.txt` -> `http://10.22.0.163:3000/api/ingest/cluster` at the time.
- `latest-<node>.json` -> gpu01 `cpu={'logical': 104, 'used_pct': 19.7}` 8 GPUs; gpu02
  `{'logical': 104, 'used_pct': 61.0}` 8 GPUs. `used_pct` a float on both, so the `/proc/stat`
  measurement was live.
- `latest-snapshot.json` -> `totals: gpus 16, gpus_alloc 15, cores 208, cores_alloc 179`;
  `queues: workq {running 3, queued 0, held 2}, gpu {running 26, queued 12, held 8}`.
- Snapshot timestamp advanced 18:48:36 -> 18:48:42 across a 6 s sleep.
- `outbox.jsonl` -> 0 bytes. `crontab -l` -> PATH line plus the three entries.
- `du -sh ~/monitor` -> 48M with two 24M daily metric logs, against a 400 GB quota.
- Laptop `/health` -> `ingest_count` 519 -> 524 in 5 s, `db: connected`.

**Sweep 2 — after the collector redeploy (8 items).**
- New collector hash `4e98e63a49acddbfe30a56ee073f055b78bb6444eecd40b6aea84585a270d4d1` matched;
  sampler hash unchanged. Collector came back as a single new pid (1290879 -> 1523974).
- 2 sampler jobs only, ids 47696 (`cp_sampler_gpu01`, `gpu01/8`) and 47697
  (`cp_sampler_gpu02`, `gpu02/0`). No duplicates.
- The short table showed them as `cp_sample*` — trap 2 above, not a rename.
- Watchdog predicate test against the live scheduler: `gpu01 matches: 1`, `gpu02 matches: 1`.
- Full-tick snapshot: `jobs_state: full`, `job_usage` 28 rows of `[id, cpu, mem_kb]`,
  e.g. `["32082", 95, 103501156]`.
- `/health` `ingest_count` 1565 -> 1576 in 11 s, and a separate 30 s sample gave 647 -> 677
  exactly 30 -> the pipeline holds 1 Hz end to end.

**Sweep 3 — after the VPN address change (`.163 -> .227`).**
- `pulse.sh status` -> 6 green lines: collector 1 instance, both samplers R, snapshot 0 s old,
  outbox empty, laptop API 200.
- `post_url.txt` -> `http://10.22.0.227:3000/api/ingest/cluster`; `outbox.jsonl` -> 0 bytes.
- `collector.log` line 242 of 323: `post target changed: ...163... -> ...227...`, picked up with
  no restart. After it, the drain: **1409 snapshots backfilled** in total across 104
  `backfilled N buffered snapshots` lines, from 156 buffered events. Outbox returned to 0.
- Steady state after the drain: `ingest_count` 2294 -> 2310 in 15 s (~1.07/s), zero new log lines
  in a 15 s window, log silent for 76 s.

**One anomaly I could not explain.** Between 18:50:32 and 18:51:01 (~29 s) the collector stopped
writing `latest-snapshot.json` while pid 1290879 sat in state `S` on
`do_poll.constprop.0`, and the laptop reported `last_snapshot_ago_s` climbing 16 -> 35. It
recovered on its own and held exactly 1/s afterwards. The shape — process alive, blocked in
`poll`, no writes, no log lines — points at a POST socket without a timeout rather than anything
in the data path. It cost roughly 85 ingests against API uptime (551 recorded at 618 s uptime).

## B5. How to operate it

```
bash ~/monitor/pulse.sh status     # read-only health check, 6 lines
bash ~/monitor/pulse.sh start      # start collector if absent, submit any missing sampler
bash ~/monitor/pulse.sh stop       # kill collector, qdel both samplers
bash ~/monitor/pulse.sh restart    # stop, wait 3s, start, then print status
```

`status` is safe to run any time and changes nothing. `stop` and `restart` kill both samplers and
requeue them, which means they go to the back of the GPU queue — do not run them casually, and
never run them while a demo is live.

The crontab covers unattended recovery:

```
SHELL=/bin/bash
PATH=/opt/pbs/bin:/usr/local/bin:/usr/bin:/bin
@reboot  cd ~/monitor && nohup python3 collector.py --post "$(cat post_url.txt)" >> collector.log 2>&1 &
*/5 * * * *  pgrep -f "^python3 collector.py" >/dev/null || bash ~/monitor/start_collector.sh
*/2 * * * *  qstat -f | grep -q "Job_Name = cp_sampler_gpu01" || qsub -N cp_sampler_gpu01 -q gpu -l select=1:ncpus=1:mem=1gb:host=gpu01 ~/monitor/sampler.pbs
*/2 * * * *  qstat -f | grep -q "Job_Name = cp_sampler_gpu02" || qsub -N cp_sampler_gpu02 -q gpu -l select=1:ncpus=1:mem=1gb:host=gpu02 ~/monitor/sampler.pbs
```

- `@reboot` brings the collector back after a login-node reboot.
- `*/5` respawns the collector within five minutes of it dying.
- The two `*/2` lines respawn a sampler within two minutes of it ending, per node, and pin it to
  the right node with `host=`.

`PATH` must be the first thing that is not `SHELL`: the cron default PATH has no PBS binaries, so
a watchdog would fail at `qstat` and take the `||` branch every single interval.

**When the dashboard looks frozen, check the feed before the UI.** In order:

1. `bash ~/monitor/pulse.sh status` — if `snapshot` reads stale, the cluster side stopped writing;
   if `snapshot` is 0 s old but the UI is blank, the problem is between the API and the browser.
2. `curl -s http://<laptop>:3000/health` — `last_snapshot_ago_s` and `ingest_count` tell you
   whether the laptop is still receiving at 1 Hz.
3. `cat ~/monitor/post_url.txt` against the laptop current address — a VPN change is the most
   common cause of a dead feed, and the collector logs `post target changed` when it catches up.
4. `tail -5 ~/monitor/collector.log` — `POST failed — buffering to outbox` with a growing
   `outbox.jsonl` means the laptop is unreachable, not that the cluster is broken.
5. `qstat -u $USER | grep cp_sample` — if a sampler is gone, the `*/2` watchdog is the thing that
   is supposed to fix it; check `crontab -l` and `systemctl is-active crond` if it did not.

## B6. Honest limits from my side

- **`pulse.sh stop` and `restart` have never been executed.** I was explicitly told not to run
  them while a demo was pending, so they are syntax-checked (`bash -n`) and reviewed but not
  fire-tested. `status` and `start` (the idempotent path) have been run.
- **No on-disk backup of the previous crontab exists.** I tried to snapshot it before replacing it
  and every attempt landed on a call the SSH channel killed before it executed. The old four-line
  crontab is preserved only in my session record.
- **Recovery is not instant, and a 2-minute watchdog is not 2-minute uptime.** A dead sampler is
  resubmitted within ~2 min, but the `gpu` queue had 11-12 jobs queued during my checks, so the
  replacement sits in `Q` behind other users before it runs. Expect a multi-minute hole in the
  data, and expect the dashboard to show a gap rather than interpolate it.
- **Nothing alerts.** There is no notification on failure — no mail, no push. `pulse.sh status` is
  opt-in, and the outbox is the only durable record of an outage. A silent failure is discovered
  by looking at a frozen chart.
- **The unexplained stall in B4 is still unexplained.** If the pipeline freezes on its own again,
  that is where I would look first: the collector blocked in `poll` with no writes and no log
  lines, which is consistent with a POST that has no timeout. I did not reproduce it a second time
  and I did not change the code to fix it.
- **The laptop is a single point of failure.** One API, one MySQL, one WebSocket. If it is down
  longer than the outbox allows (50 MB, minutes to tens of minutes at ~4 KB/s), the collector trims
  to a gap marker and the data is gone rather than delayed.
- **The weakest link to operate is the SSH channel itself.** It dropped 5-7 times per sweep during
  this session. Anything long-running must be scripted and file-backed, because a backgrounded
  process dies with the channel.
- **Everything on the cluster is three Python files and a crontab.** No services, no systemd units,
  no packages installed. That is a feature for a shared cluster, and it also means there is no
  supervisor: if cron is disabled by the admins, the recovery story is `pulse.sh start` by hand.


---

# APPENDIX — Why the dashboard "dances" for the first ~10 seconds after you open it

This is expected start-up behaviour, not a data fault. Nothing is wrong with the numbers;
the page simply assembles them from three independent sources that arrive at different times.

## What actually runs on page load

`ClusterPulseService` fires three things **without waiting for each other**
(`core/cluster-pulse.service.ts`, constructor, lines 105-108):

1. `loadInitial()` — one HTTP `GET /api/snapshot` for the latest known state
2. `loadHistory()` — HTTP `GET /api/history`, `/api/history/nodes`, `/api/history/gpus` for the chart backdrop
3. `connect()` — opens the WebSocket, which immediately receives a `hello` with the last snapshot

## Cause 1 — the chart is seeded *after* it has already started drawing

The live WebSocket normally wins the race (it connects in milliseconds; the history queries
have to read MySQL). So the chart first renders with one or two live points and an axis label
like `last 0s`. A moment later the history request returns and does:

```ts
this.history.set(points.slice(-300));   // line 164 — REPLACES the array
```

It **replaces** the array rather than merging into it, so every live point collected during
those few hundred milliseconds is discarded and ~200–300 historical points appear at once.
The axis jumps from seconds to minutes and the curve visibly re-shapes. That single moment is
the "explosion" you see.

## Cause 2 — two different resolutions are being stitched together

- Historical points come from MySQL rollups: **one point every 10 seconds**
- Live points come from the WebSocket: **one point every 1 second**

So the left part of the line is coarse (10 s steps) and the right part is fine (1 s steps).
As live points accumulate, the coarse section scrolls left out of view — which is why the graph
looks "normalised" after a short while. It is the same data, at two different densities.

## Cause 3 — cold start after a restart: the first values really are zero

When the collector restarts, its PBS cache is empty until the first `qstat -f` / `pbsnodes -av`
call finishes (that cadence is 5 s). Any snapshot built in that window carries `totals` of
`0 / 0`, so for a second or two the cards can read `0 / 16`, `0 %`, `0 GB` and then snap to the
real values. This was observed as the one `NULL` row in `cluster_metric` at 21:01:58 in the
earlier demo queries. Those bogus rows are no longer written to MySQL, but the live push still
passes through the API for that instant.

## Cause 4 — the header lies very briefly

`staleness` starts at 0, so the header can read `live · updated 0s ago` before the first message
has actually arrived. It corrects itself on the first push (and would flip to `stale` if the feed
were dead).

## Summary — what you see, and why

| What you see in the first seconds | Cause |
|---|---|
| cards showing 0 / 0 % / 0 GB, then real numbers | cold start: PBS cache empty for up to 5 s (cause 3) |
| chart reshaping, axis jumping from `0s` to `5m` | history replaces the live array instead of merging (cause 1) |
| graph looks rough then settles | 10 s rollups on the left, 1 s live on the right (cause 2) |
| header says "updated 0s ago" before data exists | staleness starts at 0 (cause 4) |

After roughly 10 seconds the seeded history and the live stream have the same weight, the axis
span stops jumping, and everything reads consistently. **No measurement is lost** — the
database never stopped recording, and the live values themselves were always correct.

If this were ever worth polishing (it is cosmetic), the two clean fixes would be: merge history
into the existing points instead of `set()`-ing over them, and suppress rendering until the first
history load resolves. Neither is required for correctness.


---

# CHANGELOG — 2026-11-20 (evening): making reconnects self-healing

The campus VPN dropped repeatedly during the day and handed out a **new `10.22.x` address on
almost every reconnect** (observed: .194 → .98 → .163 → .227 → .34 → .162 → .228 → .162). Each
change silently starved the feed, because the collector on `mgmt01` keeps POSTing to whatever
address is written in `~/monitor/post_url.txt`. That produced the "restart everything 4-5 times"
experience: the restarts were not fixing anything — running `pulse` during the ritual was, because
that is what rewrote the address.

Five changes remove the ritual:

| Change | Where | Why |
|---|---|---|
| `pulse watch` — self-healing loop (menu option **7**) | laptop | Every 15 s: if the VPN has an address but the API/UI are down it starts them; if the feed has been stale for >30 s it re-syncs `post_url.txt`. Prints one line per cycle so you can watch it recover. Ctrl+C to stop. |
| `pulse start` syncs the address **first** | laptop | Previously it synced at the end — data was already failing while you waited for the services to start. |
| Scheduled IP sync now every **1 minute** (was 5) | laptop | Worst-case stall after a reconnect drops from 5 minutes to 60 s. Task name: `ClusterPulse-IPSync`. |
| Collector re-reads `post_url.txt` every **5 s** (was 30) | `mgmt01` | A corrected address now takes effect almost immediately instead of after half a minute. |
| Interactive menu on **both** sides | both | Laptop: `1 status · 2 start · 3 stop · 4 restart · 5 logs · 6 open · 7 watch · 0 exit`. HPC: `1 status · 2 start · 3 stop · 4 restart · 5 logs · 6 exit`. Double-clicking `pulse.cmd` no longer closes the window. |

## How to use it after a VPN drop

You do not have to do anything, provided `pulse watch` is running (option 7) or the scheduled task
is registered:

1. VPN drops → collector buffers to its outbox (nothing lost; the cluster keeps sampling).
2. VPN reconnects with a new address → within ≤60 s the sync task (or `pulse watch`) writes the new
   address into `post_url.txt`.
3. Within ≤5 s the collector notices and logs `post target changed: … -> …`.
4. The outbox drains in slices of 20 snapshots / 2 s per tick; the dashboard catches up.

Manual equivalent, any time: run `pulse` (or `pulse sync`) — the same sync, immediately.

## What still cannot be fixed from here

If the tunnel itself is down (no `10.22.x` address at all), nothing can flow in either direction.
That is a network condition, not a software one. The design already degrades correctly: buffers on
the cluster, staleness badge on the dashboard, and both control panels showing a red marker instead
of pretending to be healthy.


---

# PART D — correction to Part C, measured independently (2026-11-20, 23:5x)

Part C states that `qstat -f` takes 5-15 s and that this, not the network, is what freezes the
pipeline. That claim does not reproduce. Measured directly on `mgmt01` minutes later:

| measurement | Part C claim | measured again |
|---|---|---|
| `qstat -f` (37 jobs, 1837 lines) | 15.17 / 10.37 / 5.32 s | **0.093 s** first call, then **0.284-0.287 s** over 10 consecutive runs |
| `qstat -u $USER` | 0.09 / 0.30 s | 0.287 s |
| `pbsnodes -av` | 10.13 s cold, then 0.10 s | 0.089 s |
| snapshot age, 20 samples 1 s apart | - | `1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0` - a clean 1 Hz, **zero stalls** |

So the collector is not blocked inside PBS. At ~285 ms per call, `qstat -f` plus `pbsnodes` costs
roughly 0.4 s out of every 5 s cycle - real, but 6-8%, not a freeze.

The most likely explanation for the 5-15 s readings is that they were taken while the SSH channel
was degraded (the same window recorded a 76% connection failure rate), so the wall-clock time
included handshake stalls and retries rather than PBS work. `pbsnodes` showing 10.13 s once and
0.10 s immediately afterwards points the same way: first-contact cost, not steady-state cost.

## What Part C got right, and stands

1. **`collector.log` had no timestamps at all.** Real defect; it made "how long was the POST
   failing" unanswerable. Fixed by wrapping `print` once at import so every line starts with a
   wall-clock timestamp.
2. **The watchdog can submit duplicate samplers.** Real: a single transient `qstat` error makes
   `grep -q` return non-zero and the job is resubmitted while already running. Fix: require two
   consecutive misses, ~10 s apart, before resubmitting.
3. **POST failures are bimodal** - one long outage (156 consecutive failures) plus 94 isolated
   single blips - and the outbox drains to zero at >=4.9 KB/s once the address is reachable.
4. **The SSH channel, not the pipeline, is the unstable part**: 5 successes out of 21 attempts
   (76% failure) in that window, failing in bursts.

## Net position

The pipeline's real weaknesses were never throughput. They were: a target address that changes
whenever the VPN reconnects (now synced every 60 s, re-read by the collector every 5 s), a log
without timestamps (fixed), and watchdogs that could double-submit (fix specified). Latency in
`qstat` is not one of them.


---

# PART E — the 00:08 "freeze" was clock skew, and what was changed because of it

At 00:08 the dashboard stopped updating and `latest-gpu01.json` / `latest-gpu02.json` both appeared
to be ~11 minutes stale. Both sampler jobs were in state `R`. The first conclusion - "the samplers
have wedged, restart them" - was wrong, and it is worth recording how it was disproved.

## E1. The measurement that settled it

```
wc -l metrics-gpu01-20261121.log   before: 1379
   after 30 s:                     1409      (+30 lines in 30 s = exactly 1 Hz)
wc -l metrics-gpu02-20261121.log   before: 1337
   after 30 s:                     1365      (+28 lines in 30 s)
```

The samplers were sampling perfectly. The files only *looked* old because **the GPU nodes' clocks
run about 11 minutes behind `mgmt01`**. `node_ts` written by gpu01 read `00:24:18` while `mgmt01`
read `00:35:25`. The same skew is visible in the file mtimes, because the mtime is stamped by the
writer.

This also explains the Part C observation "three sessions still logged in": `last` output on
`mgmt01` is in `mgmt01` time, while the node activity it describes is in node time.

**Consequence:** any health check based on "how old is this file" is wrong on this cluster by
construction. It will report an 11-minute-old file forever, and a naive watchdog will kill healthy
samplers every cycle.

## E2. The watchdog was rewritten to measure *progress*, not age

`~/monitor/watchdog.sh <node>` now stores the mtime it last saw in `~/monitor/.watch-<node>` and
the local time it saw it. It acts only when the mtime has not changed for **180 s of local time** -
which is skew-proof, because it compares the file to its own past self instead of to the clock.

Action on confirmed stall: find the job whose `Job_Name = cp_sampler_<node>`, `qdel` it, `qsub` a
replacement. Verified: first run seeds the state file, second run is a no-op, and neither kills a
healthy job.

Crontab now:

```
*/5 * * * * pgrep -f "^python3 collector.py" >/dev/null || bash ~/monitor/start_collector.sh
*/2 * * * * bash ~/monitor/watchdog.sh gpu01 >> ~/monitor/watchdog.log 2>&1
*/2 * * * * bash ~/monitor/watchdog.sh gpu02 >> ~/monitor/watchdog.log 2>&1
```

The previous predicate - `qstat -f | grep -q "Job_Name = cp_sampler_gpu01"` - was also wrong for a
second reason: `qstat -f` keeps listing a *finished* job, so a dead sampler left behind a record
that matched the grep and the watchdog never resubmitted. Freshness cannot be faked that way.

## E3. Sampler hardened against a genuinely wedged `nvidia-smi`

`subprocess.run(..., timeout=8)` does not bound a child stuck in uninterruptible I/O: the kill
cannot be reaped and the call blocks anyway. `run()` in `sampler.py` now executes each command on a
daemon thread and abandons it after the timeout, so one bad `nvidia-smi` can never freeze the loop.
If the GPU query yields nothing for 300 consecutive ticks, the sampler logs the fact and exits, so
the watchdog replaces the job instead of leaving a zombie that reports `R` forever.

## E4. Log timestamps

Every line in `collector.log` now starts with a wall-clock stamp (`2026-11-21 00:13:12 POST ok ...`),
which is what made Part C's A2/A5 questions unanswerable in the first place.

## E5. State after the work, verified

```
laptop ingest      2610 -> 2620 over 10 s   = 1.0 snapshot/s
snapshot age       0 s
totals             16 GPUs / 208 cores / 2.11 TB RAM, 14 GPUs and 155 cores allocated
queues             workq: 4 running; gpu: 23 running, 7 queued, 5 held
jobs tracked       39
pbs nodes          2
samplers           47757 (gpu01) and 47758 (gpu02), both R, sampling at 1 Hz
```

## E6. Open item

`job_usage` came back with 0 rows in the live snapshot, so the per-job CPU column on the Jobs screen
may be blank. The 60 s `--jobs-refresh` cycle should refill it; if it does not, that is a collector
bug worth chasing next, and it is the only piece of the pipeline not confirmed healthy tonight.
