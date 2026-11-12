# Sprint 009 Phase 9.5 / 9.6 — Alternative fixes investigation

**Date:** 2026-06-05
**Driver:** Operator directed (post-design approval): "Investigate alternative
fixes [for CSB / Arunachal / Ahmedabad] before falling back to operator-
curated promotion."

The Phase 9 design proposed promoting all three to
`extraction_method: manual_transcription_from_rendered_text` (curated-skip).
That path works but burns the deterministic-extraction option permanently
for each bank. This investigation looks at whether targeted infra fixes
can recover cloud extraction.

## Method

For each bank, three quick probes from this dev machine:
1. `curl https://<rate-page>` — see what plain HTTPS does.
2. `curl -k https://<rate-page>` — same but ignore TLS cert.
3. `curl -kL https://<rate-page>` — also follow redirects.

This separates "cert is bad" / "redirect destination matters" / "WAF blocks
non-browsers" failure modes.

## Findings

### Arunachal Pradesh Rural Bank (`aprb.bank.in/interest.php`)

| Probe | HTTP | TLS verify result | Notes |
|---|---|---|---|
| `curl`     | n/a (refused) | 20 (invalid cert) | TLS handshake fails. |
| `curl -k`  | **200** | 20 | Returns full HTML page. |

**Diagnosis:** Server presents an expired or self-signed TLS certificate.
Browsers warn but allow; Node/Playwright default-reject. Local environment
works because Norton Safe Web's MITM CA is trusted (see
[[reference_norton_tls_mitm]]). Cloud Container Apps has the standard root
CA store and no MITM — strict reject.

**Cloud fix candidate:** per-bank `tls_skip_verify: true` flag honored by
`fetch_url` (HTTPS agent option) and `run_playwright` (`--ignore-https-errors`).
Site itself is healthy and serves valid rate data — only the cert chain
is the blocker.

### Ahmedabad Mercantile Co-op (`amco.bank.in/n/deposit-interest-rate`)

| Probe | HTTP | TLS verify result | Notes |
|---|---|---|---|
| `curl`     | 000 (no response in 0.08s) | 20 | Same TLS-handshake failure pattern. |
| `curl -kL` | **200** in 0.67s | — | Returns HTML cleanly. |

**Diagnosis:** Same as Arunachal — expired/invalid cert. Resolves cleanly
with `-k`. Local extraction worked via Norton MITM bypass. Bank-domains
notes say "static HTML (PHP/server-rendered with Bootstrap CSS)". The
template/extractor is fine; only the TLS verify failure blocks cloud
extraction.

**Cloud fix candidate:** same `tls_skip_verify: true` flag.

### CSB Bank Limited (`csb.bank.in/interest-rates`)

| Probe | HTTP | Notes |
|---|---|---|
| `curl -sL` (follow redirects) | **200** but lands on `validate.perfdrive.com/?ssa=...` (Radware Bot Manager CAPTCHA page). |

**Diagnosis:** csb.bank.in is fronted by Radware Bot Manager (commercial WAF).
Non-browser User-Agent gets a 301 to the Radware challenge URL.
`validate.perfdrive.com` returns a CAPTCHA / fingerprint-detection page,
not rate data.

This is **not a TLS issue**; this is **active bot detection at the edge**.
The cert is valid; the WAF actively classifies requests.

**Why local works:** `output/latest/csb-bank-limited_*.json` shows
`extraction_method: llm_inline_extraction` with 73 slabs total. The local
environment must have either (a) Norton's reverse-proxy classifying the
operator's traffic as human, or (b) the operator manually transcribed
during a session where the WAF challenge was solved interactively.

**Cloud fix candidates:**

1. **Playwright stealth + retry** — playwright-extra + puppeteer-extra-plugin-stealth
   sometimes evades Radware, but historically unreliable; Radware is more
   aggressive than Cloudflare. Not worth pinning Sprint 9 quality on it.
2. **Mark as `cloud_block_detected: true`** — wire CSB into the
   Phase 4 split-execution path so it always runs local-only.
   Phase 4 / 5 / 6 already shipped, but the runtime trigger
   (`scripts/cohort/split.js`) requires the operator to invoke that workflow.
   For automatic cohort runs that go straight to deploy-smoke, CSB needs
   to be skipped at tier-router time.
3. **Operator-curate** — flip `extraction_method` to `manual_transcription_from_rendered_text`.
   Loses the deterministic-extractor option permanently but preserves the
   73 slabs of curated data.

**Recommendation:** **option 3 (operator-curate) for CSB.** Radware
challenges are well-known to require human-in-loop, and we have good
local data. Trying option 1 is a rabbit hole for sprint-level scope. Option 2
requires deeper workflow refactor and would be a sprint-010 candidate.

## Recommendation matrix

| Bank | Failure mode | Recommended cloud fix | Effort | Local data preserved |
|---|---|---|---|---|
| Arunachal RRB | TLS cert (invalid) | `tls_skip_verify: true` flag in bank-domains + `fetch_url` / `run_playwright` honors it | ~30 lines code + 1 test | n/a — re-extracts deterministically |
| Ahmedabad Mercantile | TLS cert (invalid) | Same `tls_skip_verify` flag | (shared with above) | n/a — re-extracts |
| CSB Bank | Radware Bot Manager WAF | Operator-curate (`extraction_method: manual_transcription_from_rendered_text`) — same as Axis/Kotak/Equitas path | ~5 lines in bank-domains.json | yes (73 slabs preserved via tier-router skip) |

## Decision needed

The operator should pick one of:

**Option A (recommended):** Implement `tls_skip_verify` for Arunachal + Ahmedabad;
operator-curate CSB.

**Option B:** Operator-curate all three (the original Phase 9 design).
Simpler short-term but loses the deterministic path for two banks whose
sites are actually healthy.

**Option C:** Skip CSB/Arunachal/Ahmedabad entirely in this round.
Continue with items 9.1–9.4; defer 9.5–9.6 to Sprint 010.

## Design for `tls_skip_verify` flag (if Option A approved)

### Storage
`data/bank-domains.json#<bank>.tls_skip_verify = true`. Like
`playwright_stealth`, `playwright_browser`, etc. — operator-only flag.

### Honored by

1. **`lib/fetch/fetch_url.js`** — when set, pass
   `{ httpsAgent: new https.Agent({ rejectUnauthorized: false }) }` to the
   request. The existing fetch_url already reads bank-domains for
   referer/UA overrides; one more field is consistent.
2. **`lib/tools.js#runPlaywright`** — pass `--ignore-https-errors` to
   `scripts/fetch_rates_playwright.js` (Playwright supports this via
   `browser.newContext({ ignoreHTTPSErrors: true })`).
3. **`scripts/fetch_rates_playwright.js`** — accept `--ignore-https-errors`
   CLI flag; thread it into `context = await browser.newContext({...})`.
4. **`lib/actions/fetch_page.js` and `lib/actions/extract_pdf_table.js`** —
   honor the same flag for orchestrator-path fetches.

### Security note

`tls_skip_verify` is a per-bank opt-in. Operator declares it for banks
whose cert is known-bad-but-site-is-trusted. Default false, no change to
the 99% of banks. The flag's name signals the security trade-off
explicitly so future readers won't enable it casually.

### Tests

- Unit: `fetch_url` with the flag set spawns an https.Agent with
  `rejectUnauthorized: false`; without the flag, default agent.
- Unit: `buildPlaywrightCmdArgs` includes `--ignore-https-errors` when the
  override has `tls_skip_verify: true`.
- Integration (Optional): a small HTTPS server with self-signed cert in
  the test suite; verify fetch_url with flag connects, without flag rejects.

## Cost estimate (Option A)

- `tls_skip_verify` plumbing: ~1.5 hours including tests
- Operator-curate CSB: ~5 minutes
- Validates via focused cohort: ~30 minutes wall + ~$2 cost

## What I'd ship if Option A is approved

1. `lib/fetch/fetch_url.js` — read flag, conditionally use lax https.Agent
2. `lib/tools.js#buildPlaywrightCmdArgs` — pass `--ignore-https-errors`
3. `scripts/fetch_rates_playwright.js` — accept the flag
4. `lib/actions/fetch_page.js` + `extract_pdf_table.js` — same
5. `data/bank-domains.json` — set `tls_skip_verify: true` on Arunachal +
   Ahmedabad; set `extraction_method: manual_transcription_from_rendered_text`
   on CSB.
6. Tests covering all the honors-the-flag sites.
7. Updated `sdlc/sprints/sprint-009/design/phase-9-cohort-runtime-fixes.md`
   to reference this investigation as the source for items 9.5/9.6.
