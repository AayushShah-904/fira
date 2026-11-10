#!/bin/bash
# FIRA — Fast redeploy script
# Run this on the VM after code changes to update the application
# Usage: sudo bash deploy.sh
set -e

echo "▸ Deploying FIRA update..."

if [ -d "/tmp/fira-source/.git" ]; then
    cd /tmp/fira-source
    echo "▸ Pulling latest code in /tmp/fira-source..."
    git pull origin main || git pull
    echo "▸ Syncing updated files to /opt/fira..."
    cp -r /tmp/fira-source/api/* /opt/fira/api/
    cp -r /tmp/fira-source/ui/* /opt/fira/ui/
    cp /tmp/fira-source/package.json /opt/fira/
    if [ -d "/tmp/fira-source/deploy" ]; then
        cp -r /tmp/fira-source/deploy/* /opt/fira/deploy/
    fi
elif [ -d "/tmp/fira-source" ]; then
    echo "▸ Syncing updated files from /tmp/fira-source to /opt/fira..."
    cp -r /tmp/fira-source/api/* /opt/fira/api/
    cp -r /tmp/fira-source/ui/* /opt/fira/ui/
    cp /tmp/fira-source/package.json /opt/fira/
fi

# Reinstall API deps if needed
echo "▸ Updating API dependencies..."
cd /opt/fira/api
npm install --omit=dev --quiet 2>&1 | tail -1

# Seed or sync database schema
echo "▸ Updating database schema..."
node -r dotenv/config src/db/seed.js

# Optional: Sync rates if sync-rates.js is present and RATES_PACK_URL is set
if [ -f /opt/fira/api/sync-rates.js ] && grep -q 'RATES_PACK_URL' /opt/fira/api/.env 2>/dev/null; then
    echo "▸ Syncing latest rates from Azure Blob Storage..."
    sed -i '1s/^\xEF\xBB\xBF//' /opt/fira/api/sync-rates.js 2>/dev/null || true
    sed -i 's/\r//' /opt/fira/api/sync-rates.js 2>/dev/null || true
    node sync-rates.js || echo "  ⚠ Rate sync skipped or non-critical failure"
fi

# Rebuild UI
echo "▸ Rebuilding UI..."
cd /opt/fira/ui
npm install --quiet 2>&1 | tail -1
npm run build

# Fix permissions
chown -R fira:fira /opt/fira

# Restart API
echo "▸ Restarting API service..."
systemctl restart fira-api

# Local health probe
sleep 2
HEALTH=$(curl -s http://127.0.0.1:4000/health || echo "failed")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "✅ Deployed! API health check returned: $HEALTH"
else
    echo "⚠ Warning: API service returned unexpected health response: $HEALTH"
fi
