Set up the Cluster Pulse pipeline on this cluster. All code below is final — do not rewrite, reformat or "improve" it. Run each step and paste RAW output. If something fails, say exactly what it printed; never fill a gap with a guess.

WHAT THIS IS
  ~/monitor/sampler.py    runs INSIDE a PBS job on gpu01/gpu02 — samples 8 GPUs + load + RAM every second
  ~/monitor/sampler.pbs   PBS wrapper (-q gpu, 24h, 1 CPU / 1 GPU / 2 GB)
  ~/monitor/collector.py  runs on mgmt01 — merges sampler files + qstat + pbsnodes, POSTs to the laptop

TWO PATHS ON PURPOSE (this is the design, not redundancy to clean up)
  fast lane : sampler POSTs every tick straight to the laptop API  (~1-2s end to end)
  buffer    : sampler also writes ~/monitor/latest-<node>.json on shared Lustre
  collector : merges + POSTs, and buffers to ~/monitor/outbox.jsonl whenever the laptop is unreachable
If the VPN drops, the sampler keeps writing files and the collector backfills later. Never remove the file write.

════════ STEP 1 — files ════════
mkdir -p ~/monitor

cat > ~/monitor/sampler.py <<'CP_SAMPLER_EOF'
#!/usr/bin/env python3
"""Cluster Pulse — node sampler.

Runs INSIDE a PBS job on a GPU node (gpu01 / gpu02). Every INTERVAL seconds it
writes one JSON snapshot of the node to $HOME/monitor/latest-<node>.json
(atomic overwrite) and appends a line to $HOME/monitor/metrics-<node>-YYYYMMDD.log.

It also tries to POST the snapshot straight to the laptop API, so the dashboard
sees ~1s latency even if the collector poll is slow. If the POST fails the file
is still there — the collector on mgmt01 backfills from it. The file is the
source of truth; the POST is an optimisation.

Python 3.9 only, stdlib. No psutil required, no pip install.

Usage:
    python3 sampler.py --interval 1 --home /home/arun.26025
    python3 sampler.py --interval 1 --post http://10.22.0.194:3000/api/ingest/node
"""

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
RETAIN_DAYS = 7


def now_iso():
    return datetime.now(IST).isoformat(timespec="seconds")


def read_file(path):
    try:
        with open(path, "r") as fh:
            return fh.read()
    except OSError:
        return ""


def run(cmd, timeout=5):
    """Run a command, return stdout stripped. Never raise."""
    try:
        out = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return out.stdout.strip()
    except Exception:
        return ""


def read_loadavg():
    raw = read_file("/proc/loadavg").split()
    try:
        return [round(float(raw[0]), 2), round(float(raw[1]), 2), round(float(raw[2]), 2)]
    except (IndexError, ValueError):
        return [None, None, None]


def read_meminfo():
    info = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.split(":")
        if len(parts) == 2:
            info[parts[0].strip()] = parts[1].strip().split()[0]
    try:
        total = int(info.get("MemTotal", 0))
        avail = int(info.get("MemAvailable", 0))
    except ValueError:
        total, avail = 0, 0
    return {"total_kb": total, "available_kb": avail, "used_kb": max(total - avail, 0)}


def read_uptime():
    raw = read_file("/proc/uptime").split()
    try:
        return int(float(raw[0]))
    except (IndexError, ValueError):
        return None


def gpu_stats():
    """Per-GPU utilisation. NOTE: node-wide — includes every user's work."""
    fmt = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
    raw = run(
        "nvidia-smi --query-gpu=%s --format=csv,noheader,nounits" % fmt, timeout=8
    )
    gpus = []
    for line in raw.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 7:
            continue
        gpus.append(
            {
                "index": to_int(cols[0]),
                "name": cols[1],
                "util_pct": to_int(cols[2]),
                "mem_used_mib": to_int(cols[3]),
                "mem_total_mib": to_int(cols[4]),
                "temp_c": to_int(cols[5]),
                "power_w": to_float(cols[6]),
            }
        )
    return gpus


def to_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def gpu_apps():
    """Which processes hold GPU memory, and whose they are.

    PBS does not set CUDA_VISIBLE_DEVICES on this cluster, so this list includes
    other users' processes. That is expected and is shown in the UI as such.
    """
    raw = run(
        "nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory "
        "--format=csv,noheader,nounits",
        timeout=8,
    )
    uuid_to_index = {}
    listing = run("nvidia-smi --query-gpu=index,uuid --format=csv,noheader", timeout=8)
    for line in listing.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) == 2:
            uuid_to_index[cols[1]] = to_int(cols[0])

    apps = []
    for line in raw.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 4:
            continue
        pid = to_int(cols[1])
        user = run("ps -o user= -p %s" % pid, timeout=3) if pid else ""
        apps.append(
            {
                "gpu_index": uuid_to_index.get(cols[0]),
                "pid": pid,
                "process": cols[2],
                "user": user or None,
                "mem_mib": to_int(cols[3]),
            }
        )
    return apps


def build_sample(node):
    return {
        "schema": 1,
        "type": "node_sample",
        "node": node,
        "node_ts": now_iso(),
        "uptime_s": read_uptime(),
        "loadavg": read_loadavg(),
        "cpu": {"logical": os.cpu_count()},
        "mem": read_meminfo(),
        "gpus": gpu_stats(),
        "apps": gpu_apps(),
        "pbs_job_id": os.environ.get("PBS_JOBID"),
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
    }


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def post_json(url, payload, timeout=2):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status < 400
        # unreachable
    except (urllib.error.URLError, OSError, ValueError):
        return False


def prune(home, node):
    cutoff = datetime.now().date() - timedelta(days=RETAIN_DAYS)
    try:
        for name in os.listdir(home):
            if not (name.startswith("metrics-%s-" % node) and name.endswith(".log")):
                continue
            stamp = name[len("metrics-%s-" % node) : -4]
            try:
                day = datetime.strptime(stamp, "%Y%m%d").date()
            except ValueError:
                continue
            if day < cutoff:
                os.remove(os.path.join(home, name))
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--home", default=os.environ.get("HOME", "."))
    ap.add_argument("--post", default=os.environ.get("CLUSTER_PULSE_POST", ""))
    ap.add_argument("--node", default=socket.gethostname().split(".")[0])
    args = ap.parse_args()

    monitor_dir = os.path.join(args.home, "monitor")
    os.makedirs(monitor_dir, exist_ok=True)
    latest_path = os.path.join(monitor_dir, "latest-%s.json" % args.node)

    print(
        "sampler starting node=%s interval=%ss dir=%s post=%s"
        % (args.node, args.interval, monitor_dir, args.post or "(none)"),
        flush=True,
    )

    tick = 0
    posted_ok = 0
    while True:
        started = time.time()
        try:
            sample = build_sample(args.node)
            blob = json.dumps(sample)
            write_atomic(latest_path, blob)

            day = datetime.now(IST).strftime("%Y%m%d")
            log_path = os.path.join(monitor_dir, "metrics-%s-%s.log" % (args.node, day))
            with open(log_path, "a") as fh:
                fh.write(blob + "\n")

            if args.post and post_json(args.post, sample):
                posted_ok += 1

            if tick % 3600 == 0:
                prune(monitor_dir, args.node)
                print(
                    "tick=%d posts_ok=%d gpus=%d"
                    % (tick, posted_ok, len(sample["gpus"])),
                    flush=True,
                )
            tick += 1
        except Exception as exc:  # keep sampling even if one tick breaks
            print("tick error: %r" % (exc,), file=sys.stderr, flush=True)

        elapsed = time.time() - started
        time.sleep(max(args.interval - elapsed, 0.05))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("sampler stopped", flush=True)
CP_SAMPLER_EOF

cat > ~/monitor/sampler.pbs <<'CP_PBS_EOF'
#!/bin/bash
# Cluster Pulse — sampler job
# Runs one sampler per GPU node. Submit TWICE, pinning a different host each time:
#   qsub -v NODE_HOST=gpu01 sampler.pbs
#   qsub -v NODE_HOST=gpu02 sampler.pbs
#
# Notes from real probing of this cluster:
#   * the default queue is workq — you MUST pass -q gpu
#   * module system is broken, PBS lives in /opt/pbs/bin (already on PATH)
#   * do NOT add "#PBS -o <path>" here: on this PBS one job silently lost its
#     output file. Default naming (-j oe) works.

#PBS -N cp_sampler
#PBS -q gpu
#PBS -l select=1:ncpus=1:ngpus=1:mem=2gb
#PBS -l walltime=24:00:00
#PBS -j oe

set -u

SAMPLER="${HOME}/monitor/sampler.py"
INTERVAL="${INTERVAL:-1}"

echo "=== cp_sampler on $(hostname) at $(date) ==="
echo "PBS_JOBID=${PBS_JOBID:-unset}"

if [ ! -f "$SAMPLER" ]; then
  echo "FATAL: $SAMPLER not found" >&2
  exit 2
fi

# POST target is optional. Leave unset to run file-only (collector backfills).
POST="${CLUSTER_PULSE_POST:-}"

cd "$HOME" || exit 3

if [ -n "$POST" ]; then
  exec python3 "$SAMPLER" --interval "$INTERVAL" --home "$HOME" --post "$POST"
else
  exec python3 "$SAMPLER" --interval "$INTERVAL" --home "$HOME"
fi
CP_PBS_EOF

cat > ~/monitor/collector.py <<'CP_COLLECTOR_EOF'
#!/usr/bin/env python3
"""Cluster Pulse — login-node collector (ETL).

Runs on mgmt01. Three sources, two cadences:

  1. $HOME/monitor/latest-<node>.json   written every 1s by the sampler job
                                        (real per-GPU utilisation, load, memory)
  2. qstat -f                          scheduler jobs        — every 5s
  3. pbsnodes -av                      node capacity/state   — every 5s

It merges them into one `cluster_snapshot` message and POSTs it to the laptop
API. If the laptop is unreachable (VPN down) it appends to an outbox file and
drains it later, so no data is lost and the demo can backfill.

Two clocks: samplers report `node_ts` (gpu01/gpu02 run ~12 min behind mgmt01),
the collector stamps `ingest_ts` from its own clock. Downstream uses ingest_ts
for charting and keeps node_ts for debugging. See CLOCK_SKEW_NOTE below.

Python 3.9, stdlib only.

Usage:
    python3 collector.py --post http://10.22.0.194:3000/api/ingest/cluster
    python3 collector.py --once --print
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
CLOCK_SKEW_NOTE = (
    "gpu01/gpu02 clocks run ~12min behind mgmt01 (measured 2026-11-20). "
    "node_ts is sampler time; ingest_ts is authoritative for charting."
)
OUTBOX_MAX_BYTES = 50 * 1024 * 1024


def now_iso():
    return datetime.now(IST).isoformat(timespec="seconds")


def run(cmd, timeout=25):
    try:
        res = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        if res.returncode != 0 and not res.stdout:
            return ""
        return res.stdout
    except Exception:
        return ""


def parse_pbsnodes(text):
    """Parse `pbsnodes -av` into [{node, state, available{...}, assigned{...}}]."""
    nodes = []
    current = None
    for raw in text.splitlines():
        if not raw.strip():
            if current:
                nodes.append(current)
                current = None
            continue
        if not raw[0].isspace():
            if current:
                nodes.append(current)
            current = {"node": raw.strip(), "attrs": {}}
            continue
        if current is None or "=" not in raw:
            continue
        key, _, value = raw.partition("=")
        current["attrs"][key.strip()] = value.strip()
    if current:
        nodes.append(current)

    out = []
    for item in nodes:
        a = item["attrs"]
        out.append(
            {
                "node": item["node"],
                "state": a.get("state") or a.get("resources_available.state"),
                "available": {
                    "ncpus": num(a.get("resources_available.ncpus")),
                    "mem_kb": num(
                        a.get("resources_available.mem")
                        or a.get("resources_available.mem_kb")
                    ),
                    "ngpus": num(a.get("resources_available.ngpus")),
                },
                "assigned": {
                    "ncpus": num(a.get("resources_assigned.ncpus")),
                    "mem_kb": num(
                        a.get("resources_assigned.mem")
                        or a.get("resources_assigned.mem_kb")
                    ),
                    "ngpus": num(a.get("resources_assigned.ngpus")),
                },
                "pcpus": num(a.get("pcpus")),
                "jobs": len(
                    [j for j in (a.get("jobs") or "").split(",") if j.strip()]
                ),
            }
        )
    return out


def parse_qstat(text):
    """Parse `qstat -f` into a list of job dicts."""
    jobs = []
    current = None
    for raw in text.splitlines():
        if raw.startswith("Job Id:"):
            if current:
                jobs.append(current)
            current = {"id": raw.split(":", 1)[1].strip(), "attrs": {}}
            continue
        if current is None or "=" not in raw:
            continue
        key, _, value = raw.partition("=")
        current["attrs"][key.strip()] = value.strip()
    if current:
        jobs.append(current)

    out = []
    for item in jobs:
        a = item["attrs"]
        owner = (a.get("Job_Owner") or "").split("@")[0]
        out.append(
            {
                "id": item["id"].split(".")[0],
                "name": a.get("Job_Name"),
                "owner": owner,
                "queue": a.get("queue"),
                "state": a.get("job_state"),
                "ncpus": num(a.get("Resource_List.ncpus")),
                "ngpus": num(a.get("Resource_List.ngpus")),
                "mem": a.get("Resource_List.mem"),
                "walltime_limit": a.get("Resource_List.walltime"),
                "walltime_used": a.get("resources_used.walltime"),
                "exec_host": a.get("exec_host"),
                "submit_time": a.get("ctime"),
                "start_time": a.get("stime"),
            }
        )
    return out


def num(value):
    """PBS writes numbers with suffixes (1056047776kb, 4gb) — take the numeric head."""
    if value is None:
        return None
    match = re.match(r"\s*(-?\d+(?:\.\d+)?)", str(value))
    if not match:
        return None
    number = float(match.group(1))
    suffix = str(value).strip().lower()[len(match.group(1)) :]
    if suffix.startswith("gb"):
        number *= 1024
    elif suffix.startswith("mb"):
        number /= 1024
    return int(number)


def read_node_file(monitor_dir, node):
    path = os.path.join(monitor_dir, "latest-%s.json" % node)
    try:
        with open(path, "r") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def build_snapshot(monitor_dir, pbs_cache):
    nodes = {}
    for node_name in ("gpu01", "gpu02"):
        sample = read_node_file(monitor_dir, node_name)
        if sample:
            nodes[node_name] = sample

    jobs = pbs_cache.get("jobs", [])
    pbs_nodes = {n["node"]: n for n in pbs_cache.get("nodes", [])}

    queues = {}
    for job in jobs:
        q = job.get("queue") or "unknown"
        entry = queues.setdefault(q, {"running": 0, "queued": 0, "held": 0})
        state = job.get("state")
        if state == "R":
            entry["running"] += 1
        elif state == "Q":
            entry["queued"] += 1
        elif state == "H":
            entry["held"] += 1

    totals = {"gpus": 0, "gpus_alloc": 0, "cores": 0, "cores_alloc": 0, "mem_kb": 0, "mem_alloc_kb": 0}
    for item in pbs_nodes.values():
        avail, assigned = item.get("available", {}), item.get("assigned", {})
        totals["gpus"] += avail.get("ngpus") or 0
        totals["gpus_alloc"] += assigned.get("ngpus") or 0
        totals["cores"] += avail.get("ncpus") or 0
        totals["cores_alloc"] += assigned.get("ncpus") or 0
        totals["mem_kb"] += avail.get("mem_kb") or 0
        totals["mem_alloc_kb"] += assigned.get("mem_kb") or 0

    return {
        "schema": 1,
        "type": "cluster_snapshot",
        "ingest_ts": now_iso(),
        "pbs_refreshed_s_ago": round(time.time() - pbs_cache.get("at", time.time()), 1),
        "clock_note": CLOCK_SKEW_NOTE,
        "totals": totals,
        "queues": queues,
        "nodes": [nodes.get("gpu01"), nodes.get("gpu02")],
        "pbs_nodes": list(pbs_nodes.values()),
        "jobs": jobs,
    }


def post(url, payload, timeout=3):
    import urllib.error
    import urllib.request

    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status < 400
    except (urllib.error.URLError, OSError, ValueError):
        return False


def enqueue(outbox, payload):
    try:
        size = os.path.getsize(outbox)
    except OSError:
        size = 0
    if size > OUTBOX_MAX_BYTES:
        return  # drop rather than fill the quota; the dashboard is live-first
    with open(outbox, "a") as fh:
        fh.write(json.dumps(payload) + "\n")


def drain(outbox, url):
    if not os.path.exists(outbox):
        return 0
    sent = 0
    with open(outbox, "r") as fh:
        lines = fh.readlines()
    remaining = []
    for line in lines:
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if post(url, payload):
            sent += 1
        else:
            remaining.append(line)
    with open(outbox, "w") as fh:
        fh.writelines(remaining)
    return sent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=float, default=1.0, help="snapshot cadence")
    ap.add_argument("--pbs-interval", type=float, default=5.0, help="qstat/pbsnodes cadence")
    ap.add_argument("--home", default=os.environ.get("HOME", "."))
    ap.add_argument("--post", default=os.environ.get("CLUSTER_PULSE_POST", ""))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--print", dest="print_only", action="store_true")
    args = ap.parse_args()

    monitor_dir = os.path.join(args.home, "monitor")
    os.makedirs(monitor_dir, exist_ok=True)
    snapshot_path = os.path.join(monitor_dir, "latest-snapshot.json")
    outbox = os.path.join(monitor_dir, "outbox.jsonl")

    pbs_cache = {"at": 0, "jobs": [], "nodes": []}
    print(
        "collector starting interval=%ss pbs_interval=%ss post=%s"
        % (args.interval, args.pbs_interval, args.post or "(none)"),
        flush=True,
    )

    while True:
        tick_start = time.time()
        try:
            if tick_start - pbs_cache["at"] >= args.pbs_interval:
                pbs_cache = {
                    "at": time.time(),
                    "jobs": parse_qstat(run("qstat -f")),
                    "nodes": parse_pbsnodes(run("pbsnodes -av")),
                }

            snapshot = build_snapshot(monitor_dir, pbs_cache)
            blob = json.dumps(snapshot)

            with open(snapshot_path + ".tmp", "w") as fh:
                fh.write(blob)
            os.replace(snapshot_path + ".tmp", snapshot_path)

            if args.print_only:
                print(blob[:800])
                return
            if args.post:
                if post(args.post, snapshot):
                    sent = drain(outbox, args.post)
                    if sent:
                        print("backfilled %d buffered snapshots" % sent, flush=True)
                else:
                    enqueue(outbox, snapshot)
                    print("POST failed — buffered to outbox", flush=True)

            if args.once:
                return
        except Exception as exc:
            print("collector tick error: %r" % (exc,), file=sys.stderr, flush=True)

        time.sleep(max(args.interval - (time.time() - tick_start), 0.05))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("collector stopped", flush=True)
CP_COLLECTOR_EOF

chmod +x ~/monitor/sampler.py ~/monitor/collector.py
ls -l ~/monitor/
python3 -c "import ast; [ast.parse(open(f).read()) for f in ['$HOME/monitor/sampler.py','$HOME/monitor/collector.py']]; print('syntax OK')"

════════ STEP 2 — reachability test BEFORE submitting anything ════════
The laptop API will listen on the VPN address below. Nothing has proven a compute node can reach the laptop, so test it first with a throwaway job. Do NOT skip this.

LAPTOP_IP=10.22.0.194

cat > ~/monitor/reach.pbs <<'CP_REACH_EOF'
#PBS -N cp_reach
#PBS -q gpu
#PBS -l select=1:ncpus=1:mem=1gb
#PBS -l walltime=00:02:00
#PBS -j oe
echo "NODE=$(hostname)"
curl -s -m 5 -o /dev/null -w "health_http=%{http_code}\n" http://10.22.0.194:3000/health || echo "curl failed rc=$?"
echo "default_route=$(ip route | head -2)"
CP_REACH_EOF

qsub ~/monitor/reach.pbs
sleep 45
qstat -u $USER
ls -t ~/cp_reach.o* 2>/dev/null | head -1 | xargs cat 2>/dev/null

An HTTP 200 means the fast lane will work. "000", a timeout, or a reset means the laptop is not reachable from compute nodes — report that and continue with the file-only path; do not fake it.

════════ STEP 3 — start the samplers ════════
`-q gpu` is REQUIRED: the default queue is workq and a GPU request still lands there without it.

qsub -q gpu -v NODE_HOST=gpu01,CLUSTER_PULSE_POST=http://10.22.0.194:3000/api/ingest/node ~/monitor/sampler.pbs
sleep 20
qstat -u $USER
qstat -f $(qstat -u $USER | awk '/cp_sampler/ {print $1; exit}') | grep -E "exec_host|queue|job_state"
ls -l ~/monitor/
head -c 800 ~/monitor/latest-gpu01.json 2>/dev/null || echo "no latest-gpu01.json yet"

If exec_host is not gpu01, stop and report it — try `-l select=1:ncpus=1:ngpus=1:host=gpu01` instead of -v NODE_HOST, and tell me which form worked.
Once gpu01 is sampling and you've told me, submit the identical job for gpu02.

════════ STEP 4 — collector, one shot first ════════
python3 ~/monitor/collector.py --once --print

Expect totals: gpus 16, cores 208, RAM ≈ 2 TB, and a job list. Paste it.

════════ STEP 5 — REPORT (raw, nothing summarised) ════════
  a) ls -l ~/monitor/
  b) qstat -u $USER
  c) the reach.pbs job output (health_http value + NODE)
  d) exec_host for each sampler job
  e) head -c 800 ~/monitor/latest-<node>.json
  f) the --once --print output

Then STOP. Do not start the collector in a loop and do not touch crontab — I'll give you those commands once I've seen the output.

RULES
- No `#PBS -o <path>` — on this PBS a job exited 0 and its output file never appeared. Default naming works.
- No `module load` — the module system is broken; PBS lives in /opt/pbs/bin and is already on PATH.
- CUDA_VISIBLE_DEVICES being empty is expected: PBS does not isolate GPUs here. Never "fix" it.
- If the connection drops mid-step, re-run the same step; do not invent output.
