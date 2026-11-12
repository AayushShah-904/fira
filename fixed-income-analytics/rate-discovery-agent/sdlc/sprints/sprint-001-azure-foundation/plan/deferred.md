# Sprint 001 — Deferred items

Each item below is a conscious choice **not** to do something in sprint 001, with the reason and the condition under which it should be revisited. When a future sprint opens, its plan reviews this list and pulls in any item whose revisit condition has triggered.

## 1. Manual `az acr build` instead of CI/CD on push

**Choice taken:** Image rebuilds happen by running `az acr build --registry <acr> --image rate-discovery-agent:<tag> .` from a developer machine.

**Why deferred:** Image change rate is currently low (the agent code stabilizes between gap-fill batches; not every commit needs a rebuild). Setting up GitHub Actions or Azure DevOps Pipelines for build + deploy adds setup time, runner-cost, and one more secret-management surface for sprint 001 to cover.

**Revisit when:** image rebuilds happen more than once per week, or a second person needs to push images. Tracked in sprint 004 (CI/CD).

## 2. PM uses service principal client secret instead of managed identity

**Choice taken:** PM's third-party VM authenticates to the `rates-pack` container using `tenant_id` + `client_id` + `client_secret`, all stored as server-side secrets on PM's VM. Each blob request goes out as `Authorization: Bearer <oauth-token>`.

**Why deferred:** Managed identity is only available to workloads running inside Azure (or with Workload Identity Federation set up — non-trivial to bootstrap on a third-party VM). PM's site is not on Azure today.

**Revisit when:** PM's site moves to Azure. The migration is a single change on PM's side (swap `ClientSecretCredential` for `ManagedIdentityCredential` in their Azure SDK call) and a one-time RBAC re-binding on our side. The role assignment itself stays on the same blob container.

## 3. Tiered cron instead of per-bank schedules

**Choice taken:** Sprint 002 will introduce 3–5 named tiers (e.g., `daily`, `weekly`, `monthly`), each running a list of banks. Bank-to-tier assignment lives in `bank-domains.json` as a `refresh_cadence` field.

**Why deferred:** Per-bank schedules at the platform level (one Container Apps Job per bank) hit per-environment job limits and operational complexity scales linearly with bank count (~1900). The tiered approach handles ~95% of real demand at a fraction of the complexity.

**Revisit when:** there is concrete business demand for more than 5 distinct schedules — e.g., a partnership that requires sub-daily refresh of specific banks, or a regulatory hook tied to a specific bank's release cycle. At that point, store schedules as data (not as infra) and dispatch from a Logic App or a custom scheduler.

## 4. Function key auth on the trigger endpoint

**Choice taken:** The HTTP Function uses an Azure Functions function key (a static long-lived shared secret) for authentication.

**Why deferred:** It is the lowest-friction option for a single-operator scenario (you trigger runs from your machine). Entra ID auth on Functions (via Easy Auth or middleware) requires either a token-issuing setup or a federated identity flow on the caller side — both more setup than the current need warrants.

**Revisit when:** the trigger endpoint is shared with anyone other than you (PM, a teammate, an automation system), or when audit requirements need to attribute each invocation to a specific identity rather than a shared secret.

## 5. Single environment (no dev / staging / prod separation)

**Choice taken:** One resource group, one Container Apps Job, one storage account, one published pack. All work happens in `prod`.

**Why deferred:** The agent is read-only on the world (it scrapes), regenerable on failure (re-run the discovery), and has no business-critical SLA on the published pack today. The cost of two parallel environments (~$15/mo each) and the operational overhead (twice the secrets, twice the deploys) are not justified by the risk profile.

**Revisit when:** a non-trivial pipeline change needs end-to-end testing without risking the live pack, or a second engineer needs a sandbox, or the pack consumer becomes business-critical with a defined SLA. Sprint 005 owns this split when it triggers.

## 6. No VNet integration / public endpoints with key-based auth

**Choice taken:** Storage account, Key Vault, ACR, Container Apps Environment all use public endpoints. Access is gated by managed identity / RBAC, not by network boundary.

**Why deferred:** No compliance or threat-model driver. VNet integration adds a private endpoint per service (~$7/mo each), private DNS zones, and the Container Apps environment switches to internal-only mode (which then needs a VNet-peered jump host or VPN for the developer). Disproportionate cost and complexity for the current security posture.

**Revisit when:** a compliance audit requires it, or the agent starts handling truly sensitive data (it currently scrapes only public bank rate pages — nothing PII).

## 7. PDF FCNR currency parsing in `extract_rates_pdf.mjs`

**Choice taken:** The deterministic PDF text parser in `scripts/extract_rates_pdf.mjs` does not detect FCNR currency from PDF section headers. All FCNR currency assignment currently happens upstream — the agent (LLM + Playwright + accordion-expanded HTML) reads PDF text and infers currency at extraction time.

**Why deferred:** All 49 FCNR files / 910 slabs across 13 currencies currently have `currency` populated correctly via the agent's extraction path. The deterministic-parser gap has no observable production impact.

**Revisit when:** an FCNR-bearing bank publishes a PDF that the agent cannot extract correctly (no working Playwright path, only a PDF). At that point, add section-header currency detection to `extract_rates_pdf.mjs`. Until then, this is a paper concern.

## 8. Cost monitoring on Azure OpenAI consumption

**Choice taken:** Sprint 001 sets a single $100/month budget alert on `rg-bofia-rate-agent-prod-southindia` only. The Azure OpenAI account (`bo-ai-dev-api` in RG `bo-ai-dev`) — which is the dominant cost driver — has **no FIA-specific budget alert** in sprint 001.

**Why deferred:**
- Sprint 001 smoke is one-bank, ~$0.05 of LLM cost. The infra-RG budget alone is a sufficient guardrail at this scale.
- The AOAI account is hosted in a different resource group (`bo-ai-dev`), and it's not yet confirmed whether that RG is dedicated to FIA workloads or shared with other projects. Setting a scope-based budget without that information would either (a) fire on unrelated workloads if shared, or (b) need to be re-scoped later. Better to wait until usage data exists.
- The agent's own `lib/cost-tracker.js` already captures per-run, per-bank token + USD cost in run summaries — finer-grained signal than Azure budgets can provide. That's the working operational telemetry for sprint 001.

**Revisit when:** sprint 002 plans the tier-batched cron and we have actual batch-cadence data. At that point the realistic monthly AOAI spend is calibrated and a budget can be sized with confidence. Likely sizing inputs at that time:
- Cost per gap-fill batch (~$55 for 251 banks observed; extrapolating to ~$375 for the remaining ~1700 banks during initial bulk discovery)
- Steady-state refresh cadence (monthly per bank ≈ ~$200/mo; quarterly per bank ≈ ~$70/mo)
- Ad-hoc debugging / re-discovery overhead (~$20–50/mo realistic)

Three concrete options to evaluate at that time:
- **Scope-based budget on `bo-ai-dev` RG** — works cleanly only if the RG is dedicated to FIA
- **Subscription-level budget with tag/deployment-name filter** — works for shared RGs, but Azure budget alerts don't support deployment-name filtering (only Cost Analysis does)
- **Migrate to a dedicated FIA AOAI account** — clean attribution, adds ~$0/mo (consumption-priced) but requires extra Bicep + deployment migration

**Note on hard caps vs. alerts:** Azure budgets alert; they do not stop spending. Hard caps need separate mechanisms (the agent's own cost-tracker kill-switch, or capping the AOAI deployment's TPM quota). That's a sprint 003 hardening conversation, not a sprint 002 budget conversation.

## How items are added or removed from this list

- **Added:** during sprint planning, when a deliberate scope cut is made. The item must have all three fields (choice, why, revisit) populated.
- **Removed:** when a future sprint pulls the item into its scope and addresses it. The retrospective for that sprint references the deferred item as resolved.
- **Updated:** if the revisit condition changes (e.g., PM site moves to Azure earlier than expected, triggering item 2 ahead of schedule), update the entry in place; do not silently drop it.
