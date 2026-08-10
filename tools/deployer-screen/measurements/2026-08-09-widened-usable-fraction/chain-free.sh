#!/usr/bin/env bash
# The three free measurement legs, STRICTLY SERIAL.
#
# Serial is forced, not cautious: api.mainnet-beta rate-limits globally across methods (two
# concurrent jobs earned a sustained 429 lockout) and the rotation state is one file two runs
# would race on.
#
# Each leg gates one third of the widened 37, interleaved by census rank so every leg spans the
# launch-flow distribution. Their union is the whole population and each wallet is walked ONCE
# across the lane, which is what keeps Stage 1 to ~2.4h in total instead of ~10h.
#
# Spend, whole chain: MadeOnSol 37 keyed (0.037% of the 100,000/day allowance), Dune 0 credits and
# 0 executions (--no-dune), Helius 0 credits (HELIUS_API_KEY unset), everything else keyless.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
cd "$repo"
for k in 1 2 3; do
  echo "leg $k starting $(date '+%H:%M:%S')"
  env -u HELIUS_API_KEY node tools/deployer-screen/screen.mjs \
    --wallets "$here/widened-37-part$k.txt" \
    --no-dune \
    --rotation "$here/rotation-state.json" \
    --runs-dir "$here/runs" \
    --out "$here/runs/widened-part$k.json" \
    > "$here/runs/widened-part$k.log" 2>&1
  rc=$?
  echo "leg $k exit=$rc $(date '+%H:%M:%S')"
  if [ "$rc" -ne 0 ]; then echo "STOPPING: leg $k exited $rc"; exit "$rc"; fi
done
echo CHAIN-DONE
