#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# setup-azure-devops.sh
# ═══════════════════════════════════════════════════════════════
# Zero-Touch automation script for Azure DevOps CI/CD setup.
# Creates service connections, pipeline, and permissions for
# deploying an Angular 17 app to Azure App Service.
#
# Prerequisites:
#   - Azure CLI installed          (https://aka.ms/install-azure-cli)
#   - GitHub PAT with repo scope   (https://github.com/settings/tokens)
#   - Bash 4+ (Git Bash on Windows, or WSL)
#
# Usage:
#   chmod +x scripts/setup-azure-devops.sh
#   ./scripts/setup-azure-devops.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

log_step()  { echo -e "\n${CYAN}${BOLD}[Step $1/$TOTAL_STEPS] $2${NC}"; }
log_ok()    { echo -e "${GREEN}✔ $1${NC}"; }
log_warn()  { echo -e "${YELLOW}⚠ $1${NC}"; }
log_err()   { echo -e "${RED}✖ $1${NC}"; }

TOTAL_STEPS=7

# ═══════════════════════════════════════════════════════════════
# STEP 1 — CHECK DEPENDENCIES
# ═══════════════════════════════════════════════════════════════
log_step 1 "Checking dependencies..."

# 1a. Azure CLI
if ! command -v az &> /dev/null; then
    log_err "azure-cli is NOT installed."
    echo "  Install it from: https://aka.ms/install-azure-cli"
    exit 1
fi
AZ_VERSION=$(az version --query '"azure-cli"' -o tsv 2>/dev/null)
log_ok "azure-cli found (v${AZ_VERSION})"

# 1b. jq (used for JSON parsing)
if ! command -v jq &> /dev/null; then
    log_err "jq is NOT installed. Install it: https://stedolan.github.io/jq/download/"
    exit 1
fi
log_ok "jq found"

# 1c. Azure DevOps extension
if ! az extension show --name azure-devops &> /dev/null 2>&1; then
    log_warn "azure-devops extension not found. Installing..."
    az extension add --name azure-devops --yes --only-show-errors
fi
log_ok "azure-devops extension installed"

echo -e "${GREEN}All dependencies satisfied.${NC}"

# ═══════════════════════════════════════════════════════════════
# STEP 2 — INTERACTIVE INPUTS
# ═══════════════════════════════════════════════════════════════
log_step 2 "Collecting configuration..."

read -rp "Azure DevOps Organization Name (e.g. myorg):  " ORG_NAME
read -rp "Azure DevOps Project Name:                     " PROJECT_NAME
read -rp "GitHub Repository (owner/repo):                " GITHUB_REPO
read -rp "Azure Resource Group Name:                     " RESOURCE_GROUP
read -rp "Azure Web App Name:                            " WEB_APP_NAME
read -rsp "GitHub Personal Access Token (PAT):           " GITHUB_PAT
echo ""

# Derived values
ORG_URL="https://dev.azure.com/${ORG_NAME}"
ARM_SC_NAME="arm-${WEB_APP_NAME}"
GITHUB_SC_NAME="github-${ORG_NAME}"
PIPELINE_NAME="${WEB_APP_NAME}-CI-CD"

echo ""
echo -e "${BOLD}Configuration summary:${NC}"
echo "  Organization:     ${ORG_URL}"
echo "  Project:          ${PROJECT_NAME}"
echo "  GitHub Repo:      ${GITHUB_REPO}"
echo "  Resource Group:   ${RESOURCE_GROUP}"
echo "  Web App:          ${WEB_APP_NAME}"
echo "  ARM SC Name:      ${ARM_SC_NAME}"
echo "  GitHub SC Name:   ${GITHUB_SC_NAME}"
echo "  Pipeline Name:    ${PIPELINE_NAME}"
echo ""
read -rp "Proceed? (y/N): " CONFIRM
if [[ ! "${CONFIRM}" =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# ═══════════════════════════════════════════════════════════════
# STEP 3 — AUTHENTICATION
# ═══════════════════════════════════════════════════════════════
log_step 3 "Authenticating..."

# 3a. Azure login (opens browser if not already logged in)
echo "Checking Azure login status..."
if ! az account show &> /dev/null; then
    echo "Launching Azure login..."
    az login --only-show-errors
fi
CURRENT_ACCOUNT=$(az account show --query "user.name" -o tsv)
log_ok "Logged in to Azure as: ${CURRENT_ACCOUNT}"

# 3b. Capture subscription details
SUBSCRIPTION_ID=$(az account show --query "id" -o tsv)
SUBSCRIPTION_NAME=$(az account show --query "name" -o tsv)
TENANT_ID=$(az account show --query "tenantId" -o tsv)
echo "  Subscription: ${SUBSCRIPTION_NAME} (${SUBSCRIPTION_ID})"

# 3c. Validate that the Resource Group exists
if ! az group show --name "${RESOURCE_GROUP}" &> /dev/null; then
    log_err "Resource Group '${RESOURCE_GROUP}' does not exist in subscription '${SUBSCRIPTION_NAME}'."
    exit 1
fi
log_ok "Resource Group '${RESOURCE_GROUP}' found"

# 3d. Validate that the Web App exists
if ! az webapp show --name "${WEB_APP_NAME}" --resource-group "${RESOURCE_GROUP}" &> /dev/null; then
    log_err "Web App '${WEB_APP_NAME}' does not exist in Resource Group '${RESOURCE_GROUP}'."
    exit 1
fi
log_ok "Web App '${WEB_APP_NAME}' found"

# 3e. Configure Azure DevOps defaults
az devops configure --defaults organization="${ORG_URL}" project="${PROJECT_NAME}"
log_ok "Azure DevOps defaults set (org=${ORG_URL}, project=${PROJECT_NAME})"

# ═══════════════════════════════════════════════════════════════
# STEP 4 — CREATE ARM SERVICE CONNECTION
# ═══════════════════════════════════════════════════════════════
log_step 4 "Creating ARM Service Connection..."

# Check if the ARM service connection already exists
EXISTING_ARM_ID=$(az devops service-endpoint list \
    --query "[?name=='${ARM_SC_NAME}'].id" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_ARM_ID}" ]; then
    log_warn "ARM Service Connection '${ARM_SC_NAME}' already exists (ID: ${EXISTING_ARM_ID}). Skipping creation."
    ARM_SC_ID="${EXISTING_ARM_ID}"
else
    # 4a. Create a Service Principal scoped to the Resource Group
    echo "Creating Service Principal for DevOps (scoped to ${RESOURCE_GROUP})..."
    SP_JSON=$(az ad sp create-for-rbac \
        --name "sp-${WEB_APP_NAME}-devops" \
        --role Contributor \
        --scopes "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}" \
        --output json)

    SP_APP_ID=$(echo "${SP_JSON}" | jq -r '.appId')
    SP_PASSWORD=$(echo "${SP_JSON}" | jq -r '.password')
    SP_TENANT=$(echo "${SP_JSON}" | jq -r '.tenant')

    log_ok "Service Principal created (appId: ${SP_APP_ID})"

    # 4b. Create the ARM service endpoint in Azure DevOps
    # The SP key is passed via an environment variable (secure, not in CLI args)
    echo "Registering ARM Service Connection in Azure DevOps..."
    export AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY="${SP_PASSWORD}"

    ARM_SC_ID=$(az devops service-endpoint azurerm create \
        --azure-rm-service-principal-id "${SP_APP_ID}" \
        --azure-rm-subscription-id "${SUBSCRIPTION_ID}" \
        --azure-rm-subscription-name "${SUBSCRIPTION_NAME}" \
        --azure-rm-tenant-id "${SP_TENANT}" \
        --name "${ARM_SC_NAME}" \
        --query "id" -o tsv)

    unset AZURE_DEVOPS_EXT_AZURE_RM_SERVICE_PRINCIPAL_KEY

    log_ok "ARM Service Connection created (ID: ${ARM_SC_ID})"
fi

# ═══════════════════════════════════════════════════════════════
# STEP 5 — CREATE GITHUB SERVICE CONNECTION
# ═══════════════════════════════════════════════════════════════
log_step 5 "Creating GitHub Service Connection..."

EXISTING_GH_ID=$(az devops service-endpoint list \
    --query "[?name=='${GITHUB_SC_NAME}'].id" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_GH_ID}" ]; then
    log_warn "GitHub Service Connection '${GITHUB_SC_NAME}' already exists (ID: ${EXISTING_GH_ID}). Skipping creation."
    GH_SC_ID="${EXISTING_GH_ID}"
else
    # The PAT is passed via environment variable (secure)
    export AZURE_DEVOPS_EXT_GITHUB_PAT="${GITHUB_PAT}"

    GH_SC_ID=$(az devops service-endpoint github create \
        --github-url "https://github.com" \
        --name "${GITHUB_SC_NAME}" \
        --query "id" -o tsv)

    unset AZURE_DEVOPS_EXT_GITHUB_PAT

    log_ok "GitHub Service Connection created (ID: ${GH_SC_ID})"
fi

# ═══════════════════════════════════════════════════════════════
# STEP 6 — GRANT PIPELINE PERMISSIONS TO SERVICE CONNECTIONS
# ═══════════════════════════════════════════════════════════════
log_step 6 "Granting pipeline permissions to Service Connections..."

# Grant all pipelines access to the ARM connection
az devops service-endpoint update \
    --id "${ARM_SC_ID}" \
    --enable-for-all true \
    --only-show-errors
log_ok "ARM Service Connection '${ARM_SC_NAME}' → accessible by all pipelines"

# Grant all pipelines access to the GitHub connection
az devops service-endpoint update \
    --id "${GH_SC_ID}" \
    --enable-for-all true \
    --only-show-errors
log_ok "GitHub Service Connection '${GITHUB_SC_NAME}' → accessible by all pipelines"

# ═══════════════════════════════════════════════════════════════
# STEP 7 — CREATE THE PIPELINE
# ═══════════════════════════════════════════════════════════════
log_step 7 "Creating Azure DevOps Pipeline..."

# Check if pipeline already exists
EXISTING_PIPELINE_ID=$(az pipelines list \
    --query "[?name=='${PIPELINE_NAME}'].id | [0]" -o tsv 2>/dev/null || true)

if [ -n "${EXISTING_PIPELINE_ID}" ]; then
    log_warn "Pipeline '${PIPELINE_NAME}' already exists (ID: ${EXISTING_PIPELINE_ID}). Skipping creation."
else
    az pipelines create \
        --name "${PIPELINE_NAME}" \
        --repository "${GITHUB_REPO}" \
        --repository-type github \
        --branch main \
        --yml-path azure-pipelines.yml \
        --service-connection "${GH_SC_ID}" \
        --skip-first-run true \
        --only-show-errors

    log_ok "Pipeline '${PIPELINE_NAME}' created"
fi

# Set the webAppName pipeline variable so the YAML can reference it
PIPELINE_ID=$(az pipelines list \
    --query "[?name=='${PIPELINE_NAME}'].id | [0]" -o tsv)

az pipelines variable create \
    --pipeline-id "${PIPELINE_ID}" \
    --name "webAppName" \
    --value "${WEB_APP_NAME}" \
    --only-show-errors 2>/dev/null || \
az pipelines variable update \
    --pipeline-id "${PIPELINE_ID}" \
    --name "webAppName" \
    --value "${WEB_APP_NAME}" \
    --only-show-errors 2>/dev/null || true

log_ok "Pipeline variable 'webAppName' set to '${WEB_APP_NAME}'"

# ═══════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  SETUP COMPLETE — Zero-Touch Configuration Finished!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Pipeline:${NC}           ${PIPELINE_NAME}"
echo -e "  ${BOLD}Organization:${NC}       ${ORG_URL}"
echo -e "  ${BOLD}Project:${NC}            ${PROJECT_NAME}"
echo -e "  ${BOLD}ARM Connection:${NC}     ${ARM_SC_NAME}  (ID: ${ARM_SC_ID})"
echo -e "  ${BOLD}GitHub Connection:${NC}  ${GITHUB_SC_NAME}  (ID: ${GH_SC_ID})"
echo -e "  ${BOLD}Web App:${NC}            ${WEB_APP_NAME}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "    1. Push your code (with the new azure-pipelines.yml) to main"
echo -e "    2. The pipeline will trigger automatically"
echo -e "    3. Monitor at: ${ORG_URL}/${PROJECT_NAME}/_build"
echo ""
