// Durable state for the Proof Gatekeeper agent: the seen-set of proof_tx
// values (PROOF_REUSED detection) and the per-task response cache
// (idempotency: the platform may retry a task_id after a network failure).
//
// Serverless functions are stateless, so the in-memory Set of the local build
// cannot survive across invocations. The production store is Upstash Redis
// (free tier) over its plain HTTP REST API — no extra dependency, just fetch.
// Credentials come ONLY from env vars UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN; never hardcode them.
//
// Store interface (used by lib/core.js):
//   getState(task_id, proof_tx) -> { cached: {status, body} | null, seen: boolean }
//   commit(task_id, {status, body}, proof_tx | null) -> void
//     Writes the response cache AND (on APPROVE) the seen-mark TOGETHER in a
//     single pipeline call, so the two can never diverge: a retry either finds
//     both (returns the cached APPROVE) or neither (re-decides from scratch).
//     The old local bug — a retry of an APPROVEd task flipping to
//     REJECT/PROOF_REUSED because the seen-set had the tx but there was no
//     response cache — is structurally impossible with this shape.
//   mode: "redis" | "memory" | "memory-fallback"
//
// TTL: 7 days (604800 s) on both keys. The competition closes 21 Nov 2026;
// a deploy on ~17 Nov only needs state to live ~5 days. Entries older than
// the TTL simply re-decide from scratch, which is always a correct decision
// for a fresh task_id.
//
// Failure policy: a Redis error on any call falls back to an in-memory store
// for THAT call only (logged to console.error, visible in Vercel logs) and
// the next call retries Redis. Rationale: a correct decision (+12) is worth
// far more than a timeout (−2), and the fallback keeps decisions correct on
// first attempts; only cross-instance reuse detection degrades while Redis is
// down. If Redis is down for the whole round, worst case is a same-instance
// retry returning a freshly re-decided (identical) answer, never a flip —
// because commit() writes cache + seen together, a fallback instance that
// recorded an APPROVE also has its cached response to return.
export const DEFAULT_TTL_SECONDS = 604800; // 7 days

const respKey = (taskId) => `gk:resp:${taskId}`;
const seenKey = (proofTx) => `gk:seen:${proofTx}`;

// ---- In-memory store (local dev, tests, and per-call Redis fallback) ----
export class MemoryStore {
  constructor(ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.ttlMs = ttlSeconds * 1000;
    this.responses = new Map(); // task_id -> { value, expiresAt }
    this.seen = new Map(); // proof_tx -> expiresAt
    this.mode = "memory";
  }

  _get(map, key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  async getState(taskId, proofTx) {
    const raw = this._get(this.responses, taskId);
    const cached = raw ? JSON.parse(raw) : null;
    return { cached, seen: this._get(this.seen, proofTx) !== null };
  }

  async commit(taskId, response, proofTx) {
    const expiresAt = Date.now() + this.ttlMs;
    this.responses.set(taskId, { value: JSON.stringify(response), expiresAt });
    if (proofTx) this.seen.set(proofTx, { value: "1", expiresAt });
  }
}

// ---- Upstash Redis store (plain REST, no SDK) ----
// Upstash REST API: POST <REST_URL> with Authorization: Bearer <token> and a
// JSON body of one command (["GET","key"]) or a pipeline of commands
// ([["GET","k1"],["GET","k2"]]). Single command -> {result}; pipeline ->
// [{result}, ...]. Errors surface as {error} or a non-2xx status.
export class RedisStore {
  constructor(url, token, { ttlSeconds = DEFAULT_TTL_SECONDS, fetchImpl = fetch } = {}) {
    if (!url || !token) throw new Error("RedisStore needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.ttlSeconds = ttlSeconds;
    this.fetchImpl = fetchImpl;
    this.mode = "redis";
  }

  async _call(commands) {
    const isPipeline = Array.isArray(commands[0]);
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Upstash REST HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data === "object" && "error" in data && data.error) {
      throw new Error(`Upstash REST error: ${data.error}`);
    }
    const results = isPipeline ? data : [data];
    return results.map((r) => (r && typeof r === "object" && "result" in r ? r.result : r));
  }

  async getState(taskId, proofTx) {
    const [cachedRaw, seenRaw] = await this._call([
      ["GET", respKey(taskId)],
      ["GET", seenKey(proofTx)],
    ]);
    return {
      cached: cachedRaw ? JSON.parse(cachedRaw) : null,
      seen: seenRaw !== null && seenRaw !== undefined,
    };
  }

  async commit(taskId, response, proofTx) {
    const commands = [
      ["SET", respKey(taskId), JSON.stringify(response), "EX", String(this.ttlSeconds)],
    ];
    if (proofTx) {
      commands.push(["SET", seenKey(proofTx), "1", "EX", String(this.ttlSeconds)]);
    }
    await this._call(commands);
  }
}

// ---- Resilient wrapper: Redis primary, in-memory per-call fallback ----
export class ResilientStore {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
    this.mode = "redis";
  }

  async getState(taskId, proofTx) {
    try {
      const state = await this.primary.getState(taskId, proofTx);
      this.mode = this.primary.mode;
      return state;
    } catch (err) {
      console.error(`[store] Redis getState failed, using in-memory fallback for this call: ${err.message}`);
      this.mode = "memory-fallback";
      return this.fallback.getState(taskId, proofTx);
    }
  }

  async commit(taskId, response, proofTx) {
    try {
      await this.primary.commit(taskId, response, proofTx);
      this.mode = this.primary.mode;
    } catch (err) {
      console.error(`[store] Redis commit failed, using in-memory fallback for this call: ${err.message}`);
      this.mode = "memory-fallback";
      await this.fallback.commit(taskId, response, proofTx);
    }
  }
}

// ---- Factory: env vars decide the backend. No env vars -> in-memory with a warning. ----
export function createStoreFromEnv(env = process.env, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return new ResilientStore(new RedisStore(url, token, { ttlSeconds }), new MemoryStore(ttlSeconds));
  }
  console.warn(
    "[store] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — using in-memory store. " +
      "Fine for local dev/tests, NOT for production: reuse detection breaks across instances."
  );
  return new MemoryStore(ttlSeconds);
}
