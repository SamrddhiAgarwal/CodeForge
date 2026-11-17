#!/bin/sh
set -eu
cat > /workspace/main.py
exec python3 -I -B -u /workspace/main.py
