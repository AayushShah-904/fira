# ADR-003: Authentication model for PM's pack access

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — Entra ID service principal + client secret + bearer token |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-04 |
| Sprint | 001 |
| Supersedes | — |

## Context

The PM's website needs to fetch `rates-pack.json` from Azure Blob Storage. Constraints:

- The pack must **not be publicly accessible** (no anonymous-read containers).
- The credential must **not appear in URLs** (rules out query-string SAS — leaks into Azure Blob diagnostic logs, server access logs, browser histories, copy-paste-during-debugging).
- PM's site is currently hosted on a third-party VM (no Azure managed identity available there).
- PM's site will eventually move to Azure (timing unknown — months to a year).
- The agent / our team controls the storage account and Entra ID tenant; PM consumes only.
- The credential should be revocable / rotatable without disturbing the storage account itself.
- Auth setup on PM's side should not require non-trivial engineering.

## Options considered

### Option 1: Entra ID service principal + client secret + bearer token

**What it is:** Create an app registration in our Entra ID tenant, generate a service principal with `Storage Blob Data Reader` scoped to the `rates-pack` container only. Hand PM the tenant ID, client ID, and client secret. PM uses the Azure SDK (Node / Python / .NET — whatever fits their stack) which handles OAuth token acquisition + caching. Each blob request goes out as `Authorization: Bearer <oauth-token>`.

**Pros:**
- No credential in URL — bearer token in `Authorization` header, never logged by Azure Storage diagnostics with the value
- Token is short-lived (~1 hour) and auto-refreshed by the SDK; client secret is the only long-lived credential
- RBAC is scoped to one container only — defense in depth even if credential leaks
- Client secret is rotatable independently of the storage account key
- Standard pattern; SDK support is excellent in every language
- When PM moves to Azure, this becomes a one-line code change on their side (`ClientSecretCredential` → `ManagedIdentityCredential`); our RBAC binding stays the same

**Cons:**
- Two credentials to manage initially (client ID + client secret), not one
- Client secret expiry (default 24 months, recommend 90 days) requires periodic rotation — calendar reminder, not code
- Slightly more setup on PM's side than copy-pasting a SAS URL into a config

### Option 2: Container-level SAS token (with stored access policy)

**What it is:** Generate a long-lived SAS token (read-only, ~1 year expiry) on the `rates-pack` container, backed by a stored access policy so it can be revoked without rotating the storage account key. PM appends `?<sas>` to the blob URL for each request.

**Pros:**
- Simplest possible setup on PM's side — one URL with a query string
- Revocable via stored access policy revocation
- No Entra ID / SDK dependency on PM's side

**Cons:**
- **Credential in URL.** This is the disqualifying factor.
  - Azure Storage diagnostic logs record the full URL with SAS by default
  - Any reverse proxy / WAF / CDN in front of PM's site logs the URL
  - Outbound HTTP logs on PM's VM record it
  - Trivial to leak via screen-share, copy-paste during debugging, error messages
- SAS rotation requires hand-off to PM (same operational cost as client secret, with worse leakage profile)
- Container-level SAS is the coarsest granularity — no path-level scoping

### Option 3: Workload Identity Federation (WIF)

**What it is:** Configure Entra ID to trust an external identity provider (e.g., GitHub OIDC, or PM's third-party VM if it can produce a JWT). PM authenticates using their external identity; Entra ID issues a token with no long-lived secret involved.

**Pros:**
- No long-lived credential anywhere — most secure option
- Same downstream pattern as Option 1 (bearer token in header)
- Eliminates secret rotation entirely

**Cons:**
- PM's third-party VM needs an OIDC-capable identity provider configured. Not impossible but requires non-trivial setup on PM's side (their hosting provider's IAM, or running their own OIDC issuer).
- Significantly higher setup cost than Option 1
- Overkill for a single consumer in a friendly relationship
- Becomes redundant when PM moves to Azure (managed identity is simpler)

### Option 4: Storage account access key (shared key auth)

**What it is:** Hand PM the storage account's primary access key. PM uses it directly with the SDK via shared key auth.

**Pros:**
- Trivial to set up

**Cons:**
- Grants **full read/write access to every container in the storage account** — violates least privilege catastrophically
- Rotating the key requires updating every consumer
- No path scoping
- Disqualifying for any production use

### Option 5: Reverse proxy on our side (API Management / Front Door / Function)

**What it is:** Stand up an HTTPS endpoint we control (APIM, Front Door, or a Function app) that authenticates PM (any way we like — API key, Entra ID, mTLS) and proxies the blob fetch internally using managed identity.

**Pros:**
- Maximum control over auth layer
- Can add caching, rate limiting, custom logging
- PM sees a stable URL on our domain regardless of underlying storage changes

**Cons:**
- Extra moving part — APIM or Front Door is significant infrastructure
- APIM Consumption tier is ~$0 base but per-call pricing; Standard tier is $700+/mo
- Front Door adds ~$35+/mo base
- Function-as-proxy adds latency and yet another auth surface to design
- Solves a problem we don't have (PM is one consumer in a known relationship)

## Tradeoffs

| Axis | SP + secret | SAS | WIF | Account key | Reverse proxy |
|---|---|---|---|---|---|
| Credential in URL | No | **Yes** | No | No (header) | No |
| Setup cost (PM side) | Low | Trivial | Medium-high | Trivial | Trivial |
| Setup cost (our side) | Low | Low | Medium | Trivial | High |
| Rotation friction | Low (90d) | Low (annual) | None | High | None for PM |
| Granularity | Container-scoped | Container-scoped | Container-scoped | Account-wide | Whatever we build |
| Fits PM-on-VM | Yes | Yes | With effort | Yes | Yes |
| Migration path when PM moves to Azure | Trivial (one line) | Migrate to MI | Already MI-equivalent | Migrate to MI | Migrate to direct |
| Operational cost | $0 | $0 | $0 | $0 | $0–$700/mo |

## Recommendation

**Option 1: Entra ID service principal + client secret + bearer token.**

Reasoning: It's the only option that simultaneously (a) keeps credentials out of URLs, (b) doesn't require PM-side OIDC infrastructure, (c) fits a third-party VM today, and (d) has a trivial migration path when PM moves to Azure. SAS is disqualified by the URL-credential leakage profile (the user explicitly raised this concern). WIF is the right answer for a hostile or zero-trust environment, but the setup cost isn't justified for a single trusted consumer with a well-known migration path. Reverse proxy is overkill.

The 90-day client secret rotation is real but manageable — a calendar reminder and a 5-minute hand-off procedure.

## Consequences

If Option 1 is chosen:
- We create app registration `app-bird-pm-rates-reader` in our Entra ID tenant (this is a tenant-scoped resource, not in the resource group)
- Service principal gets `Storage Blob Data Reader` role assignment scoped to `rates-pack` container only — nothing else
- We hand PM three values out-of-band: tenant ID, client ID, client secret (initial value)
- PM's server stores these as server-side secrets; uses Azure SDK to fetch
- Documented secret rotation procedure: generate new secret, share with PM, confirm switchover, delete old secret
- On PM-moves-to-Azure: PM swaps `ClientSecretCredential` for `ManagedIdentityCredential` (or `DefaultAzureCredential`); we rebind the same role to PM's new managed identity; delete the service principal

Lock-in: low. The bearer-token-via-OAuth pattern is standard and portable; switching to WIF later is incremental, not disruptive.

## Open questions (deferred to sprint 001 implementation)

The following do not change the architectural decision and will be resolved when the PM handoff is scheduled during sprint 001 implementation:

1. **PM's site runtime stack** — determines which Azure SDK documentation we hand over (Node `@azure/storage-blob` + `@azure/identity`, Python `azure-storage-blob` + `azure-identity`, .NET, etc.).
2. **Secret-sharing channel** — 1Password share, encrypted email, in-person. Shapes the rotation procedure documentation.
3. **Tenant selection** — which Entra tenant hosts the app registration if there are multiple to choose from.

## Decision log

- **2026-05-04** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (Entra ID service principal + client secret + bearer token)**.
  - Decision originated earlier in the design conversation when the SAS-in-URL leakage profile was raised as disqualifying. Option 2 (SAS) was ruled out on those grounds. Options 4 (account key — over-privileged) and 5 (reverse proxy — overkill) were also ruled out.
  - Option 3 (Workload Identity Federation) is the right answer for a zero-trust environment but requires OIDC setup on PM's third-party VM — disproportionate for a trusted single-consumer relationship with a known migration path.
  - Migration path when PM's site moves to Azure: client secret swap to managed identity is a one-line change on PM's side; the same RBAC binding stays in place on our side.
  - Three open questions deferred to sprint 001 implementation phase — they affect handoff logistics, not the architectural decision.
