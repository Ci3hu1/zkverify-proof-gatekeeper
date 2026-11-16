// HMAC helpers for the Agent Games platform signature.
// Header: x-agent-games-signature = "sha256=" + HMAC-SHA256(secret, raw body).
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
