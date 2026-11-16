# DEPLOY — Proof Gatekeeper on Vercel (serverless) + Upstash Redis

Deploy-ready port of the local gatekeeper (`gatekeeper.js`) for the zkVerify
Agent Games **Proof Gatekeeper** arena. Same decision + Groth16 prove/verify
logic (unchanged semantics), with two production changes:

1. **Durable state** — the seen-set + per-task response cache moved from an
   in-memory `Set` to **Upstash Redis** (free tier) via `lib/store.js`.
   Serverless functions are stateless; without this, PROOF_REUSED detection
   breaks across invocations.
2. **Idempotency fix** — a platform retry of a decided `task_id` now returns
   the **cached response** (same decision, same proof). The old local bug —
   a retry of an APPROVEd task flipping to REJECT/PROOF_REUSED because the
   seen-set had the `proof_tx` but there was no response cache — is fixed in
   `lib/core.js` and covered by `test/serverless/run-tests.js` (section B).

**Cost: $0.** Vercel Hobby (no card) + Upstash Redis free tier (no card).
No wallet, no signing, no on-chain transaction in this deploy.

## Layout

| Path | What |
|---|---|
| `api/agent.js` | Vercel function: `POST /api/agent` (task endpoint), `GET` = health probe |
| `api/health.js` | `GET /api/health` (explicit health endpoint) |
| `lib/core.js` | `handleTask()`: cache -> decide -> prove/verify -> commit |
| `lib/decide.js` | 7-way decision (unchanged from the local build) |
| `lib/hmac.js` | HMAC-SHA256 verify/sign, `x-agent-games-signature` |
| `lib/store.js` | RedisStore (Upstash REST, plain fetch) + MemoryStore + ResilientStore fallback |
| `circuit.js`, `circuits/` | Unchanged: official circuit artifacts (wasm/zkey/vk) |
| `vercel.json` | `maxDuration: 60` (the platform's 60 s deadline), `includeFiles: circuits/**` |
| `scripts/deploy-check.mjs` | Post-deploy smoke test (GET health + signed synthetic task) |
| `test/serverless/run-tests.js` | Handler tests against a mock Upstash REST server |

## Step 1 — Upstash Redis (free tier, ~10 min, Joni's click)

1. Go to https://console.upstash.com and sign up (email or GitHub — either
   is fine; no credit card).
2. **Create Database** → type **Regional** → name e.g. `agent-games-gatekeeper`
   → region closest to the players: **Singapore (`ap-southeast-1`)** is the
   sensible pick for WIB.
3. Open the database → **REST API** section → copy:
   - `UPSTASH_REDIS_REST_URL` (looks like `https://<name>-<id>.upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN`
4. Keep them in a safe place for Step 3. **Never put them in the repo.**

Free-tier limits (verify at signup): 10k commands/day, 256 MB. One scored
round is 8 tasks ≈ 4 Redis calls each ≈ 32 commands — far inside the limit.

## Step 2 — Vercel project (~10 min, Joni's click)

1. Go to https://vercel.com and **Continue with GitHub** (account
   **Ci3hu1**) → authorize Vercel.
2. **Add New → Project → Import Git Repository** →
   select **`Ci3hu1/zkverify-proof-gatekeeper`**.
3. Settings on the import screen:
   - **Framework Preset:** Other
   - **Root Directory:** `./` (default)
   - **Build Command:** leave empty (no build step — plain Node.js functions)
   - **Install Command:** default (`npm install`)
   - **Node.js Version:** 22.x (set in `package.json` `engines`)
4. **Deploy.** First deploy will succeed with placeholder behaviour (see
   Step 3) — the endpoint will answer, but with the test HMAC secret until
   the real one is set in Step 6.

Your endpoint will be: `https://<project-name>.vercel.app/api/agent`
(note the `/api/agent` path — that is the URL to register in Step 5).

## Step 3 — Environment variables (Vercel dashboard)

Project → **Settings → Environment Variables** → add all three (all
environments: Production + Preview + Development):

| Variable | Value |
|---|---|
| `AGENT_GAMES_HMAC_SECRET` | `test-secret-local-only` for now (placeholder — replaced in Step 6 after registration) |
| `UPSTASH_REDIS_REST_URL` | from Step 1 |
| `UPSTASH_REDIS_REST_TOKEN` | from Step 1 |

Then **Deployments → ⋯ → Redeploy** so the new env vars take effect.

## Step 4 — Verify the deployment (no account needed beyond the URL)

From this VM (or any machine with Node.js):

```bash
ENDPOINT=https://<project-name>.vercel.app/api/agent \
AGENT_GAMES_HMAC_SECRET=test-secret-local-only \
node scripts/deploy-check.mjs
```

Expected: `GET health -> 200 ok`, then `POST task -> 200 APPROVE/VALID_CONDITION`
in well under 60 s (typically <2 s), with the response signature verified.
If this fails, fix it now — do NOT register a broken endpoint (Step 5).

## Step 5 — Register the agent (Agent Games dashboard, Joni's browser)

1. https://agentgames.zkverify.io/dashboard/agents → **Register agent**.
2. Fields:
   - **Agent name:** a unique name, e.g. `ci3hu1-gatekeeper` (must be unique
     across the competition — if taken, add a suffix).
   - **Event tracks:** tick **Proof Gatekeeper** (leave Steal the VFY unticked
     — see the arena plan §3: effectively out of reach in the remaining window).
   - **Repository URL:** `https://github.com/Ci3hu1/zkverify-proof-gatekeeper`
     (personal repo — organisation repos are not supported).
   - **Agent endpoint:** `https://<project-name>.vercel.app/api/agent`
3. Submit. **Copy the 32-byte HMAC secret shown exactly once** — it is never
   shown again (rotate from agent settings if lost/compromised).

## Step 6 — HMAC secret handoff (Joni's step, ~5 min)

1. Vercel project → **Settings → Environment Variables** →
   `AGENT_GAMES_HMAC_SECRET` → replace the placeholder with the real secret
   from Step 5. **Never put it in the repo, chat, or a file.**
2. **Redeploy** (env var changes need a redeploy to take effect).
3. Re-run the smoke test with the real secret:

```bash
ENDPOINT=https://<project-name>.vercel.app/api/agent \
AGENT_GAMES_HMAC_SECRET=<the-real-secret> \
node scripts/deploy-check.mjs
```

Expected: same as Step 4. If the old placeholder is still used by mistake,
the smoke test fails with 401 — that is the HMAC check working.

## Step 7 — Preflight + health check

The platform calls the endpoint with a fake proof ("Pre-flight check… verify
that it can respond correctly") and runs its health check. Watch the
dashboard agent status until it reads **Healthy**. If it fails:

- **401s in Vercel logs:** the HMAC secret in Vercel does not match the
  dashboard — redo Step 6.
- **Health check failing but POSTs work:** the platform may probe a different
  path/method than `GET /api/agent` or `GET /api/health` — the dashboard
  reveals the probe; add an alias in `api/` and redeploy.
- **Timeouts:** check Vercel function logs for cold-start or proving errors.
  Proving takes ~300 ms warm; a >60 s response means something else is stuck.

## Step 8 — Practice tasks (resolves the open unknowns)

Dispatch practice tasks from the dashboard (≤10/hour, free, unscored) and
check the debugging history:

1. Does the platform accept our response shape (`proof` + `public_signals`
   at top level)? If not, the practice result shows the expected shape —
   adjust `lib/core.js` response assembly and re-test locally first.
2. Does our proof verify on their side? If not, the field encodings
   (taskId keccak, VK-hash mod p, salt 12345) differ from theirs — the
   practice task is the only way to learn the true encodings; adjust
   `circuit.js` `buildCircuitInput` accordingly.
3. Confirm the seen-set works: dispatch a practice task, then the same
   `proof_tx` again — second answer must be REJECT/PROOF_REUSED, and a
   retry of the same `task_id` must return the identical APPROVE.

Only when practice is clean should scored rounds be trusted.

## Step 9 — Scored rounds + prize wallet

- Remaining Gatekeeper rounds (per the arena plan): **Rounds 6–8, 18–20 Nov,
  17:30–03:30 WIB**, 8 tasks each. Daily top 3 advance to the Finals
  (21 Nov 2026 22:00 UTC). Monitor Vercel logs + the dashboard debugging
  history during rounds.
- **Prize wallet:** the dashboard requires a connected wallet address for
  prize distribution (Rules §1.1). That is Joni's decision and can be added
  any time before the competition closes — it does NOT block entry.

## What NOT to do

- **Never** put the real HMAC secret, an Upstash token, a seed phrase, or
  any credential in the repo, chat, or logs. Env vars only.
- **Do NOT use the zkVerifyJS path** (needs a seed phrase + funded VFY
  account) — it conflicts with the standing rule (signing only via baw,
  never handle seeds). Kurier (API key only) is the acceptable path if an
  on-chain step is ever needed.
- **Kurier per-proof cost is unknown** (no pricing found). If practice shows
  the platform requires an on-chain-finalised decision proof, check Kurier's
  terms at signup and report the cost to Joni BEFORE submitting anything.
- Do not register the Steal the VFY track with this agent: it needs a
  separate circuit + strategy commitment that was due before Swiss Round 1.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `GET /api/agent` 404 | Wrong project URL, or the deploy failed — check Vercel Deployments |
| POST returns 401 | HMAC secret mismatch (Step 6) or the smoke test used the wrong secret |
| POST returns 500 `local proof verification failed` | Circuit files missing from the bundle — check `vercel.json` `includeFiles` and redeploy |
| Responses slow (>10 s) | Cold start on first call after idle; warm calls are ~300–500 ms. If persistent, check Vercel function logs |
| `store: "memory-fallback"` in `meta` | Upstash unreachable — decisions still correct, but reuse detection is per-instance only. Check the env vars and Upstash status |
| Vercel Hobby limits hit | 1M invocations/mo, 100 GB transfer — a competition entry cannot hit these; if the project is paused, check the usage tab |
