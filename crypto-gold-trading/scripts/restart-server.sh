#!/usr/bin/env bash
# Restart the production bundle on PORT (default 8787): kill whatever holds the port, wait
# for it to free, start the server detached, and wait for the ready line.
set -u
PORT="${PORT:-8787}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${LOG:-$ROOT/data/server.log}"
PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
if [ -n "$PIDS" ]; then kill $PIDS 2>/dev/null || true; sleep 1; PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true); [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null || true; fi
for _ in $(seq 1 20); do lsof -ti tcp:"$PORT" >/dev/null 2>&1 || break; sleep 0.5; done
cd "$ROOT" && PORT="$PORT" nohup node apps/server/dist/server.js < /dev/null > "$LOG" 2>&1 &
disown 2>/dev/null || true
for _ in $(seq 1 40); do grep -q "listening on" "$LOG" 2>/dev/null && break; sleep 0.5; done
grep -E "listening on|fatal" "$LOG" | tail -2
