#!/usr/bin/env bash
# Sequential recovery (concurrency 1) — avoids the 300s timeouts and 429s
# that the 3-concurrent run hit.
#   Phase A: re-sync the 11 failed clients, one at a time.
#   Phase B: tag-backfill tier 1 for ALL clients (Google -> google/segs split).
set -u
S=outboundhero2024
BASE=https://replies-custom-code-project.vercel.app
OUT=/tmp/panel_results.txt
: > "$OUT"

# Clients whose Phase-1 sync failed (timeout or 429) — need a clean re-sync.
RESYNC=(SBCC JPWM JPNNJ BAJFI RFS JPET JPETC JPK CCGSWI JPPH ESJ)
# All clients with data — get the tag backfill (JPG excluded: 0 leads).
ALL=(SBCC JPWM "JPC%26A" JPH JPNNJ JPNW BAJFI RFS GJEC TGS MS JPNH JPET JPETC ICCCS JPTUC JPKC JPK CCGSWI JPPH ESJ)

echo "cooling down 60s before recovery..." | tee -a "$OUT"
sleep 60

echo "=== Phase A: RE-SYNCS (sequential, pages=2000) ===" | tee -a "$OUT"
for tag in "${RESYNC[@]}"; do
  r=$(curl -s --max-time 298 "$BASE/api/cron/nurture-sync-client/$tag?secret=$S&pages=2000")
  echo "RESYNC $tag: $r" | tee -a "$OUT"
  sleep 8
done
echo "=== Phase A DONE ===" | tee -a "$OUT"

echo "=== Phase B: BACKFILL tier 1 (sequential) ===" | tee -a "$OUT"
for tag in "${ALL[@]}"; do
  g=0; o=0; sg=0; fl=0
  for n in $(seq 1 20); do
    r=$(curl -s --max-time 298 "$BASE/api/cron/backfill-esp-from-bison?secret=$S&tier=1&client=$tag")
    read -r F J BG BO BS < <(echo "$r" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except: print('0 0 0 0 0'); sys.exit()
b=d.get('bucketTally',{}) or {}
print(d.get('filled',0), d.get('jobs',0), b.get('google',0), b.get('outlook',0), b.get('segs',0))
" 2>/dev/null)
    F=${F:-0}; J=${J:-0}; BG=${BG:-0}; BO=${BO:-0}; BS=${BS:-0}
    fl=$((fl+F)); g=$((g+BG)); o=$((o+BO)); sg=$((sg+BS))
    [ "$F" = "0" ] && [ "$BS" = "0" ] && [ "$BO" = "0" ] && [ "$BG" = "0" ] && break
    [ "$J" != "400" ] && break
    sleep 2
  done
  echo "BACKFILL $tag: filled=$fl  google=$g outlook=$o segs=$sg" | tee -a "$OUT"
  sleep 3
done
echo "=== Phase B DONE ===" | tee -a "$OUT"
echo "=== PANEL DONE ===" | tee -a "$OUT"
