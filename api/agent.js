// Vercel serverless entry point for the Proof Gatekeeper agent.
// POST /api/agent — the platform's task endpoint (registered in the Agent
// Games dashboard). GET /api/agent — health probe (no HMAC): the platform's
// health-check path/method is unpublished, and a GET probe is the common
// shape; answering it here costs nothing (no decision, no data).
//
// Contract (arena plan §1, from the official /build, /rules, /events pages):
// - JSON POST to a public HTTPS endpoint, standard port 443.
// - Hard deadline 60 s per task (vercel.json sets maxDuration 60); fail closed.
// - Incoming HMAC verified against the RAW body BEFORE parsing — 401 on any
//   failure. Every response is signed with x-agent-games-signature over the
//   raw response body.
// - Task IDs are idempotency keys (lib/core.js returns the cached response
//   for a retry of a decided task_id).
// - State (seen-set + response cache) lives in Upstash Redis via lib/store.js;
//   without UPSTASH_* env vars the handler falls back to an in-memory store
//   and warns — fine for local dev, NOT for production (see DEPLOY.md).
//
// Env vars (Vercel project Settings -> Environment Variables, never in repo):
//   AGENT_GAMES_HMAC_SECRET   32-byte secret from dashboard registration (shown once)
//   UPSTASH_REDIS_REST_URL     Upstash database REST URL
//   UPSTASH_REDIS_REST_TOKEN   Upstash database REST token
//
// NOTE: only plain Node http APIs (writeHead/end) are used here — no
// Express-style helpers — so the handler runs identically on Vercel and in
// the local test harness.
import { handleTask } from "../lib/core.js";
import { HMAC_SECRET, HMAC_HEADER, hmacHex, verifyHmac } from "../lib/hmac.js";
import { createStoreFromEnv } from "../lib/store.js";

// Module-level: reused across warm invocations of the same instance.
// The Redis client itself is stateless (REST); the in-memory fallback store
// inside ResilientStore persists across warm invocations on this instance.
const store = createStoreFromEnv();
const secret = process.env.AGENT_GAMES_HMAC_SECRET ?? HMAC_SECRET;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const raw = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(raw);
  return raw;
}

export default async function handler(req, res) {
  // Health probe: no HMAC, no decision, no data.
  if (req.method === "GET") {
    sendJson(res, 200, { status: "ok", service: "zkverify-proof-gatekeeper", store: store.mode });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const startedAt = Date.now();
  const rawBody = await readRawBody(req);

  // 1. HMAC against the RAW body BEFORE parsing. Fail closed.
  if (!verifyHmac(secret, rawBody, req.headers[HMAC_HEADER])) {
    sendJson(res, 401, { error: "invalid signature" });
    return;
  }
  let task;
  try {
    task = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid json" });
    return;
  }
  if (task.type !== "agent-games.proof-gatekeeper.v1" || !task.input || !task.task_id) {
    sendJson(res, 400, { error: "unexpected task envelope" });
    return;
  }

  // 2. Soft deadline guard: never start proving with <10 s left of the 60 s
  //    platform deadline (proving itself takes ~300 ms; this is belt-and-braces).
  if (Date.now() - startedAt > 50000) {
    sendJson(res, 500, { error: "deadline exceeded before proving", task_id: task.task_id });
    return;
  }

  const { status, body } = await handleTask(task, store, { secret });
  sendJson(res, status, body, { [HMAC_HEADER]: "sha256=" + hmacHex(secret, JSON.stringify(body)) });
}
