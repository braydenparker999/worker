import { PhoneRelay } from "./phone-relay.js";
import { LOGIN_HTML, CONTROL_HTML } from "./ui.js";
import {
  json, secureHeaders, clientIp, sameOrigin, cookies,
  makeSession, validSession, trustedOAuthOrigin, secureEqual,
} from "./security.js";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  handleAuthorize,
  handleToken,
  authorizeMcpRequest,
} from "./oauth.js";
import { handleMcp } from "./mcp.js";

export { PhoneRelay };

function relay(env) {
  return env.PHONE_RELAY.getByName("primary");
}

function redirect(request, path) {
  return Response.redirect(new URL(path, request.url), 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.SESSION_SECRET || !env.CONTROL_PASSWORD || !env.DEVICE_TOKEN) {
      return secureHeaders(json({ error: "Relay secrets are not fully configured" }, 500));
    }

    const stub = relay(env);
    const ip = clientIp(request);

    try {
      if (url.pathname === "/ws") {
        const headers = new Headers(request.headers);
        headers.set("X-Relay-IP", ip);
        return stub.fetch(new Request("https://relay.internal/ws", {
          method: "GET", headers,
        }));
      }

      if (url.pathname === "/healthz") {
        const r = await stub.fetch("https://relay.internal/status");
        const state = await r.json();
        return secureHeaders(json({ ok: true, phone_connected: !!state.phone_connected }));
      }

      if (url.pathname === "/debug/oauth" && request.method === "GET") {
        if (!await secureEqual(request.headers.get("X-WorkDroid-Password") || "", env.CONTROL_PASSWORD)) {
          return secureHeaders(new Response("Not found", { status: 404 }));
        }
        const r = await stub.fetch("https://relay.internal/oauth/debug");
        return secureHeaders(new Response(r.body, {
          status: r.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        }));
      }

      if (["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"].includes(url.pathname) && request.method === "GET") {
        return secureHeaders(protectedResourceMetadata(request));
      }

      if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
        return secureHeaders(authorizationServerMetadata(request));
      }

      if (url.pathname === "/oauth/authorize") {
        if (request.method === "POST" && !trustedOAuthOrigin(request)) {
          return secureHeaders(oauthErrorResponse("Origin rejected", 403));
        }
        return secureHeaders(await handleAuthorize(request, stub));
      }

      if (url.pathname === "/oauth/token") {
        return secureHeaders(await handleToken(request, env, stub));
      }

      if (url.pathname === "/mcp") {
        if (request.method === "OPTIONS") {
          return secureHeaders(new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-origin": "https://chatgpt.com",
              "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
              "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
            },
          }));
        }
        const authorization = await authorizeMcpRequest(request, env);
        if (!authorization.ok) return secureHeaders(authorization.response);
        return secureHeaders(await handleMcp(request, stub, authorization.authInfo));
      }

      const loggedIn = await validSession(
        env.SESSION_SECRET,
        cookies(request).wd_session,
      );

      if (url.pathname === "/") return redirect(request, loggedIn ? "/control" : "/login");

      if (url.pathname === "/login" && request.method === "GET") {
        if (loggedIn) return redirect(request, "/control");
        return secureHeaders(new Response(LOGIN_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }));
      }

      if (url.pathname === "/login" && request.method === "POST") {
        if (!sameOrigin(request)) return secureHeaders(new Response("Origin rejected", { status: 403 }));
        const form = await request.formData();
        const r = await stub.fetch(new Request("https://relay.internal/auth/control", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Relay-IP": ip },
          body: JSON.stringify({ password: String(form.get("password") || "") }),
        }));
        if (!r.ok) {
          return secureHeaders(new Response(r.status === 429 ? "Too many attempts" : "Invalid password", { status: r.status }));
        }
        const ttl = Number(env.SESSION_TTL_SECONDS || 43_200);
        const session = await makeSession(env.SESSION_SECRET, ttl);
        const headers = new Headers({ Location: new URL("/control", request.url).toString() });
        headers.append("Set-Cookie", `wd_session=${encodeURIComponent(session)}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Strict`);
        return secureHeaders(new Response(null, { status: 302, headers }));
      }

      if (url.pathname === "/logout" && request.method === "POST") {
        if (!sameOrigin(request)) return secureHeaders(new Response("Origin rejected", { status: 403 }));
        const headers = new Headers({ Location: new URL("/login", request.url).toString() });
        headers.append("Set-Cookie", "wd_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
        return secureHeaders(new Response(null, { status: 302, headers }));
      }

      if (url.pathname === "/control" && request.method === "GET") {
        if (!loggedIn) return redirect(request, "/login");
        return secureHeaders(new Response(CONTROL_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }));
      }

      if (url.pathname.startsWith("/api/")) {
        if (!loggedIn) return secureHeaders(json({ error: "Login required" }, 401));
        if (request.method !== "GET" && !sameOrigin(request)) {
          return secureHeaders(json({ error: "Origin rejected" }, 403));
        }

        if (url.pathname === "/api/status" && request.method === "GET") {
          const r = await stub.fetch("https://relay.internal/status");
          return secureHeaders(new Response(r.body, {
            status: r.status,
            headers: { "content-type": "application/json" },
          }));
        }

        if (url.pathname === "/api/command" && request.method === "POST") {
          const r = await stub.fetch(new Request("https://relay.internal/action", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: await request.text(),
          }));
          return secureHeaders(new Response(r.body, {
            status: r.status,
            headers: { "content-type": "application/json" },
          }));
        }

        if (url.pathname === "/api/batch" && request.method === "POST") {
          const r = await stub.fetch(new Request("https://relay.internal/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: await request.text(),
          }));
          return secureHeaders(new Response(r.body, {
            status: r.status,
            headers: { "content-type": "application/json" },
          }));
        }
      }

      return secureHeaders(new Response("Not found", { status: 404 }));
    } catch (e) {
      return secureHeaders(json({ error: e?.message || String(e) }, 500));
    }
  },
};

function oauthErrorResponse(message, status) {
  return json({ error: "invalid_request", error_description: message }, status);
}
