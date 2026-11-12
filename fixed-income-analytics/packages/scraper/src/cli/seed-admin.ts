#!/usr/bin/env node
/**
 * Seed an admin user into the database.
 *
 * Usage:
 *   npx tsx packages/scraper/src/cli/seed-admin.ts --email admin@bird.app --password secret123
 */
import { resolve } from "path";
import { createDb, schema } from "../db.js";
import { eq } from "drizzle-orm";

const projectRoot = resolve(import.meta.dirname!, "../../../..");
process.chdir(projectRoot);

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const email = getArg("email");
const password = getArg("password");
const name = getArg("name") || "Admin";

if (!email || !password) {
  console.error("Usage: seed-admin --email <email> --password <password> [--name <name>]");
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

// Hash password using the same PBKDF2 approach as the API
// (Web Crypto API is available in Node 20+)
async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${toHex(salt.buffer)}:${toHex(hash)}`;
}

async function main() {
  const { db } = createDb();
  const now = new Date().toISOString();

  // Check if user exists
  const existing = db.select().from(schema.users).where(eq(schema.users.email, email!)).get();

  if (existing) {
    // Update to admin
    db.update(schema.users)
      .set({ role: "admin", password_hash: await hashPassword(password!), updated_at: now })
      .where(eq(schema.users.id, existing.id))
      .run();
    console.log(`Updated existing user ${email} to admin role.`);
  } else {
    db.insert(schema.users)
      .values({
        email: email!,
        name,
        password_hash: await hashPassword(password!),
        role: "admin",
        created_at: now,
        updated_at: now,
      })
      .run();
    console.log(`Created admin user: ${email}`);
  }
}

main().catch(err => {
  console.error(`Failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
