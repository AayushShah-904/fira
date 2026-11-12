import { Hono } from "hono";
import type { Env } from "../app.js";

export const healthRoutes = new Hono<Env>().get("/health", (c) => {
  return c.json({ status: "ok", environment: c.env.ENVIRONMENT });
});
