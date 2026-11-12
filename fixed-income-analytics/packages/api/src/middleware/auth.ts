/**
 * Auth middleware for Hono.
 * Reads Bearer token from Authorization header, validates session.
 */
import { createMiddleware } from "hono/factory";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, gt } from "drizzle-orm";
import { users, sessions } from "../db/schema.js";
import type { Env } from "../app.js";

export type AuthUser = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};

// Extend Hono context with user
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

/**
 * Middleware that requires a valid session token.
 * Sets c.var.user on success. Returns 401 on failure.
 */
export const requireAuth = createMiddleware<Env>(async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const db = drizzle(c.env.DB);
  const now = new Date().toISOString();

  const session = await db
    .select({
      user_id: sessions.user_id,
      expires_at: sessions.expires_at,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.token, token),
        gt(sessions.expires_at, now),
      ),
    )
    .get();

  if (!session) {
    return c.json({ error: "Invalid or expired session" }, 401);
  }

  const user = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, session.user_id))
    .get();

  if (!user) {
    return c.json({ error: "User not found" }, 401);
  }

  c.set("user", user);
  await next();
});

/**
 * Middleware that requires admin role.
 * Must be used after requireAuth.
 */
export const requireAdmin = createMiddleware<Env>(async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "Admin access required" }, 403);
  }
  await next();
});
