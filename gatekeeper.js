// Local Proof Gatekeeper — Agent Games (zkVerify) Season 01, Creator Track build.
// Local only: binds 127.0.0.1, no public endpoint, no on-chain submission.
// Receives a task envelope, verifies the HMAC signature against the RAW body
// BEFORE parsing, decides APPROVE/REJECT with a reason code, generates a
// Groth16 proof of the decision with the OFFICIAL gatekeeper circuit, verifies
// the proof locally against the verification key exported from the official
// zkey, and returns the decision + proof, signed with x-agent-games-signature
// over the raw response body.
//
// HMAC secret: env AGENT_GAMES_HMAC_SECRET. Default is a LOCAL TEST placeholder
// ("test-secret-local-only"). The real platform secret comes from the
// dashboard's "Rotate Secret" and is NOT available to this build; never put a
// real secret in code or logs.
import http from "node:http";
import crypto from "node:crypto";
import { buildCircuitInput, prove, verify, REGISTERED_VK_HASH } from "./circuit.js";

export const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET ?? "test-secret-local-only";
export const HMAC_HEADER = "x-agent-games-signature";

export function hmacHex(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyHmac(secret, rawBody, headerValue) {
  if (typeof headerValue !== "string") return false;
  const given = headerValue.startsWith("sha256=") ? headerValue.slice(7) : headerValue;
  const expected = hmacHex(secret, rawBody);
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const normHex = (h) => String(h).toLowerCase();
const normAddr = (a) => normHex(a);

/**
 * Deterministic decision for one task envelope.
 * Order: reuse (a property of the proof reference, checked against the local
 * seen-set) first, then the field checks in the order the trap encyclopedia
 * lists them. Each task in the competition carries at most one trap, so the
 * order only matters for synthetic multi-trap tasks; it is documented here.
 * Returns { decision: "APPROVE"|"REJECT", reason_code }.
 */
export function decide(task, seenProofTx) {
  const inp = task.input;
  if (seenProofTx.has(inp.proof_tx)) {
    return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  }
  if (normHex(inp.proof_vk) !== normHex(inp.registered_vk)) {
    return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  }
  if (BigInt(inp.public_balance) < BigInt(inp.minimum)) {
    return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  }
  if (BigInt(inp.current_block) >= BigInt(inp.expiry_block)) {
    return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  }
  if (normAddr(inp.recipient) !== normAddr(inp.condition_recipient)) {
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  }
  if (BigInt(inp.amount) > BigInt(inp.max_transfer)) {
    return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  }
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

/**
 * Handle one task envelope end-to-end.
 * Returns { status, body } where body is the response object.
 * - HMAC failure -> 401, no decision (fail closed, nothing is processed).
 * - PROOF_REUSED -> REJECT with no proof (platform rule: reused tasks have no
 *   proof to submit and are excluded from the reliability bonus).
 * - Any other decision -> Groth16 proof generated + locally verified. If proof
 *   generation fails for a decision the circuit should support, fail closed
 *   with 500 and no decision rather than sending an unproven answer.
 * On APPROVE the proof_tx is recorded in the seen-set.
 */
export async function handleTask(task, seenProofTx, { secret = HMAC_SECRET } = {}) {
  const t0 = Date.now();
  const { decision, reason_code } = decide(task, seenProofTx);
  const decisionBit = decision === "APPROVE" ? 1 : 0;

  let proof = null;
  let publicSignals = null;
  let proveMs = null;
  let verifyMs = null;

  if (reason_code === "PROOF_REUSED") {
    // No proof exists for this decision by design: the fields are valid, so
    // the circuit would demand decision=1. Recorded, not proven.
  } else {
    const input = buildCircuitInput(task, decisionBit);
    const proved = await prove(input);
    proof = proved.proof;
    publicSignals = proved.publicSignals;
    proveMs = proved.proveMs;
    const checked = await verify(proof, publicSignals);
    verifyMs = checked.verifyMs;
    if (!checked.ok) {
      return { status: 500, body: { error: "local proof verification failed", task_id: task.task_id } };
    }
  }

  if (decision === "APPROVE") seenProofTx.add(task.input.proof_tx);

  const body = {
    decision,
    reason_code,
    proof_tx: task.input.proof_tx,
    ...(proof ? { proof, public_signals: publicSignals } : {}),
    meta: { response_ms: Date.now() - t0, prove_ms: proveMs, verify_ms: verifyMs },
  };
  return { status: 200, body };
}

export function createServer({ secret = HMAC_SECRET, port = 0 } = {}) {
  const seenProofTx = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      // 1. HMAC against the RAW body BEFORE parsing. Fail closed.
      if (!verifyHmac(secret, rawBody, req.headers[HMAC_HEADER])) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid signature" }));
        return;
      }
      let task;
      try {
        task = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
        return;
      }
      if (task.type !== "agent-games.proof-gatekeeper.v1" || !task.input) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unexpected task envelope" }));
        return;
      }
      const { status, body } = await handleTask(task, seenProofTx, { secret });
      const rawResponse = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        [HMAC_HEADER]: "sha256=" + hmacHex(secret, rawResponse),
      });
      res.end(rawResponse);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, seenProofTx, port: server.address().port });
    });
  });
}

// Run standalone: node gatekeeper.js [port]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 0);
  const { server, port: actual } = await createServer({ port });
  console.log(`gatekeeper listening on 127.0.0.1:${actual} (local only)`);
  console.log(`registered vk hash: ${REGISTERED_VK_HASH}`);
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}
