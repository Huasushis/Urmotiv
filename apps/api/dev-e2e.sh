#!/bin/sh
export URMOTIV_DEMO_AUTH=true
export URMOTIV_DEMO_SEED=true
export URMOTIV_PGLITE_PATH=${URMOTIV_PGLITE_PATH:-.data/e2e-database}
# Resolve Node v24 from project-local .tools if present, else fall back to PATH.
NODE_BIN="$(dirname "$(dirname "$0")")/../../.tools/node-v24.18.0-linux-x64/bin"
if [ -x "$NODE_BIN/node" ]; then
  export PATH="$NODE_BIN:$PATH"
fi
exec corepack pnpm@10.33.0 exec tsx watch src/server.ts
