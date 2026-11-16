# zkVerify Proof Gatekeeper

A local Proof Gatekeeper agent for the **zkVerify Agent Games (Season 01)**.
It receives zk-proof task envelopes, decides **APPROVE / REJECT** with a reason
code, and proves every provable decision with the **official Groth16
gatekeeper circuit** — then verifies that proof locally before answering.

Built by an AI agent (@ci3hu1) as a working prototype. $0 spent: no wallet
connected, no signing, no on-chain transaction, no VFY spent.

> **Related:** the build story is told in the Creator Track article
> [“I Had My AI Agent Build a Proof Gatekeeper — and the Circuit Refused to
> Lie”](https://medium.com/@joni07683/i-had-my-ai-agent-build-a-proof-gatekeeper-and-the-circuit-refused-to-lie-67b74db1cb37)
> and the [X thread](https://x.com/ci3hu1/status/2122335908901040518).

## How it works

```
task envelope (agent-games.proof-gatekeeper.v1)
        │
        ▼
┌──────────────────────────────┐
│ 1. HMAC verify (raw body,    │  x-agent-games-signature, checked
│    before parsing) — 401 on  │  BEFORE any parsing. Fail closed.
│    any failure               │
├──────────────────────────────┤
│ 2. decide() — deterministic  │  7 varieties, first match wins:
│    checks, in order          │  PROOF_REUSED → VK_SUBSTITUTION →
│                              │  THRESHOLD_MISMATCH → EXPIRED_CONDITION →
│                              │  RECIPIENT_MISMATCH → AMOUNT_OVERFLOW →
│                              │  VALID_CONDITION (APPROVE)
├──────────────────────────────┤
│ 3. Groth16 prove + verify    │  snarkjs 0.7.5, official circuit files
│    (official circuit)        │  (gatekeeper.wasm / gatekeeper_final.zkey).
│                              │  A wrong decision cannot even build a
│                              │  witness — the circuit refuses to lie.
├──────────────────────────────┤
│ 4. HMAC-signed response      │  { decision, reason_code, proof,
│                              │    public_signals } + meta timings
└──────────────────────────────┘
```

The server binds **127.0.0.1 only** — this is a local prototype, not a public
arena endpoint. It answers in ~310–390 ms steady-state, far inside the
competition's 60-second deadline.

### Two findings the build surfaced

1. **A wrong decision cannot even build a witness.** Approving a trap and
   rejecting a valid task both die at the same circuit assert
   (`GatekeeperEvaluation_79` line 102) before any proving happens. A bad
   proof is never produced for a verifier to catch.
2. **Proof reuse is invisible to the circuit.** For a reused `proof_tx` with
   otherwise valid fields, decision=1 proves and verifies fine — the circuit
   has no "seen" input. Only the agent's local seen-set catches reuse, and
   the correct REJECT then has no proof at all (matching the platform's own
   rule that reused tasks have no proof to submit). Memory, not math, stops a
   replay here.

### Recovering what the docs didn't publish

The platform publishes no circuit source and no input signal names. The 13
input names were recovered by probing the official WASM itself: Circom 2.x
resolves input signals by FNV-1a 64-bit hash of the name, so `probe.js` tested
38 candidate names and exactly 13 returned a size (`registeredVkHash`,
`proofVkHash`, `minimum`, `publicBalance`, `expiryBlock`, `currentBlock`,
`recipient`, `conditionRecipient`, `amount`, `maxTransfer`, `decision`,
`taskId`, `salt`). The registered VK hash
(`0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`) is taken
as published by the official `/api/circuit-info` endpoint — its exact
derivation is undocumented, an honest gap recorded in
[`BUILD-LOG.md`](BUILD-LOG.md).

## Test results

Run `npm test` (full suite, `test/run-tests.js`, exit 0, 0 failures):

| Suite | Result |
|---|---|
| HTTP decisions (all 7 varieties) | **7/7 correct**, 310–990 ms each |
| HMAC negatives (tampered body, missing header, wrong secret) | **3/3 rejected with 401** |
| Proof matrix (7 tasks × correct + wrong decision) | **7 proved + verified locally** (prove 233–285 ms, verify 14–34 ms); the 7 wrong decisions all fail witness generation, as intended |

Full machine-readable results: [`test/results.json`](test/results.json).
Every number in [`BUILD-LOG.md`](BUILD-LOG.md) is from the real final run.

## Run it locally

```bash
npm install            # snarkjs 0.7.5, js-sha3, circom_runtime (via snarkjs)
node probe.js          # re-probe the official wasm for input signal names
npm test               # full suite: HTTP + HMAC + 14-attempt proof matrix
node gatekeeper.js     # start the local server (127.0.0.1, random port)
```

Optional: set `AGENT_GAMES_HMAC_SECRET` (see `.env.example`) to the secret
from the Agent Games dashboard. If unset, the server uses a **local test
placeholder only** (`test-secret-local-only`) — never a real platform secret,
and never put one in code or logs.

## Files

| File | Purpose |
|---|---|
| `gatekeeper.js` | `decide()` + local HTTP server with raw-body HMAC verification |
| `circuit.js` | Input encoding + `prove()` / `verify()` against the official circuit |
| `probe.js` | FNV-1a WASM probe that recovered the circuit's input signal names |
| `test/run-tests.js` | Full test suite (HTTP decisions, HMAC negatives, proof matrix) |
| `test/results.json` | Machine-readable results of the final run |
| `circuits/gatekeeper.wasm`, `circuits/gatekeeper_final.zkey` | Official artifacts from agentgames.zkverify.io |
| `circuits/vk.json` | Verification key exported from the official zkey (`snarkjs zkey export verificationkey`) |
| `circuits/probe-result.json` | Probe output (13 input signals found) |
| `BUILD-LOG.md` | Full build log: sources, protocol facts, decision logic, results, findings, scope |

## Scope — what this is NOT

- No public HTTPS endpoint (127.0.0.1 only; no hosting, no domain).
- No agent registered for the Proof Gatekeeper arena event; no endpoint
  registered with the platform; no health check; no signed preflight.
- No practice task, no scored round, no live task envelope — all 7 tasks are
  synthetic, built from the event page's sample numbers.
- No verification-key registration on-chain and no proof submitted to Kurier
  or zkVerify mainnet/Volta — proofs were verified only locally against the
  VK exported from the official zkey.
- Platform-side field encodings were not verified against a live round (see
  the documentation gap above).

## Sources

- Builder Field Guide: https://agentgames.zkverify.io/build
- Proof Gatekeeper event: https://agentgames.zkverify.io/events/proof-gatekeeper
- Circuit info: https://agentgames.zkverify.io/api/circuit-info
- Circuit WASM: https://agentgames.zkverify.io/circuits/gatekeeper.wasm
- Circuit proving key: https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey

## License

ISC
