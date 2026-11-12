#!/usr/bin/env node

/**
 * guess-bank-in.js — Probe likely bank.in domains for uncached banks.
 *
 * Generates candidate bank.in domains from bank names using common
 * Indian bank naming patterns, probes each with a HEAD request, and
 * updates bank-domains.json with verified domains.
 *
 * This is a zero-cost alternative to web search for domain discovery.
 *
 * Usage:
 *   node scripts/guess-bank-in.js banks.csv                     # probe all uncached banks
 *   node scripts/guess-bank-in.js banks.csv --dry-run            # show candidates without probing
 *   node scripts/guess-bank-in.js banks.csv --category "Small Finance Bank"
 *   node scripts/guess-bank-in.js banks.csv --limit 20
 *   node scripts/guess-bank-in.js --bank "HDFC Bank Limited"     # single bank
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const { slugify } = require("./utils/slugify");
const { loadBanksCSV } = require("./utils/parse-csv");

// ── CLI args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let csvFile = "";
let singleBank = "";
let categoryFilter = "";
let limit = Infinity;
const dryRun = args.includes("--dry-run");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bank" && args[i + 1]) singleBank = args[++i];
  else if (args[i] === "--category" && args[i + 1]) categoryFilter = args[++i];
  else if (args[i] === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
  else if (!args[i].startsWith("--") && !csvFile) csvFile = args[i];
}

if (!csvFile && !singleBank) {
  console.error("Usage: node scripts/guess-bank-in.js <banks.csv> [options]");
  console.error("       node scripts/guess-bank-in.js --bank \"Bank Name\"");
  process.exit(1);
}

const DOMAINS_FILE = path.join(__dirname, "..", "data", "bank-domains.json");

// ── Load existing domains ──────────────────────────────────────────

let domains = {};
if (fs.existsSync(DOMAINS_FILE)) {
  domains = JSON.parse(fs.readFileSync(DOMAINS_FILE, "utf-8"));
}

// ── Candidate generators ───────────────────────────────────────────

/**
 * Generate likely bank.in domain candidates from a bank name.
 * Returns an array of candidate domains (without .bank.in suffix).
 */
function generateCandidates(bankName) {
  const name = bankName.trim();
  const lower = name.toLowerCase();
  const candidates = new Set();

  // Common words to strip
  const STRIP = /\b(limited|ltd\.?|the|of|and|co-operative|co operative|cooperative|sahakari|sahkari|nagrik|nagar|nagarik|bank|gramin|kshetriya|pvt\.?|private)\b/gi;
  const STRIP_TYPE = /\b(small finance|payments|rural|urban|district central|state co-operative|state|apex|central)\b/gi;

  // 1. Full name concatenated: "bankofbaroda"
  const fullConcat = lower.replace(/[^a-z]/g, "");
  candidates.add(fullConcat);

  // 2. Key words concatenated (strip common suffixes): "bankbaroda"
  const stripped = lower.replace(STRIP, "").replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, "");
  if (stripped.length >= 3) candidates.add(stripped);

  // 3. Further stripped (remove type words too)
  const coreWords = lower.replace(STRIP, "").replace(STRIP_TYPE, "").replace(/[^a-z\s]/g, "").trim().replace(/\s+/g, "");
  if (coreWords.length >= 3) candidates.add(coreWords);

  // 4. Acronym / initials: "BOB", "SBI", "PNB"
  const words = name.replace(/[().,]/g, "").split(/\s+/).filter((w) => w.length > 0);
  const significantWords = words.filter((w) => !/^(the|of|and|ltd\.?|limited|pvt\.?|private)$/i.test(w));
  if (significantWords.length >= 2) {
    const acronym = significantWords.map((w) => w[0]).join("").toLowerCase();
    if (acronym.length >= 2 && acronym.length <= 6) candidates.add(acronym);
  }

  // 5. First significant word only: "axis", "bandhan", "kotak"
  if (significantWords.length > 0) {
    const first = significantWords[0].toLowerCase().replace(/[^a-z]/g, "");
    if (first.length >= 3) candidates.add(first);
  }

  // 6. First two significant words: "kotakmahindra", "induslnd"
  if (significantWords.length >= 2) {
    const firstTwo = significantWords.slice(0, 2).join("").toLowerCase().replace(/[^a-z]/g, "");
    if (firstTwo.length >= 4) candidates.add(firstTwo);
  }

  // 7. SFB suffix pattern: "ujjivansfb", "equitassfb"
  if (/small finance/i.test(name)) {
    const base = lower.replace(/small finance bank.*$/i, "").replace(/[^a-z]/g, "").trim();
    if (base) {
      candidates.add(base + "sfb");
      candidates.add(base);
    }
  }

  // 8. Payments bank pattern: "airtelpayments", "jiopayments"
  if (/payments? bank/i.test(name)) {
    const base = lower.replace(/payments? bank.*$/i, "").replace(/[^a-z]/g, "").trim();
    if (base) {
      candidates.add(base + "payments");
      candidates.add(base);
    }
  }

  // 9. Cooperative bank patterns: "abhyudaya", "cosmos"
  if (/co-?operative|sahakari/i.test(name)) {
    const base = lower
      .replace(/the\s+/i, "")
      .replace(/co-?operative.*$/i, "")
      .replace(/sahakari.*$/i, "")
      .replace(/[^a-z]/g, "")
      .trim();
    if (base.length >= 3) candidates.add(base);
  }

  // 10. State co-op patterns: "tscb", "mscb" (abbreviation + "scb" or "cb")
  if (/state.*co-?operative/i.test(name)) {
    const stateWord = significantWords[0]?.toLowerCase().replace(/[^a-z]/g, "");
    if (stateWord) {
      candidates.add(stateWord.slice(0, 2) + "scb"); // e.g., "tscb" for Tripura SCB
      candidates.add(stateWord + "scb");
    }
  }

  // 11. District central patterns: "dccb" suffix
  if (/district.*central/i.test(name)) {
    const district = significantWords[0]?.toLowerCase().replace(/[^a-z]/g, "");
    if (district) {
      candidates.add(district + "dccb");
    }
  }

  // Filter out too-short or too-long candidates
  return [...candidates]
    .filter((c) => c.length >= 2 && c.length <= 40)
    .map((c) => `${c}.bank.in`);
}

// ── HTTP probe with title verification ─────────────────────────────

/** Probe a domain: check it responds, then verify the page title contains the bank name. */
function probeAndVerify(domain, bankName, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const url = `https://${domain}`;
    const req = https.get(url, { timeout: timeoutMs, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      // Follow one redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve({ ok: true, title: "(redirect)", verified: false });
      }
      if (res.statusCode >= 400) {
        res.resume();
        return resolve({ ok: false });
      }
      // Read enough to find <title>
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
        if (body.length > 50000) res.destroy(); // enough to find title
      });
      res.on("end", () => resolveWithTitle(body));
      res.on("close", () => resolveWithTitle(body));

      function resolveWithTitle(html) {
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
        // Verify: does the title plausibly match the bank name?
        const verified = titleContainsBank(title, bankName);
        resolve({ ok: true, title, verified });
      }
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false }); });
  });
}

/** Check if a page title plausibly matches a bank name. */
function titleContainsBank(title, bankName) {
  if (!title) return false;
  const tLower = title.toLowerCase();
  const nLower = bankName.toLowerCase();

  // Extract significant words from bank name (skip common words)
  const skip = new Set(["the", "of", "and", "ltd", "ltd.", "limited", "bank", "co-operative",
    "cooperative", "co", "operative", "pvt", "private", "plc", "bsc", "pjsc", "na", "ag"]);
  const nameWords = nLower.replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !skip.has(w));

  if (nameWords.length === 0) return true; // can't verify, assume ok

  // At least one significant word must appear in the title
  return nameWords.some((w) => tLower.includes(w));
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Guess bank.in Domains ${dryRun ? "(DRY RUN)" : ""} ===\n`);

  // Build bank list
  let banks = [];
  if (singleBank) {
    banks.push({ name: singleBank, category: "" });
  } else {
    banks = loadBanksCSV(csvFile, { categoryFilter });
  }

  // Skip banks that already have a domain in cache
  const uncached = banks.filter((b) => {
    const slug = slugify(b.name);
    const entry = domains[slug];
    return !entry || !entry.domain;
  });

  console.log(`  Total banks: ${banks.length}`);
  console.log(`  Already cached: ${banks.length - uncached.length}`);
  console.log(`  To probe: ${Math.min(uncached.length, limit)}\n`);

  const toProbe = uncached.slice(0, limit);
  let found = 0;
  let notFound = 0;

  for (const bank of toProbe) {
    const slug = slugify(bank.name);
    const candidates = generateCandidates(bank.name);

    if (dryRun) {
      console.log(`  ${slug}:`);
      for (const c of candidates) console.log(`    ${c}`);
      continue;
    }

    // Probe candidates in parallel (max 5 at a time), verify via page title
    let hitDomain = null;
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5);
      const results = await Promise.all(batch.map(async (domain) => {
        const result = await probeAndVerify(domain, bank.name);
        return { domain, ...result };
      }));

      // Prefer verified hits; fall back to unverified if no verified found
      const verified = results.find((r) => r.ok && r.verified);
      if (verified) {
        hitDomain = verified.domain;
        break;
      }
      // Keep first unverified hit as fallback (but keep probing for a verified one)
      if (!hitDomain) {
        const unverified = results.find((r) => r.ok);
        if (unverified) hitDomain = unverified.domain;
      }
    }

    // If we only have an unverified hit, warn about it
    if (hitDomain) {
      // Re-verify the final candidate
      const check = await probeAndVerify(hitDomain, bank.name);
      if (check.verified) {
        found++;
        console.log(`  ✓ ${slug} → ${hitDomain}`);

        // Update cache — only set domain, never overwrite existing fields
        const existing = domains[slug] || {};
        domains[slug] = { ...existing, domain: existing.domain || hitDomain };
      } else {
        // Title doesn't match — likely a false positive (e.g., acronym collision)
        notFound++;
        console.log(`  ✗ ${slug} — ${hitDomain} responded but title doesn't match: "${(check.title || "").slice(0, 60)}"`);
        hitDomain = null;
      }
    } else {
      notFound++;
      console.log(`  ✗ ${slug} — no bank.in found (tried ${candidates.length} candidates)`);
    }
  }

  if (!dryRun && found > 0) {
    // Sort and write
    const sorted = {};
    for (const key of Object.keys(domains).sort()) sorted[key] = domains[key];
    // safe-write-exempt: TODO migrate per ADR-012 — registry write (kind: 'registry-file', source: 'agent'). Not in the Sprint 002 #15b 5-writer scope; queued for follow-up.
    fs.writeFileSync(DOMAINS_FILE, JSON.stringify(sorted, null, 2) + "\n");
  }

  console.log(`\n=== Summary ${dryRun ? "(DRY RUN)" : ""} ===`);
  console.log(`  Found: ${found}`);
  console.log(`  Not found: ${notFound}`);
  if (found > 0) console.log(`  Updated: ${DOMAINS_FILE}`);
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
