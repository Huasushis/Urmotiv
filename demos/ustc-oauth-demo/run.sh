#!/bin/sh
# Start the USTC OAuth2 demo. Configuration is read by the server from the private env file,
# never sourced through the shell (secrets stay out of the environment of other tools).
# Usage: USTC_DEMO_ENV_FILE=/owner-only/path/demo.env sh run.sh
set -eu
cd "$(dirname "$0")"
exec node server.mjs