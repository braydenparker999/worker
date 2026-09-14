import { DurableObject } from "cloudflare:workers";
import { ACTIONS, DEFAULT_BLOCKED } from "./config.js";
import { json, secureEqual } from "./security.js";

export class PhoneRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
  }

  phone() {
    const sockets = this.ctx.getWebSockets("phone");
    return sockets.length ? sockets[0] : null;
  }

  blockedPackages() {
    const extra = String(this.env.BLOCKED_PACKAGES || "")
      .split(",").map(x => x.trim()).filter(Boolean);
    return new Set([...DEFAULT_BLOCKED, ...extra]);
  }

  async rateLimited(kind, ip) {
    const now = Date.now();
    const key = `rate:${kind}:${ip}`;
    const state = (await this.ctx.storage.get(key)) || { failures: [], blockedUntil: 0 };
    if (state.blockedUntil > now) return true;
    state.failures = state.failures.filter(t => now - t < 60_000);
    await this.ctx.storage.put(key, state);
    return false;
  }

  async recordFailure(kind, ip) {
    const now = Date.now();
    const key = `rate:${kind}:${ip}`;
    const state = (await this.ctx.storage.get(key)) || { failures: [], blockedUntil: 0 };
    state.failures = state.failures.filter(t => now - t < 60_000);
    state.failures.push(now);
    if (state.failures.length >= 5) {
      state.failures = [];
      state.blockedUntil = now + 300_000;
    }
    await this.ctx.storage.put(key, state);
  }

  async clearFailures(kind, ip) {
    await this.ctx.storage.delete(`rate:${kind}:${ip}`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ip = request.headers.get("X-Relay-IP") || "unknown";

    if (url.pathname === "/auth/control" && request.method === "POST") {
      if (await this.rateLimited("control", ip)) return json({ error: "Too many attempts" }, 429);
      const body = await request.json().catch(() => ({}));
      if (!await secureEqual(body.password, this.env.CONTROL_PASSWORD || "")) {
        await this.recordFailure("control", ip);
        return json({ error: "Invalid password" }, 403);
      }
      await this.clearFailures("control", ip);
      return json({ ok: true });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket required", { status: 426 });
      }
      if (await this.rateLimited("device", ip)) return new Response("Too many attempts", { status: 429 });
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!await secureEqual(token, this.env.DEVICE_TOKEN || "")) {
        await this.recordFailure("device", ip);
        return new Response("Invalid device token", { status: 403 });
      }
      await this.clearFailures("device", ip);

      for (const old of this.ctx.getWebSockets("phone")) {
        try { old.close(1012, "Replaced by new phone connection"); } catch {}
      }
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server, ["phone"]);
      server.serializeAttachment({ role: "phone", connectedAt: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/status") {
      return json({
        phone_connected: !!this.phone(),
        enabled_actions: Object.keys(ACTIONS).sort(),
      });
    }

    if (url.pathname === "/action" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        const result = await this.executeAction(String(body.action || ""), body.args || {});
        return json({ ok: true, action: body.action, result });
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, e?.status || 500);
      }
    }

    if (url.pathname === "/batch" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const actions = body.actions;
      if (!Array.isArray(actions) || actions.length < 1 || actions.length > 30) {
        return json({ error: "actions must contain 1..30 items" }, 400);
      }
      const results = [];
      for (let i = 0; i < actions.length; i++) {
        const item = actions[i] || {};
        try {
          const result = await this.executeAction(String(item.action || ""), item.args || {});
          results.push({ index: i, ok: true, action: item.action, result });
        } catch (e) {
          results.push({ index: i, ok: false, action: item.action, status: e?.status || 500, error: e?.message || String(e) });
          if (body.stop_on_error !== false) break;
        }
      }
      return json({ ok: results.every(x => x.ok), results });
    }

    return new Response("Not found", { status: 404 });
  }

  async currentPackage() {
    const result = await this.dispatch("GET", "/current_app", {});
    return result?.package || result?.packageName || result?.currentPackage || null;
  }

  async ensureSafe(action, args) {
    const blocked = this.blockedPackages();
    if (action === "open_app") {
      const pkg = String(args.package || "");
      if (!pkg) throw Object.assign(new Error("package is required"), { status: 400 });
      if (blocked.has(pkg)) throw Object.assign(new Error(`Package blocked by relay policy: ${pkg}`), { status: 403 });
      return;
    }
    if (["apps", "current_app", "media"].includes(action)) return;
    if (action === "press_key" && String(args.key || "").toLowerCase() === "home") return;
    const pkg = await this.currentPackage();
    if (pkg && blocked.has(pkg)) {
      throw Object.assign(new Error(`Current package blocked by relay policy: ${pkg}`), { status: 403 });
    }
  }

  async executeAction(action, args) {
    if (!ACTIONS[action]) throw Object.assign(new Error(`Unknown or disabled action: ${action}`), { status: 400 });
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw Object.assign(new Error("args must be an object"), { status: 400 });
    }
    await this.ensureSafe(action, args);
    const [method, path] = ACTIONS[action];
    return this.dispatch(method, path, args);
  }

  async dispatch(method, path, args) {
    const ws = this.phone();
    if (!ws) throw Object.assign(new Error("Android bridge is not connected"), { status: 503 });
    const requestId = crypto.randomUUID();
    const command = {
      request_id: requestId,
      method,
      path,
      params: method === "GET" ? args : {},
      body: method === "GET" ? {} : args,
    };
    const timeoutMs = Number(this.env.COMMAND_TIMEOUT_MS || 25_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`Phone command timed out: ${method} ${path}`), { status: 504 }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(command));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`WebSocket send failed: ${e?.message || e}`), { status: 502 }));
      }
    });
  }

  async webSocketMessage(_ws, message) {
    if (typeof message !== "string") return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    const pending = this.pending.get(data.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.request_id);
    const status = Number(data.status || 200);
    if (status >= 400) {
      pending.reject(Object.assign(new Error(JSON.stringify(data.result || data)), { status: 502 }));
    } else {
      pending.resolve(data.result ?? data);
    }
  }

  failPending(message) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { status: 503 }));
      this.pending.delete(id);
    }
  }

  async webSocketClose(_ws, code, reason) {
    this.failPending(`Android bridge disconnected (${code}: ${reason || "closed"})`);
  }

  async webSocketError(_ws, error) {
    this.failPending(`Android bridge WebSocket error: ${error?.message || error}`);
  }
}
