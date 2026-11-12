# Cloud as Source of Truth — cutover design (2026-07-08)

**Operator decision (2026-07-08, refined same day):** rate packs are always generated
from **data collected by cloud runs** — the provenance rule is about where the *data*
came from, not where the pack is *assembled*.

- **Valid data channels** (both are cloud-run outputs): the `agent-state` **blob**
  container (today's active channel) and the cloud **git-publish** path (commits rate
  data back to the repo; currently OFF behind `BIRD_DISABLE_GIT_PUBLISH=1`).
- **Assembly is location-free.** A pack may be built on the operator machine, in the
  cloud container, or in CI — as long as it reads from a cloud-sourced channel. This
  blesses the lightweight republish (`pull-latest-from-blob.js → build-pack.js →
  quality-gate.js → publish.js`) as a first-class path, not a workaround.
- **Local runs still never feed the pack** — they are for debugging/development.

**Two provenance decisions (operator-approved 2026-07-08):**

1. **Today's full-state seed is a one-time migration baseline.** The blob is now the
   cloud-owned baseline. Much of the seeded data (co-op/DCCB tail from sprints 005–007,
   June-15 FCNR recoveries, curated PDFs) was *local-collected*; it is grandfathered in
   so we don't reopen the 119-bank coverage gap. Cloud runs refresh it going forward.
2. **Local-origin data is an allowed, labeled fallback for cloud-unreachable banks.**
   Co-op sites and WAF-blocked banks (the 15 failures on run `inydw91`) reject datacenter
   IPs and may never be collectible from cloud. Rather than drop them, we keep local-origin
   data and mark it. **Follow-up:** add a per-record `collected_via: cloud | local`
   provenance flag (extraction → rate JSON → pack) so the distinction is visible and
   auditable, and a future "cloud-collected %" metric can track migration progress.

The cloud run should get everything it needs for a successful run from git (via the image);
per-bank state and collected rate data flow through the blob/git channels above.

## How cloud state actually flows today

1. **Image build** (`iac/deploy-image.sh` → ACR): bundles the git tree, including
   `data/bank-domains.json` (registry: URLs, templates, extraction hints) and all code.
2. **Run start** (`run-batch.js` → `cloud/sync.js pull`): downloads
   `data:bank-domains.json` **from blob, overwriting the image's git copy**, and
   hydrates `output/latest/` from blob (through safe-write).
3. **During run**: per-bank artifacts upload incrementally (`uploadOneBank`).
4. **Finalize**: full push (output/latest + runs + registry) back to blob; **pack is
   rebuilt from the container's output/latest and published to the `rates-pack`
   container** (`pack/build-pack.js` + `pack/publish.js`); git publish is behind the
   kill-switch (`BIRD_DISABLE_GIT_PUBLISH=1`).

So the pack-from-cloud pipeline already exists end-to-end. The failures observed on the
2026-07-07 cloud cohort were **input drift**, not architecture:

- **Registry drift**: step 2 overwrote the image's fixed registry (jkb `/interest-rates`
  repoint, emirates-nbd `expected_currencies: ["USD"]`, Axis URL rolls) with the blob's
  June-era copy. This is the same failure Sprint 009 hit (see
  `scripts/azops/push-bank-domains-merge.js` header) — the pull-then-push loop
  perpetuates whatever is in blob.
- **State drift**: local-only artifacts (June-15 FCNR recovery scripts, 2026-07-07
  fix-validation run) never reached blob, so a blob-built pack silently regresses FCNR
  coverage vs the local pack (blob: 35 FCNR banks / local pack: 44).

## Why "the registry is in the image" isn't enough — and the fix

The registry is **two things in one file**:

- **Config** (human/git-authored): domains, rate-page URLs, templates, extraction hints,
  `expected_currencies` overrides. Git should win.
- **Run-authored state**: `cloud_block_status`, `cloud_capability`, domain-cache
  discoveries. Cloud runs should win (they observe it), and git only gets it via
  checkpoint commits.

Because both live in one blob and one file, "blob wins" (current pull) loses config
fixes, and "image wins" (naive fix) would lose run observations. The durable fix is a
**field-aware merge at pull time** in `cloud/sync.js`:

> pull = image (git) registry as base; overlay only run-authored fields
> (`cloud_block_status`, `cloud_capability`) from the blob copy where blob's
> `last_observed` is newer.

This is the exact inverse of the local→blob merge in `push-bank-domains-merge.js`
(which as of 2026-07-08 ports run-authored fields cloud→merged). Queued as a sprint
item — requires an image rebuild + operator deploy to take effect.

### Should the cloud build its own image? (operator question, 2026-07-08)

Yes, that's feasible and desirable as CI/CD: an ACR Task or GitHub Action that runs
`az acr build` on push to the deploy branch, so every cloud run uses an image with the
current git registry and code. Two caveats:

1. It fixes staleness of the **image**, but not the pull-overwrite above — the sync.js
   merge change is required either way. With that change in, per-run image builds make
   "cloud fetches everything from git" literally true for config.
2. Deploys are currently a deliberate operator action (Bicep param preservation per
   ADR-013, kill-switch). Auto-build can be decoupled from auto-deploy: build+tag on
   every push, but the job's image reference update stays an operator step (or a
   pinned `:latest-<branch>` tag with explicit promotion).

## One-time reconcile plan (today, 2026-07-08)

1. **Registry**: `push-bank-domains-merge.js` (upgraded with run-authored field port) —
   local base + 63 cloud-newer telemetry fields (6 `cloud_block_status`, 57
   `cloud_capability` from the 07-07 runs). Verified merged file carries jkb/emirates
   fixes. → **operator runs the upload** (classifier-gated prod write).
2. **Artifacts**: `seed-latest-from-local.js` — scraped_at-guarded one-way seed of
   local NRI-variant artifacts into blob. Never overwrites blob files with newer
   scraped_at (protects the 18 banks the 07-07 cloud cohort refreshed); never uploads
   empty ladders or pending sidecars. → dry-run plan reviewed, then operator/approved
   apply.
3. **Re-run** `fcnr-cohort-2026-07-07` in cloud (`start-cohort-run.js`). Finalize
   rebuilds + publishes the pack from reconciled cloud state.
4. **Deliverable**: download the cloud-built pack, verify quality gate, build
   `output/pm-2026-07-08/` PM set.

## Follow-ups (sprint backlog)

- **Republish-only cloud mode** (`run-batch.js`): `pull → build-pack → gate → publish`,
  skipping the bank loop AND the redundant end-of-batch `output/latest` push-back. Today's
  1-bank republish smoke pulls ~4,300 blobs, runs one bank, then finalize re-pushes all
  ~4,300 unchanged (only HDFC changed, already covered by incremental `uploadOneBank`).
  The pull is inherent to a full-pack rebuild; the push-back is pure waste for small runs
  and is the root of the "end-of-run re-stamps every blob → timestamps useless" problem.
- **Provenance flag** `collected_via: cloud | local` per rate record (extraction → rate
  JSON → pack), per the operator-approved fallback policy above. Enables a
  "cloud-collected %" migration metric and makes the grandfathered local-origin data
  auditable.
- `cloud/sync.js` pull: field-aware registry merge (git config wins, blob telemetry wins).
- CI/CD image build on push (build ≠ deploy; deploy stays operator-gated).
- Decide the checkpoint cadence for harvesting run-authored registry fields into git.
- Domestic (bare) coverage diff blob vs local — if the cloud pack regresses domestic
  slabs vs `rates-pack-2026-07-07`, extend seeding beyond NRI variants.
