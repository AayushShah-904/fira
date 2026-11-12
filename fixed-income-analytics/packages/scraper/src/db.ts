/**
 * Database connection helper for the scraper.
 * Uses better-sqlite3 to access the local Wrangler D1 SQLite database.
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import * as schema from "../../api/src/db/schema.js";

export { schema };

/**
 * Find the local D1 SQLite database file created by Wrangler.
 * Wrangler stores it under packages/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
 */
function findD1Database(): string {
  const apiDir = resolve(import.meta.dirname!, "../../api");
  const d1Dir = join(apiDir, ".wrangler", "state", "v3", "d1");
  if (!existsSync(d1Dir)) {
    throw new Error(
      `Wrangler D1 state not found at ${d1Dir}. Run 'npm run db:setup -w @bird/api' first.`,
    );
  }

  function findSqlite(dir: string): string | null {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith(".sqlite")) return full;
      if (stat.isDirectory()) {
        const found = findSqlite(full);
        if (found) return found;
      }
    }
    return null;
  }

  const dbPath = findSqlite(d1Dir);
  if (!dbPath) {
    throw new Error(
      `No .sqlite file found under ${d1Dir}. Run 'npm run db:setup -w @bird/api' first.`,
    );
  }
  return dbPath;
}

/**
 * Create a typed Drizzle ORM instance connected to the local D1 database.
 */
export function createDb() {
  const dbPath = findD1Database();
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, dbPath };
}

export type Db = ReturnType<typeof createDb>["db"];
