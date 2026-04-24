#!/bin/bash
# Route openclaw commands to Sakura's instance on Ishikawa via SSH
# Use printf to properly quote arguments for the remote shell
ARGS=""
for arg in "$@"; do
  ARGS="$ARGS $(printf '%q' "$arg")"
done
exec ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no fancymatt@10.10.0.104 \
  "PATH=/usr/local/bin:\$PATH openclaw $ARGS"
