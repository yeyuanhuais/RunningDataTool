#!/usr/bin/env bash
set -euo pipefail

echo "[shell_recordHMI] $(date '+%F %T') running..." >> /root/shell_recordHMI.log

# Placeholder for long-running data capture logic.
# Replace this script with the real implementation as needed.
while true; do
  echo "[shell_recordHMI] heartbeat $(date '+%F %T')" >> /root/shell_recordHMI.log
  sleep 60
done
