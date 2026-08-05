#!/bin/bash
# FIRA Production Setup Script for Ubuntu 22.04/24.04
# Run as root or with sudo
# Usage: sudo bash setup.sh
set -e

echo "═══════════════════════════════════════════════"
echo "  FIRA — Production Setup"
echo "  Target: fia.bharatomni.com"
echo "═══════════════════════════════════════════════"

# ── 1. System packages ──
echo ""
echo "▸ Installing system packages..."
apt update -qq
apt install -y -qq nginx certbot python3-certbot-nginx curl git build-essential

# ── 2. Node.js 22 LTS ──
echo "▸ Installing Node.js 22 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt install -y -qq nodejs
fi
echo "  Node: $(node --version), npm: $(npm --version)"

# ── 3. Create fira user ──
echo "▸ Creating fira system user..."
if ! id "fira" &>/dev/null; then
    useradd --system --home /opt/fira --shell /bin/false fira
fi

# ── 4. Create directory structure ──
echo "▸ Setting up directories..."
mkdir -p /opt/fira/{api,ui,data}

# ── 5. Copy application files ──
# Assumes the repo is cloned/uploaded to /tmp/fira-source
if [ -d "/tmp/fira-source" ]; then
    echo "▸ Copying application files..."
    cp -r /tmp/fira-source/api/* /opt/fira/api/
    cp -r /tmp/fira-source/ui/* /opt/fira/ui/
    cp /tmp/fira-source/package.json /opt/fira/
else
    echo "  ⚠ Source not found at /tmp/fira-source"
    echo "  Upload your repo there first, or git clone it"
fi

# ── 6. Production .env ──
echo "▸ Setting up environment..."
if [ ! -f /opt/fira/api/.env ]; then
    cp /tmp/fira-source/deploy/env.production /opt/fira/api/.env
    # Generate random JWT secret
    JWT=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_TO_A_RANDOM_32_CHAR_STRING/$JWT/" /opt/fira/api/.env
    echo "  ✓ Generated JWT secret"
    echo "  ⚠ Edit /opt/fira/api/.env to configure SMTP settings"
else
    echo "  .env already exists, skipping"
fi

# ── 7. Install dependencies ──
echo "▸ Installing API dependencies..."
cd /opt/fira/api
npm install --omit=dev --quiet 2>&1 | tail -1

echo "▸ Building UI..."
cd /opt/fira/ui
npm install --quiet 2>&1 | tail -1
npm run build
echo "  ✓ UI built to /opt/fira/ui/dist"

# ── 8. Seed database ──
echo "▸ Seeding database..."
cd /opt/fira/api
if [ ! -f /opt/fira/data/fira.db ]; then
    node src/db/seed.js
    node src/db/seed-bulk-banks.js
    echo "  ✓ Database seeded"
else
    echo "  Database already exists, skipping"
fi

# ── 9. Fix permissions ──
echo "▸ Setting permissions..."
chown -R fira:fira /opt/fira

# ── 10. Systemd service ──
echo "▸ Installing systemd service..."
cp /tmp/fira-source/deploy/fira-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable fira-api
systemctl start fira-api
echo "  ✓ API service started"

# ── 11. Nginx ──
echo "▸ Configuring Nginx..."
cp /tmp/fira-source/deploy/nginx.conf /etc/nginx/sites-available/fira
ln -sf /etc/nginx/sites-available/fira /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test nginx config (without SSL first)
# Temporarily use HTTP-only config for certbot
cat > /etc/nginx/sites-available/fira-temp <<'EOF'
server {
    listen 80;
    server_name fia.bharatomni.com;
    root /opt/fira/ui/dist;
    index index.html;
    location /api/ { proxy_pass http://127.0.0.1:4000; }
    location /health { proxy_pass http://127.0.0.1:4000; }
    location / { try_files $uri $uri/ /index.html; }
}
EOF
ln -sf /etc/nginx/sites-available/fira-temp /etc/nginx/sites-enabled/fira
nginx -t && systemctl restart nginx

# ── 12. SSL already configured — just apply full nginx config ──
echo "▸ Applying full nginx config (SSL already set up)..."
cp /tmp/fira-source/deploy/nginx.conf /etc/nginx/sites-available/fira
ln -sf /etc/nginx/sites-available/fira /etc/nginx/sites-enabled/fira
rm -f /etc/nginx/sites-available/fira-temp
nginx -t && systemctl reload nginx

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ FIRA deployed successfully!"
echo ""
echo "  URL:     https://fia.bharatomni.com"
echo "  API:     https://fia.bharatomni.com/api/v1"
echo "  Health:  https://fia.bharatomni.com/health"
echo ""
echo "  Manage:"
echo "    systemctl status fira-api"
echo "    journalctl -u fira-api -f"
echo "    systemctl restart fira-api"
echo ""
echo "  ⚠ Don't forget:"
echo "    1. Edit /opt/fira/api/.env for SMTP settings"
echo "    2. Change demo user password in production"
echo "    3. Set up automated backups for /opt/fira/data/"
echo "═══════════════════════════════════════════════"
