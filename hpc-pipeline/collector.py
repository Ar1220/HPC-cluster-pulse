#!/usr/bin/env python3
"""Cluster Pulse — login-node collector (ETL).

Runs on mgmt01. Three sources, two cadences:

  1. $HOME/monitor/latest-<node>.json   written every 1s by the sampler job
                                        (real per-GPU utilisation, load, memory)
  2. qstat -f                          scheduler jobs        — every 5s
  3. pbsnodes -av                      node capacity/state   — every 5s

It merges them into one `cluster_snapshot` message and POSTs it to the laptop
API. If the laptop is unreachable it buffers into a BOUNDED ring buffer
(outbox.jsonl) and drains it later.

Payload slimming (v1 sent ~9.4 KB/s and filled a 50 MB buffer in 90 minutes):
  * the job list is re-sent only when it changes; "jobs": null means unchanged
    and downstream must keep the previous list
  * apps[] (GPU memory owners) goes out every --apps-interval seconds only
  * floats are rounded before serialising

Outbox behaviour: past --outbox-mb the OLDEST half is dropped and a
{"type":"gap"} marker is written, so a long outage degrades visibly instead of
silently. Backfill is bounded by size, not by an unstated promise.

Two clocks: samplers report `node_ts` (gpu01/gpu02 run ~11 min behind mgmt01),
the collector stamps `ingest_ts` from its own clock. Downstream charts on
ingest_ts and keeps node_ts for debugging.

Python 3.9, stdlib only.

The POST target can also live in a file (~/monitor/post_url.txt) which is
re-read every 30 s — the laptop's VPN address changed once during development,
and this avoids restarting the collector when it changes again.

Usage:
    python3 collector.py --post http://10.22.0.98:3000/api/ingest/cluster
    python3 collector.py --once --print
"""

import argparse
import threading
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

# The live tick and the backfill worker both touch the outbox file, so every
# read/append/rewrite of it must hold this lock.
OUTBOX_LOCK = threading.Lock()

IST = timezone(timedelta(hours=5, minutes=30))
CLOCK_SKEW_NOTE = (
    "gpu01/gpu02 clocks run ~12min behind mgmt01 (measured 2026-11-20). "
    "node_ts is sampler time; ingest_ts is authoritative for charting."
)
DEFAULT_OUTBOX_MB = 50
# PBS is not always on PATH (the interactive shell on this login node omits
# /opt/pbs/bin, and cron's PATH is even narrower). Never rely on PATH lookup:
# resolve the binaries explicitly, fall back to the bare name only if absent.
PBS_BIN = os.environ.get("PBS_BIN", "/opt/pbs/bin")


def now_iso():
    return datetime.now(IST).isoformat(timespec="seconds")


# --- timestamped logging ---------------------------------------------------
# Every diagnostic line used to be bare text with no time on it, which made
# "how long was the POST failing" unanswerable after the fact. Wrap print once
# here so every line in collector.log starts with a wall-clock timestamp.
import builtins as _builtins
import time as _time

if not getattr(_builtins.print, "_cp_stamped", False):
    _real_print = _builtins.print

    def _stamped_print(*args, **kwargs):
        kwargs.setdefault("flush", True)
        _real_print(_time.strftime("%Y-%m-%d %H:%M:%S"), *args, **kwargs)

    _stamped_print._cp_stamped = True
    _builtins.print = _stamped_print
# ---------------------------------------------------------------------------


def pbs_cmd(name):
    """Absolute path to a PBS binary, so PATH can never break the collector."""
    candidate = os.path.join(PBS_BIN, name)
    return candidate if os.path.exists(candidate) else name


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
                # Actual consumption, not the request. PBS reports these per job,
                # so "job stress" is real data: cpupercent can exceed 100 on a
                # multithreaded job, mem comes in kb.
                "cpupercent": num(a.get("resources_used.cpupercent")),
                "mem_used_kb": num(a.get("resources_used.mem")),
                "vmem_used_kb": num(a.get("resources_used.vmem")),
                "cput": a.get("resources_used.cput"),
                "ncpus_used": num(a.get("resources_used.ncpus")),
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


def slim_sample(sample, include_apps):
    """Copy a node sample, dropping the large slow-changing apps[] list."""
    out = dict(sample)
    if include_apps:
        out["apps_omitted"] = False
    else:
        out["apps"] = []
        out["apps_omitted"] = True
    gpus = []
    for gpu in sample.get("gpus") or []:
        item = dict(gpu)
        if isinstance(item.get("power_w"), float):
            item["power_w"] = round(item["power_w"], 1)
        gpus.append(item)
    out["gpus"] = gpus
    load = sample.get("loadavg")
    if isinstance(load, list):
        out["loadavg"] = [round(v, 2) if isinstance(v, float) else v for v in load]
    return out


def jobs_signature(jobs):
    """Hash of the fields that matter, so an unchanged poll costs nothing."""
    trimmed = [
        [
            j.get("id"), j.get("state"), j.get("queue"), j.get("walltime_used"),
            j.get("exec_host"), j.get("owner"), j.get("ncpus"), j.get("ngpus"),
        ]
        for j in jobs
    ]
    trimmed.sort()
    return hashlib.sha1(json.dumps(trimmed).encode()).hexdigest()


def build_snapshot(monitor_dir, pbs_cache, include_apps=True, last_jobs_sig=None,
                   last_usage=None):
    samples = []
    for node_name in ("gpu01", "gpu02"):
        sample = read_node_file(monitor_dir, node_name)
        samples.append(slim_sample(sample, include_apps) if sample else None)

    jobs = pbs_cache.get("jobs", [])
    pbs_nodes = {n["node"]: n for n in pbs_cache.get("nodes", [])}

    signature = jobs_signature(jobs)
    jobs_payload = jobs if signature != last_jobs_sig else None

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

    # Live consumption per job. Kept out of the job list (which is 61% of a
    # payload) and sent as compact deltas: [[id, cpupercent, mem_kb], ...] for
    # jobs whose numbers moved, plus a full set whenever the job list is sent.
    # A quiet cluster costs zero bytes; a busy one ~30 bytes/job.
    job_usage = [
        [j.get("id"), j.get("cpupercent"), j.get("mem_used_kb")]
        for j in jobs
        if j.get("state") == "R"
    ]

    snapshot = {
        "schema": 1,
        "type": "cluster_snapshot",
        "ingest_ts": now_iso(),
        "pbs_refreshed_s_ago": round(time.time() - pbs_cache.get("at", time.time()), 1),
        "clock_note": CLOCK_SKEW_NOTE,
        "totals": totals,
        "queues": queues,
        "nodes": samples,
        "pbs_nodes": list(pbs_nodes.values()),
        "jobs": jobs_payload,
        "jobs_state": "unchanged" if jobs_payload is None else "full",
        "job_usage": (
            job_usage if jobs_payload is not None
            else [row for row in job_usage if last_usage is None or last_usage.get(row[0]) != row[1:]]
        ),
        "usage_full": jobs_payload is not None,
    }
    return snapshot, signature


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


def trim_outbox(outbox, keep_ratio=0.5):
    """Keep the newest half, drop the oldest, and record the gap."""
    try:
        with open(outbox, "r") as fh:
            lines = fh.readlines()
    except OSError:
        return 0
    keep = lines[int(len(lines) * (1 - keep_ratio)):]
    dropped = len(lines) - len(keep)
    marker = json.dumps({"type": "gap", "dropped_snapshots": dropped, "at": now_iso()})
    with open(outbox, "w") as fh:
        fh.write(marker + "\n")
        fh.writelines(keep)
    return len(keep)


def enqueue(outbox, payload, max_bytes):
    try:
        size = os.path.getsize(outbox)
    except OSError:
        size = 0
    if size > max_bytes:
        kept = trim_outbox(outbox)
        limit = ("%dMB" % (max_bytes // (1024 * 1024))) if max_bytes >= 1024 * 1024 \
            else ("%dKB" % (max_bytes // 1024))
        print(
            "outbox exceeded %s — kept newest %d snapshots, gap marker written"
            % (limit, kept),
            flush=True,
        )
    with OUTBOX_LOCK:
        with open(outbox, "a") as fh:
            fh.write(json.dumps(payload) + "\n")


def drain(outbox, url, max_items=20, budget_s=2.0):
    """Locked wrapper - see _drain."""
    with OUTBOX_LOCK:
        return _drain(outbox, url, max_items, budget_s)


def _drain(outbox, url, max_items=20, budget_s=2.0):
    """Backfill a bounded slice of the outbox.

    Draining everything in one tick blocked the loop: after a long outage the
    buffer held 800+ snapshots, each POST can take up to its timeout, and during
    that time no fresh snapshot was written and no log line appeared (observed as
    the collector sitting in poll for ~30s). Cap both count and wall-clock.
    """
    if not os.path.exists(outbox):
        return 0
    started = time.time()
    sent = 0
    attempted = 0
    with open(outbox, "r") as fh:
        lines = fh.readlines()
    remaining = []
    for index, line in enumerate(lines):
        if attempted >= max_items or (time.time() - started) >= budget_s:
            remaining.extend(lines[index:])  # keep the rest for the next tick
            break
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        if payload.get("type") == "gap":
            continue  # marker has served its purpose once we are draining
        attempted += 1
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
    ap.add_argument("--apps-interval", type=float, default=15.0,
                    help="how often to include the GPU process list")
    ap.add_argument("--jobs-refresh", type=float, default=60.0,
                    help="force a full job list at least this often")
    ap.add_argument("--outbox-mb", type=int, default=DEFAULT_OUTBOX_MB)
    ap.add_argument("--home", default=os.environ.get("HOME", "."))
    ap.add_argument("--post", default=os.environ.get("CLUSTER_PULSE_POST", ""))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--print", dest="print_only", action="store_true")
    args = ap.parse_args()

    monitor_dir = os.path.join(args.home, "monitor")
    os.makedirs(monitor_dir, exist_ok=True)
    snapshot_path = os.path.join(monitor_dir, "latest-snapshot.json")
    outbox = os.path.join(monitor_dir, "outbox.jsonl")
    max_bytes = args.outbox_mb * 1024 * 1024

    # Backfill used to run inline in the tick. Each tick then waited on 4-6
    # POST round-trips, so the live snapshot advanced once per ~2.5 s (0.4 Hz)
    # instead of 1 Hz for as long as a backlog existed - the dashboard looked
    # like it refreshed every 3 s. Draining belongs on its own thread, at its
    # own pace; the live tick must never wait for it.
    def backfill_worker():
        last_report = 0.0
        while True:
            try:
                sent = drain(outbox, args.post)
            except Exception as exc:
                print("backfill error: %r" % (exc,), file=sys.stderr, flush=True)
                sent = 0
            now = time.time()
            if sent and now - last_report >= 5.0:
                print("backfilled %d buffered snapshots" % sent, flush=True)
                last_report = now
            # fast while it is working, gentle while the laptop is unreachable
            time.sleep(0.25 if sent else 2.0)

    if args.post and not args.once:
        threading.Thread(target=backfill_worker, daemon=True).start()
    post_file = os.path.join(monitor_dir, "post_url.txt")
    pbs_cache = {"at": 0, "jobs": [], "nodes": []}
    last_jobs_sig = None
    last_jobs_at = 0.0
    last_usage = {}
    last_apps_at = 0.0
    last_post_ok = None
    last_url_check = 0.0
    print(
        "collector starting interval=%ss pbs=%ss apps=%ss outbox=%dMB post=%s"
        % (args.interval, args.pbs_interval, args.apps_interval,
           args.outbox_mb, args.post or "(none)"),
        flush=True,
    )

    while True:
        tick_start = time.time()
        try:
            # The laptop's VPN address can change; re-read it from the file.
            if tick_start - last_url_check >= 5:
                last_url_check = tick_start
                try:
                    with open(post_file, "r") as fh:
                        file_url = fh.read().strip()
                    if file_url and file_url != args.post:
                        print("post target changed: %s -> %s" % (args.post, file_url), flush=True)
                        args.post = file_url
                        last_post_ok = None
                except OSError:
                    pass

            if tick_start - pbs_cache["at"] >= args.pbs_interval:
                pbs_cache = {
                    "at": time.time(),
                    "jobs": parse_qstat(run("%s -f" % pbs_cmd("qstat"))),
                    "nodes": parse_pbsnodes(run("%s -av" % pbs_cmd("pbsnodes"))),
                }

            include_apps = (tick_start - last_apps_at) >= args.apps_interval
            force_jobs = (tick_start - last_jobs_at) >= args.jobs_refresh
            snapshot, signature = build_snapshot(
                monitor_dir, pbs_cache,
                include_apps=include_apps,
                last_jobs_sig=None if force_jobs else last_jobs_sig,
                last_usage=last_usage,
            )
            if include_apps:
                last_apps_at = tick_start
            if snapshot.get("jobs") is not None:
                last_jobs_at = tick_start
            for row in snapshot.get("job_usage") or []:
                last_usage[row[0]] = row[1:]
            last_jobs_sig = signature

            blob = json.dumps(snapshot)

            with open(snapshot_path + ".tmp", "w") as fh:
                fh.write(blob)
            os.replace(snapshot_path + ".tmp", snapshot_path)

            if args.print_only:
                print(blob)
                return
            if args.post:
                # Only the live snapshot is posted from this loop. Backfill runs
                # on its own thread, so a drain can never delay the 1 Hz tick.
                if post(args.post, snapshot):
                    if last_post_ok is not True:
                        print("POST ok — connection established", flush=True)
                    last_post_ok = True
                else:
                    if last_post_ok is not False:
                        print("POST failed — buffering to outbox", flush=True)
                    last_post_ok = False
                    enqueue(outbox, snapshot, max_bytes)

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
