#!/bin/bash
# FIRA — Quick redeploy script
# Run this after git pull to update the production server
# Usage: sudo bash deploy.sh
set -e

echo "▸ Deploying FIRA update..."

if [ -d "/tmp/fira-source" ]; then
    cd /tmp/fira-source
    echo "▸ Pulling latest code in /tmp/fira-source..."
    git pull origin main
    echo "▸ Syncing updated files to /opt/fira..."
    cp -r /tmp/fira-source/api/* /opt/fira/api/
    cp -r /tmp/fira-source/ui/* /opt/fira/ui/
    cp /tmp/fira-source/package.json /opt/fira/
else
    echo "  ⚠ /tmp/fira-source not found"
    exit 1
fi

# Reinstall API deps if package.json changed
echo "▸ Updating API dependencies..."
cd /opt/fira/api
npm install --omit=dev --quiet 2>&1 | tail -1

# Seed/Update database users & banks schema
echo "▸ Seeding database schema & users..."
node -r dotenv/config src/db/seed.js

# Sync live rates from Azure Blob Storage into the production DB
echo "▸ Syncing latest rates from Azure Blob Storage..."
node sync-rates.js && echo "  ✓ Rates synced" || echo "  ⚠ Rate sync failed — check logs, continuing deploy"

# Rebuild UI
echo "▸ Rebuilding UI..."
cd /opt/fira/ui
npm install --quiet 2>&1 | tail -1
npm run build

# Fix permissions
chown -R fira:fira /opt/fira

# Restart API
echo "▸ Restarting API..."
systemctl restart fira-api

echo "✅ Deployed! Check health at http://52.172.225.199/health"

