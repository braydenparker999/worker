import assert from "node:assert/strict";
import crypto from "node:crypto";

const base = process.env.WORKDROID_TEST_URL || "http://127.0.0.1:8791";
const password = process.env.WORKDROID_TEST_PASSWORD || "test-control-password";
const clientId = "https://chatgpt.com/oauth/client.json";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const resource = `${base}/mcp`;
const verifier = "workdroid-test-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

const metadataResponse = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json();
assert.equal(metadata.resource, resource);
assert.deepEqual(metadata.authorization_servers, [base]);

const unauthorized = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }),
});
assert.equal(unauthorized.status, 401);
assert.match(unauthorized.headers.get("www-authenticate") || "", /oauth-protected-resource/);

const authorizeParams = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirectUri,
  state: "smoke-state",
  scope: "workdroid:control",
  resource,
  code_challenge: challenge,
  code_challenge_method: "S256",
});
const authorizePage = await fetch(`${base}/oauth/authorize?${authorizeParams}`);
assert.equal(authorizePage.status, 200);
assert.match(await authorizePage.text(), /Authorize ChatGPT/);

authorizeParams.set("password", password);
const rejectedOrigin = await fetch(`${base}/oauth/authorize`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://malicious.example" },
  body: authorizeParams,
});
assert.equal(rejectedOrigin.status, 403);

const authorizeResponse = await fetch(`${base}/oauth/authorize`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://chatgpt.com" },
  body: authorizeParams,
});
assert.equal(authorizeResponse.status, 302);
const callback = new URL(authorizeResponse.headers.get("location"));
assert.equal(callback.origin + callback.pathname, redirectUri);
assert.equal(callback.searchParams.get("state"), "smoke-state");
assert.equal(callback.searchParams.get("iss"), base);
const code = callback.searchParams.get("code");
assert.ok(code);

const tokenParams = new URLSearchParams({
  grant_type: "authorization_code",
  code,
  client_id: clientId,
  redirect_uri: redirectUri,
  code_verifier: verifier,
  resource,
});
const tokenResponse = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenParams,
});
assert.equal(tokenResponse.status, 200);
const tokens = await tokenResponse.json();
assert.equal(tokens.token_type, "Bearer");
assert.ok(tokens.access_token);
assert.ok(tokens.refresh_token);

const replayResponse = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: tokenParams,
});
assert.equal(replayResponse.status, 400);

async function mcp(body) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.text());
  return response.json();
}

const initialized = await mcp({
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
});
assert.equal(initialized.result.serverInfo.name, "workdroid");

const listed = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
const names = listed.result.tools.map(tool => tool.name);
for (const expected of ["phone_status", "read_screen", "open_app", "seek_media", "run_flow"]) assert.ok(names.includes(expected));

const refreshResponse = await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource }),
});
assert.equal(refreshResponse.status, 200);
assert.ok((await refreshResponse.json()).access_token);

console.log(`WorkDroid MCP smoke test passed (${names.length} tools).`);
