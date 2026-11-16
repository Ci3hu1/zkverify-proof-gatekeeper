// Probe the official gatekeeper.wasm for input signal names.
// Circom 2.x WASM resolves input signals by FNV-1a 64-bit hash of the name.
// getInputSignalSize(hMSB, hLSB) returns the signal size (>=0) if the name
// exists, and traps / returns <0 otherwise. Candidate names below come from
// third-party write-ups and are VERIFIED here against the official artifact —
// a name only counts if the wasm itself says it exists.
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

// FNV-1a 64-bit, copied from circom_runtime/js/utils.js (same function the
// witness calculator itself uses to resolve signal names).
function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str[i].charCodeAt(0));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = "0".repeat(16 - shash.length).concat(shash);
  return shash;
}

const wasmBuf = fs.readFileSync("circuits/gatekeeper.wasm");
const wc = await WitnessCalculatorBuilder(wasmBuf, { sanityCheck: false });
console.log("circom version reported by wasm:", wc.circom_version());
console.log("witness vars (NVars):", wc.NVars);

const candidates = [
  // claimed by third-party write-ups (to verify)
  "registeredVkHash", "proofVkHash", "minimum", "publicBalance",
  "expiryBlock", "currentBlock", "recipient", "conditionRecipient",
  "amount", "maxTransfer", "decision", "taskId", "salt",
  // extra candidates to make sure nothing is missed
  "proofTx", "proofReference", "seen", "isReused", "reused",
  "valid", "approved", "threshold", "balance", "minBalance",
  "maxAmount", "transferAmount", "expiry", "block", "current",
  "vkHash", "registeredVk", "proofVk", "task_id", "taskID",
  "nonce", "commitment", "output", "action", "allow",
];
const found = [];
for (const name of candidates) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  let size = -1;
  try {
    size = wc.instance.exports.getInputSignalSize(hMSB, hLSB);
  } catch {
    size = -1;
  }
  if (size >= 0) {
    found.push({ name, size });
    console.log(`FOUND  ${name}  size=${size}`);
  }
}
console.log(`\nTotal signals found: ${found.length}`);
console.log(JSON.stringify(found, null, 2));
fs.writeFileSync("circuits/probe-result.json", JSON.stringify(found, null, 2));
