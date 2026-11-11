#!/usr/bin/env bash
# ==============================================================================
# FIRA — Automated Azure for Students Provisioning & Deployment Script
# Run this directly inside Azure Cloud Shell (Bash) in your browser:
#
#   curl -sSL https://raw.githubusercontent.com/AayushShah-904/fira/final/deploy/azure-student-provision.sh | bash
#   (or paste and run this file directly in Cloud Shell)
# ==============================================================================
set -e

# Configuration
RESOURCE_GROUP="rg-fira-india"
VM_NAME="vm-fira-student"
IMAGE="Ubuntu2204"
ADMIN_USER="azureuser"
PREFERRED_DNS="fira-app"
REPO_URL="https://github.com/AayushShah-904/fira.git"
REPO_BRANCH="final"

# 1. Verify Azure CLI login & active subscription
echo ""
echo "▸ Step 1/6: Checking Azure subscription..."
SUB_NAME=$(az account show --query name -o tsv 2>/dev/null || echo "Unknown")
SUB_ID=$(az account show --query id -o tsv 2>/dev/null || echo "Unknown")
echo "  Active Subscription: ${SUB_NAME} (${SUB_ID})"

# 2. Candidate VM sizes & regions allowed by University Policy (India only)
# Tests B-series (free tier core quota) across South India, West India & Central India
CANDIDATES=(
  "southindia:Standard_B1s"
  "westindia:Standard_B1s"
  "westindia:Standard_B2s"
  "westindia:Standard_B1ms"
  "southindia:Standard_B2s"
  "southindia:Standard_B1ms"
  "centralindia:Standard_B1s"
  "centralindia:Standard_B1ms"
  "centralindia:Standard_B2s"
  "southindia:Standard_D2s_v3"
  "westindia:Standard_D2s_v3"
  "centralindia:Standard_D2s_v3"
)

# 3. Generate a unique DNS label to prevent naming collision
echo "▸ Step 2/6: Resolving public DNS prefix..."
DNS_LABEL="${PREFERRED_DNS}"
SUFFIX=$(od -A n -t x -N 2 /dev/urandom 2>/dev/null | tr -d ' ' || echo "$RANDOM")
DNS_LABEL="${PREFERRED_DNS}-${SUFFIX}"
echo "  Assigned unique DNS label: ${DNS_LABEL}"

# 4. Provision VM using intelligent capacity fallback loop
echo "▸ Step 3/6: Provisioning Virtual Machine (testing capacity across allowed India regions)..."
NSG_NAME="nsg-fira-student"
VM_SUCCESS=false

for candidate in "${CANDIDATES[@]}"; do
    C_LOC="${candidate%%:*}"
    C_SIZE="${candidate##*:}"
    
    echo "  → Checking ${C_SIZE} in ${C_LOC}..."
    
    # Ensure Resource Group in candidate region
    az group create --name "${RESOURCE_GROUP}" --location "${C_LOC}" --output none 2>/dev/null || true
    
    # Ensure NSG in candidate region
    az network nsg create --resource-group "${RESOURCE_GROUP}" --name "${NSG_NAME}" --location "${C_LOC}" --output none 2>/dev/null || true
    
    # Configure security rules
    az network nsg rule create --resource-group "${RESOURCE_GROUP}" --nsg-name "${NSG_NAME}" --name Allow-HTTP --priority 1000 --destination-port-ranges 80 --protocol Tcp --access Allow --output none 2>/dev/null || true
    az network nsg rule create --resource-group "${RESOURCE_GROUP}" --nsg-name "${NSG_NAME}" --name Allow-HTTPS --priority 1010 --destination-port-ranges 443 --protocol Tcp --access Allow --output none 2>/dev/null || true
    az network nsg rule create --resource-group "${RESOURCE_GROUP}" --nsg-name "${NSG_NAME}" --name Allow-SSH --priority 1020 --destination-port-ranges 22 --protocol Tcp --access Allow --output none 2>/dev/null || true

    # Attempt VM creation (safely catch capacity errors without exiting)
    set +e
    VM_OUTPUT=$(az vm create \
      --resource-group "${RESOURCE_GROUP}" \
      --name "${VM_NAME}" \
      --location "${C_LOC}" \
      --image "${IMAGE}" \
      --size "${C_SIZE}" \
      --admin-username "${ADMIN_USER}" \
      --generate-ssh-keys \
      --nsg "${NSG_NAME}" \
      --public-ip-address-dns-name "${DNS_LABEL}" \
      --os-disk-size-gb 30 \
      --storage-sku StandardSSD_LRS \
      --security-type Standard \
      --output json 2>&1)
    VM_STATUS=$?
    set -e

    if [ $VM_STATUS -eq 0 ] && echo "${VM_OUTPUT}" | grep -q '"publicIps"'; then
        echo "  ✓ Successfully provisioned ${C_SIZE} in ${C_LOC}!"
        LOCATION="${C_LOC}"
        VM_SIZE="${C_SIZE}"
        VM_SUCCESS=true
        break
    else
        echo "    Notice: ${C_SIZE} has temporary capacity constraints in ${C_LOC}. Trying next size..."
    fi
done

if [ "$VM_SUCCESS" = false ]; then
    echo "ERROR: All tested India VM sizes are currently experiencing capacity limits."
    echo "${VM_OUTPUT}"
    exit 1
fi

PUBLIC_IP=$(echo "${VM_OUTPUT}" | grep -o '"publicIps": *"[^"]*"' | cut -d'"' -f4)
FQDN="${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  🚀 VM Provisioned & Live"
echo "  Region:    ${LOCATION}"
echo "  VM Size:   ${VM_SIZE}"
echo "  Public IP: ${PUBLIC_IP}"
echo "  FQDN:      http://${FQDN}"
echo "════════════════════════════════════════════════════════════════"

# 5. Execute FIRA installation directly on the VM via Azure Run-Command
echo "▸ Step 4/4: Bootstrapping application on the VM..."
echo "  (Configuring 2GB swap, installing Node.js 22 LTS, Nginx, SQLite & building UI)..."

az vm run-command invoke \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${VM_NAME}" \
  --command-id RunShellScript \
  --scripts "
    set -e
    echo '=== Starting Server Bootstrap ==='
    export DEBIAN_FRONTEND=noninteractive
    
    # 1. Setup 2GB Swap for 1GB RAM VM
    if [ ! -f /swapfile ]; then
      fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
      chmod 600 /swapfile
      mkswap /swapfile
      swapon /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
    
    # 2. Clone Repository (Branch: ${REPO_BRANCH})
    mkdir -p /tmp/fira-source
    if [ ! -d /tmp/fira-source/.git ]; then
      git clone -b ${REPO_BRANCH} ${REPO_URL} /tmp/fira-source
    else
      cd /tmp/fira-source && git fetch origin && git checkout ${REPO_BRANCH} && git pull origin ${REPO_BRANCH}
    fi

    # 3. Run Setup
    cd /tmp/fira-source
    SERVER_NAME=${FQDN} bash deploy/setup.sh ${FQDN}
    echo '=== Server Bootstrap Complete ==='
  " --output none

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  🎉 CONGRATULATIONS! FIRA IS DEPLOYED AND LIVE!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  🌍 Open in Your Browser:"
echo "     http://${FQDN}/"
echo "     http://${PUBLIC_IP}/"
echo ""
echo "  🩺 Health Check Endpoint:"
echo "     http://${FQDN}/health"
echo ""
echo "  🔑 Demo Credentials to Log In:"
echo "     Email:    demo@fdrates.in"
echo "     Password: demo123!"
echo ""
echo "  💻 Direct SSH Access (if needed):"
echo "     ssh ${ADMIN_USER}@${PUBLIC_IP}"
echo ""
echo "  🔒 Free HTTPS (Optional):"
echo "     ssh ${ADMIN_USER}@${PUBLIC_IP}"
echo "     sudo certbot --nginx -d ${FQDN}"
echo "════════════════════════════════════════════════════════════════"
