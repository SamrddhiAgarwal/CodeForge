#!/bin/sh
set -eu
cat > /workspace/main.cpp
g++ -std=c++17 -O0 -pipe /workspace/main.cpp -o /workspace/program
exec /workspace/program
