// Post-deploy smoke test for the Vercel gatekeeper endpoint.
// Usage:
//   ENDPOINT=https://<project>.vercel.app/api/agent \
//   AGENT_GAMES_HMAC_SECRET=<secret> node scripts/deploy-check.mjs
// Checks: GET health (200 ok), then a signed POST of a synthetic VALID task
// (expects 200 APPROVE/VALID_CONDITION, well inside 60 s) and verifies the
// response HMAC signature. Exits non-zero on any failure.
// The secret comes from the environment only — never commit or print it.
import crypto from "node:crypto";

const ENDPOINT = process.env.ENDPOINT;
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;
if (!ENDPOINT || !SECRET) {
  console.error("Usage: ENDPOINT=<url> AGENT_GAMES_HMAC_SECRET=<secret> node scripts/deploy-check.mjs");
  process.exit(2);
}

const hmacHex = (secret, rawBody) =>
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

const VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const task = {
  type: "agent-games.proof-gatekeeper.v1",
  task_id: `deploy_check_${Date.now()}`,
  mode: "practice",
  issued_at: new Date().toISOString(),
  deadline_at: new Date(Date.now() + 60000).toISOString(),
  input: {
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe42000000000000000000000000000000009f01",
    condition_recipient: "0xDe42000000000000000000000000000000009f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0x" + Buffer.from(`deploy-check-${Date.now()}`).toString("hex").padEnd(64, "0").slice(0, 64),
  },
};

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// 1. GET health (no HMAC).
const tHealth = Date.now();
const healthRes = await fetch(ENDPOINT, { method: "GET" });
const healthBody = await healthRes.text();
let healthJson = null;
try { healthJson = JSON.parse(healthBody); } catch { /* leave null */ }
check("GET health -> 200 ok", healthRes.status === 200 && healthJson?.status === "ok",
  `HTTP ${healthRes.status} in ${Date.now() - tHealth}ms`);

// 2. Signed POST of a valid task.
const raw = JSON.stringify(task);
const t0 = Date.now();
const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-agent-games-signature": "sha256=" + hmacHex(SECRET, raw),
  },
  body: raw,
});
const ms = Date.now() - t0;
const resRaw = await res.text();
let body = null;
try { body = JSON.parse(resRaw); } catch { /* leave null */ }
const sigOk = res.headers.get("x-agent-games-signature") === hmacHex(SECRET, resRaw);
check("POST valid task -> 200 APPROVE/VALID_CONDITION",
  res.status === 200 && body?.decision === "APPROVE" && body?.reason_code === "VALID_CONDITION",
  `HTTP ${res.status} in ${ms}ms, decision=${body?.decision}/${body?.reason_code}`);
check("response < 60 s", ms < 60000, `${ms}ms`);
check("response signature valid", sigOk);
check("proof present in response", body && typeof body.proof === "object");
check("store mode reported", typeof body?.meta?.store === "string", `store=${body?.meta?.store}`);

console.log(failures === 0 ? "\nDeploy check: OK" : `\nDeploy check: ${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
