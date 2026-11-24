#!/bin/sh
# `cli` on the image's PATH: the operator command from any directory
# (docker-entrypoint.sh, case cli).
cd /app && exec docker-entrypoint.sh cli "$@"
