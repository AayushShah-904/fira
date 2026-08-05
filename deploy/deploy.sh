#!/bin/bash
# FIRA — Quick redeploy script
# Run this after git pull to update the production server
# Usage: sudo bash deploy.sh
set -e

echo "▸ Deploying FIRA update..."

cd /opt/fira

# Pull latest code
echo "▸ Pulling latest code..."
git pull origin main

# Reinstall API deps if package.json changed
echo "▸ Updating API dependencies..."
cd /opt/fira/api
npm install --omit=dev --quiet 2>&1 | tail -1

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

echo "✅ Deployed! Check: https://fia.bharatomni.com/health"
