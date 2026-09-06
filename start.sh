#!/bin/sh
# Startup script - runs prisma db push then starts server
set -e

# Debug: Show what env vars are available
echo "=== Redis Debug ==="
echo "REDIS_URL set: $([ -n \"$REDIS_URL\" ] && echo 'YES' || echo 'NO')"
echo "REDIS_PASSWORD set: $([ -n \"$REDIS_PASSWORD\" ] && echo 'YES' || echo 'NO')"
echo "REDIS_HOST set: $([ -n \"$REDIS_HOST\" ] && echo 'YES' || echo 'NO')"
echo "All env vars with REDIS: $(env | grep -i redis | head -5)"

# If REDIS_URL exists but has NO password (no @ sign), treat it as unauthenticated
if [ -n "$REDIS_URL" ] && echo "$REDIS_URL" | grep -qE '^redis://[^@]*$'; then
  echo "WARNING: REDIS_URL has no password ($REDIS_URL) — clearing it to prevent NOAUTH errors"
  unset REDIS_URL
fi

# Coolify quirk: sometimes injects full Redis URL into REDIS_USERNAME
if [ -z "$REDIS_URL" ] && [ -n "$REDIS_USERNAME" ] && echo "$REDIS_USERNAME" | grep -qE '^redis://'; then
  export REDIS_URL="$REDIS_USERNAME"
  echo "Detected Redis URL from REDIS_USERNAME (Coolify quirk)"
fi

# Build REDIS_URL only if not already set
# IMPORTANT: Only build URL WITH auth. Never connect without password.
if [ -z "$REDIS_URL" ]; then
  if [ -n "$REDIS_PASSWORD" ]; then
    host="${REDIS_HOST:-coolify-redis}"
    port="${REDIS_PORT:-6379}"
    export REDIS_URL="redis://:${REDIS_PASSWORD}@${host}:${port}"
    echo "Built REDIS_URL with password for ${host}:${port}"
  else
    echo "No REDIS_URL or REDIS_PASSWORD set — Redis will be disabled"
    unset REDIS_HOST 2>/dev/null || true
  fi
fi

# IMPORTANT: Redis is ONLY enabled when REDIS_ENABLED=true is EXPLICITLY set in env vars.
# We do NOT auto-enable based on REDIS_URL presence. This prevents Coolify's
# auto-injected env vars from causing cascading timeout floods when the
# Redis endpoint is unreachable from the app container.
# To enable Redis, set REDIS_ENABLED=true in Coolify or docker environment.
# The TypeScript circuit breaker in redis-connection.ts provides a second
# line of defense (redisUnreachable flag) that stops all Redis activity on
# first timeout, even if REDIS_ENABLED=true.

echo "Redis URL present: $([ -n \"$REDIS_URL\" ] && echo 'YES' || echo 'NO')"
echo "Running Prisma generate + db push..."

# Remove orphaned rows that block Prisma migrations
# The ApiKey table may have 1 stale row from dev that lacks required columns
echo "Running preflight cleanup..."
node ./scripts/prisma-preflight.mjs 2>&1 || echo "Warning: preflight cleanup failed, continuing..."

# Prisma generate is already done during Docker build (RUN step)
# Only retry if .prisma/client is missing (e.g. volume mount overwrote node_modules)
if [ ! -f node_modules/.prisma/client/index.js ]; then
  echo "Prisma client missing, regenerating..."
  npx prisma generate 2>&1 || echo "Warning: Prisma generate failed, continuing..."
else
  echo "Prisma client already generated, skipping."
fi
# Run migrations first - they handle data transformations properly
output=$(timeout 120 npx prisma migrate deploy 2>&1) || true
echo "$output"

# Handle P3005: database schema is empty
if echo "$output" | grep -q "P3005"; then
  echo "Baselining existing migration..."
  npx prisma migrate resolve --applied 20260624_init 2>&1 || true
fi

# Sync additive schema drift (missing tables/columns) WITHOUT data loss.
# NOTE: no --accept-data-loss. If the DB has destructive drift (dropped columns
# etc.), db push REFUSES and logs the diff instead of silently deleting data.
# Remediation: create a real migration (`npx prisma migrate dev`) and redeploy.
echo "Syncing database schema (db push, non-destructive)..."
timeout 120 npx prisma db push --skip-generate 2>&1 || echo "⚠️ db push refused (destructive drift?) — see diff above. Schema may be out of sync."

echo "Starting server..."
exec node dist/server/index.js
