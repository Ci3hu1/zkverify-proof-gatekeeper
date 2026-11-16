// Core task handling, shared by the local server (gatekeeper.js) and the
// Vercel serverless handler (api/agent.js). Decision semantics are IDENTICAL
// to the local build — decide() in lib/decide.js is untouched; only the state
// backend changed (durable store instead of an in-memory Set).
//
// Flow:
//   1. Idempotency FIRST: if task_id already has a cached response, return it
//      verbatim (same decision, same proof). This is the fix for the bug the
//      arena plan found: without the cache, a platform retry of an APPROVEd
//      task would find proof_tx in the seen-set and flip to REJECT/PROOF_REUSED.
//   2. decide() with the durable seen-check (pre-fetched boolean).
//   3. PROOF_REUSED -> REJECT with no proof (platform rule: reused tasks have
//      no proof to submit, excluded from the reliability bonus).
//   4. Any other decision -> Groth16 proof generated + locally verified. If
//      proof generation fails for a decision the circuit should support, fail
//      closed with 500 and no decision rather than sending an unproven answer.
//   5. commit() writes the response cache AND (on APPROVE) the seen-mark
//      together, so the two can never diverge.
//   6. The response body shape is unchanged from the local build:
//      { decision, reason_code, proof_tx, proof?, public_signals?, meta }.
//      (Whether the platform wants the proof in a different field is an open
//      unknown — only a practice task resolves it; see DEPLOY.md step F.)
import { buildCircuitInput, prove, verify } from "../circuit.js";
import { decide } from "./decide.js";
import { HMAC_SECRET } from "./hmac.js";

export { decide };

/**
 * Handle one task envelope end-to-end against a store (see lib/store.js).
 * Returns { status, body, cached, store } where body is the response object.
 * - HMAC/envelope validation happens in the caller (HTTP layer), not here.
 * - Proof verification failure -> 500, no decision (fail closed).
 * - Store read/write failures are handled inside the store (per-call
 *   in-memory fallback); a failure here means something else broke.
 */
export async function handleTask(task, store, { secret = HMAC_SECRET } = {}) {
  const t0 = Date.now();

  // 1. Idempotency: return the cached response for a known task_id.
  const { cached, seen } = await store.getState(task.task_id, task.input.proof_tx);
  if (cached) {
    return { status: cached.status, body: cached.body, cached: true, store: store.mode };
  }

  // 2. Decide (seen-check uses the pre-fetched durable boolean).
  const { decision, reason_code } = decide(task, { has: () => seen });
  const decisionBit = decision === "APPROVE" ? 1 : 0;

  // 3-4. Prove (unless PROOF_REUSED, which has no proof by design).
  let proof = null;
  let publicSignals = null;
  let proveMs = null;
  let verifyMs = null;

  if (reason_code !== "PROOF_REUSED") {
    const input = buildCircuitInput(task, decisionBit);
    const proved = await prove(input);
    proof = proved.proof;
    publicSignals = proved.publicSignals;
    proveMs = proved.proveMs;
    const checked = await verify(proof, publicSignals);
    verifyMs = checked.verifyMs;
    if (!checked.ok) {
      return {
        status: 500,
        body: { error: "local proof verification failed", task_id: task.task_id },
        cached: false,
        store: store.mode,
      };
    }
  }

  const body = {
    decision,
    reason_code,
    proof_tx: task.input.proof_tx,
    ...(proof ? { proof, public_signals: publicSignals } : {}),
    meta: {
      response_ms: Date.now() - t0,
      prove_ms: proveMs,
      verify_ms: verifyMs,
      store: store.mode,
    },
  };

  // 5. Cache the response + mark the proof seen (APPROVE only), together.
  // NOTE: a store commit failure is already absorbed inside the store
  // (per-call fallback); if commit throws here, the response is still
  // correct — only its durability is at risk — so log and continue.
  try {
    await store.commit(task.task_id, { status: 200, body }, decision === "APPROVE" ? task.input.proof_tx : null);
  } catch (err) {
    console.error(`[core] store commit failed after deciding ${task.task_id}: ${err.message}`);
  }

  return { status: 200, body, cached: false, store: store.mode };
}
