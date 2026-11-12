# ADR-007: Azure region

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | South India (`southindia`) |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-05 |
| Sprint | 001 |
| Supersedes | — |

## Context

The agent and all its supporting Azure resources must be deployed to a specific Azure region. The choice affects:

- Azure OpenAI model availability (the model menu varies significantly per region)
- Latency to Indian bank websites (the agent's primary HTTP targets)
- Latency for PM's site fetching the pack (currently on a third-party VM, location unknown but likely India-based)
- Data residency expectations (banks' rate data is public, so this isn't a hard constraint)
- Azure service availability for non-OpenAI services we depend on (Container Apps Jobs, Key Vault, Functions — these are broadly available, but some preview features lag in non-US regions)

## Options considered

### Option 1: South India (`southindia`)

**What it is:** Azure's Chennai region. Verified May 2026 against the Microsoft Learn region matrix for Azure OpenAI.

**Pros:**
- **Comprehensive Azure OpenAI model coverage** — verified to host:
  - GPT-5 family (gpt-5, gpt-5-mini, gpt-5-nano, gpt-5.1/5.2/5.3/5.4 chat + codex variants, gpt-5-pro)
  - Reasoning models (o1, o3, o3-mini, o4-mini)
  - GPT-4 family (gpt-4o, gpt-4o-mini, gpt-4.1 + variants)
  - Embeddings (text-embedding-3-large, ada-002), Whisper
- All major deployment types (Standard, Global Standard, Provisioned Managed, Global Batch)
- Lowest latency to Indian bank websites
- Lowest latency to PM's site (assuming India hosting)
- All non-OpenAI services we need (Container Apps Jobs, Functions, Storage, Key Vault, ACR) are GA
- Data resides in India — aligns with any future data residency expectations even if not strictly required

**Cons:**
- Some Azure preview features land in US/Europe regions first (e.g., new Container Apps features, new Functions runtimes) — possible lag of weeks to months
- Cost is essentially identical to other regions for our service set

### Option 2: Central India (`centralindia`)

**What it is:** Azure's Pune region.

**Pros:**
- Slightly closer to North/Central India bank locations (negligible practical difference)
- All non-OpenAI services available

**Cons:**
- **Azure OpenAI is not hosted in Central India** (verified against Microsoft Learn) — this is disqualifying for our use case
- Would have to use cross-region calls to Azure OpenAI in another region (added latency, cross-region egress cost, more failure surface)

### Option 3: A US or European region (e.g., `eastus`, `swedencentral`)

**What it is:** Use a region with the broadest Azure OpenAI model availability and feature freshness.

**Pros:**
- Often the first region for new Azure OpenAI features and models
- Largest pool of compute capacity (less likely to hit quota / capacity issues)
- Mature ecosystem, most documentation examples written for these regions

**Cons:**
- Higher latency to Indian bank websites (~150–250ms RTT vs. ~10–30ms from India regions) — adds up across hundreds of HTTP requests per agent run
- Higher latency for PM's site fetching the pack
- Cross-region cost if we need to read from Indian sources (negligible at our volume but counts)
- No data residency benefit
- Politically odd (Indian bank data going via US) for a system focused on India

### Option 4: Multi-region (active-passive or active-active)

**What it is:** Deploy the agent in two regions with failover.

**Pros:**
- High availability
- Disaster recovery story

**Cons:**
- Doubles infra cost
- Adds significant complexity (replication, failover orchestration, DNS)
- The agent has no HA requirement — it can fail and re-run, the published pack is idempotent
- Disproportionate to the workload

## Tradeoffs

| Axis | South India | Central India | US/EU | Multi-region |
|---|---|---|---|---|
| Azure OpenAI availability | Excellent | **None** | Excellent | Excellent (one region) |
| Latency to Indian banks | Low | Low | High | Mixed |
| Latency to PM (assumed India) | Low | Low | High | Mixed |
| Service freshness | Good | Good | Best | Best |
| Cost | Standard | Standard | Standard | 2× |
| Complexity | Low | Low | Low | High |
| Data residency in India | Yes | Yes | No | Mixed |

## Recommendation

**South India (`southindia`).**

Reasoning: The combination of comprehensive Azure OpenAI coverage AND low latency to Indian bank websites AND low latency to PM's site makes South India unambiguously the right answer. Central India is disqualified by Azure OpenAI not being hosted there. US/EU regions are operationally feasible but accept latency penalties for no compensating benefit (we don't need preview features that haven't reached India yet).

The "service freshness lag" downside of South India is real but minor — Container Apps Jobs and Functions are mature, and we're not chasing bleeding-edge Azure features.

## Consequences

If chosen:
- All Bicep modules deploy to `location: 'southindia'`
- Azure OpenAI resource provisioned in South India (or referenced if one already exists)
- All resources in resource group `rg-bird-rate-agent-southindia` (name encodes region for clarity)
- Future: if model availability changes such that South India falls behind on a model we want to adopt, the architecture is region-portable — only Bicep `location` parameter and the Azure OpenAI endpoint URL change

Lock-in: low. Storage, container images, and Bicep are region-agnostic. Migrating regions later requires re-provisioning + data copy + DNS / endpoint updates, but no code changes.

## Open questions (resolved + deferred)

1. **Existing Azure OpenAI resource?** RESOLVED — yes, an existing Azure OpenAI resource is already provisioned in South India and will be referenced (not re-provisioned) by the Bicep deployment. Bicep parameter `existingAzureOpenAIResourceId` carries the ARM resource ID; the agent's managed identity gets `Cognitive Services OpenAI User` role assignment scoped to that resource.
2. **Capacity quotas?** DEFERRED — confirm during sprint 001 implementation when first batch deploy is sized. Sprint 001 smoke test (one bank end-to-end) won't stress quotas; sprint 002 tier-batched runs may.
3. **Reservations / savings plans?** DEFERRED — re-check when usage stabilizes and predictable monthly spend can justify a reservation.

## Decision log

- **2026-05-05** — Status: PROPOSED → DECIDED. Chosen option: **South India (`southindia`)**.
  - Confirmed by web verification (May 2026) against the Microsoft Learn region matrix: South India has comprehensive Azure OpenAI model coverage including GPT-5 family, o1/o3/o4-mini, GPT-4o, GPT-4.1, embeddings, and Whisper.
  - Central India ruled out — Azure OpenAI is not hosted there.
  - US / Europe regions ruled out — adds 150–250ms RTT to Indian bank websites for no benefit we'd actually use; preview-feature freshness is not a current need.
  - Existing Azure OpenAI resource in South India will be referenced rather than re-provisioned.
