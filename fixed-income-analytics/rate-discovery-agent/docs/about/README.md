# `docs/about/` — Project guidebook (start here for handover)

New to this project? **Read [`overview.md`](overview.md) first** — it explains the whole system in one sitting and links everything else. The rest of this folder goes a level deeper, one area per file.

| Doc | What it covers |
|---|---|
| **[overview.md](overview.md)** | **Start here.** What the project is, the pipeline, the component map, the two data stores, key concepts, current state, gotchas. |
| [architecture.md](architecture.md) | Runtime modes (local vs cloud, identical code paths), the three runners, per-bank control flow, the storage abstraction. |
| [agent-design.md](agent-design.md) | How the "agent" works: prompt fragments assembled from `docs/agent/`, deterministic orchestration, model tiering, the three modes. |
| [crawling.md](crawling.md) | Discovery: finding websites & rate pages, page classification, HTTP vs Playwright fetching, anti-bot, the `www` gotcha. |
| [extraction.md](extraction.md) | Turning HTML/PDF into rate slabs: extractors, the rate/config schemas, validation, tenure/currency parsing. |
| [quality-checks.md](quality-checks.md) | Safe-write rules, the pre-publish quality gate, signed accepts, confidence scoring, rate bounds. |
| [deployment.md](deployment.md) | Azure topology, the container image, the Container Apps Job, the Function trigger, IaC/Bicep, the kill switch. |
| [testing.md](testing.md) | Test layers, how to run them (`npm test`), fixtures & golden HTML, the write-discipline guard. |
| [scripts.md](scripts.md) | Catalog of the `scripts/` toolbox — what each family (azops, pack, analysis, registry, recovery…) does. |
| [operator-guide.md](operator-guide.md) | **The runbook.** Command-level how-to: run a cohort local & cloud, deploy the image, build/gate/publish a pack, repair blob state, troubleshoot. |

### Where the authoritative sources live (this guide indexes them, doesn't replace them)

- **`../agent/`** — the agent's playbook and the single source of truth for its behaviour (prompt fragments).
- **`../../sdlc/`** — the durable design record: `architecture.md`, `deployment.md`, `data-model.md`, `test-strategy.md`, `decisions/ADR-*`, and per-sprint folders.
- **`../../sdlc/backlog.md`** and **`../../sdlc/sprints/sprint-011/BACKLOG.md`** — open work and strategic items.

*Written for project handover, 2026-07-09.*
