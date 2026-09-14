import { json, secureEqual } from "./security.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_SCOPE = "workdroid:control";
const ACCESS_TTL_SECONDS = 43_200;
const REFRESH_TTL_SECONDS = 2_592_000;

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeB64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

async function makeToken(secret, claims, ttlSeconds) {
  const payload = {
    ...claims,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: crypto.randomUUID(),
  };
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${b64url(await hmac(secret, encoded))}`;
}

async function readToken(secret, token) {
  try {
    const [encoded, signature, extra] = String(token || "").split(".");
    if (!encoded || !signature || extra) return null;
    const expected = b64url(await hmac(secret, encoded));
    if (!await secureEqual(signature, expected)) return null;
    const claims = JSON.parse(decoder.decode(decodeB64url(encoded)));
    if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function canonical(request) {
  const url = new URL(request.url);
  return {
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    metadata: `${url.origin}/.well-known/oauth-protected-resource/mcp`,
  };
}

function oauthError(error, description, status = 400) {
  return json({ error, error_description: description }, status);
}

function requestedScopes(value) {
  return new Set(String(value || CONTROL_SCOPE).trim().split(/\s+/).filter(Boolean));
}

function validScope(value) {
  const scopes = requestedScopes(value);
  return scopes.size === 1 && scopes.has(CONTROL_SCOPE);
}

function validClient(clientId, redirectUri) {
  if (clientId === "https://chatgpt.com/oauth/client.json") {
    return redirectUri === "https://chatgpt.com/connector_platform_oauth_redirect";
  }

  const client = /^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]+)\/client\.json$/.exec(clientId);
  const redirect = /^https:\/\/chatgpt\.com\/connector\/oauth\/([A-Za-z0-9_-]+)$/.exec(redirectUri);
  return !!client && !!redirect && client[1] === redirect[1];
}

function validAuthorizeParams(params, request) {
  const { resource } = canonical(request);
  if (params.get("response_type") !== "code") return "response_type must be code";
  if (!validClient(params.get("client_id") || "", params.get("redirect_uri") || "")) return "Unsupported OAuth client or redirect URI";
  if (params.get("code_challenge_method") !== "S256") return "PKCE S256 is required";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(params.get("code_challenge") || "")) return "Invalid PKCE code challenge";
  if ((params.get("resource") || "") !== resource) return "Invalid protected resource";
  if (!validScope(params.get("scope"))) return "Invalid scope";
  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function authorizeHtml(params, error = "") {
  const names = ["response_type", "client_id", "redirect_uri", "state", "scope", "resource", "code_challenge", "code_challenge_method"];
  const hidden = names.map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) || "")}">`).join("");
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize WorkDroid</title><style>:root{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}main{width:min(92vw,440px);background:#191919;border:1px solid #353535;border-radius:18px;padding:24px;box-sizing:border-box}h1{font-size:22px;margin:0 0 10px}.muted{color:#aaa}.scope{background:#0e0e0e;border:1px solid #333;border-radius:10px;padding:12px;margin:16px 0}.error{color:#ff9999}input,button{width:100%;box-sizing:border-box;font:inherit;border-radius:10px;padding:12px}input{background:#090909;color:#fff;border:1px solid #444;margin:10px 0 12px}button{border:0;background:#eee;color:#111;font-weight:750;cursor:pointer}</style></head><body><main><h1>Connect WorkDroid</h1><p class="muted">ChatGPT is requesting access to your private Android bridge.</p><div class="scope">Allow phone status, screen inspection, navigation, touch, text entry, app launch, media control, and approved multi-step flows.</div>${errorHtml}<form method="post" action="/oauth/authorize">${hidden}<input name="password" type="password" autocomplete="current-password" placeholder="WorkDroid control password" autofocus required><button type="submit">Authorize ChatGPT</button></form></main></body></html>`;
}

export function protectedResourceMetadata(request) {
  const { issuer, resource } = canonical(request);
  return json({
    resource,
    authorization_servers: [issuer],
    scopes_supported: [CONTROL_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/control`,
  });
}

export function authorizationServerMetadata(request) {
  const { issuer } = canonical(request);
  return json({
    issuer,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    scopes_supported: [CONTROL_SCOPE],
  });
}

async function verifyControlPassword(stub, request, password) {
  return stub.fetch(new Request("https://relay.internal/auth/control", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Relay-IP": request.headers.get("CF-Connecting-IP") || "unknown",
    },
    body: JSON.stringify({ password }),
  }));
}

export async function handleAuthorize(request, stub) {
  if (request.method === "GET") {
    const params = new URL(request.url).searchParams;
    const error = validAuthorizeParams(params, request);
    if (error) return oauthError("invalid_request", error);
    return new Response(authorizeHtml(params), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const params = new URLSearchParams(await request.text());
  const error = validAuthorizeParams(params, request);
  if (error) return oauthError("invalid_request", error);

  const passwordResult = await verifyControlPassword(stub, request, params.get("password") || "");
  if (!passwordResult.ok) {
    const message = passwordResult.status === 429 ? "Too many attempts. Try again later." : "Incorrect control password.";
    return new Response(authorizeHtml(params, message), {
      status: passwordResult.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const issue = await stub.fetch(new Request("https://relay.internal/oauth/code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: params.get("client_id"),
      redirect_uri: params.get("redirect_uri"),
      code_challenge: params.get("code_challenge"),
      resource: params.get("resource"),
      scope: params.get("scope") || CONTROL_SCOPE,
    }),
  }));
  const issued = await issue.json();
  if (!issue.ok) return oauthError("server_error", issued.error || "Could not issue authorization code", 500);

  const redirect = new URL(params.get("redirect_uri"));
  redirect.searchParams.set("code", issued.code);
  if (params.get("state")) redirect.searchParams.set("state", params.get("state"));
  redirect.searchParams.set("iss", canonical(request).issuer);
  return Response.redirect(redirect.toString(), 302);
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return b64url(new Uint8Array(digest));
}

function tokenResponse(body) {
  return json(body);
}

async function issueTokens(env, { resource, scope }) {
  const base = { sub: "workdroid-owner", aud: resource, scope, iss: new URL(resource).origin };
  const [accessToken, refreshToken] = await Promise.all([
    makeToken(env.SESSION_SECRET, { ...base, kind: "access" }, ACCESS_TTL_SECONDS),
    makeToken(env.SESSION_SECRET, { ...base, kind: "refresh" }, REFRESH_TTL_SECONDS),
  ]);
  return tokenResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  });
}

export async function handleToken(request, env, stub) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const params = new URLSearchParams(await request.text());
  const { resource } = canonical(request);
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") || "";
    const verifier = params.get("code_verifier") || "";
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthError("invalid_grant", "Invalid authorization code or PKCE verifier");
    }

    const exchange = await stub.fetch(new Request("https://relay.internal/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }));
    const record = await exchange.json();
    if (!exchange.ok) return oauthError("invalid_grant", record.error || "Authorization code is invalid or expired");

    const suppliedResource = params.get("resource") || record.resource;
    if (record.client_id !== params.get("client_id") || record.redirect_uri !== params.get("redirect_uri") || suppliedResource !== record.resource || record.resource !== resource) {
      return oauthError("invalid_grant", "Authorization code binding mismatch");
    }
    if (!await secureEqual(await pkceChallenge(verifier), record.code_challenge)) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return issueTokens(env, record);
  }

  if (grantType === "refresh_token") {
    const claims = await readToken(env.SESSION_SECRET, params.get("refresh_token"));
    if (!claims || claims.kind !== "refresh" || claims.aud !== resource || !validScope(claims.scope)) {
      return oauthError("invalid_grant", "Refresh token is invalid or expired");
    }
    const suppliedResource = params.get("resource");
    if (suppliedResource && suppliedResource !== claims.aud) return oauthError("invalid_target", "Invalid protected resource");
    return issueTokens(env, { resource: claims.aud, scope: claims.scope });
  }

  return oauthError("unsupported_grant_type", "Supported grants are authorization_code and refresh_token");
}

export async function authorizeMcpRequest(request, env) {
  const { metadata, resource } = canonical(request);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const claims = await readToken(env.SESSION_SECRET, token);
  if (!claims || claims.kind !== "access" || claims.aud !== resource || claims.iss !== new URL(resource).origin || !validScope(claims.scope)) {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "WWW-Authenticate": `Bearer resource_metadata="${metadata}", scope="${CONTROL_SCOPE}"`,
    });
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized", error_description: "A valid WorkDroid OAuth token is required" }), { status: 401, headers }),
    };
  }
  return {
    ok: true,
    authInfo: {
      token,
      clientId: "chatgpt",
      scopes: String(claims.scope).split(/\s+/),
      expiresAt: claims.exp,
      extra: { subject: claims.sub, audience: claims.aud },
    },
  };
}

