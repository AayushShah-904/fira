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

# 2. Find best available India region allowed by university Azure policy
echo "▸ Step 2/6: Finding allowed India region with available capacity..."
CHOSEN_LOC=""
CHOSEN_SIZE=""

# Priority 1: Check if Standard_B1s (100% Free Tier) is available in southindia, centralindia, or westindia
for loc in "southindia" "centralindia" "westindia"; do
    RESTRICTION=$(az vm list-skus --location "$loc" --size "Standard_B1s" --all --query "[0].restrictions[0].reasonCode" -o tsv 2>/dev/null || echo "Restricted")
    if [ -z "$RESTRICTION" ] || [ "$RESTRICTION" = "None" ]; then
        CHOSEN_LOC="$loc"
        CHOSEN_SIZE="Standard_B1s"
        echo "  ✓ Selected 100% Free Tier Standard_B1s in ${loc}!"
        break
    fi
done

# Priority 2: If Standard_B1s has capacity limits in all India regions, use B1ms or B2s (uses tiny fraction of $100 credit)
if [ -z "$CHOSEN_LOC" ]; then
    echo "  Notice: Standard_B1s currently has capacity limits across India regions."
    echo "  Checking Standard_B1ms / Standard_B2s (covered by your \$100 student balance)..."
    for loc in "centralindia" "southindia"; do
        for size in "Standard_B1ms" "Standard_B2s"; do
            RESTRICTION=$(az vm list-skus --location "$loc" --size "$size" --all --query "[0].restrictions[0].reasonCode" -o tsv 2>/dev/null || echo "Restricted")
            if [ -z "$RESTRICTION" ] || [ "$RESTRICTION" = "None" ]; then
                CHOSEN_LOC="$loc"
                CHOSEN_SIZE="$size"
                echo "  ✓ Selected available size ${size} in ${loc}!"
                break 2
            fi
        done
    done
fi

LOCATION="${CHOSEN_LOC:-centralindia}"
VM_SIZE="${CHOSEN_SIZE:-Standard_B2s}"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  🚀 Provisioning FIRA Target"
echo "  Region:   ${LOCATION} (Allowed by University Azure Policy)"
echo "  VM Size:  ${VM_SIZE}"
echo "════════════════════════════════════════════════════════════════"

# 3. Generate a unique DNS label to prevent naming collision
echo "▸ Step 3/6: Resolving public DNS prefix in ${LOCATION}..."
DNS_LABEL="${PREFERRED_DNS}"
if az network public-ip list --query "[?dnsSettings.domainNameLabel=='${DNS_LABEL}' && location=='${LOCATION}']" -o tsv 2>/dev/null | grep -q "${DNS_LABEL}"; then
    SUFFIX=$(od -A n -t x -N 2 /dev/urandom 2>/dev/null | tr -d ' ' || echo "$RANDOM")
    DNS_LABEL="${PREFERRED_DNS}-${SUFFIX}"
    echo "  Notice: '${PREFERRED_DNS}' was taken. Assigned unique label: ${DNS_LABEL}"
else
    echo "  DNS Label reserved: ${DNS_LABEL}"
fi

# 4. Create Resource Group in Allowed Region
echo "▸ Step 4/6: Creating Resource Group '${RESOURCE_GROUP}' in ${LOCATION}..."
az group create --name "${RESOURCE_GROUP}" --location "${LOCATION}" --output none
echo "  ✓ Resource group ready in ${LOCATION}"

# 5. Create Network Security Group & Security Rules (Port 22, 80, 443)
echo "▸ Step 5/6: Configuring Network Security Group..."
NSG_NAME="nsg-fira-student"
az network nsg create --resource-group "${RESOURCE_GROUP}" --name "${NSG_NAME}" --location "${LOCATION}" --output none

# Allow HTTP (Port 80)
az network nsg rule create \
  --resource-group "${RESOURCE_GROUP}" \
  --nsg-name "${NSG_NAME}" \
  --name Allow-HTTP \
  --priority 1000 \
  --destination-port-ranges 80 \
  --protocol Tcp \
  --access Allow \
  --output none

# Allow HTTPS (Port 443)
az network nsg rule create \
  --resource-group "${RESOURCE_GROUP}" \
  --nsg-name "${NSG_NAME}" \
  --name Allow-HTTPS \
  --priority 1010 \
  --destination-port-ranges 443 \
  --protocol Tcp \
  --access Allow \
  --output none

# Allow SSH (Port 22)
az network nsg rule create \
  --resource-group "${RESOURCE_GROUP}" \
  --nsg-name "${NSG_NAME}" \
  --name Allow-SSH \
  --priority 1020 \
  --destination-port-ranges 22 \
  --protocol Tcp \
  --access Allow \
  --output none
echo "  ✓ NSG created (Inbound allowed: 80, 443, 22)"

# 6. Create Virtual Machine
echo "▸ Step 6/7: Provisioning Virtual Machine '${VM_NAME}' (${VM_SIZE})..."
echo "  This typically takes 60–90 seconds..."

VM_OUTPUT=$(az vm create \
  --resource-group "${RESOURCE_GROUP}" \
  --name "${VM_NAME}" \
  --location "${LOCATION}" \
  --image "${IMAGE}" \
  --size "${VM_SIZE}" \
  --admin-username "${ADMIN_USER}" \
  --generate-ssh-keys \
  --nsg "${NSG_NAME}" \
  --public-ip-address-dns-name "${DNS_LABEL}" \
  --os-disk-size-gb 30 \
  --storage-sku StandardSSD_LRS \
  --security-type Standard \
  --output json)

PUBLIC_IP=$(echo "${VM_OUTPUT}" | grep -o '"publicIps": *"[^"]*"' | cut -d'"' -f4)
FQDN="${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"

echo "  ✓ VM created successfully!"
echo "  Public IP: ${PUBLIC_IP}"
echo "  FQDN:      http://${FQDN}"

# 7. Execute FIRA installation directly on the VM via Azure Run-Command
echo "▸ Step 7/7: Bootstrapping application on the VM..."
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
