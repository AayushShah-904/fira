# ADR-010: Blob storage layout and naming

| Field | Value |
|---|---|
| Status | DECIDED |
| Decision | Option 1 — One storage account, two containers (`agent-state` + `rates-pack`); per-run logs in `agent-state/runs/<ISO-timestamp>/`; last-writer-wins concurrency |
| Decided by | Samir Joshi |
| Date drafted | 2026-05-02 |
| Date decided | 2026-05-05 |
| Sprint | 001 |
| Supersedes | — |

## Context

When the agent runs in containerized mode (ADR-004), its state and outputs live in Azure Blob Storage. We need to decide:

1. How many storage accounts to provision
2. How many containers within each account, and what they hold
3. The blob naming convention (key structure)
4. How concurrent runs avoid clobbering each other (per-run logs vs. shared state)
5. Whether to version anything (the published pack, the bank-domains map)

The local filesystem layout (`output/latest/`, `data/bank-domains.json`, `pack/dist/`) is the starting point — the question is how that maps to blob storage in a way that fits Azure conventions and the access-control needs of the two tenants (the agent's managed identity, and PM's service principal from ADR-003).

## Options considered

### Option 1: Single account, two containers (`agent-state` + `rates-pack`)

**Layout:**
```
storage account: stbirdratepack<unique>
├── Container: agent-state              (private, agent MI has R/W)
│   ├── data/bank-domains.json
│   ├── output/latest/<slug>_*.json
│   ├── output/latest/_bank_index.json
│   ├── output/latest/legacy/...
│   └── runs/<ISO-timestamp>/<slug>.log + .summary.json
└── Container: rates-pack               (private, PM SP has R)
    ├── rates-pack.json
    ├── rates-pack.schema.json
    └── README.md
```

**Pros:**
- One storage account to provision, monitor, alert on
- RBAC granularity at the container level — agent MI gets data-contributor on both, PM SP gets data-reader on `rates-pack` only
- Cost-effective (one account's overhead)
- Logically clean: `agent-state` = "what the agent works with"; `rates-pack` = "what consumers receive"
- Per-run logs in `runs/<timestamp>/` separate from canonical `output/latest/` — handles concurrent batch runs cleanly

**Cons:**
- Single point of failure (one account compromise affects both areas) — but RBAC scoping limits blast radius
- `runs/` accumulates over time — needs a lifecycle policy (e.g., delete runs older than 30 days)

### Option 2: Two accounts (one for agent state, one for published pack)

**Layout:**
```
storage account: stagentstate<unique>     (private, agent MI has R/W)
└── Container: state
    └── ... (data, output, runs)

storage account: stratespack<unique>      (private, PM SP has R)
└── Container: pack
    └── rates-pack.json + schema + README
```

**Pros:**
- Strong isolation — compromise of one account doesn't affect the other
- Could enable separate cost tracking (agent infra cost vs. pack distribution cost)
- Flexible access policies — different storage account-level firewalls, redundancy tiers, etc.

**Cons:**
- Two accounts to provision, monitor, alert on, manage diagnostic settings for
- Higher overhead with no commensurate benefit at our scale
- Cross-account writes (agent → pack account) require credentials in both — slightly more complex auth
- ~2× the storage account base cost (small but real)

### Option 3: One container with prefix-based separation

**Layout:**
```
storage account: stbird<unique>
└── Container: data
    ├── agent-state/data/bank-domains.json
    ├── agent-state/output/latest/...
    └── public/rates-pack.json
```

**Pros:**
- Simplest possible — one account, one container
- All keys in one place

**Cons:**
- **RBAC cannot scope below container level** in Azure Blob — PM SP would get read access to the entire container, including agent state
- Forces use of SAS tokens or Azure ABAC (preview) for prefix-level scoping — neither is clean
- Increases blast radius if the PM SP credential leaks
- Disqualifying for our access-control needs

### Option 4: Versioned pack (date-suffixed publishes)

**Layout (extends Option 1):**
```
rates-pack/
├── latest/                       (always points to most recent)
│   ├── rates-pack.json
│   └── rates-pack.schema.json
└── archive/
    ├── 2026-05-02-rates-pack.json
    ├── 2026-05-09-rates-pack.json
    └── ...
```

**Pros:**
- Historical packs available for audit / rollback
- Consumers can pin to a specific version
- "What changed between weekly publishes" is answerable

**Cons:**
- PM is the only consumer and doesn't currently need history
- Storage cost grows linearly (mitigated by lifecycle policy)
- Adds complexity to publish (which path to write, how to atomically swap "latest")
- `latest` swap is tricky in blob storage (no atomic rename across paths) — typically done by copy + delete, with a window of inconsistency

### Option 5: Hierarchical Namespace (Data Lake Gen2) instead of plain blob

**What it is:** Enable Azure Data Lake Storage Gen2 features on the storage account — adds true hierarchical filesystem semantics (atomic directory rename, real folder ACLs).

**Pros:**
- Atomic directory operations
- POSIX-style permissions in addition to RBAC
- Better fit if we ever want to use the data lake analytics ecosystem

**Cons:**
- Slightly more expensive
- Some Blob SDK operations behave differently — added complexity
- We don't need atomic directory ops — our writes are file-by-file and the "last writer wins" model is acceptable
- Overkill for our access pattern (small files, infrequent writes)

## Tradeoffs

| Axis | 1 acct + 2 containers | 2 accounts | 1 container | Versioned | Hierarchical NS |
|---|---|---|---|---|---|
| RBAC granularity | Container | Account | None below container | Container | Container + ACL |
| Operational overhead | Low | Medium | Lowest | Medium | Low |
| Cost | Low | ~2× base | Lowest | Slightly higher (storage growth) | Slightly higher |
| Blast radius | Container | Account | Account | Container | Container/ACL |
| Fits PM access-control model | Yes | Yes | No (disqualifying) | Yes | Yes (overkill) |
| Audit / history | None | None | None | Yes | Yes (via versioning) |
| Concurrency story (logs) | Per-run subfolder | Per-run subfolder | Per-run subfolder | Per-run subfolder | Per-run subfolder |

## Recommendation

**Option 1: One storage account, two containers (`agent-state` + `rates-pack`).**

Reasoning: RBAC scoping is achievable at container level — agent MI gets `Storage Blob Data Contributor` on both, PM SP gets `Storage Blob Data Reader` on `rates-pack` only. That cleanly satisfies the "PM cannot read agent state, agent cannot accidentally write to PM's pack" requirements with a single account's operational overhead.

Two accounts (Option 2) over-engineer for our scale. Single container (Option 3) violates the access-control requirement. Versioned pack (Option 4) is a nice-to-have but PM has not asked for it — defer until requested. Hierarchical Namespace (Option 5) solves problems we don't have.

**Sub-decision: per-run logs in `agent-state/runs/<timestamp>/`**, separate from the canonical `agent-state/output/latest/`. This avoids concurrent batch runs clobbering each other's logs (which would be a real risk if logs lived alongside config/rate files in `output/latest/`). The local filesystem mode keeps logs in `output/latest/` for developer convenience — the storage adapter handles the divergence transparently.

**Sub-decision on concurrency:** Last-writer-wins at the file level. This is the natural blob semantics, and is acceptable because (a) manual triggers are operator-driven and serialized in practice, (b) scheduled tier-batched runs in sprint 002 have no per-bank overlap by design, (c) the pack is regenerated end-to-end on each publish so partial states don't propagate. No conditional writes, no etag handling required for sprint 001.

## Proposed key conventions

- **Forward-slash separators throughout.** Matches blob conventions and is portable to fs (storage adapter normalizes for Windows).
- **Lowercase keys**, except where preserving original casing matters (e.g., bank slugs which are already lowercase by `CLAUDE.md` convention).
- **ISO-8601 UTC timestamps** in directory names (`runs/2026-05-02T14-30-00Z/`) — colons are illegal in blob names, replaced with hyphens.
- **No leading slashes** in keys (Blob SDK rejects them).
- **No file extensions on directory placeholders** (Blob has no real directories; prefixes are virtual).

## Consequences

If chosen:
- Bicep provisions one storage account with two containers: `agent-state` and `rates-pack`
- Agent's Container App MI gets `Storage Blob Data Contributor` role on both containers
- PM's service principal gets `Storage Blob Data Reader` role on `rates-pack` container only
- `agent-state/runs/` accumulates per-run logs and summaries — add a lifecycle policy to delete blobs older than 30 days (configurable)
- `rates-pack/` is overwritten on each publish; no versioning
- Storage adapter (`AzureBlobStorage` from ADR-004) is configured with the `agent-state` container as its default; pack publisher writes to `rates-pack` separately
- Diagnostic settings on the storage account → Log Analytics workspace (when sprint 003 lands observability)

Lock-in: low. Renaming containers later is a copy-and-redeploy operation; adding versioning to the pack is additive.

## Open questions (deferred to sprint 001 design phase)

1. Lifecycle policy for `runs/` — 30/90/forever-day retention. Default proposed: 30 days. Sprint 003 may revisit if observability dashboards need historical run data.
2. Whether `legacy/` subfolder lives under `output/latest/` (mirrors local) or moves to a top-level `agent-state/archive/legacy/` (cleaner separation). Sprint 001 design phase decides.
3. Storage account name suffix — deterministic (8-char hash of RG name) vs. random (one-time generated). Affects whether IaC is re-applicable cleanly.

## Decision log

- **2026-05-05** — Status: PROPOSED → DECIDED. Chosen option: **Option 1 (one storage account, two containers)**.
  - Two-account isolation (Option 2) ruled out as over-engineered for our scale; container-level RBAC scoping cleanly satisfies the access-control needs of agent MI vs PM SP.
  - Single-container layout (Option 3) ruled out — Azure RBAC cannot scope below container level, so PM SP would get read access to agent state.
  - Versioned pack (Option 4) deferred — PM hasn't asked for history; can be added additively later.
  - Hierarchical Namespace (Option 5) ruled out — solves problems we don't have.
  - Sub-decisions adopted as part of this decision:
    - **Per-run logs in `agent-state/runs/<ISO-timestamp>/`**, separate from canonical `agent-state/output/latest/`. Local fs mode keeps logs in `output/latest/` for developer convenience; storage adapter handles the divergence.
    - **Last-writer-wins concurrency** at the file level — natural blob semantics; acceptable because manual triggers are operator-serialized and scheduled tier-batches have no per-bank overlap by design.
    - **Key conventions:** forward-slash separators throughout, lowercase keys (except bank slugs which are already lowercase by convention), ISO-8601 UTC timestamps in directory names with colons replaced by hyphens, no leading slashes.
    - **Lifecycle policy:** default proposed at 30 days for `agent-state/runs/`; final value confirmed in sprint 001 design phase.
