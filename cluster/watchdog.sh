#!/bin/bash
# Cluster Pulse progress watchdog.
#
# Do NOT judge health by file mtime age: the GPU nodes' clocks run about 11
# minutes behind mgmt01, so a perfectly healthy latest-<node>.json always looks
# ~11 minutes old from here. Judging by age would kill healthy samplers forever.
#
# What is skew-proof: whether the file is still being *rewritten*. Track the
# mtime we last saw; if it has not changed for STUCK seconds of local time, the
# sampler really has stopped, and only then kill and requeue it.
#
# Usage: watchdog.sh gpu01|gpu02      (cron: every 2 minutes)
MON="$HOME/monitor"
PBS=/opt/pbs/bin
node="${1:?usage: $0 gpu01|gpu02}"
file="$MON/latest-$node.json"
state="$MON/.watch-$node"
STUCK=180

[ -f "$file" ] || exit 0
cur=$(stat -c %Y "$file")
now=$(date +%s)

if [ -f "$state" ]; then
  read -r prev prev_ts < "$state" 2>/dev/null || { prev=""; prev_ts=0; }
else
  prev=""; prev_ts=0
fi

# File changed since last check - record the new mtime and local time, done.
if [ "$cur" != "$prev" ] || [ "$prev_ts" = 0 ]; then
  echo "$cur $now" > "$state"
  exit 0
fi

idle=$(( now - prev_ts ))
[ "$idle" -lt "$STUCK" ] && exit 0

jid=$($PBS/qstat -f 2>/dev/null | awk -v pat="Job_Name = cp_sampler_$node" \
      '/^[0-9]+\./ {id=$1} $0 ~ pat {print id; exit}')

echo "$(date '+%F %T') watchdog: latest-$node.json unchanged for ${idle}s${jid:+, killing $jid}"
[ -n "$jid" ] && $PBS/qdel "$jid" >/dev/null 2>&1
sleep 2
$PBS/qsub -N "cp_sampler_$node" -q gpu -l select=1:ncpus=1:mem=1gb:host="$node" "$MON/sampler.pbs"
echo "$cur $now" > "$state"
