#!/bin/bash
# Measures how many new HTTPS connections succeed to each upstream (for the dorm-network
# congestion question). Appends one CSV row per host to data/netprobe.csv:
#   iso_time,host,ok,tries,avg_ms
# Run every 10 minutes by the ykmaps-netprobe systemd timer.
cd "$(dirname "$0")/.." || exit 1
OUT=data/netprobe.csv
TRIES=6
[ -f "$OUT" ] || echo "time,host,ok,tries,avg_ms" > "$OUT"
NOW=$(date -Iseconds)
for host in iett.istanbul nasilgiderim.iett.gov.tr photon.komoot.io api.ibb.gov.tr github.com www.google.com; do
  ok=0; total_ms=0
  for _ in $(seq 1 $TRIES); do
    # --no-keepalive + a fresh process each time = a brand-new TCP/TLS connection
    t=$(curl -s -o /dev/null -m 8 -w '%{http_code} %{time_total}' "https://$host/" 2>/dev/null)
    code=${t%% *}; secs=${t##* }
    if [ "$code" != "000" ] && [ -n "$code" ]; then
      ok=$((ok + 1))
      total_ms=$((total_ms + $(awk -v s="$secs" 'BEGIN{printf "%d", s*1000}')))
    fi
    sleep 0.3
  done
  avg=0; [ $ok -gt 0 ] && avg=$((total_ms / ok))
  echo "$NOW,$host,$ok,$TRIES,$avg" >> "$OUT"
done
