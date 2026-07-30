#!/bin/sh
export URMOTIV_DEMO_AUTH=true
export URMOTIV_DEMO_SEED=true
export URMOTIV_PGLITE_PATH=${URMOTIV_PGLITE_PATH:-.data/e2e-database}
export PATH=/home/ubuntu/urmotiv-codex/node-v24.18.0-linux-x64/bin:$PATH
exec corepack pnpm@10.33.0 exec tsx watch src/server.ts
