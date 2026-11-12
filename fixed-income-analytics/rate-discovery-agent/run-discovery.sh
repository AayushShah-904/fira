#!/usr/bin/env bash
#
# run-discovery.sh — Invoke the Rate Discovery Agent for a single bank
#
# Usage:
#   ./run-discovery.sh "State Bank of India" "Public Sector Bank" "Maharashtra"
#   ./run-discovery.sh "Cosmos Co-operative Bank Ltd." "Scheduled Urban Co-operative Bank" "Maharashtra"
#   ./run-discovery.sh "HDFC Bank Limited"
#
# Arguments:
#   $1 — Bank name (required)
#   $2 — Category (optional, e.g., "Public Sector Bank")
#   $3 — State (optional, e.g., "Maharashtra")
#
# Output:
#   output/<bank_code>_config.json
#   output/<bank_code>_rates.json
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BANK_NAME="${1:?Usage: $0 <bank_name> [category] [state]}"
CATEGORY="${2:-}"
STATE="${3:-}"

# Build the input string
INPUT="Bank Name: ${BANK_NAME}"
[ -n "$CATEGORY" ] && INPUT="$INPUT | Category: $CATEGORY"
[ -n "$STATE" ]    && INPUT="$INPUT | State: $STATE"

echo "============================================"
echo " Rate Discovery Agent"
echo "============================================"
echo " Bank:     $BANK_NAME"
echo " Category: ${CATEGORY:-N/A}"
echo " State:    ${STATE:-N/A}"
echo "============================================"
echo ""

mkdir -p output

# Build the prompt by reading the template and substituting arguments
PROMPT=$(sed "s|\\\$ARGUMENTS|$INPUT|g" prompts/discover.md)

# Derive log file name
LOG_FILE="output/$(echo "$BANK_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '_' | tr -cd 'a-z0-9_').log"

# Invoke Claude Code — CLAUDE.md is auto-loaded from the current directory
claude \
  --print \
  --allowedTools "WebSearch,WebFetch,Edit,Write,Bash" \
  "$PROMPT" \
  2>&1 | tee "$LOG_FILE"

echo ""
echo "Done. Check the output/ directory for results."
