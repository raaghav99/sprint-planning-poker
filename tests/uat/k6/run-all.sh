#!/usr/bin/env bash
# Runs every k6 script one after another (pauses keep the per-IP room-creation limit from interfering).
#   UAT_URL=<page address> API_URL=<worker address> bash k6/run-all.sh
cd "$(dirname "$0")/.." || exit 1
mkdir -p k6/results
pause() { echo "   (pausing ${1}s so the creation window resets)"; sleep "$1"; }

run() {
    local name="$1"
    echo
    echo "=================== k6: $name ==================="
    k6 run --summary-export="k6/results/$name.json" "k6/$name.js" 2>&1 | grep -E "✓|✗|INFO|WARN|level=(info|error|warn)|checks_(succeeded|failed)|http_req_failed|ws_errors|iterations\.|vus_max|p\(95\)" | grep -vE "^\s*(default|room|race|storm|rooms|burst) "
    echo "   -> exit status of $name: ${PIPESTATUS[0]}"
}

run rate-limit;      pause 65
run name-race;       pause 20
run claim-race;      pause 20
run load-room;       pause 20
run reconnect-storm; pause 65
run multi-room;      pause 20
run probe
echo
echo "ALL K6 SCRIPTS FINISHED"
