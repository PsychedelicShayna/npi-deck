#!/usr/bin/env bash
# Convenience dev launcher for macOS / Linux: start the dev server + Vite
# together in the background, write logs under `.logs/`, open the deck in
# the default browser.
#
# Quitting: `bash Start-OMP-Deck.sh stop` (or Ctrl+C if started without
# the `start` argument — see below).

set -euo pipefail

cd "$(dirname "$0")"

LOG_DIR=".logs"
PID_FILE="$LOG_DIR/dev.pid"
LOG_FILE="$LOG_DIR/dev.log"
DECK_URL="http://127.0.0.1:5173"

mkdir -p "$LOG_DIR"

case "${1:-foreground}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "omp-deck already running (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
      exit 0
    fi
    bun install --frozen-lockfile > "$LOG_DIR/install.log" 2>&1
    nohup bun run dev > "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    echo "omp-deck started (PID $PID). Logs: $LOG_FILE"
    sleep 4
    if command -v open >/dev/null 2>&1; then open "$DECK_URL"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$DECK_URL"
    else echo "Open $DECK_URL in your browser."
    fi
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      if kill -0 "$PID" 2>/dev/null; then
        # Kill the whole process group so vite + the bun server both exit
        # together. Falls back to SIGKILL if SIGTERM is ignored.
        kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
        sleep 1
        if kill -0 "$PID" 2>/dev/null; then
          kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
        fi
        echo "stopped omp-deck (PID $PID)"
      fi
      rm -f "$PID_FILE"
    else
      echo "no PID file at $PID_FILE — nothing to stop"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
    else
      echo "not running"
    fi
    ;;
  foreground|"")
    # No-argument run = foreground, same shape as `bun run dev`. Ctrl+C
    # cleans up. Skips the install step — assume the developer already
    # ran `bun install`.
    exec bun run dev
    ;;
  *)
    cat <<USAGE
Usage: $0 [start|stop|status|foreground]

  (no arg)     foreground run, same as 'bun run dev'
  start        background, writes PID + logs to $LOG_DIR/, opens browser
  stop         terminate the background run started via 'start'
  status       check whether a background run is alive

For dev iteration, just run with no argument. For "set it and forget it",
use 'start' and quit later with 'stop'.
USAGE
    exit 1
    ;;
esac
