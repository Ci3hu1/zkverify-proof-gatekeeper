// Encoding + proving helpers for the OFFICIAL Agent Games gatekeeper circuit.
// Artifacts: https://agentgames.zkverify.io/circuits/gatekeeper.wasm
//            https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
// Registered vkHash (from https://agentgames.zkverify.io/api/circuit-info):
//   0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
// Input signal names were VERIFIED against the official wasm by FNV-1a probing
// (see probe.js / circuits/probe-result.json): exactly 13 scalar inputs.
//   registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
//   currentBlock, recipient, conditionRecipient, amount, maxTransfer,
//   decision, taskId, salt
//
// ENCODING ASSUMPTIONS (documented because the site does not publish them):
// - A 32-byte hash (vk hash) is reduced mod the bn128 field prime: BigInt(hex) % p.
// - taskId is keccak256(utf8(task_id)) reduced mod p.
// - Addresses are plain integers: BigInt(address).
// - salt is a private nonce, never in the public signals. Tests use a fixed
//   salt (12345) so results are reproducible; a production agent would randomise it.
// - The platform-side encoding of these fields is undocumented; if it differs,
//   the platform would reject the public signals on re-verification. This is a
//   genuine gap in the public documentation, recorded in BUILD-LOG.md.
import { keccak256 } from "js-sha3";
import * as snarkjs from "snarkjs";

export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const REGISTERED_VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

export const WASM_PATH = new URL("./circuits/gatekeeper.wasm", import.meta.url).pathname;
export const ZKEY_PATH = new URL("./circuits/gatekeeper_final.zkey", import.meta.url).pathname;
export const VK_PATH = new URL("./circuits/vk.json", import.meta.url).pathname;

export const modP = (x) => {
  const v = BigInt(x) % FIELD_PRIME;
  return v < 0n ? v + FIELD_PRIME : v;
};

export const hashToField = (hexOrBytes) => {
  const hex = typeof hexOrBytes === "string"
    ? hexOrBytes.startsWith("0x") ? hexOrBytes.slice(2) : hexOrBytes
    : Buffer.from(hexOrBytes).toString("hex");
  return modP(BigInt("0x" + hex));
};

export const taskIdToField = (taskId) => modP(BigInt("0x" + keccak256(taskId)));

/** Build the circuit input object from a task envelope. taskId is the envelope-level task_id. */
export function buildCircuitInput(task, decision, salt = 12345n) {
  const taskInput = task.input;
  return {
    registeredVkHash: hashToField(taskInput.registered_vk).toString(),
    proofVkHash: hashToField(taskInput.proof_vk).toString(),
    minimum: BigInt(taskInput.minimum).toString(),
    publicBalance: BigInt(taskInput.public_balance).toString(),
    expiryBlock: BigInt(taskInput.expiry_block).toString(),
    currentBlock: BigInt(taskInput.current_block).toString(),
    recipient: BigInt(taskInput.recipient).toString(),
    conditionRecipient: BigInt(taskInput.condition_recipient).toString(),
    amount: BigInt(taskInput.amount).toString(),
    maxTransfer: BigInt(taskInput.max_transfer).toString(),
    decision: decision === 1 || decision === "1" ? "1" : "0",
    taskId: taskIdToField(task.task_id).toString(),
    salt: BigInt(salt).toString(),
  };
}

/** Generate a Groth16 proof for the given circuit inputs. Returns {proof, publicSignals, proveMs}. */
export async function prove(input) {
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
  return { proof, publicSignals, proveMs: Date.now() - t0 };
}

/** Verify a proof against the verification key exported from the OFFICIAL zkey. */
export async function verify(proof, publicSignals) {
  const vk = (await import(VK_PATH, { with: { type: "json" } })).default;
  const t0 = Date.now();
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  return { ok, verifyMs: Date.now() - t0 };
}
