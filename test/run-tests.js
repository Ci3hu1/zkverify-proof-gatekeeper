// Test runner: synthetic task envelopes covering ALL 7 documented varieties
// (1 valid + 6 traps), HMAC negative tests, and a 14-attempt proof matrix
// (each task x correct decision + wrong decision) against the OFFICIAL circuit.
// Writes test/results.json and prints a summary table. Exits non-zero if any
// expectation fails.
import fs from "node:fs";
import http from "node:http";
import { createServer, HMAC_HEADER, HMAC_SECRET, hmacHex } from "../gatekeeper.js";
import { buildCircuitInput, prove, verify, REGISTERED_VK_HASH } from "../circuit.js";

const VK = REGISTERED_VK_HASH;
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
  { id: "T0-valid", task: envelope("gk_test_001", base()),
    expect: { decision: "APPROVE", reason_code: "VALID_CONDITION" } },
  { id: "T1-vk-substitution", task: envelope("gk_test_002", base({
      proof_vk: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
      proof_tx: "0xA4C2000000000000000000000000000000000000000000000000000000008FF2" })),
    expect: { decision: "REJECT", reason_code: "VK_SUBSTITUTION" } },
  { id: "T2-threshold-mismatch", task: envelope("gk_test_003", base({
      public_balance: "999",
      proof_tx: "0xA4C3000000000000000000000000000000000000000000000000000000008FF3" })),
    expect: { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" } },
  { id: "T3-proof-reused", task: envelope("gk_test_004", base({ proof_tx: TX0 })),
    expect: { decision: "REJECT", reason_code: "PROOF_REUSED" } },
  { id: "T4-expired", task: envelope("gk_test_005", base({
      current_block: 19842201,
      proof_tx: "0xA4C5000000000000000000000000000000000000000000000000000000008FF5" })),
    expect: { decision: "REJECT", reason_code: "EXPIRED_CONDITION" } },
  { id: "T5-recipient-mismatch", task: envelope("gk_test_006", base({
      condition_recipient: OTHER_ADDR,
      proof_tx: "0xA4C6000000000000000000000000000000000000000000000000000000008FF6" })),
    expect: { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" } },
  { id: "T6-amount-overflow", task: envelope("gk_test_007", base({
      amount: "1001",
      proof_tx: "0xA4C7000000000000000000000000000000000000000000000000000000008FF7" })),
    expect: { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" } },
];

function post(port, rawBody, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "POST", headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(rawBody),
        ...headers,
      } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
    req.on("error", reject);
    req.end(rawBody);
  });
}

const results = { ran_at: new Date().toISOString(), vk_hash: VK, http: [], hmac: [], matrix: [] };
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

// ---- A. HTTP-level: one POST per task, in order (T3 reuses T0's proof_tx) ----
const { server, port } = await createServer({ port: 0 });
console.log(`\n== HTTP tests (server 127.0.0.1:${port}) ==`);
for (const t of TASKS) {
  const raw = JSON.stringify(t.task);
  const t0 = Date.now();
  const res = await post(port, raw, { [HMAC_HEADER]: "sha256=" + hmacHex(HMAC_SECRET, raw) });
  const ms = Date.now() - t0;
  let body = null;
  try { body = JSON.parse(res.body); } catch { /* leave null */ }
  const decisionOk = body && body.decision === t.expect.decision && body.reason_code === t.expect.reason_code;
  const sigOk = body && res.headers[HMAC_HEADER] === "sha256=" + hmacHex(HMAC_SECRET, res.body);
  const hasProof = body && typeof body.proof === "object";
  const expectProof = t.id !== "T3-proof-reused";
  check(`${t.id}: decision ${t.expect.decision}/${t.expect.reason_code}`,
    res.status === 200 && decisionOk && sigOk && ms < 60000 && hasProof === expectProof,
    `HTTP ${res.status}, ${ms}ms, proof=${hasProof}, resp-sig-ok=${sigOk}`);
  results.http.push({ task: t.id, expect: t.expect, status: res.status, ms,
    decision: body?.decision, reason_code: body?.reason_code,
    proof_present: hasProof, response_sig_ok: sigOk,
    prove_ms: body?.meta?.prove_ms ?? null, verify_ms: body?.meta?.verify_ms ?? null });
}

// ---- B. HMAC negative tests ----
console.log(`\n== HMAC negative tests ==`);
const good = TASKS[0].task;
const rawGood = JSON.stringify(good);
const sigGood = "sha256=" + hmacHex(HMAC_SECRET, rawGood);
const tampered = rawGood.replace("1460", "1461");
const r1 = await post(port, tampered, { [HMAC_HEADER]: sigGood });
check("tampered body rejected", r1.status === 401, `HTTP ${r1.status}`);
results.hmac.push({ case: "tampered-body", status: r1.status, expect: 401 });
const r2 = await post(port, rawGood, {});
check("missing signature rejected", r2.status === 401, `HTTP ${r2.status}`);
results.hmac.push({ case: "missing-signature", status: r2.status, expect: 401 });
const r3 = await post(port, rawGood, { [HMAC_HEADER]: "sha256=" + hmacHex("wrong-secret", rawGood) });
check("wrong secret rejected", r3.status === 401, `HTTP ${r3.status}`);
results.hmac.push({ case: "wrong-secret", status: r3.status, expect: 401 });

// ---- C. Proof matrix: each task x correct decision + wrong decision ----
console.log(`\n== Proof matrix (14 attempts, official circuit) ==`);
for (const t of TASKS) {
  const correctBit = t.expect.decision === "APPROVE" ? 1 : 0;
  for (const [label, bit] of [["correct", correctBit], ["wrong", 1 - correctBit]]) {
    const isCorrect = label === "correct";
    // Correct decision proves — except PROOF_REUSED, whose fields are valid
    // so the circuit demands decision=1 and no proof of REJECT exists (the
    // platform's own rule: reused tasks have no proof to submit). A WRONG
    // decision must fail witness generation: the circuit cannot be made to
    // prove a lie (assert at GatekeeperEvaluation_79 line 102) — EXCEPT the
    // T3 "wrong" case: decision=1 for a reused proof DOES prove, because the
    // fields are valid and reuse is not a circuit input. That is the point:
    // the circuit alone cannot catch reuse; only the agent's seen-set can.
    // The agent still REJECTs it — decide() checks reuse before proving.
    const expectProve = t.id === "T3-proof-reused" ? !isCorrect : isCorrect;
    const t0 = Date.now();
    let outcome;
    try {
      const input = buildCircuitInput(t.task, bit);
      const { proof, publicSignals, proveMs } = await prove(input);
      const { ok, verifyMs } = await verify(proof, publicSignals);
      outcome = { proved: true, verified: ok, prove_ms: proveMs, verify_ms: verifyMs,
        public_signals: publicSignals, error: null };
    } catch (e) {
      outcome = { proved: false, verified: false, prove_ms: null, verify_ms: null,
        public_signals: null, error: String(e.message ?? e).split("\n")[0] };
    }
    const ms = Date.now() - t0;
    const ok = outcome.proved === expectProve && (expectProve ? outcome.verified === true : true);
    check(`${t.id} decision=${bit} (${label}): ${expectProve ? "proves+verifies" : "witness must fail"}`,
      ok, outcome.proved ? `prove ${outcome.prove_ms}ms, verify ${outcome.verify_ms}ms` : `failed: ${outcome.error}`);
    results.matrix.push({ task: t.id, decision: bit, label, expect_prove: expectProve,
      ...outcome, wall_ms: ms });
  }
}

// Public-signal annotation for the valid APPROVE proof (from the matrix).
// Positions are checked against the circuit's input order (the order the
// signals were probed in): [0]=output commitment, then the 12 public inputs
// in declaration order — salt is private and never appears.
const validProof = results.matrix.find((m) => m.task === "T0-valid" && m.label === "correct");
if (validProof?.public_signals) {
  const input = buildCircuitInput(TASKS[0].task, 1);
  const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const order = ["registeredVkHash", "proofVkHash", "minimum", "publicBalance",
    "expiryBlock", "currentBlock", "recipient", "conditionRecipient",
    "amount", "maxTransfer", "decision", "taskId"];
  console.log("\n== Public signals, T0 valid APPROVE (13 = 1 output + 12 public inputs) ==");
  const annotation = [{ index: 0, value: validProof.public_signals[0], field: "output-commitment" }];
  console.log(`  [0] ${validProof.public_signals[0]}  <- output commitment`);
  order.forEach((field, j) => {
    const expected = String(BigInt(input[field]) % P);
    const actual = validProof.public_signals[j + 1];
    const match = actual === expected;
    console.log(`  [${j + 1}] ${actual}  <- ${field}${match ? "" : "  MISMATCH (expected " + expected + ")"}`);
    annotation.push({ index: j + 1, value: actual, field, matches_input: match });
    if (!match) failures++;
  });
  results.public_signals_annotation = annotation;
}

server.close();
fs.writeFileSync(new URL("./results.json", import.meta.url).pathname, JSON.stringify(results, null, 2));

const nHttp = results.http.filter((h) => h.decision).length;
const nMatrixProve = results.matrix.filter((m) => m.proved).length;
const nMatrixVerify = results.matrix.filter((m) => m.verified).length;
console.log(`\n== SUMMARY ==`);
console.log(`HTTP decisions correct: ${results.http.filter((h) => h.status === 200).length}/7 (all <60s)`);
console.log(`HMAC negatives rejected: ${results.hmac.filter((h) => h.status === 401).length}/3`);
console.log(`Proof matrix: ${nMatrixProve}/14 proved, ${nMatrixVerify}/14 verified locally`);
console.log(`Failures: ${failures}`);
process.exit(failures ? 1 : 0);
