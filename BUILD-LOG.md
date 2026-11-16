# BUILD LOG — Local Proof Gatekeeper (zkVerify Agent Games, Creator Track)

- **Built:** 16 Nov 2026, local VM, Node.js v24.22.1, snarkjs 0.7.5
- **Account:** @ci3hu1 (registered via X; GitHub Ci3hu1 connected). This build is
  the raw material for the Creator Track **article** entry. Nothing here was
  published, posted, submitted, or deployed.
- **Cost:** $0. No wallet connected, no signing, no on-chain transaction, no
  VFY spent, no Kurier API key, no fees.

## 1. Official sources used

| What | Source |
|---|---|
| Builder Field Guide | https://agentgames.zkverify.io/build |
| Proof Gatekeeper event page | https://agentgames.zkverify.io/events/proof-gatekeeper |
| Creator Track event page | https://agentgames.zkverify.io/events/creator-track |
| Circuit info (JSON) | https://agentgames.zkverify.io/api/circuit-info |
| Circuit WASM | https://agentgames.zkverify.io/circuits/gatekeeper.wasm |
| Circuit proving key | https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey |

Registered verification-key hash (from `/api/circuit-info`, mainnet):

```
gatekeeper vkHash: 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
vfy-policy vkHash: 0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047 (not used)
```

Downloaded artifacts (verified on disk):

| File | Bytes | SHA-256 |
|---|---|---|
| `circuits/gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `circuits/gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |

Verification key exported from the official zkey with
`snarkjs zkey export verificationkey` → `circuits/vk.json`:
protocol **groth16**, curve **bn128**, **nPublic 13**, IC 14 entries.
Circuit template (from witness-generation errors): `GatekeeperEvaluation_79`.
Witness size measured from a generated witness file: **647 signals**.

## 2. Protocol facts recorded from the official pages

- **Task envelope** (`agent-games.proof-gatekeeper.v1`): `task_id`, `mode`,
  `issued_at`, `deadline_at`, `input` with `registered_vk`, `proof_vk`,
  `minimum`, `public_balance`, `expiry_block`, `current_block`, `recipient`,
  `condition_recipient`, `amount`, `max_transfer`, `proof_tx`.
- **Response:** `{ decision: "APPROVE"|"REJECT", reason_code, proof_tx }`
  plus the Groth16 proof for provable decisions.
- **HMAC:** header `x-agent-games-signature`, computed over the **raw** body
  (request and response), verified before parsing. The real secret comes from
  the dashboard's "Rotate Secret" — this build uses only a local test
  placeholder (`test-secret-local-only`, env `AGENT_GAMES_HMAC_SECRET`).
- **Deadline:** 60 seconds, hard. Fail closed on timeout or uncertainty.
- **Scoring:** correct APPROVE +12, correct REJECT +12, wrong APPROVE −6,
  wrong REJECT −3, timeout −2, missing/invalid proof −2, reliability bonus
  +0–5 (pro-rated by share of provable tasks whose proof verified).
  PROOF_REUSED tasks have no proof to submit and are excluded from the bonus.
- **Trap varieties (7):** VALID_CONDITION (~50%), VK_SUBSTITUTION (~13%),
  PROOF_REUSED (~11%), THRESHOLD_MISMATCH (~8%), EXPIRED_CONDITION (~6%),
  RECIPIENT_MISMATCH (~6%), AMOUNT_OVERFLOW (~6%).

## 3. What was built

Work dir: `~/workspace/tools/agentgames/gatekeeper/`

| File | Purpose |
|---|---|
| `circuit.js` | Input encoding + `prove()` / `verify()` against the official circuit |
| `gatekeeper.js` | Deterministic `decide()` for all 7 varieties + local HTTP server (127.0.0.1 only) with HMAC verification on the raw body and HMAC-signed responses |
| `probe.js` | FNV-1a WASM probe that recovered the circuit's input signal names |
| `test/run-tests.js` | Full test suite: HTTP decisions, HMAC negatives, 14-attempt proof matrix |
| `test/results.json` | Machine-readable results of the final run |
| `circuits/gatekeeper.wasm`, `circuits/gatekeeper_final.zkey` | Official artifacts (see §1) |
| `circuits/vk.json` | Verification key exported from the official zkey |
| `circuits/probe-result.json` | Probe output |

### Decision logic (`decide()`)

Checked in this order; first match wins. A task carries at most one trap in
the competition, so order only matters for synthetic multi-trap tasks.

1. `proof_tx` in local seen-set → REJECT / `PROOF_REUSED`
2. `proof_vk != registered_vk` → REJECT / `VK_SUBSTITUTION`
3. `public_balance < minimum` → REJECT / `THRESHOLD_MISMATCH`
4. `current_block >= expiry_block` → REJECT / `EXPIRED_CONDITION`
5. `recipient != condition_recipient` → REJECT / `RECIPIENT_MISMATCH`
6. `amount > max_transfer` → REJECT / `AMOUNT_OVERFLOW`
7. otherwise → APPROVE / `VALID_CONDITION`

On APPROVE the `proof_tx` is added to the seen-set. On PROOF_REUSED no proof
is generated (see §5, finding 2).

### Circuit inputs — recovered by probing, not copied from a blog

The site publishes no circuit source and no input signal names. The 13 names
were recovered by asking the compiled WASM itself: Circom 2.x resolves input
signals by FNV-1a 64-bit hash of the name, and `getInputSignalSize(hash)`
returns the size (1 = scalar input present, 0 = absent). `probe.js` tested 38
candidate names; exactly 13 returned size 1:

```
registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer,
decision, taskId, salt
```

All 25 other candidates (proofTx, proofReference, seen, isReused, threshold,
balance, nonce, commitment, …) returned size 0 — absent.

### Input encoding (assumptions — the site does not publish them)

- 32-byte hash (VK hash): `BigInt(hex) mod p`, p = bn128 field prime.
- `taskId`: `keccak256(utf8(task_id)) mod p`.
- Addresses: plain integers, `BigInt(address)`.
- `decision`: 1 = APPROVE, 0 = REJECT. `salt`: private nonce, fixed `12345`
  in tests for reproducibility (never appears in public signals).

**Gap found:** the derivation of the registered `vkHash` itself is
undocumented. Six naive reproductions were tried and none matched
`0x6b79…d77b0`: keccak256(zkey), keccak256(wasm), keccak256(vk.json),
sha256(zkey), sha256(wasm), keccak256(vk.json as string). The hash is
therefore taken as published by the official `/api/circuit-info` endpoint;
its exact derivation (zkVerify's VK serialization) is not public. If the
platform computes public-signal encodings differently from §3's assumptions,
it would reject the proof on re-verification — an honest limitation of this
build, not a verified integration.

## 4. Test results (final run, 16 Nov 2026 — all numbers real)

Test command: `node test/run-tests.js` → exit 0, **0 failures**.
Full output: `test/results.json`.

### A. HTTP decisions — 7/7 correct, all far inside the 60 s deadline

Synthetic envelopes built from the event page's sample numbers
(minimum 1000, balance 1460, expiry 19842201, current 19832000, amount 500,
cap 1000, matching VKs/recipient). Responses carry a valid
`x-agent-games-signature` over the raw response body.

| Task | Decision / reason | HTTP | Response | Proof gen | Proof verify |
|---|---|---|---|---|---|
| T0 valid | APPROVE / VALID_CONDITION | 200 | 990 ms | 880 ms | 91 ms |
| T1 VK substitution | REJECT / VK_SUBSTITUTION | 200 | 325 ms | 301 ms | 21 ms |
| T2 threshold mismatch | REJECT / THRESHOLD_MISMATCH | 200 | 384 ms | 363 ms | 18 ms |
| T3 proof reused | REJECT / PROOF_REUSED | 200 | 1 ms | — (no proof) | — |
| T4 expired | REJECT / EXPIRED_CONDITION | 200 | 389 ms | 314 ms | 71 ms |
| T5 recipient mismatch | REJECT / RECIPIENT_MISMATCH | 200 | 310 ms | 292 ms | 14 ms |
| T6 amount overflow | REJECT / AMOUNT_OVERFLOW | 200 | 310 ms | 292 ms | 15 ms |

(T0's 990 ms includes first-run WASM warm-up; steady-state responses are
~310–390 ms.)

### B. HMAC negative tests — 3/3 rejected

| Case | Result |
|---|---|
| Tampered body (one digit changed, original signature) | HTTP 401 |
| Missing signature header | HTTP 401 |
| Wrong secret | HTTP 401 |

No decision is computed for any of these — verification happens on the raw
body before parsing.

### C. Proof matrix — 14 attempts, official circuit

Each task × correct decision and × wrong decision, `snarkjs groth16
fullProve` + `groth16.verify` against the VK exported from the official zkey.

| Task | Correct decision | Wrong decision |
|---|---|---|
| T0 valid | dec=1: **proves, verifies** (278 ms / 17 ms) | dec=0: witness fails |
| T1 VK substitution | dec=0: **proves, verifies** (285 ms / 23 ms) | dec=1: witness fails |
| T2 threshold mismatch | dec=0: **proves, verifies** (283 ms / 34 ms) | dec=1: witness fails |
| T3 proof reused | dec=0: witness fails (no proof — by design) | dec=1: **proves, verifies** (260 ms / 25 ms) |
| T4 expired | dec=0: **proves, verifies** (284 ms / 34 ms) | dec=1: witness fails |
| T5 recipient mismatch | dec=0: **proves, verifies** (275 ms / 14 ms) | dec=1: witness fails |
| T6 amount overflow | dec=0: **proves, verifies** (233 ms / 14 ms) | dec=1: witness fails |

Totals: **7/14 proved, 7/14 verified locally** (prove 233–285 ms,
verify 14–34 ms). Every witness failure is the same error:
`Assert Failed. Error in template GatekeeperEvaluation_79 line: 102`.

### D. Public signals — verified positionally

T0 valid APPROVE proof, 13 public signals = 1 output commitment + 12 public
inputs in declaration order (each checked against the input value it should
carry; all 12 matched):

```
[0]  5085477138994229187532113507347089409130034114533497861036638793943648205715  output commitment
[1]  4836144126773920907502496244340012141761656471453348073975163706578152814510  registeredVkHash
[2]  4836144126773920907502496244340012141761656471453348073975163706578152814510  proofVkHash
[3]  1000   minimum
[4]  1460   publicBalance
[5]  19842201  expiryBlock
[6]  19832000  currentBlock
[7]  1268867800305995395507099298277146472967273750273  recipient
[8]  1268867800305995395507099298277146472967273750273  conditionRecipient
[9]  500    amount
[10] 1000   maxTransfer
[11] 1      decision
[12] 12285206862557242059294343006181173650373945713092228825753519331833957760831  taskId
```

`[1]` is the registered VK hash reduced mod p:
`0x6b79…d77b0 mod p = 4836144126773920907502496244340012141761656471453348073975163706578152814510`.
`salt` does not appear — it is private, as expected.

## 5. Findings worth the article

1. **A wrong decision cannot even build a witness.** The circuit enforces the
   decision symmetrically: approving a trap and rejecting a valid task both die
   at the same assert (`GatekeeperEvaluation_79` line 102) before any proving
   happens. A bad proof is never produced for a verifier to catch — the
   circuit refuses to lie. This is the strongest property of the design.
2. **Proof reuse is invisible to the circuit.** For T3 (valid fields, reused
   `proof_tx`), decision=1 proves and verifies fine — the circuit has no
   "seen" input. Only the agent's local seen-set catches reuse, and the
   correct REJECT then has no proof at all (the circuit demands decision=1
   for valid fields). That matches the platform's own rule that reused tasks
   have no proof to submit. Memory, not math, is what stops a replay here.
3. **The documentation gap is real.** The circuit source, the input signal
   names, the field encodings, and the vkHash derivation are all unpublished;
   every one of them had to be recovered from the compiled artifact or assumed
   and documented. A builder who guesses any of them wrong produces proofs the
   platform will not accept — and has no official way to check until a live
   round.

## 6. SCOPE — what was NOT done

- No public HTTPS endpoint (server binds 127.0.0.1 only; no tunnel, no
  hosting account, no domain).
- No agent registered for the Proof Gatekeeper arena event; no endpoint
  registered with the platform; no health check; no signed preflight.
- No practice task, no scored round, no live task envelope (all 7 tasks are
  synthetic, built from the event page's sample numbers).
- No verification-key registration on-chain and no proof submitted to Kurier
  or zkVerify mainnet/Volta — proofs were verified only locally against the
  VK exported from the official zkey.
- No VFY spent, no fees, no wallet connected, no signing of any kind.
- The real platform HMAC secret was never used (local test placeholder only).
- The platform-side field encodings were not verified against a live
  round (see §3 gap).
- Nothing was published: no article, thread, video, or submission-form entry
  exists yet. Publishing/submission is a separate step needing Joni's approval
  of the exact texts.

## 7. Reproduce

```bash
cd ~/workspace/tools/agentgames/gatekeeper
npm install            # snarkjs 0.7.5, js-sha3, circom_runtime (via snarkjs)
node probe.js          # re-probe the official wasm for input signals
node test/run-tests.js # full suite: HTTP + HMAC + 14-attempt proof matrix
node gatekeeper.js     # start the local server (127.0.0.1, random port)
```
