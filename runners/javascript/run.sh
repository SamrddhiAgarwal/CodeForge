#!/bin/sh
set -eu
cat > /workspace/main.js
exec node --max-old-space-size=128 /workspace/main.js
