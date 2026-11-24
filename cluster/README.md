# Cluster Pulse — data pipeline design

Cluster: **UPES HPC**, login node `mgmt01`, compute nodes `gpu01` / `gpu02` (PBS Pro).
Everything here runs on the cluster. The dashboard runs on the laptop.

## 1. Why two cadences

| Source | Command | Cadence | Gives you |
|---|---|---|---|
| Sampler job (on gpu01/gpu02) | `nvidia-smi`, `/proc/loadavg`, `/proc/meminfo` | **1 s** | real per-GPU utilisation, memory, temp, power; CPU load; RAM; process→GPU memory owners |
| Scheduler | `qstat -f` | **5 s** | jobs: id, name, owner, queue, state, cpus, gpus, walltime |
| Node state | `pbsnodes -av` | **5 s** | capacity and allocation per node (cores/RAM/GPU) |

`nvidia-smi` on the login node cannot see a driver — it must run inside a job.
`qstat`/`pbsnodes` take 1–3 s each on a loaded server, so they are cached for 5 s
and the collector reuses the cache on every 1 s tick.

## 2. Flow

```
  gpu01 ─┐  sampler.py (in PBS job)                    every 1 s
         ├─→ ~/monitor/latest-<node>.json   (atomic overwrite, source of truth)
  gpu02 ─┘   ~/monitor/metrics-<node>-YYYYMMDD.log  (append, 7-day prune)
                        │
                        │  home is shared Lustre → visible on mgmt01
                        ▼
  mgmt01 ─ collector.py ─→ cluster_snapshot ──POST──→ laptop Node API :3000
              │  (merges sampler files + qstat + pbsnodes)      │
              │                                                  ├→ WebSocket → Angular (render on push)
              └─ on POST failure → ~/monitor/outbox.jsonl        └→ MySQL (10 s rollups)
                 retried every tick until it drains
```

Two write paths on purpose: the **file is the truth** (survives a VPN drop, feeds
the replay mode), the **POST is the fast path** (removes the collector-poll second).
If the laptop is unreachable the collector buffers; nothing is lost.

## 3. Message contracts

`node_sample` — written by the sampler, one per tick:

```json
{
  "schema": 1, "type": "node_sample", "node": "gpu01",
  "node_ts": "2026-11-20T14:30:32+05:30",
  "uptime_s": 1555000,
  "loadavg": [8.42, 7.16, 6.9],
  "cpu": {"logical": 104},
  "mem": {"total_kb": 1056047776, "available_kb": 320000000, "used_kb": 736047776},
  "gpus": [{"index": 0, "name": "NVIDIA H100 80GB HBM3", "util_pct": 94,
            "mem_used_mib": 74000, "mem_total_mib": 81559, "temp_c": 77, "power_w": 420.5}],
  "apps": [{"gpu_index": 0, "pid": 3194983, "process": "python3",
            "user": "arun.26025", "mem_mib": 28678}],
  "pbs_job_id": "47611.mgmt01",
  "cuda_visible_devices": ""
}
```

`cluster_snapshot` — POSTed by the collector:

```json
{
  "schema": 1, "type": "cluster_snapshot",
  "ingest_ts": "2026-11-20T14:42:25+05:30",
  "pbs_refreshed_s_ago": 1.2,
  "clock_note": "gpu01/gpu02 clocks run ~12min behind mgmt01 …",
  "totals": {"gpus": 16, "gpus_alloc": 14, "cores": 208, "cores_alloc": 164,
             "mem_kb": 2112097032, "mem_alloc_kb": 566231040},
  "queues": {"workq": {"running": 7, "queued": 1, "held": 0},
             "gpu":   {"running": 19, "queued": 20, "held": 0}},
  "nodes": [<node_sample|null>, <node_sample|null>],
  "pbs_nodes": [{"node": "gpu01", "available": {...}, "assigned": {...}}],
  "jobs": [{"id": "47610", "name": "probe2", "owner": "arun.26025", "queue": "workq",
            "state": "R", "ncpus": 1, "ngpus": 1, "walltime_used": "00:00:12"}]
}
```

## 4. Latency budget

| Stage | Delay |
|---|---|
| sampler interval | 1.0 s |
| Lustre visibility on mgmt01 | < 1 s (occasionally a few s, client attr cache) |
| collector tick | 1.0 s |
| VPN + POST + WebSocket | 50–150 ms |
| Angular render (on push, not on timer) | ~16 ms |

**≈ 2–3 s typical, 5 s worst case.** GPU panel says "2 s ago", jobs panel says
"≤ 5 s ago" — never one blended "live" badge.

## 5. Truths the UI must respect (measured, not assumed)

1. **No GPU isolation.** `CUDA_VISIBLE_DEVICES` is empty inside jobs, so a 1-GPU
   job can see all 8. Utilisation is **node-wide and includes other users**.
   There is no job→GPU mapping. Never claim otherwise.
2. **~12-minute clock skew** between gpu01/gpu02 and mgmt01. Samplers stamp
   `node_ts`; the collector stamps `ingest_ts`; charts use `ingest_ts`.
3. **`-q gpu` is mandatory.** A job asking for `ngpus=1` still lands in `workq`
   otherwise.
4. **Do not use `#PBS -o <path>`** — one job exited 0 and its output file never
   appeared on this PBS.
5. **`quota -s` lies** (rc=1, empty output on Lustre). Use `lfs quota -u <user> /home`.
6. **The module system is broken** (`_module_raw: command not found`). PBS binaries
   are in `/opt/pbs/bin` and already on PATH.

## 6. Failure modes

| Failure | What happens |
|---|---|
| VPN drops | Collector buffers to `outbox.jsonl`, drains on reconnect. Sampler keeps writing. |
| Sampler job hits walltime | `latest-<node>.json` goes stale — collector reports `null` for that node, UI greys it. Resubmit (see §7). |
| `nvidia-smi` fails on a node | Sampler still writes the sample with `gpus: []`; UI shows the node with no GPU data. |
| Laptop API down | Same as VPN drop — outbox. |
| Laptop IP changes | Re-export `CLUSTER_PULSE_POST` and restart the collector, or leave it unset and use the file-only path. |

## 7. Keeping the sampler alive

Walltime is 24 h in `sampler.pbs`. A `crontab -e` entry on mgmt01 resubmits when
the job is gone:

```
*/10 * * * * qstat -u $USER | grep -q cp_sampler || qsub -v NODE_HOST=gpu01 ~/monitor/sampler.pbs
*/10 * * * * qstat -u $USER | grep -q cp_sampler || qsub -v NODE_HOST=gpu02 ~/monitor/sampler.pbs
```

(First verify `qsub -l select=host=gpu01` evidence: if `-v NODE_HOST` is not
consumed, replace with `-l select=1:ncpus=1:ngpus=1:host=gpu01`.)

## 8. Files

| File | Runs on | Purpose |
|---|---|---|
| `sampler.py` | gpu01/gpu02 inside a PBS job | node + GPU sampling, file write, optional POST |
| `sampler.pbs` | submitted from mgmt01 | PBS wrapper: `-q gpu`, 24 h, 1 CPU/1 GPU/2 GB |
| `collector.py` | mgmt01 | ETL: merges sampler files + PBS, POSTs, buffers on failure |

Python 3.9 stdlib only. `psutil` is available but not required.
