// GET /api/health — explicit health endpoint for the platform's health check
// (the check path/method is unpublished; /api/agent also answers GET). No
// HMAC, no decision, no data. If the platform's health check turns out to
// use a different path, add an alias here and redeploy — see DEPLOY.md step E.
export default function handler(req, res) {
  const raw = JSON.stringify({ status: "ok", service: "zkverify-proof-gatekeeper" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(raw);
}
