# Design — Container image

**Status:** Design draft 2026-05-06; implementation pending review
**Implements:** [ADR-002](../../../decisions/ADR-002-compute-platform.md) (Container Apps Jobs as the runtime)
**Touches:** new files at repo root — `Dockerfile`, `.dockerignore`; new `iac/deploy-image.sh`; small `--dry-run` flag addition to `run-batch.js`

## Scope

This doc fixes the container image's base, layer composition, entrypoint contract, tag strategy, build procedure, and pre-push smoke test. The runtime platform (Container Apps Jobs) is decided in ADR-002; this doc is the implementation-level contract for the image that platform pulls and runs.

## Base image

**Choice:** `mcr.microsoft.com/playwright:v<x.y.z>-jammy`

The exact `<x.y.z>` matches the Playwright version pinned in `package.json` (currently `1.49.0` — verify and update at Dockerfile authoring time). The `jammy` variant is Ubuntu 22.04 LTS. Microsoft also publishes `noble` (24.04) but `jammy` is older, more battle-tested, and matches the broader Azure base image fleet.

**Why this base over `node:20-slim` + `npx playwright install`:**

| Concern | Microsoft Playwright base | `node:20-slim` + `playwright install` |
|---|---|---|
| Chromium / system-deps compatibility | Microsoft owns it; tested in CI by Playwright team | We own it; debug deps drift each upgrade |
| Image size | ~550 MB | ~200 MB + ~350 MB after install ≈ ~550 MB |
| Build time | Single FROM, fast | Multiple `apt-get install` + `npx playwright install` ≈ 3–5 min |
| Initial setup pain | None | Real (find the right libnss / libxkb / libgbm versions) |
| Long-term maintenance | Bump tag when Playwright bumps | Same plus dependency triage every Ubuntu point release |

The "smaller image with `node:20-slim`" argument turns out to be wrong once `playwright install` deposits Chromium and its libs — the final size is comparable. The official base wins on operational simplicity for the same payload.

**Cost of choice:** the ~550 MB image lives in ACR (storage cost ≈ $0.01/GB/mo for Basic SKU = essentially free) and gets pulled on each Container Apps Job cold-start. ACR-to-Container-Apps pull within the same region is fast (~5–10s for a 550 MB image with layer caching, ~15–20s on a fresh node). The agent runs for minutes per execution, so cold-start image pull is invisible to the operator.

## Pinning strategy

The Dockerfile pins three things:

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy
```

- **Playwright version** matches `package.json`'s `playwright` dep. Bumping `package.json`'s Playwright version requires updating the Dockerfile FROM line in the same commit. This is enforced by a checklist line in `CLAUDE.md` (TBD) or a small CI check (sprint 004).
- **No `:latest` floating tag** anywhere — guarantees reproducibility; an old `git checkout` builds the same image as it did originally.
- Node version comes from the base image (currently Node 20.x baked in by Microsoft). If we ever need to override, we'd add `RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash -` and explicitly install — not needed today.

## Layer composition

Single FROM. Layers ordered for cache-hit efficiency on the common case (code-only changes).

```dockerfile
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Layer 1: package files + lockfile-deterministic install
# Cache-busted only when package.json or package-lock.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Layer 2: source code
# Cache-busted on any source change
COPY . .

# Container Apps Jobs sets non-default env vars at runtime; baking these is for visibility only
ENV NODE_ENV=production
ENV BIRD_STORAGE=azure

# The default args are overridden by Container Apps Job's args field per-execution
ENTRYPOINT ["node", "run-batch.js"]
```

**Why `npm ci --omit=dev`:**
- `npm ci` (vs `npm install`) errors if `package-lock.json` is out of sync — surfaces a desync in the build, not at runtime
- `--omit=dev` excludes test-only deps (`@types/*`, eslint, etc.) from the image. ~50–100 MB savings.

**Why no multi-stage:** there's nothing to discard between stages. We ship Node + Playwright + agent code, all needed at runtime. Multi-stage adds Dockerfile complexity for zero size gain in this case.

**Why the order (package files first, then source):**
- The `npm ci` layer is the slow one (~30–60s)
- Code changes are frequent; package changes are rare
- Putting `COPY . .` first would invalidate the `npm ci` layer on every code change → every build is slow
- Standard Node Dockerfile pattern

## Entrypoint contract

The image's entrypoint is `node run-batch.js`. The Container Apps Job passes its `args` array as positional argv:

| Job `args` (from Function trigger) | What runs inside the container |
|---|---|
| `["state-bank-of-india", "hdfc-bank-limited"]` | `node run-batch.js state-bank-of-india hdfc-bank-limited` |
| `["--dry-run", "state-bank-of-india"]` | `node run-batch.js --dry-run state-bank-of-india` |
| `["--category", "PSB"]` | `node run-batch.js --category PSB` |
| `["--category", "PSB", "--dry-run"]` | `node run-batch.js --category PSB --dry-run` |

`run-batch.js` already accepts positional bank slugs and `--category` from local CLI use. **Sprint 001 adds `--dry-run`**: parse argv, expand `--category` against `data/bank-domains.json` (the Job's MI has read access to `agent-state`), print the resolved slug list to stdout, exit 0 without LLM calls. Implementation is ~10 LOC inside `run-batch.js`'s argv parser plus a guard around the per-bank discovery loop.

The agent's storage adapter (per [storage-adapter.md](./storage-adapter.md)) already routes via `BIRD_STORAGE=azure` to the `agent-state` container — no container-side code change for storage.

**Exit codes:**
- `0` — all banks succeeded (or `--dry-run` printed and exited)
- `1` — at least one bank failed but the run completed (partial success — log details, proceed)
- `2` — fatal infrastructure error (storage unreachable, AOAI auth failure, etc.) — Container Apps Job records this, alerts can fire on it (sprint 003)

`run-batch.js` already produces these codes for local CLI; the container inherits them.

## Tag strategy

Every image push to ACR creates **two tags**:

```
crbofiarateagentprod.azurecr.io/rate-discovery-agent:<git-sha>
crbofiarateagentprod.azurecr.io/rate-discovery-agent:latest
```

- `<git-sha>` — the short git SHA (7 chars) of the commit that built the image. Deterministic, immutable.
- `latest` — points to the most recent push. Convenience only; **never referenced by IaC**.

The Container Apps Job spec in [bicep-modules.md](./bicep-modules.md) takes `imageTag` as a Bicep parameter; the deploy procedure passes the git SHA explicitly:

```bash
GIT_SHA=$(git rev-parse --short HEAD)
az deployment sub create \
  --template-file iac/main.bicep \
  --parameters iac/parameters.prod.bicepparam \
  --parameters imageTag=$GIT_SHA
```

**Why both tags rather than just `:<git-sha>`:**
- `:latest` is useful for ad-hoc inspection (`docker pull crbofiarateagentprod.azurecr.io/rate-discovery-agent:latest && docker run -it ... bash`) without first looking up the latest SHA
- `:<git-sha>` ensures Bicep re-applies are deterministic — re-applying with the same parameters produces the same job

**Why never `:latest` in IaC:**
- Container Apps Job re-applied with `image: ...:latest` looks like a no-op to ARM (same string), but underlying image bytes may differ. Diagnosing "what version is actually running?" requires manual ACR inspection. SHAs make this trivial.

A small `iac/deploy-image.sh` wraps the build + deploy:

```bash
#!/usr/bin/env bash
set -euo pipefail
GIT_SHA=$(git rev-parse --short HEAD)
ACR_NAME=crbofiarateagentprod

echo "Building image @ $GIT_SHA via ACR..."
az acr build \
  --registry $ACR_NAME \
  --image rate-discovery-agent:$GIT_SHA \
  --image rate-discovery-agent:latest \
  --file Dockerfile \
  .

echo "Updating Job to image $GIT_SHA..."
az deployment sub create \
  --location southindia \
  --template-file iac/main.bicep \
  --parameters iac/parameters.prod.bicepparam \
  --parameters imageTag=$GIT_SHA
```

Single command from a clean `git pull` to deployed image. CI/CD (sprint 004) will call this same script.

## Build procedure

**`az acr build` (cloud-side)**, not local `docker build` + `docker push`.

Why:
- No local Docker daemon required (some operator machines lack one; Docker Desktop's licensing terms have been a friction point for some shops)
- Build context uploads from local repo to ACR over HTTPS
- ACR runs the build on its own Linux build agent
- Result lands in ACR directly — no separate `docker push` step
- Build provenance is recorded in ACR's task history (`az acr task list-runs`)

Cost: ACR build agent time (~$0.05–0.10 per build at current pricing for our image size and build time of ~1–2 min). Versus free local builds. Acceptable for sprint 001's low build cadence (manual, ~weekly).

No local Docker is available in this environment, so cloud-side `az acr build` is the only build path. The script does not support a local-build fallback.

## `.dockerignore`

Keeps the build context (uploaded to ACR for cloud-side builds) small:

```
# Build artifacts
node_modules/
output/
pack/dist/
**/*.log

# Dev / docs
sdlc/
docs/
tests/
.vscode/
.idea/
*.md
!CLAUDE.md             # keep CLAUDE.md — agent reads it at runtime in some debug paths

# Source control — KEEP .git in the image so cloud/git-publish.js can push
# rate data back to the repo at the end of a cloud run. Excluding .github
# (workflows) and .gitignore is fine; the active runtime only needs .git.
.github/
.gitignore

# IaC (built and deployed separately, not part of the image)
iac/

# OS / editor
.DS_Store
Thumbs.db
*.swp
```

The `output/` exclusion is critical — local discovery runs leave 100s of MB there, and the image must not ship operator data to ACR.

A small CI check (sprint 004) compares `.dockerignore` against the repo's top-level dirs and warns when a new top-level appears that isn't in the ignore list. Sprint 001 relies on operator discipline.

## Image security posture

**Sprint 001 posture: image runs as root, no scanning gate.**

Threat model:
- Container is ephemeral (one job execution = one container instance, no persistent state inside)
- Network access from inside is to public internet (bank sites, AOAI endpoint) — outbound only
- The agent processes public bank rate data; no PII, no secrets handled inside other than what Key Vault refs into env vars
- Image base is Microsoft-maintained; CVE patching cadence is theirs

What we accept:
- A compromised process inside the container runs as root. Blast radius: the container itself + outbound network calls (could exfiltrate the AOAI key if it's a sufficiently sophisticated attack). Mitigated by the image source (Microsoft, not random Docker Hub) and the agent's own code surface (no `eval`, no shell-out with user input).

Hardening items deferred to sprint 003:
- Run as non-root user (requires Chromium permission tweaks — Playwright supports `--no-sandbox` workaround but the proper fix is non-trivial)
- Microsoft Defender for Containers enabled on the ACR + Container Apps Environment for CVE scanning
- Read-only root filesystem (Container Apps supports this; Playwright requires writable `/tmp` for browser cache — manageable with a tmpfs mount)

These don't change the image structure — they're added on top later.

## Smoke testing — three layers, no local Docker

Local Docker is not available in this environment, so the image-as-built can't be exercised on the operator's machine. The agent's correctness is verified across three independent layers, each catching a distinct class of failure:

### Layer 1 — Node-side smoke against Azurite (no Docker)

Catches: agent logic, storage adapter, AOAI integration, end-to-end discovery flow.

Azurite is distributed as an npm package (`npm install -g azurite`) and runs as a plain Node process — no Docker required. This is the same setup [ADR-009](../../../decisions/ADR-009-local-blob-emulation.md) specifies for the Azurite-gated test suite, so the operator already has it on hand.

```bash
# One-time install
npm install -g azurite

# Start Azurite (background)
azurite --silent --location ./.azurite-data --debug ./.azurite-debug.log &

# Provision the agent-state container
az storage container create --name agent-state \
  --connection-string "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=...;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"

# Run the agent directly (no container) against Azurite + real AOAI
BIRD_STORAGE=azure \
AZURE_STORAGE_ACCOUNT_NAME=devstoreaccount1 \
AZURE_STORAGE_CONTAINER_NAME=agent-state \
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=...;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;" \
AZURE_OPENAI_ENDPOINT="$AZURE_OPENAI_ENDPOINT" \
AZURE_OPENAI_API_KEY="$AZURE_OPENAI_API_KEY" \
AZURE_OPENAI_DEPLOYMENT=gpt-4o \
node run-batch.js hdfc-bank-limited

# Verify
az storage blob list --container-name agent-state \
  --connection-string "DefaultEndpointsProtocol=http;..." --output table
```

**Pass criteria:** run completes; blobs appear under `output/latest/hdfc-bank-limited_*.json` matching the `CLAUDE.md` schema.

This layer does **not** test the container image itself — it tests the agent code that the image will run. A Dockerfile bug (missing copy, broken entrypoint) is invisible here.

### Layer 2 — `az acr build` succeeds

Catches: Dockerfile syntax errors, broken `FROM` references, missing `COPY` source files, `npm ci` failure due to lock-file desync, layers exceeding ACR limits.

Running `iac/deploy-image.sh` invokes `az acr build`. ACR rejects the build with a clear error and the script exits non-zero. The image is never tagged in the registry on failure, so a broken Dockerfile cannot reach the Container Apps Job.

This layer doesn't verify runtime behavior — only that the image bytes are well-formed. An image that builds but crashes on startup gets through.

### Layer 3 — Cloud-side post-deploy execution

Catches: image runtime issues (missing package at runtime, environment mismatch between local Node and the image's Node, Playwright path issues, MI auth failures specific to Container Apps).

This is sprint 001 success criterion 3 — after `iac/deploy-image.sh` completes, trigger the Function with `{"banks": ["hdfc-bank-limited"]}` and observe the Container Apps Job execution succeed and write to real `agent-state`.

```bash
curl -X POST -H "x-functions-key: $FUNCTION_KEY" -H "Content-Type: application/json" \
  "https://func-bofia-trigger-prod.azurewebsites.net/api/start-discovery" \
  -d '{"banks": ["hdfc-bank-limited"]}'

# Within ~5 min, verify
az containerapp job execution show --name <executionId> \
  --job-name caj-bofia-rate-discovery-prod \
  --resource-group rg-bofia-rate-agent-prod-southindia
az storage blob list --account-name stbofiarateagentprod01 \
  --container-name agent-state --auth-mode login --output table
```

### Trade-off

Without a local Docker layer, an image-runtime bug is caught only at Layer 3 — after a real cloud deploy. The iteration loop on a runtime regression is: fix code → `iac/deploy-image.sh` (~3–5 min) → trigger → observe → repeat. Compared to a hypothetical local container-run loop (~30s per cycle), each iteration is ~6–10× slower.

This is acceptable for sprint 001 because:
- Image-runtime regressions are rare in practice when the same Node version + the same code runs in the image as ran locally in Layer 1
- The image change cadence is low (sprint 001 deferred CI/CD; manual rebuilds happen ~weekly)
- The cost of provisioning local Docker (Docker Desktop license, machine resources) is real and not justified by this sprint's volume

Sprint 004 (CI/CD) revisits this — GitHub Actions runners have Docker; the layer-2-equivalent test there can also do a `docker run` smoke against Azurite-in-CI before promoting an image tag.

## Image size and pull-time benchmarks

Targets (verify post-build):

| Metric | Target | Hard limit |
|---|---|---|
| Total image size | <700 MB | <1 GB |
| Layers | <15 | <25 |
| Cold pull (Container Apps cold-start) | <20s | <60s |

These are sanity guardrails, not hard requirements. If image size creeps to 1+ GB across future changes, that's a signal something unintended got bundled in.

`az acr repository show-manifests --repository rate-discovery-agent --name crbofiarateagentprod` reports per-tag size and creation time after each push.

## Handling base image updates

Microsoft publishes new Playwright base tags ~monthly. Cadence:

1. **Triggered manually**, not on-schedule. There's no auto-bump in sprint 001.
2. Operator updates Playwright in `package.json`, runs `npm install`, fixes any test breakage.
3. Operator updates the Dockerfile `FROM` line to match.
4. Operator runs `iac/deploy-image.sh` — local smoke test, build, deploy.
5. Sprint 003 will add Dependabot for Playwright; sprint 004 will run smoke tests in CI.

## Open implementation questions

1. **Resource limits in the Job spec.** [bicep-modules.md](./bicep-modules.md) sets `cpu: 1.0, memory: '2Gi'`. 2 GiB is the recommended minimum for Chromium + Node + agent code; bumping to 4 GiB is a one-line change if OOM appears. Verify with smoke test: monitor `docker stats` during a 1-bank run, look for memory pressure.
2. **Build agent type for `az acr build`.** Default is Linux x64. ARM64 build is supported (`--platform linux/arm64`) but Container Apps environment must match. Sprint 001 stays on x64 — Container Apps environments default to x64 and switching is a non-goal.
3. **Build cache reuse across `az acr build` invocations.** ACR caches layers across builds within a registry. Verify the second build of the same code completes in <30s (cache hit). If not, layer ordering may need adjustment.
4. **Reproducibility of `npm ci`.** A `package-lock.json` desync (someone runs `npm install` instead of `npm ci` locally and forgets to commit) will fail the image build. This is a feature, not a bug — fail loudly. Documented in `CLAUDE.md` build section (sprint 001 to add).
5. **Playwright browsers other than Chromium.** Microsoft's Playwright base image bundles Chromium, Firefox, and WebKit. We only use Chromium. Stripping the others would save ~250 MB but requires a custom build of the base — not worth the maintenance cost for sprint 001.

## Acceptance criteria

The design is implemented when:

- `Dockerfile` exists at repo root with the exact structure above
- `.dockerignore` exists at repo root with the exact list above
- `iac/deploy-image.sh` exists, executable, and successfully builds + deploys end-to-end on a clean checkout
- `run-batch.js` accepts `--dry-run` and exits 0 with the resolved slug list printed
- Layer 1 smoke (Node-side, `node run-batch.js` against npm-Azurite, no Docker) successfully runs `hdfc-bank-limited` and produces correctly-shaped blobs in Azurite
- Layer 3 smoke (cloud-side post-deploy, via Function trigger) successfully runs `hdfc-bank-limited` end-to-end against real Azure storage
- An `az acr build` from a clean repo state produces an image tagged with both `:<git-sha>` and `:latest` in `crbofiarateagentprod.azurecr.io/rate-discovery-agent`
- The Container Apps Job, after Bicep apply with the new `imageTag`, successfully starts on manual trigger and runs `hdfc-bank-limited` end-to-end (success criterion 3 from `scope.md`)
- Image size on push <700 MB; cold-start pull <20s (verified via Container Apps Job execution log)
