// Local Proof Gatekeeper — Agent Games (zkVerify) Season 01, Creator Track build.
// Local only: binds 127.0.0.1, no public endpoint, no on-chain submission.
// Receives a task envelope, verifies the HMAC signature against the RAW body
// BEFORE parsing, decides APPROVE/REJECT with a reason code, generates a
// Groth16 proof of the decision with the OFFICIAL gatekeeper circuit, verifies
// the proof locally against the verification key exported from the official
// zkey, and returns the decision + proof, signed with x-agent-games-signature
// over the raw response body.
//
// Shared logic lives in lib/ (same code the Vercel serverless handler uses):
//   lib/hmac.js   — HMAC helpers + secret handling
//   lib/decide.js — deterministic 7-way decision (semantics unchanged)
//   lib/core.js   — handleTask: idempotent cache -> decide -> prove -> commit
//   lib/store.js  — durable store (Upstash Redis) / in-memory store
// This file is now only the local HTTP server around lib/core.js. The local
// server keeps an in-memory Set + response cache (per-process); the serverless
// port uses the durable Redis store instead.
//
// HMAC secret: env AGENT_GAMES_HMAC_SECRET. Default is a LOCAL TEST placeholder
// ("test-secret-local-only"). The real platform secret comes from the
// dashboard's "Rotate Secret" and is NOT available to this build; never put a
// real secret in code or logs.
import http from "node:http";
import { REGISTERED_VK_HASH } from "./circuit.js";
import { HMAC_SECRET, HMAC_HEADER, hmacHex, verifyHmac } from "./lib/hmac.js";
import { decide } from "./lib/decide.js";
import { handleTask as coreHandleTask } from "./lib/core.js";

export { HMAC_SECRET, HMAC_HEADER, hmacHex, verifyHmac, decide, REGISTERED_VK_HASH };

/**
 * Legacy adapter: handleTask with a caller-provided Set as the seen-set.
 * Kept for API compatibility with the original local build. NOTE: through
 * this signature the response cache does not survive across calls — use
 * lib/core.js handleTask with a store for the idempotent path (that is what
 * createServer below does).
 */
export async function handleTask(task, seenProofTx, { secret = HMAC_SECRET } = {}) {
  const cache = new Map();
  const store = {
    mode: "memory",
    getState: async (taskId, proofTx) => ({
      cached: cache.get(taskId) ?? null,
      seen: seenProofTx.has(proofTx),
    }),
    commit: async (taskId, response, proofTx) => {
      cache.set(taskId, response);
      if (proofTx) seenProofTx.add(proofTx);
    },
  };
  return coreHandleTask(task, store, { secret });
}

export function createServer({ secret = HMAC_SECRET, port = 0 } = {}) {
  const seenProofTx = new Set();
  const responseCache = new Map();
  // In-memory store for the local server: same interface as lib/store.js.
  // The idempotency fix applies here too — a retry of a decided task_id
  // returns the cached response instead of flipping to PROOF_REUSED.
  const store = {
    mode: "memory",
    getState: async (taskId, proofTx) => ({
      cached: responseCache.get(taskId) ?? null,
      seen: seenProofTx.has(proofTx),
    }),
    commit: async (taskId, response, proofTx) => {
      responseCache.set(taskId, response);
      if (proofTx) seenProofTx.add(proofTx);
    },
  };
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
      const { status, body } = await coreHandleTask(task, store, { secret });
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
