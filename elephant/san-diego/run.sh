#!/usr/bin/env bash
# Runs every parcel in seed.csv through elephant-cli:
#   seed transform -> prepare (live fetch) -> scripts transform -> validate -> hash
# and copies the results into output/. Nothing is uploaded and no key or wallet is used.
#
# Usage (Git Bash, Linux or macOS; needs node, python and the Elephant CLI):
#   ELEPHANT_CLI="node /path/to/elephant-cli/bin/elephant-cli" bash elephant/san-diego/run.sh
#
# ELEPHANT_CLI must be a command that works from any folder. A failing step stops that
# parcel, is recorded in output/timings.csv, and the script goes on to the next parcel.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CLI="${ELEPHANT_CLI:?set ELEPHANT_CLI, e.g. \"node /path/to/elephant-cli/bin/elephant-cli\"}"
PYTHON="${PYTHON:-python}"
WORK="$(mktemp -d)"
OUT="$HERE/output"
trap 'rm -rf "$WORK"' EXIT

now_ms() { echo $(($(date +%s%N) / 1000000)); }

rm -rf "$OUT"
mkdir -p "$OUT"
"$PYTHON" -I "$HERE/tools.py" zip-dir "$HERE/scripts" "$WORK/scripts.zip"
echo "apn,seed_transform_ms,prepare_ms,scripts_transform_ms,validate_ms,hash_ms,total_ms,result" >"$OUT/timings.csv"

row=0
for apn in $("$PYTHON" -I "$HERE/tools.py" apns "$HERE/seed.csv" | tr -d '\r'); do
  row=$((row + 1))
  dir="$WORK/$apn"
  dest="$OUT/$apn"
  mkdir -p "$dir" "$dest"
  cd "$dir" || exit 1
  result="ok"
  t_seed="" t_prepare="" t_transform="" t_validate="" t_hash=""
  start=$(now_ms)

  # 1. seed.csv row -> seed bundle
  "$PYTHON" -I "$HERE/tools.py" seed-zip "$HERE/seed.csv" "$row" seed-input.zip
  t0=$(now_ms)
  $CLI transform --input-zip seed-input.zip --output-zip seed-bundle.zip >seed-transform.log 2>&1 ||
    result="seed transform failed"
  t_seed=$(($(now_ms) - t0))

  # 2. prepare: the CLI fetches the source record named by the seed
  if [ "$result" = "ok" ]; then
    "$PYTHON" -I "$HERE/tools.py" prepare-input seed-bundle.zip prepare-input.zip
    t0=$(now_ms)
    $CLI prepare prepare-input.zip --output-zip prepared-site.zip >prepare.log 2>&1 ||
      result="prepare failed"
    t_prepare=$(($(now_ms) - t0))
  fi

  # 3. scripts-mode transform with the San Diego bundle
  if [ "$result" = "ok" ]; then
    "$PYTHON" -I "$HERE/tools.py" capture prepared-site.zip "$dest/source.json"
    t0=$(now_ms)
    $CLI transform --input-zip prepared-site.zip --scripts-zip "$WORK/scripts.zip" \
      --output-zip transformed-data.zip >scripts-transform.log 2>&1 ||
      result="scripts transform failed"
    t_transform=$(($(now_ms) - t0))
  fi

  # 4. validate against the live lexicon; the errors CSV is kept whether or not it is empty
  if [ "$result" = "ok" ]; then
    "$PYTHON" -I "$HERE/tools.py" unpack-json transformed-data.zip "$dest"
    t0=$(now_ms)
    $CLI validate transformed-data.zip --output-csv validate-errors.csv >validate.log 2>&1 ||
      result="validate reported errors"
    t_validate=$(($(now_ms) - t0))
    [ -f validate-errors.csv ] && cp validate-errors.csv "$dest/validate-errors.csv"
  fi

  # 5. hash (CIDs only; nothing leaves this machine)
  if [ "$result" = "ok" ]; then
    t0=$(now_ms)
    $CLI hash transformed-data.zip --output-zip hashed-data.zip --output-csv hash-results.csv \
      >hash.log 2>&1 || result="hash failed"
    t_hash=$(($(now_ms) - t0))
    [ -f hash-results.csv ] && cp hash-results.csv "$dest/hash-results.csv"
  fi

  total=$(($(now_ms) - start))
  echo "$apn,$t_seed,$t_prepare,$t_transform,$t_validate,$t_hash,$total,$result" >>"$OUT/timings.csv"
  echo "$apn: $result (${total} ms)"
  if [ "$result" != "ok" ]; then
    # Keep the CLI's own words for the step that failed.
    for log in seed-transform prepare scripts-transform validate hash; do
      [ -f "$log.log" ] && sed 's/\x1b\[[0-9;]*m//g' "$log.log" >"$dest/$log.log"
    done
  fi
  [ -f "$dest/source.json" ] && node "$HERE/coverage.cjs" "$dest" >"$dest/coverage.json"
done

{
  echo "run_date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "elephant_cli_version: $($CLI --version 2>/dev/null | tail -1)"
  echo "node: $(node --version)"
} >"$OUT/run-info.txt"
cat "$OUT/timings.csv"
