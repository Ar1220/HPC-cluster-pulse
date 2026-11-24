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
import threading
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
    """Run a command, return stdout stripped. Never raise, never block.

    subprocess.run(timeout=...) is not enough here: when the child is stuck in
    uninterruptible I/O - which is exactly what a wedged nvidia-smi looks like on
    a node whose GPUs are saturated - the kill cannot be reaped and the call
    hangs forever, freezing the whole sampling loop. Running it on a daemon
    thread means the caller always gets control back after `timeout` seconds and
    abandons the stuck child instead of waiting on it.
    """
    box = {}

    def _work():
        try:
            box["out"] = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, timeout=timeout
            ).stdout or ""
        except Exception:
            box["out"] = ""

    worker = threading.Thread(target=_work, daemon=True)
    worker.start()
    worker.join(timeout + 2)
    return (box.get("out") or "").strip()


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


_prev_cpu = {"idle": 0, "total": 0}


def read_cpu_used_pct():
    """Real CPU utilisation from /proc/stat deltas.

    PBS only reports cores ALLOCATED, which barely moves; this is what the CPU is
    actually doing, so the dashboard's CPU line has a pulse.
    """
    line = ""
    for candidate in read_file("/proc/stat").splitlines():
        if candidate.startswith("cpu "):
            line = candidate
            break
    if not line:
        return None
    fields = [int(x) for x in line.split()[1:]]
    if len(fields) < 4:
        return None
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
    total = sum(fields)
    prev_idle, prev_total = _prev_cpu["idle"], _prev_cpu["total"]
    _prev_cpu["idle"], _prev_cpu["total"] = idle, total
    if prev_total and total > prev_total:
        d_total = total - prev_total
        d_idle = idle - prev_idle
        return round(max(0.0, min(100.0, (1 - d_idle / d_total) * 100)), 1)
    return None


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
        "cpu": {"logical": os.cpu_count(), "used_pct": read_cpu_used_pct()},
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
    gpu_blind = 0
    while True:
        started = time.time()
        try:
            sample = build_sample(args.node)

            # A wedged nvidia-smi must not look like a healthy sampler: count how
            # long the GPU query has been silent, say so in the log, and if it never
            # recovers, exit so the watchdog starts a fresh job instead of leaving a
            # zombie that reports R forever.
            if sample["gpus"]:
                if gpu_blind >= 30:
                    print("gpu query recovered after %d blind ticks" % gpu_blind, flush=True)
                gpu_blind = 0
            else:
                gpu_blind += 1
                if gpu_blind % 30 == 0:
                    print("gpu query blind for %ds (nvidia-smi not answering)" % gpu_blind, flush=True)
                if gpu_blind >= 300:
                    print("exiting: nvidia-smi unresponsive for 300s; watchdog will replace this job", flush=True)
                    sys.exit(1)
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
