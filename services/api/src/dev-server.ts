/**
 * Local development server (Node 22+, no Cloudflare account needed).
 *   npm run dev:api        → http://localhost:8787/api/v1
 * Creates services/api/.data/forge.dev.sqlite, applies migrations, seeds the registry, imports the dated
 * read-only snapshots of the live ledger and n8n history, runs the watchdog, then keeps ticking every minute.
 * Auth: send header `x-forge-dev-token: <token>` (token printed below; stored in services/api/.data/dev-token).
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { NodeD1, applyMigrations } from "./lib/node-d1.ts";
import { createApp } from "./app.ts";
import type { Env } from "./lib/env.ts";
import { seedRegistry } from "./domain/seed.ts";
import { REGISTRY_DATA } from "./domain/registry-data.ts";
import { defaultHandlers } from "./orchestration/handlers.ts";
import { enqueue, tick } from "./orchestration/engine.ts";
import { enqueueDue, seedSchedules, seedOperatorRegistry, OPERATOR_SCHEDULES } from "../../../packages/operator/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dataDir = join(root, ".data");
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "forge.dev.sqlite");
const fresh = !existsSync(dbPath);
const d1 = new NodeD1(dbPath);
if (fresh) applyMigrations(d1, join(root, "migrations"));

const tokenFile = join(dataDir, "dev-token");
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString("hex"));
const devToken = readFileSync(tokenFile, "utf8").trim();

const env: Env = {
  DB: d1.asD1(), ENVIRONMENT: "development",
  OWNER_EMAILS: process.env.FORGE_OWNER_EMAILS ?? "owner@forge.local",
  DEV_AUTH_TOKEN: devToken,
};
const handlers = defaultHandlers();
const app = createApp({ handlers });

async function bootTick() {
  const hour = new Date().toISOString().slice(0, 13);
  for (const kind of ["ledger.sync", "n8n.sync"]) await enqueue(env.DB, handlers, { kind, idempotencyKey: `${kind}:${hour}`, createdBy: "dev-server" });
  await tick(env.DB, env, handlers, { workerId: "dev" });
  await enqueue(env.DB, handlers, { kind: "heartbeat.watchdog", idempotencyKey: `heartbeat.watchdog:${new Date().toISOString().slice(0, 16)}`, createdBy: "dev-server" });
  await tick(env.DB, env, handlers, { workerId: "dev" });
  // Operator schedules make real read-only GETs to the live sites; opt in locally with FORGE_OPERATOR=1.
  if (process.env.FORGE_OPERATOR === "1") { await enqueueDue(env.DB, handlers); await tick(env.DB, env, handlers, { workerId: "dev" }); }
}

await seedRegistry(env.DB, REGISTRY_DATA);
await seedOperatorRegistry(env.DB);
await seedSchedules(env.DB, OPERATOR_SCHEDULES);
await bootTick();
setInterval(() => { bootTick().catch((e) => console.error("tick failed:", (e as Error).message)); }, 60000);

const CORS_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173"]);
const port = Number(process.env.PORT ?? 8787);
createServer(async (req, res) => {
  const origin = req.headers.origin ?? "";
  const cors: Record<string, string> = CORS_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type,x-forge-dev-token", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-credentials": "true", vary: "origin" } : {};
  if (req.method === "OPTIONS") { res.writeHead(204, cors).end(); return; }
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined });
  const response = await app.fetch(request, env);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, { ...headers, ...cors });
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`FORGE API (development) on http://localhost:${port}/api/v1`);
  console.log(`Dev auth header: x-forge-dev-token: ${devToken}   (local only; stored in services/api/.data/dev-token)`);
});
