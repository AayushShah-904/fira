# FIRA — Azure Virtual Machine Deployment Guide

> **Target VM:** `bo-sandbox-vm-india` (`bosandvmindia`)  
> **Resource Group:** `sandbox-rg`  
> **Location:** Central India  
> **Public IP:** `52.172.225.199`  
> **Private IP:** `10.0.0.33`  
> **OS & Spec:** Linux (Ubuntu) · Standard D2s v3 (2 vCPUs, 8 GiB RAM)  
> **Repository:** `AayushShah-904/fira` (branch: `final`)

---

## 🏗 Architecture Overview

```
User Request (Port 80 / 443)
       │
       ▼
Azure Public IP (52.172.225.199)
       │
       ▼
Nginx Reverse Proxy & Static File Server (bo-sandbox-vm-india)
       │
       ├── /api/v1/* ─────────► Express API (Node.js 22 LTS, Port 4000, Systemd)
       │                         │
       │                         ▼
       │                       SQLite DB (/opt/fira/data/fira.db)
       │
       └── /* (All UI routes) ──► Static UI Dist (/opt/fira/ui/dist)
                                  Vite 7 + React 18 / TanStack Router
```

---

## Step 1 — Start the Azure VM

Since the VM status in Azure Portal is currently **`Stopped (deallocated)`**, start it before proceeding:

### Option A: Via Azure Portal
1. Open [Azure Portal](https://portal.azure.com/).
2. Navigate to **Resource groups** → `sandbox-rg` → **Virtual machines** → `bo-sandbox-vm-india`.
3. Click the **Start** button at the top toolbar.

### Option B: Via Azure CLI
```bash
az vm start --resource-group sandbox-rg --name bo-sandbox-vm-india
```

Verify status changes to **`Running`**.

---

## Step 2 — Configure Network Security Group (NSG) Rules

Ensure the inbound security rules for `bo-sandbox-nic-india` / NSG allow traffic on:
- **Port 22 (SSH)** — For administration
- **Port 80 (HTTP)** — Web traffic & Certbot validation
- **Port 443 (HTTPS)** — Secure Web UI & API

### Add NSG Rules via Azure CLI (if not already present):
```bash
# Allow HTTP (Port 80)
az network nsg rule create \
  --resource-group sandbox-rg \
  --nsg-name bo-sandbox-nsg-india \
  --name Allow-HTTP \
  --priority 1000 \
  --destination-port-ranges 80 \
  --protocol Tcp \
  --access Allow

# Allow HTTPS (Port 443)
az network nsg rule create \
  --resource-group sandbox-rg \
  --nsg-name bo-sandbox-nsg-india \
  --name Allow-HTTPS \
  --priority 1010 \
  --destination-port-ranges 443 \
  --protocol Tcp \
  --access Allow
```

---

## Step 3 — SSH into the Virtual Machine

```bash
ssh azureuser@52.172.225.199
```
*(Replace `azureuser` with your configured VM SSH admin username)*

---

## Step 4 — Upload / Clone FIRA Repository

On the VM, prepare the source directory:

```bash
sudo mkdir -p /tmp/fira-source
sudo chown -R $USER:$USER /tmp/fira-source

# Clone repository directly to /tmp/fira-source (final branch)
git clone -b final https://github.com/AayushShah-904/fira.git /tmp/fira-source
```

---

## Step 5 — Run Automated Setup (`setup.sh`)

The repository includes a production setup script in `deploy/setup.sh`. Run:

```bash
cd /tmp/fira-source
sudo bash deploy/setup.sh
```

### What `setup.sh` automatically performs:
1. **Installs System Packages**: `nginx`, `certbot`, `python3-certbot-nginx`, `curl`, `git`, build tools.
2. **Installs Node.js 22 LTS**: Node runtime & npm.
3. **Creates System User**: `fira` system user.
4. **Sets Up Directory Structure**: `/opt/fira/{api,ui,data}`.
5. **Configures Environment**: Copies `deploy/env.production` to `/opt/fira/api/.env` and generates a secure 32-byte JWT secret.
6. **Installs & Builds**:
   - `npm install` for API
   - `npm install && npm run build` for UI (compiles Vite bundle to `/opt/fira/ui/dist`)
7. **Seeds Database**: Creates SQLite DB at `/opt/fira/data/fira.db` and runs `seed.js` & `seed-bulk-banks.js`.
8. **Installs Systemd Service**: Registers and starts `/etc/systemd/system/fira-api.service`.
9. **Configures Nginx**: Deploys reverse proxy config to serve `/opt/fira/ui/dist` for static files and proxy `/api/*` to `http://127.0.0.1:4000`.

---

## Step 6 — Nginx & SSL Certificate Configuration

If using a domain name (e.g., `fia.bharatomni.com` mapped to IP `52.172.225.199`), issue a free Let's Encrypt SSL certificate:

```bash
sudo certbot --nginx -d fia.bharatomni.com --non-interactive --agree-tos -m business@bharatomni.com
```

If deploying directly to IP `52.172.225.199` without SSL initially, update `/etc/nginx/sites-available/fira`:

```nginx
server {
    listen 80;
    server_name 52.172.225.199;

    root /opt/fira/ui/dist;
    index index.html;

    # API Proxy
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check
    location /health {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
    }

    # Single Page Application (SPA) routing fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Static assets caching
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

Reload Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## Step 7 — Managing API Service

The Express backend runs as a systemd service `fira-api`.

```bash
# Check service status
sudo systemctl status fira-api

# View live logs
sudo journalctl -u fira-api -f

# Restart API service
sudo systemctl restart fira-api
```

---

## Step 8 — Quick Redeployment (`deploy.sh`)

Whenever you push new updates to GitHub `main`, update the VM in one step:

```bash
cd /tmp/fira-source
git pull origin main
sudo bash deploy/deploy.sh
```

`deploy.sh` will automatically pull latest code, rebuild UI assets, update API dependencies, and restart `fira-api` service cleanly.

---

## ✅ Post-Deployment Verification Checklist

- [ ] VM `bo-sandbox-vm-india` is **Running** in Azure Portal.
- [ ] Public IP `http://52.172.225.199/health` returns `{"status":"ok"}`.
- [ ] Navigating to `http://52.172.225.199/` loads the FIRA UI application.
- [ ] Login with seed admin credentials works: `admin@fira.in` / `admin123!`.
- [ ] Rate Refresh pipeline, live rates table, and simulator calculate accurately.

---

## 🛠 Quick Command Cheat Sheet

```bash
# SSH into VM
ssh azureuser@52.172.225.199

# Initial setup
sudo bash /tmp/fira-source/deploy/setup.sh

# Redeploy latest updates
sudo bash /tmp/fira-source/deploy/deploy.sh

# Check API logs
sudo journalctl -u fira-api -n 100 -f

# Check Nginx logs
sudo tail -f /var/log/nginx/error.log
```
