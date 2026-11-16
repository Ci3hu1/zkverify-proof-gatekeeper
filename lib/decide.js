// Deterministic decision for one Proof Gatekeeper task envelope.
// UNCHANGED semantics from the local build (gatekeeper.js): order is reuse
// (a property of the proof reference, checked against the seen-set) first,
// then the field checks in the order the trap encyclopedia lists them. Each
// task in the competition carries at most one trap, so the order only matters
// for synthetic multi-trap tasks; it is documented here.
// Returns { decision: "APPROVE"|"REJECT", reason_code }.
//
// `seenProofTx` is any object with a .has(proof_tx) method returning a
// boolean — an in-memory Set locally, or a pre-fetched boolean wrapped by the
// caller in the serverless handler (the durable check lives in lib/store.js).
const normHex = (h) => String(h).toLowerCase();
const normAddr = (a) => normHex(a);

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
