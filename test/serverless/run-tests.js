// Serverless-port tests: the Vercel handler (api/agent.js) + lib/core.js +
// lib/store.js, against a MOCK Upstash REST server (no cloud accounts).
// Covers what the local suite cannot:
//   A. All 7 decisions through the real handler, store-backed (Redis mock).
//   B. Idempotency fix: retrying a decided task_id returns the CACHED response
//      (same decision, same body) — never flips APPROVE -> PROOF_REUSED.
//   C. Cross-"invocation" seen-set: T0 APPROVE then a different task_id with
//      the same proof_tx -> PROOF_REUSED (proves the durable store works
//      across handler calls, which an in-memory Set cannot do serverless).
//   D. TTL expiry: keys disappear after the TTL.
//   E. Redis-down fallback: store pointing at a dead URL still decides
//      correctly (mode "memory-fallback"), never 500s on a store error.
//   F. HMAC negatives + GET health through the handler.
// Writes test/serverless/results.json. Exits non-zero on any failure.
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { HMAC_HEADER, hmacHex } from "../../lib/hmac.js";
import { RedisStore, ResilientStore, MemoryStore } from "../../lib/store.js";
import { handleTask } from "../../lib/core.js";

const SECRET = "test-secret-local-only";
const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const RECIPIENT = "0xDe42000000000000000000000000000000009f01";
const OTHER_ADDR = "0xAb00000000000000000000000000000000000001";
const TX0 = "0xA4C1000000000000000000000000000000000000000000000000000000008FF1";

function envelope(task_id, input) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id,
    mode: "competition",
    issued_at: "2026-11-16T07:00:00Z",
    deadline_at: "2026-11-16T07:01:00Z",
    input,
  };
}

const base = (over = {}) => ({
  registered_vk: VK,
  proof_vk: VK,
  minimum: "1000",
  public_balance: "1460",
  expiry_block: 19842201,
  current_block: 19832000,
  recipient: RECIPIENT,
  condition_recipient: RECIPIENT,
  amount: "500",
  max_transfer: "1000",
  proof_tx: TX0,
  ...over,
});

const TASKS = [
  { id: "T0-valid", task: envelope("gk_srv_001", base()), expect: { decision: "APPROVE", reason_code: "VALID_CONDITION" } },
  { id: "T1-vk-substitution", task: envelope("gk_srv_002", base({
      proof_vk: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
      proof_tx: "0xA4C2000000000000000000000000000000000000000000000000000000008FF2" })),
    expect: { decision: "REJECT", reason_code: "VK_SUBSTITUTION" } },
  { id: "T2-threshold-mismatch", task: envelope("gk_srv_003", base({
      public_balance: "999",
      proof_tx: "0xA4C3000000000000000000000000000000000000000000000000000000008FF3" })),
    expect: { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" } },
  { id: "T3-proof-reused", task: envelope("gk_srv_004", base({ proof_tx: TX0 })),
    expect: { decision: "REJECT", reason_code: "PROOF_REUSED" } },
  { id: "T4-expired", task: envelope("gk_srv_005", base({
      current_block: 19842201,
      proof_tx: "0xA4C5000000000000000000000000000000000000000000000000000000008FF5" })),
    expect: { decision: "REJECT", reason_code: "EXPIRED_CONDITION" } },
  { id: "T5-recipient-mismatch", task: envelope("gk_srv_006", base({
      condition_recipient: OTHER_ADDR,
      proof_tx: "0xA4C6000000000000000000000000000000000000000000000000000000008FF6" })),
    expect: { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" } },
  { id: "T6-amount-overflow", task: envelope("gk_srv_007", base({
      amount: "1001",
      proof_tx: "0xA4C7000000000000000000000000000000000000000000000000000000008FF7" })),
    expect: { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" } },
];

// ---- Mock Upstash REST server (POST / with ["CMD",...] or POST /pipeline
// with [["CMD",...],...]) — mirrors real Upstash: a pipeline posted to the
// bare URL is a syntax error (HTTP 400). ----
function startMockUpstash() {
  const data = new Map(); // key -> { value, expiresAt }
  const seenCommands = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let commands;
      try {
        commands = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const isPipeline = Array.isArray(commands[0]);
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (isPipeline && pathname !== "/pipeline") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ERR pipeline must be sent to /pipeline" }));
        return;
      }
      if (!isPipeline && pathname !== "/") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ERR single command must be sent to /" }));
        return;
      }
      const list = isPipeline ? commands : [commands];
      const results = list.map((cmd) => {
        seenCommands.push(cmd[0]);
        const [op, key, value, ...rest] = cmd;
        if (op === "GET") {
          const entry = data.get(key);
          if (!entry) return { result: null };
          if (Date.now() > entry.expiresAt) { data.delete(key); return { result: null }; }
          return { result: entry.value };
        }
        if (op === "SET") {
          let ttlMs = 0;
          for (let i = 0; i < rest.length; i += 2) {
            if (rest[i] === "EX") ttlMs = Number(rest[i + 1]) * 1000;
          }
          data.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : Infinity });
          return { result: "OK" };
        }
        return { error: `ERR unknown command '${op}'` };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(isPipeline ? results : results[0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seenCommands }));
  });
}

// ---- Mock req/res for the Vercel handler (plain Node http APIs only) ----
function mockReq({ method = "POST", headers = {}, body = "" }) {
  const stream = Readable.from([Buffer.from(body, "utf8")]);
  stream.method = method;
  stream.headers = headers;
  return stream;
}

function mockRes() {
  let status = null;
  let headers = {};
  let body = "";
  let done = null;
  const donePromise = new Promise((resolve) => { done = resolve; });
  return {
    writeHead(s, h) { status = s; headers = h; },
    end(raw) { body = raw; done(); },
    done: donePromise,
    get status() { return status; },
    get headers() { return headers; },
    get body() { return body; },
  };
}

const results = { ran_at: new Date().toISOString(), handler: [], idempotency: [], store: [] };
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

const { server: mockServer, port: mockPort, seenCommands } = await startMockUpstash();
console.log(`mock Upstash REST on 127.0.0.1:${mockPort}`);

// Env must be set BEFORE importing api/agent.js (module-level store creation).
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${mockPort}`;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
process.env.AGENT_GAMES_HMAC_SECRET = SECRET;
const { default: agentHandler } = await import("../../api/agent.js");
const { default: healthHandler } = await import("../../api/health.js");

async function callAgent(task, sigSecret = SECRET) {
  const raw = JSON.stringify(task);
  const req = mockReq({
    method: "POST",
    headers: { "content-type": "application/json", [HMAC_HEADER]: "sha256=" + hmacHex(sigSecret, raw) },
    body: raw,
  });
  const res = mockRes();
  const t0 = Date.now();
  await agentHandler(req, res);
  await res.done;
  const ms = Date.now() - t0;
  let body = null;
  try { body = JSON.parse(res.body); } catch { /* leave null */ }
  return { status: res.status, headers: res.headers, body, raw: res.body, ms };
}

// ---- A. All 7 decisions through the handler (Redis-backed store) ----
console.log("\n== A. Handler decisions (mock Redis store) ==");
for (const t of TASKS) {
  const r = await callAgent(t.task);
  const decisionOk = r.body && r.body.decision === t.expect.decision && r.body.reason_code === t.expect.reason_code;
  const sigOk = r.body && r.headers[HMAC_HEADER] === hmacHex(SECRET, r.raw);
  const expectProof = t.id !== "T3-proof-reused";
  const hasProof = r.body && typeof r.body.proof === "object";
  check(`${t.id}: decision ${t.expect.decision}/${t.expect.reason_code}`,
    r.status === 200 && decisionOk && sigOk && r.ms < 60000 && hasProof === expectProof,
    `HTTP ${r.status}, ${r.ms}ms, proof=${hasProof}, resp-sig-ok=${sigOk}, store=${r.body?.meta?.store}`);
  results.handler.push({ task: t.id, status: r.status, ms: r.ms,
    decision: r.body?.decision, reason_code: r.body?.reason_code,
    proof_present: hasProof, response_sig_ok: sigOk, store: r.body?.meta?.store ?? null });
}

// ---- B. Idempotency: retry the SAME task_id -> cached, identical, no flip ----
console.log("\n== B. Idempotency (the bug fix) ==");
{
  const first = await callAgent(TASKS[0].task); // T0 APPROVE, already decided in A
  const second = await callAgent(TASKS[0].task);
  const sameBody = JSON.stringify(first.body) === JSON.stringify(second.body);
  check("retry APPROVE task_id returns identical cached response",
    first.status === 200 && second.status === 200 && sameBody && second.body.decision === "APPROVE",
    `first=${first.body?.decision}/${first.body?.reason_code} second=${second.body?.decision}/${second.body?.reason_code} identical=${sameBody} store=${second.body?.meta?.store}`);
  results.idempotency.push({ case: "retry-approve", identical: sameBody,
    first: first.body?.decision, second: second.body?.decision, store: second.body?.meta?.store });

  const r1 = await callAgent(TASKS[1].task); // T1 REJECT/VK_SUBSTITUTION, already decided
  const r2 = await callAgent(TASKS[1].task);
  const sameBody2 = JSON.stringify(r1.body) === JSON.stringify(r2.body);
  check("retry REJECT task_id returns identical cached response",
    r1.status === 200 && r2.status === 200 && sameBody2 && r2.body.decision === "REJECT",
    `identical=${sameBody2} store=${r2.body?.meta?.store}`);
  results.idempotency.push({ case: "retry-reject", identical: sameBody2,
    first: r1.body?.decision, second: r2.body?.decision, store: r2.body?.meta?.store });

  // A retry must NOT be re-decided as PROOF_REUSED: the cached APPROVE has no
  // PROOF_REUSED reason, and meta.store must say redis (served from the store).
  check("retry was served from the durable store, not re-decided",
    second.body?.meta?.store === "redis" && r2.body?.meta?.store === "redis",
    `approve-retry store=${second.body?.meta?.store}, reject-retry store=${r2.body?.meta?.store}`);
}

// ---- C. Cross-invocation seen-set is already proven by T3 in section A,
//      but prove it again with a FRESH task_id reusing T0's proof_tx ----
console.log("\n== C. Fresh task_id reusing a seen proof_tx ==");
{
  const fresh = envelope("gk_srv_008", base({ proof_tx: TX0 }));
  const r = await callAgent(fresh);
  check("fresh task_id, reused proof_tx -> REJECT/PROOF_REUSED",
    r.status === 200 && r.body?.decision === "REJECT" && r.body?.reason_code === "PROOF_REUSED",
    `${r.body?.decision}/${r.body?.reason_code}`);
  results.store.push({ case: "fresh-task-reused-tx", decision: r.body?.decision, reason_code: r.body?.reason_code });
}

// ---- D. TTL expiry (1 s TTL store, direct RedisStore calls) ----
console.log("\n== D. TTL expiry ==");
{
  const shortStore = new RedisStore(`http://127.0.0.1:${mockPort}`, "test-token", { ttlSeconds: 1 });
  await shortStore.commit("ttl_task_1", { status: 200, body: { decision: "APPROVE" } }, "0xttl1");
  const before = await shortStore.getState("ttl_task_1", "0xttl1");
  check("keys present before TTL", before.cached !== null && before.seen === true, JSON.stringify(before.cached));
  await new Promise((r) => setTimeout(r, 1200));
  const after = await shortStore.getState("ttl_task_1", "0xttl1");
  check("keys gone after TTL", after.cached === null && after.seen === false, JSON.stringify(after));
  results.store.push({ case: "ttl-expiry", before_cached: before.cached !== null, after_cached: after.cached !== null });
}

// ---- E. Redis-down fallback: dead URL still decides correctly ----
console.log("\n== E. Redis-down fallback ==");
{
  const deadStore = new ResilientStore(
    new RedisStore("http://127.0.0.1:1", "test-token", { ttlSeconds: 60 }),
    new MemoryStore(60)
  );
  const r = await handleTask(TASKS[0].task, deadStore, { secret: SECRET });
  check("dead Redis -> correct APPROVE via memory fallback",
    r.status === 200 && r.body?.decision === "APPROVE" && r.store === "memory-fallback",
    `${r.body?.decision}/${r.body?.reason_code} store=${r.store}`);
  results.store.push({ case: "redis-down-fallback", decision: r.body?.decision, store: r.store });
}

// ---- F. HMAC negatives + GET health through the handler ----
console.log("\n== F. HMAC negatives + health ==");
{
  const raw = JSON.stringify(TASKS[0].task);
  const tampered = raw.replace("1460", "1461");
  const req1 = mockReq({ method: "POST", headers: { [HMAC_HEADER]: "sha256=" + hmacHex(SECRET, raw) }, body: tampered });
  const res1 = mockRes();
  await agentHandler(req1, res1);
  await res1.done;
  check("tampered body rejected", res1.status === 401, `HTTP ${res1.status}`);

  const req2 = mockReq({ method: "POST", headers: {}, body: raw });
  const res2 = mockRes();
  await agentHandler(req2, res2);
  await res2.done;
  check("missing signature rejected", res2.status === 401, `HTTP ${res2.status}`);

  const req3 = mockReq({ method: "POST", headers: { [HMAC_HEADER]: "sha256=" + hmacHex("wrong-secret", raw) }, body: raw });
  const res3 = mockRes();
  await agentHandler(req3, res3);
  await res3.done;
  check("wrong secret rejected", res3.status === 401, `HTTP ${res3.status}`);

  const req4 = mockReq({ method: "GET", headers: {}, body: "" });
  const res4 = mockRes();
  await agentHandler(req4, res4);
  await res4.done;
  check("GET /api/agent answers health (no HMAC needed)",
    res4.status === 200 && JSON.parse(res4.body).status === "ok", `HTTP ${res4.status}`);

  const res5 = mockRes();
  await healthHandler(mockReq({ method: "GET", headers: {}, body: "" }), res5);
  await res5.done;
  check("GET /api/health answers ok",
    res5.status === 200 && JSON.parse(res5.body).status === "ok", `HTTP ${res5.status}`);

  results.handler.push({ case: "hmac-negatives", tampered: res1.status, missing: res2.status, wrong: res3.status });
}

// ---- G. Preflight handshake (platform health check) ----
// The dashboard preflight sends a signed {type:"agent-games.preflight.v1"}
// with no input/task_id and expects HTTP 200 {ok:true, protocolVersion:"v1"}
// signed. Before the fix (17 Nov 2026) it 400'd on the task-envelope check.
console.log("\n== G. Preflight handshake ==");
{
  const r = await callAgent({ type: "agent-games.preflight.v1" });
  const sigOk = r.body && r.headers[HMAC_HEADER] === hmacHex(SECRET, r.raw);
  check("signed preflight answered 200 {ok:true, protocolVersion:v1}",
    r.status === 200 && r.body?.ok === true && r.body?.protocolVersion === "v1" && sigOk,
    `HTTP ${r.status}, resp-sig-ok=${sigOk}`);

  const bad = await callAgent({ type: "agent-games.preflight.v1" }, "wrong-secret");
  check("preflight with wrong secret rejected 401", bad.status === 401, `HTTP ${bad.status}`);

  results.handler.push({ case: "preflight", status: r.status, bad_secret_status: bad.status });
}

// Protocol sanity: the handler used pipelined GETs and SETs against the mock.
console.log(`\n== Mock Upstash protocol ==`);
console.log(`commands seen by mock: ${[...new Set(seenCommands)].join(", ")}`);
check("mock saw GET + SET commands", seenCommands.includes("GET") && seenCommands.includes("SET"),
  `unique: ${[...new Set(seenCommands)].join(", ")}`);

mockServer.close();
fs.writeFileSync(new URL("./results.json", import.meta.url).pathname, JSON.stringify(results, null, 2));

console.log(`\n== SUMMARY ==`);
console.log(`Handler decisions correct: ${results.handler.filter((h) => h.decision).length}/7`);
console.log(`Idempotency cases identical: ${results.idempotency.filter((i) => i.identical).length}/2`);
console.log(`Failures: ${failures}`);
process.exit(failures ? 1 : 0);
