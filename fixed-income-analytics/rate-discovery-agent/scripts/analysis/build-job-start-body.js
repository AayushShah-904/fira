#!/usr/bin/env node
'use strict';

/**
 * Sprint 002 #16 smoke — build the body for POST .../Microsoft.App/jobs/{name}/start.
 *
 * Reads the current Job spec (template.containers[0]) and emits an override
 * body that inherits image/env/resources but adds `args: [slug, slug, ...]`
 * so a single execution runs run-batch.js against the named slugs.
 *
 * Identical to what functions/start-discovery/lib/dispatch.js does, but
 * inlined so the operator can trigger it via az without going through the
 * (currently disabled) Function trigger.
 *
 * Usage:
 *   node scripts/analysis/build-job-start-body.js \
 *     --job-spec path/to/job-spec.json \
 *     --slugs-from <module> \
 *     --out path/to/start-body.json
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const jobSpecPath = flag('--job-spec');
const slugsFromModule = flag('--slugs-from');
const slugsLiteralFile = flag('--slugs-file');
const outPath = flag('--out');

if (!jobSpecPath || (!slugsFromModule && !slugsLiteralFile) || !outPath) {
  console.error('Usage: --job-spec <path> (--slugs-from <module>|--slugs-file <path>) --out <path>');
  process.exit(1);
}

const jobSpec = JSON.parse(fs.readFileSync(jobSpecPath, 'utf-8'));
const baseContainer = jobSpec.properties.template.containers[0];
if (!baseContainer || !baseContainer.image) {
  console.error('Could not find container[0] image in job spec');
  process.exit(1);
}

let slugs;
if (slugsFromModule) {
  const mod = require(path.resolve(slugsFromModule));
  const sample = mod.selectSample();
  slugs = sample.map((b) => typeof b === 'string' ? b : (b.slug || b.bank_code));
} else {
  slugs = JSON.parse(fs.readFileSync(slugsLiteralFile, 'utf-8'));
  if (!Array.isArray(slugs)) {
    console.error(`--slugs-file must be a JSON array of strings; got ${typeof slugs}`);
    process.exit(1);
  }
}

const triggerEnv = [
  { name: 'TRIGGER_SOURCE', value: 'operator-manual' },
  { name: 'TRIGGER_REQUEST_ID', value: `smoke-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}` },
];

// ARM body shape for POST .../jobs/{name}/start is JobExecutionTemplate,
// not Job.template. So containers go at root, no nested 'template' key.
// (functions/start-discovery/lib/dispatch.js wraps in {template:...} because
// the SDK reshapes for us — direct ARM doesn't.)
const body = {
  containers: [
    {
      name: baseContainer.name,
      image: baseContainer.image,
      args: slugs,
      env: [...(baseContainer.env || []), ...triggerEnv],
      resources: baseContainer.resources,
    },
  ],
};

// safe-write-exempt: operator-side ARM request body; not a per-bank artifact.
fs.writeFileSync(outPath, JSON.stringify(body, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`Container: ${baseContainer.name} @ ${baseContainer.image}`);
console.log(`Slug count: ${slugs.length}`);
console.log(`Env count (base + trigger): ${(baseContainer.env || []).length} + ${triggerEnv.length}`);
console.log(`First 5 slugs: ${slugs.slice(0, 5).join(', ')}`);
console.log(`Trigger request id: ${triggerEnv[1].value}`);
