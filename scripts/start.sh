#!/bin/sh
set -eu
if [ -z "${DATABASE_PRIVATE_URL:-${DATABASE_URL:-}}" ]; then
  echo "Production start requires private PostgreSQL DATABASE_PRIVATE_URL or DATABASE_URL" >&2
  exit 1
fi
export DATABASE_URL="${DATABASE_PRIVATE_URL:-${DATABASE_URL:-}}"
export NODE_ENV=production
schema="$(pnpm exec tsx scripts/deployment.ts)"
views="${PONDER_VIEWS_SCHEMA:-rental}"
case "$views" in
  off) ;;
  *) node -e 'if (!/^[a-z][a-z0-9_]{0,44}$/.test(process.argv[1])) process.exit(1)' "$views" ;;
esac
pnpm exec tsx scripts/preflight.ts
if [ "$views" = off ] || [ "$views" = "$schema" ]; then
  exec pnpm exec ponder start --schema "$schema" --hostname 0.0.0.0 --port "${PORT:-42069}"
fi
exec pnpm exec ponder start --schema "$schema" --views-schema "$views" --hostname 0.0.0.0 --port "${PORT:-42069}"
