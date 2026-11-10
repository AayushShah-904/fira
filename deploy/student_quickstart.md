# 🎓 FIRA — Azure for Students Quickstart Deployment Guide

This guide shows you how to deploy FIRA onto your free **Azure for Students** account in under 5 minutes without spending a single cent or using your $100 student credits.

---

## ⚡ Quick 1-Command Deployment (Recommended)

### Step 1: Open Azure Cloud Shell
1. Go to your [Azure Portal](https://portal.azure.com/) in your browser.
2. In the top navigation bar (next to the search box), click the **Cloud Shell** icon (`>_`):

```
┌─────────────────────────────────────────────────────────────┐
│ ≡  Microsoft Azure      [Search...        ]   [>_]  🔔  ⚙️  👤│
└─────────────────────────────────────────────────────────────┘
                                                 ▲
                                        Click this icon
```

3. If prompted to select an environment, choose **Bash**.
4. If prompted to mount storage, click **Create storage** (this uses the free Blob Storage tier included with your student account).

---

### Step 2: Paste the Provisioning Script
In the Cloud Shell terminal at the bottom of your screen, paste and run:

```bash
curl -sSL https://raw.githubusercontent.com/AayushShah-904/fira/final/deploy/azure-student-provision.sh | bash
```

*(Or copy-paste the contents of [`deploy/azure-student-provision.sh`](file:///d:/Computer/Workspace/Projects/fira-project-final/deploy/azure-student-provision.sh) directly into the shell and run `bash deploy/azure-student-provision.sh`)*

---

### Step 3: What the Script Does Automatically
1. Creates a free-tier resource group `rg-fira-student` in **East US** (guaranteed B1s free-tier capacity).
2. Sets up a Network Security Group with ports `80` (HTTP), `443` (HTTPS), and `22` (SSH) open.
3. Allocates a free Standard Public IP with DNS name:  
   `http://fira-app.eastus.cloudapp.azure.com`
4. Deploys an Ubuntu 22.04 LTS VM on the **`Standard_B1s`** size (eligible for 750 free hours/month).
5. Automatically configures a **2 GB Swap file** (so Vite compiles React on 1GB RAM without memory errors).
6. Installs Node.js 22 LTS, Nginx, SQLite database, seeds 60+ banks, builds the UI, and starts the systemd service.

---

## 🌐 Accessing Your Application

Once the script completes, open the following in your web browser:

| Resource | URL |
|---|---|
| **Web Application** | `http://fira-app.eastus.cloudapp.azure.com/` |
| **Health Check** | `http://fira-app.eastus.cloudapp.azure.com/health` |
| **API Base URL** | `http://fira-app.eastus.cloudapp.azure.com/api/v1/` |

### Default Credentials:
- **Email**: `demo@fdrates.in`
- **Password**: `demo123!`

---

## 🔒 Optional: Enabling Free HTTPS / SSL
Azure assigns you a real subdomain (`.eastus.cloudapp.azure.com`). You can get a free Let's Encrypt SSL certificate in one step:

1. Connect to your VM from Cloud Shell:
   ```bash
   ssh azureuser@fira-app.eastus.cloudapp.azure.com
   ```
2. Run Certbot:
   ```bash
   sudo certbot --nginx -d fira-app.eastus.cloudapp.azure.com
   ```
3. Enter your email and agree to terms. Certbot will automatically configure SSL and redirect HTTP to HTTPS!

---

## 🛠 Useful Server Management Commands

When connected to your VM:

```bash
# Check API server status
sudo systemctl status fira-api

# View live API logs
sudo journalctl -u fira-api -f

# Check memory & 2GB swap usage
free -h

# Restart API
sudo systemctl restart fira-api

# Redeploy latest code updates
sudo bash /opt/fira/deploy/deploy.sh
```

---

## 💡 Keeping Your Azure Costs at $0.00
- **VM Size**: Always keep the VM as **`Standard_B1s`** (750 hours/month free = 1 VM running 24/7 all month).
- **Disk**: Kept at 30 GB (well under the 64 GB free managed disk quota).
- **Your \$100 Credit**: Remains 100% intact!
