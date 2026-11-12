import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users, sessions } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { requireAuth } from "../middleware/auth.js";
import type { Env } from "../app.js";

const SESSION_TTL_DAYS = 30;

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function sessionExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_TTL_DAYS);
  return d.toISOString();
}

export const authRoutes = new Hono<Env>()
  // POST /auth/register
  .post("/auth/register", async (c) => {
    const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
    const { email, password, name } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const db = drizzle(c.env.DB);

    // Check if email already exists
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (existing) {
      return c.json({ error: "Email already registered" }, 409);
    }

    const password_hash = await hashPassword(password);
    const now = new Date().toISOString();

    const result = await db
      .insert(users)
      .values({ email, name: name || null, password_hash, role: "user", created_at: now, updated_at: now })
      .run();

    const userId = Number(result.meta.last_row_id);
    const token = generateToken();

    await db.insert(sessions).values({
      user_id: userId,
      token,
      expires_at: sessionExpiry(),
    }).run();

    return c.json({
      token,
      user: { id: userId, email, name: name || null, role: "user" },
    }, 201);
  })

  // POST /auth/login
  .post("/auth/login", async (c) => {
    const body = await c.req.json<{ email?: string; password?: string }>();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const db = drizzle(c.env.DB);

    const user = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .get();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    const token = generateToken();
    await db.insert(sessions).values({
      user_id: user.id,
      token,
      expires_at: sessionExpiry(),
    }).run();

    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  })

  // POST /auth/logout
  .post("/auth/logout", requireAuth, async (c) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.slice(7);
    if (token) {
      const db = drizzle(c.env.DB);
      await db.delete(sessions).where(eq(sessions.token, token)).run();
    }
    return c.json({ ok: true });
  })

  // GET /auth/me
  .get("/auth/me", requireAuth, async (c) => {
    const user = c.get("user");
    return c.json({ user });
  });
