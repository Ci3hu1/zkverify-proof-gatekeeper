// HMAC helpers for the Agent Games platform signature.
// Incoming requests: header x-agent-games-signature carries the HMAC-SHA256
// of the raw body; verifyHmac tolerates the value with or without a
// "sha256=" prefix. Outgoing responses: the header carries the BARE hex
// digest — NO "sha256=" prefix. The platform's response verifier rejects
// the prefixed form (dashboard preflight, 17 Nov 2026: prefixed signature
// failed with "body or signature was invalid"; the request side proves the
// key itself is the secret as a UTF-8 string, so the prefix is the only
// difference). Keep inbound tolerance — the platform may sign requests
// either way.
// The secret comes from env AGENT_GAMES_HMAC_SECRET. Default is a LOCAL TEST
// placeholder ("test-secret-local-only"). The real platform secret comes from
// the dashboard's "Rotate Secret" and is NOT available to this build; never
// put a real secret in code or logs.
import crypto from "node:crypto";

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
