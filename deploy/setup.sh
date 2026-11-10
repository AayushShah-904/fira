#!/bin/bash
# FIRA Setup Script for Ubuntu 22.04 / 24.04
# Works for both Azure for Students (Standard_B1s) and standard production VMs.
# Run as root or with sudo
# Usage: sudo bash setup.sh [optional-domain-or-ip]
set -e

SERVER_NAME="${1:-${SERVER_NAME:-_}}"

echo "═══════════════════════════════════════════════"
echo "  FIRA — Automated Server Setup"
echo "  Target Host: ${SERVER_NAME}"
echo "═══════════════════════════════════════════════"

# ── 0. Memory & Swap Configuration (Crucial for B1s 1GB RAM) ──
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
SWAP_TOTAL_KB=$(grep SwapTotal /proc/meminfo | awk '{print $2}')

echo "▸ Detected RAM: ${TOTAL_RAM_MB} MB"
if [ "$TOTAL_RAM_MB" -lt 2000 ] && [ "$SWAP_TOTAL_KB" -lt 500000 ]; then
    echo "▸ Low RAM detected (<2GB). Setting up 2GB swap space for smooth compilation..."
    if [ ! -f /swapfile ]; then
        fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' >> /etc/fstab
        fi
        echo "  ✓ 2GB Swap enabled"
    else
        swapon /swapfile 2>/dev/null || true
        echo "  ✓ Swapfile already present"
    fi
else
    echo "  ✓ Memory configuration is adequate"
fi

# ── 1. System packages ──
echo ""
echo "▸ Installing system packages..."
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx curl git build-essential

# ── 2. Node.js 22 LTS ──
echo "▸ Checking Node.js runtime..."
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
    echo "  Installing Node.js 22 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  Node: $(node --version), npm: $(npm --version)"

# ── 3. Create fira user ──
echo "▸ Creating fira system user..."
if ! id "fira" &>/dev/null; then
    useradd --system --home /opt/fira --shell /bin/false fira
fi

# ── 4. Create directory structure ──
echo "▸ Setting up directories in /opt/fira..."
mkdir -p /opt/fira/{api,ui,data}

# ── 5. Copy application files ──
if [ -d "/tmp/fira-source" ]; then
    echo "▸ Copying application files from /tmp/fira-source..."
    cp -r /tmp/fira-source/api/* /opt/fira/api/
    cp -r /tmp/fira-source/ui/* /opt/fira/ui/
    cp /tmp/fira-source/package.json /opt/fira/
    if [ -d "/tmp/fira-source/deploy" ]; then
        mkdir -p /opt/fira/deploy
        cp -r /tmp/fira-source/deploy/* /opt/fira/deploy/
    fi
elif [ -f "./package.json" ] && [ -d "./api" ] && [ -d "./ui" ]; then
    echo "▸ Copying application files from current directory..."
    cp -r ./api/* /opt/fira/api/
    cp -r ./ui/* /opt/fira/ui/
    cp ./package.json /opt/fira/
    mkdir -p /opt/fira/deploy
    cp -r ./deploy/* /opt/fira/deploy/ 2>/dev/null || true
else
    echo "  ⚠ Source not found at /tmp/fira-source or current working directory"
    echo "  Please clone repo to /tmp/fira-source first: git clone <repo> /tmp/fira-source"
    exit 1
fi

# ── 6. Production .env ──
echo "▸ Setting up environment configuration..."
if [ ! -f /opt/fira/api/.env ]; then
    if [ -f /tmp/fira-source/deploy/env.production ]; then
        cp /tmp/fira-source/deploy/env.production /opt/fira/api/.env
    else
        cat > /opt/fira/api/.env <<EOF
NODE_ENV=production
PORT=4000
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES=24h
CORS_ORIGIN=*
DB_PATH=/opt/fira/data/fira.db
EOF
    fi
    # Generate random JWT secret if placeholder exists
    JWT=$(openssl rand -hex 32)
    sed -i "s/CHANGE_ME_TO_A_RANDOM_32_CHAR_STRING/$JWT/" /opt/fira/api/.env 2>/dev/null || true
    echo "  ✓ Created /opt/fira/api/.env with generated JWT secret"
else
    echo "  ✓ .env already exists, keeping existing secrets"
fi

# ── 7. Install dependencies & Build UI ──
echo "▸ Installing API dependencies..."
cd /opt/fira/api
npm install --omit=dev --quiet 2>&1 | tail -1

echo "▸ Building UI assets (Vite React bundle)..."
cd /opt/fira/ui
npm install --quiet 2>&1 | tail -1
npm run build
echo "  ✓ UI built to /opt/fira/ui/dist"

# ── 8. Seed database ──
echo "▸ Initializing database..."
cd /opt/fira/api
if [ ! -f /opt/fira/data/fira.db ]; then
    node src/db/seed.js
    if [ -f src/db/seed-bulk-banks.js ]; then
        node src/db/seed-bulk-banks.js 2>/dev/null || true
    fi
    echo "  ✓ Database seeded at /opt/fira/data/fira.db"
else
    echo "  ✓ Database already exists at /opt/fira/data/fira.db"
fi

# ── 9. Fix permissions ──
echo "▸ Setting file permissions..."
chown -R fira:fira /opt/fira

# ── 10. Systemd service ──
echo "▸ Installing systemd service..."
if [ -f /opt/fira/deploy/fira-api.service ]; then
    cp /opt/fira/deploy/fira-api.service /etc/systemd/system/
elif [ -f /tmp/fira-source/deploy/fira-api.service ]; then
    cp /tmp/fira-source/deploy/fira-api.service /etc/systemd/system/
fi

systemctl daemon-reload
systemctl enable fira-api
systemctl restart fira-api
echo "  ✓ API service active (port 4000)"

# ── 11. Nginx Configuration ──
echo "▸ Configuring Nginx reverse proxy..."
cat > /etc/nginx/sites-available/fira <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};

    # Security headers
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 1000;

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Health check proxy
    location /health {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host \$host;
    }

    # Serve static UI files
    root /opt/fira/ui/dist;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)\$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
EOF

ln -sf /etc/nginx/sites-available/fira /etc/nginx/sites-enabled/fira
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
echo "  ✓ Nginx active and proxying traffic"

# ── 12. Check if SSL certificates already exist ──
if [ -d "/etc/letsencrypt/live/${SERVER_NAME}" ] && [ "${SERVER_NAME}" != "_" ]; then
    echo "▸ Found existing SSL certificates for ${SERVER_NAME}. Enabling HTTPS..."
    certbot --nginx -d "${SERVER_NAME}" --non-interactive --redirect --agree-tos || true
fi

PUBLIC_IP=$(curl -s -m 3 http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01 -H "Metadata:true" 2>/dev/null || curl -s -m 3 ifconfig.me 2>/dev/null || echo "YOUR-SERVER-IP")

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ FIRA deployed successfully!"
echo ""
echo "  Web UI:    http://${PUBLIC_IP}/"
if [ "${SERVER_NAME}" != "_" ] && [ "${SERVER_NAME}" != "${PUBLIC_IP}" ]; then
    echo "  DNS URL:   http://${SERVER_NAME}/"
fi
echo "  Health:    http://${PUBLIC_IP}/health"
echo "  API Base:  http://${PUBLIC_IP}/api/v1/"
echo ""
echo "  Demo Credentials:"
echo "    Email:    demo@fdrates.in"
echo "    Password: demo123!"
echo ""
echo "  Helpful Commands:"
echo "    Check API:     systemctl status fira-api"
echo "    API Logs:      journalctl -u fira-api -f"
echo "    Check Memory:  free -h"
if [ "${SERVER_NAME}" != "_" ]; then
    echo "    Enable HTTPS:  sudo certbot --nginx -d ${SERVER_NAME}"
fi
echo "═══════════════════════════════════════════════"
