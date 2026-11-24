#!/bin/bash
# Cluster Pulse - HPC side control
PBS=/opt/pbs/bin
MON=$HOME/monitor
URL=$(cat $MON/post_url.txt 2>/dev/null)
HEALTH=$(echo "$URL" | sed 's#/api/ingest/cluster#/health#')
OK()  { printf "  \033[32m*\033[0m %-22s %s\n" "$1" "$2"; }
BAD() { printf "  \033[31m- \033[0m %-22s %s\n" "$1" "$2"; }

status() {
  echo; echo "CLUSTER PULSE - HPC side"; echo
  n=$(pgrep -cf "^python3 collector.py")
  [ "$n" = "1" ] && OK "collector" "running (1 instance)" || BAD "collector" "instances=$n"
  for node in gpu01 gpu02; do
    if $PBS/qstat -f | grep -q "Job_Name = cp_sampler_$node"; then OK "sampler $node" "R"; else BAD "sampler $node" "not running"; fi
  done
  if [ -f $MON/latest-snapshot.json ]; then
    age=$(( $(date +%s) - $(stat -c %Y $MON/latest-snapshot.json) ))
    [ $age -lt 10 ] && OK "snapshot" "${age}s old" || BAD "snapshot" "${age}s old (stale)"
  else BAD "snapshot" "missing"; fi
  ob=$(stat -c %s $MON/outbox.jsonl 2>/dev/null || echo 0)
  [ "$ob" -eq 0 ] && OK "outbox" "empty" || BAD "outbox" "$ob bytes buffered"
  code=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$HEALTH" 2>/dev/null)
  [ "$code" = "200" ] && OK "laptop API" "200" || BAD "laptop API" "http=$code"
  echo
}

start() {
  pgrep -f "^python3 collector.py" >/dev/null || bash $MON/start_collector.sh
  for node in gpu01 gpu02; do
    $PBS/qstat -f | grep -q "Job_Name = cp_sampler_$node" || \
      $PBS/qsub -N cp_sampler_$node -q gpu -l select=1:ncpus=1:mem=1gb:host=$node $MON/sampler.pbs
  done
  sleep 6; status
}

stop() {
  pkill -f "^python3 collector.py" 2>/dev/null
  for j in $($PBS/qstat -u $USER | awk '/cp_sample/ {print $1}'); do $PBS/qdel $j >/dev/null 2>&1; done
  sleep 2; status
}

watch() {
  echo "watch mode - Ctrl+C to stop"
  while true; do
    stamp=$(date +%H:%M:%S)
    if ! pgrep -f "^python3 collector.py" >/dev/null; then
      echo "[$stamp] collector down - starting"; bash "$MON/start_collector.sh"
    fi
    for node in gpu01 gpu02; do
      # Two consecutive misses before resubmitting: one failed qstat call would
      # otherwise queue a duplicate sampler next to the one already running.
      missing=0
      $PBS/qstat -f 2>/dev/null | grep -q "Job_Name = cp_sampler_$node" || missing=1
      if [ "$missing" = 1 ]; then sleep 8; fi
      if [ "$missing" = 1 ] && ! $PBS/qstat -f 2>/dev/null | grep -q "Job_Name = cp_sampler_$node"; then
        echo "[$stamp] sampler $node missing twice - resubmitting"
        $PBS/qsub -N cp_sampler_$node -q gpu -l select=1:ncpus=1:mem=1gb:host=$node "$MON/sampler.pbs"
      fi
    done
    ob=$(stat -c %s "$MON/outbox.jsonl" 2>/dev/null || echo 0)
    echo "[$stamp] collector=up samplers=$( $PBS/qstat -u $USER | grep -c cp_sample ) outbox=${ob}B"
    sleep 20
  done
}

menu() {
  while true; do
    clear 2>/dev/null
    echo
    echo "  ================================================"
    echo "            CLUSTER PULSE  -  HPC CONTROL"
    echo "  ================================================"
    echo
    echo "    1)  status    - collector, samplers, snapshot, outbox, laptop API"
    echo "    2)  start     - start collector + missing samplers"
    echo "    3)  stop      - stop collector and queue-delete the samplers"
    echo "    4)  restart   - stop, wait 3 s, start"
    echo "    5)  logs      - last 20 lines of collector.log"
    echo "    6)  exit"
    echo "    7)  watch     - self-healing loop (Ctrl+C to stop)"
    echo
    read -rp "  choose: " choice
    case "$choice" in
      1) status ;;
      2) start ;;
      3) stop ;;
      4) stop; sleep 3; start ;;
      5) echo "--- ~/monitor/collector.log (last 20) ---"; tail -20 "$MON/collector.log" ;;
      6) return ;;
      7) watch ;;
      *) echo "  not an option" ;;
    esac
    echo
    read -rp "  press Enter to go back to the menu" _
  done
}

case "${1:-menu}" in
  status)  status  ;;
  start)   start   ;;
  stop)    stop    ;;
  restart) stop; sleep 3; start ;;
  logs)    tail -20 "$MON/collector.log" ;;
  watch)   watch   ;;
  menu|"") menu    ;;
  *)       echo "usage: $0 [status|start|stop|restart|logs|watch|menu]"; menu ;;
esac
