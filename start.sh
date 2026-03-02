#!/bin/bash
# Process wrapper that restarts the server on exit code 75 (repair applied).
# Usage: bash start.sh

# Load .env if present
if [ -f .env ]; then
  set -a; source .env; set +a
fi

while true; do
  node server.js
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 75 ]; then
    echo "[start.sh] Repair restart (exit 75). Restarting in 3s..."
    sleep 3
    continue
  fi
  echo "[start.sh] Server exited with code $EXIT_CODE"
  exit $EXIT_CODE
done
