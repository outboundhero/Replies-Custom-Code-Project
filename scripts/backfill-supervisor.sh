#!/bin/bash
# Overnight ESP backfill supervisor.
#
# Keeps `_expand.ts --phase b` running until the remaining null-ESP waiting
# leads are drained. The backfill is idempotent (only fills esp IS NULL rows),
# so every (re)run resumes from the current DB state — losing at most the
# in-flight lookups of a crashed pass.
#
# Behaviour (per the request "resume on error, do not stop"):
#   - pass completes (reaches "Phase B DONE") with meaningful fills  -> short
#     pause, run another pass to drain stragglers.
#   - pass crashes / is killed mid-run                               -> pause 5
#     min, then resume.
#   - pass completes filling < CONVERGE_MIN new leads                -> done.
#   - hard cap of MAX_PASSES as a backstop.
#
# Launch (sleep-proof) with:
#   nohup caffeinate -i bash scripts/backfill-supervisor.sh >> /tmp/backfill-supervisor.log 2>&1 &

cd "$(dirname "$0")/.." || exit 1
LOG=/tmp/expand.txt
CONCURRENCY=8
CONVERGE_MIN=200      # a DONE pass that fills fewer than this => converged
CRASH_PAUSE=300       # 5 min pause before resuming after a crash
DONE_PAUSE=60         # short pause between successful passes
MAX_PASSES=60

echo "=== SUPERVISOR START $(date) ===" >> "$LOG"

for pass in $(seq 1 $MAX_PASSES); do
  MARK=$(wc -l < "$LOG")
  echo "=== SUPERVISOR pass #$pass start $(date) ===" >> "$LOG"

  npx tsx scripts/_expand.ts --phase b --concurrency $CONCURRENCY >> /tmp/expand-full.log 2>&1
  code=$?

  NEW=$(tail -n +$((MARK + 1)) "$LOG")
  FILLED=$(echo "$NEW" | grep -oE 'filled=[0-9]+' | cut -d= -f2 | awk '{s+=$1} END{print s+0}')
  DONE=$(echo "$NEW" | grep -c 'Phase B DONE')
  echo "=== SUPERVISOR pass #$pass end code=$code filled=$FILLED done=$DONE $(date) ===" >> "$LOG"

  if [ "$DONE" -gt 0 ] && [ "$FILLED" -lt "$CONVERGE_MIN" ]; then
    echo "=== SUPERVISOR CONVERGED after pass #$pass (filled=$FILLED < $CONVERGE_MIN). Stopping. $(date) ===" >> "$LOG"
    break
  fi

  if [ "$DONE" -gt 0 ]; then
    sleep $DONE_PAUSE          # full pass done, more stragglers — go again
  else
    echo "=== SUPERVISOR pass #$pass crashed (no DONE). Pausing ${CRASH_PAUSE}s then resuming. $(date) ===" >> "$LOG"
    sleep $CRASH_PAUSE
  fi
done

echo "=== SUPERVISOR EXIT $(date) ===" >> "$LOG"
