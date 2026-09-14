import { DurableObject } from "cloudflare:workers";
import { ACTIONS, DEFAULT_BLOCKED, PROTOCOL_2_ENDPOINTS } from "./config.js";
import { selectPhoneSocket, shouldAcceptPhoneSocket, socketMetadata } from "./phone-sockets.js";
import { json, secureEqual } from "./security.js";

export class PhoneRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map();
  }

  phone() {
    return selectPhoneSocket(this.ctx.getWebSockets("phone"));
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

    if (url.pathname === "/oauth/code" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const required = ["client_id", "redirect_uri", "code_challenge", "resource", "scope"];
      if (required.some(key => !body[key])) return json({ error: "Incomplete authorization request" }, 400);
      const code = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
      await this.ctx.storage.put(`oauth:code:${code}`, {
        client_id: String(body.client_id),
        redirect_uri: String(body.redirect_uri),
        code_challenge: String(body.code_challenge),
        resource: String(body.resource),
        scope: String(body.scope),
        expires_at: Date.now() + 300_000,
      });
      return json({ code });
    }

    if (url.pathname === "/oauth/exchange" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const code = String(body.code || "");
      if (!code) return json({ error: "Authorization code is required" }, 400);
      let record = null;
      await this.ctx.storage.transaction(async transaction => {
        const key = `oauth:code:${code}`;
        record = await transaction.get(key);
        if (record) await transaction.delete(key);
      });
      if (!record || record.expires_at <= Date.now()) return json({ error: "Authorization code is invalid or expired" }, 400);
      return json(record);
    }

    if (url.pathname === "/oauth/event" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const stage = String(body.stage || "unknown").slice(0, 80);
      const details = body.details && typeof body.details === "object" ? body.details : {};
      const events = (await this.ctx.storage.get("oauth:events")) || [];
      events.push({ stage, at: new Date().toISOString(), details });
      await this.ctx.storage.put("oauth:events", events.slice(-25));
      return json({ ok: true });
    }

    if (url.pathname === "/oauth/debug" && request.method === "GET") {
      return json({ events: (await this.ctx.storage.get("oauth:events")) || [] });
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

      const oldSockets = this.ctx.getWebSockets("phone");
      const protocol = Number(request.headers.get("X-WorkDroid-Protocol") || 1);
      const current = selectPhoneSocket(oldSockets);
      if (!shouldAcceptPhoneSocket(current, protocol)) {
        return new Response("A newer WorkDroid bridge protocol is already connected", { status: 409 });
      }
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server, ["phone"]);
      const sessionId = String(request.headers.get("X-WorkDroid-Session") || "");
      const bridgeVersion = String(request.headers.get("X-WorkDroid-Bridge") || "legacy");
      if (protocol >= 2 && !sessionId) {
        try { server.close(1008, "Protocol 2 session required"); } catch {}
        return new Response(null, { status: 101, webSocket: client });
      }
      server.serializeAttachment({
        role: "phone",
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
        protocol,
        sessionId,
        bridgeVersion,
      });
      for (const old of oldSockets) {
        try { old.close(1012, "Replaced by new phone connection"); } catch {}
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/status") {
      const phone = this.phone();
      const meta = phone ? socketMetadata(phone) : {};
      return json({
        phone_connected: !!phone,
        protocol: Number(meta.protocol || 1),
        session_id: meta.sessionId || null,
        bridge_version: meta.bridgeVersion || null,
        last_heartbeat_at: Number(meta.lastHeartbeatAt || meta.connectedAt || 0) || null,
        enabled_actions: Number(meta.protocol || 1) >= 2
          ? PROTOCOL_2_ENDPOINTS
          : Object.keys(ACTIONS).sort(),
      });
    }

    if (url.pathname === "/observe" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json({ ok: true, result: await this.dispatchV2("/observe", {
          screenshot: body.screenshot === true,
        }) });
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, e?.status || 500);
      }
    }

    if (url.pathname === "/execute" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json({ ok: true, result: await this.dispatchV2("/execute", body) });
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, e?.status || 500);
      }
    }

    if (url.pathname === "/apps" && request.method === "GET") {
      try {
        const phone = this.phone();
        const protocol = Number(phone ? socketMetadata(phone).protocol || 1 : 1);
        const result = protocol >= 2
          ? await this.appsProtocol2()
          : await this.dispatch("GET", "/apps", {});
        return json({ ok: true, result });
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, e?.status || 500);
      }
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
      const phone = this.phone();
      if (phone && Number(socketMetadata(phone).protocol || 1) >= 2) {
        try {
          return json(await this.executeProtocol2Batch(actions, body.stop_on_error !== false));
        } catch (e) {
          return json({ ok: false, results: [{ index: 0, ok: false, status: e?.status || 500, error: e?.message || String(e) }] });
        }
      }

      const results = [];
      // Reuse a known-safe foreground package across adjacent batch steps.
      // Actions that can cross an app boundary invalidate the cache below.
      const safetyContext = { checked: false, currentPackage: null };
      for (let i = 0; i < actions.length; i++) {
        const item = actions[i] || {};
        try {
          const result = await this.executeAction(String(item.action || ""), item.args || {}, safetyContext);
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

  async ensureSafe(action, args, context = null) {
    const blocked = this.blockedPackages();
    if (action === "open_app") {
      const pkg = String(args.package || "");
      if (!pkg) throw Object.assign(new Error("package is required"), { status: 400 });
      if (blocked.has(pkg)) throw Object.assign(new Error(`Package blocked by relay policy: ${pkg}`), { status: 403 });
      return;
    }
    if (["apps", "current_app", "media"].includes(action)) return;
    if (action === "press_key" && String(args.key || "").toLowerCase() === "home") return;
    let pkg;
    if (context?.checked) {
      pkg = context.currentPackage;
    } else {
      pkg = await this.currentPackage();
      if (context) {
        context.checked = true;
        context.currentPackage = pkg;
      }
    }
    if (pkg && blocked.has(pkg)) {
      throw Object.assign(new Error(`Current package blocked by relay policy: ${pkg}`), { status: 403 });
    }
  }

  async executeAction(action, args, safetyContext = null) {
    const phone = this.phone();
    if (phone && Number(socketMetadata(phone).protocol || 1) >= 2) {
      return this.executeProtocol2Action(action, args);
    }
    if (!ACTIONS[action]) throw Object.assign(new Error(`Unknown or disabled action: ${action}`), { status: 400 });
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw Object.assign(new Error("args must be an object"), { status: 400 });
    }
    await this.ensureSafe(action, args, safetyContext);
    const [method, path] = ACTIONS[action];
    const result = await this.dispatch(method, path, args);
    if (safetyContext) {
      if (action === "open_app") {
        safetyContext.checked = true;
        safetyContext.currentPackage = String(args.package || "") || null;
      } else if (action === "current_app") {
        safetyContext.checked = true;
        safetyContext.currentPackage = result?.package || result?.packageName || result?.currentPackage || null;
      } else if (["tap", "tap_text", "press_key"].includes(action)) {
        // A tap or navigation key can launch another package. Force a fresh
        // package check before the next protected action.
        safetyContext.checked = false;
        safetyContext.currentPackage = null;
      }
    }
    return result;
  }

  protocol2Observation(result) {
    const screen = result?.screen || result;
    return {
      sessionId: String(result?.session_id || socketMetadata(this.phone()).sessionId || ""),
      screen,
      screenshot: result?.screenshot,
    };
  }

  async observeProtocol2(screenshot = false) {
    return this.protocol2Observation(await this.dispatchV2("/observe", { screenshot }));
  }

  async appsProtocol2() {
    try {
      return await this.dispatchV2("/apps", {});
    } catch (error) {
      // Android's first PackageManager label scan can exceed the bridge's
      // 2.5-second UI-thread guard. A second read benefits from the warmed
      // package cache and is safe because app discovery is read-only.
      if (!String(error?.message || error).includes("ANDROID_CALL_TIMEOUT")) throw error;
      return this.dispatchV2("/apps", {});
    }
  }

  async executeProtocol2Job(sessionId, steps, screenshot = false, timeoutMs = 15_000) {
    const now = Date.now();
    return this.dispatchV2("/execute", {
      operation_id: crypto.randomUUID(),
      session_id: sessionId,
      expires_at: now + 25_000,
      timeout_ms: Math.min(15_000, Math.max(100, Number(timeoutMs) || 15_000)),
      steps,
      screenshot: screenshot === true,
    });
  }

  selectorForText(text, exact = true) {
    return { text: String(text || "").slice(0, 300), exact: exact !== false };
  }

  selectorForLabel(screen, text, exact = true) {
    const wanted = String(text || "").slice(0, 300);
    const needle = wanted.toLocaleLowerCase();
    const nodes = Array.isArray(screen?.nodes) ? screen.nodes : [];
    const matches = (value) => {
      const candidate = String(value || "").toLocaleLowerCase();
      return exact !== false ? candidate === needle : candidate.includes(needle);
    };
    if (nodes.some(node => matches(node?.text))) return { text: wanted, exact: exact !== false };
    if (nodes.some(node => matches(node?.description ?? node?.contentDescription ?? node?.content_description))) {
      return { description: wanted, exact: exact !== false };
    }
    return { text: wanted, exact: exact !== false };
  }

  focusedEditor(screen) {
    return (Array.isArray(screen?.nodes) ? screen.nodes : []).find(node => node?.focused === true && node?.editable === true) || null;
  }

  async leaveBlockedPackage(observation) {
    const pkg = String(observation.screen?.package || "");
    if (!this.blockedPackages().has(pkg)) return observation;
    await this.executeProtocol2Job(observation.sessionId, [{ action: "home", expected_package: pkg }]);
    return this.observeProtocol2(false);
  }

  stepForProtocol2(action, args, context) {
    const expectedPackage = String(context.package || "");
    if (!expectedPackage) throw Object.assign(new Error("No foreground Android package is available"), { status: 409 });
    if (action === "open_app") {
      const packageName = String(args.package || args.package_name || "");
      if (!packageName) throw Object.assign(new Error("package is required"), { status: 400 });
      return { action: "open_app", expected_package: expectedPackage, package_name: packageName };
    }
    if (action === "tap_text") {
      return { action: "tap", expected_package: expectedPackage, target: this.selectorForLabel(context.screen, args.text, args.exact) };
    }
    if (action === "tap") {
      return {
        action: "tap_point", expected_package: expectedPackage, revision: String(args.revision || context.revision || ""),
        x1: Number(args.x), y1: Number(args.y), duration_ms: 100,
      };
    }
    if (action === "type") {
      const currentText = String(context.editor?.text || "");
      const replacement = args.clearFirst === false ? `${currentText}${String(args.text || "")}` : String(args.text || "");
      const step = {
        action: "replace_text", expected_package: expectedPackage,
        target: { focused: true, editable: true }, text: replacement,
      };
      if (context.editor && !context.editor.hint) step.expected_text = currentText;
      return step;
    }
    if (action === "swipe") {
      return {
        action: "swipe", expected_package: expectedPackage, revision: String(args.revision || context.revision || ""),
        x1: Number(args.x1), y1: Number(args.y1), x2: Number(args.x2), y2: Number(args.y2),
        duration_ms: Math.min(1_500, Math.max(50, Number(args.durationMs || args.duration_ms || 350))),
      };
    }
    if (action === "press_key") {
      const key = String(args.key || "").toLowerCase();
      if (!['back', 'home'].includes(key)) throw Object.assign(new Error(`Protocol 2 does not expose Android key: ${key}`), { status: 400 });
      return { action: key, expected_package: expectedPackage };
    }
    if (action === "scroll") {
      return {
        action: "scroll", expected_package: expectedPackage,
        target: args.target || { scrollable: true },
        direction: String(args.direction || "forward").toLowerCase() === "backward" ? "backward" : "forward",
      };
    }
    if (action === "wait") {
      const target = args.target || this.selectorForLabel(context.screen, args.text, args.exact === true);
      return { action: "wait_for", expected_package: expectedPackage, target };
    }
    throw Object.assign(new Error(`Action is not available through WorkDroid protocol 2: ${action}`), { status: 400 });
  }

  async executeProtocol2CompatibilityStep(action, args, observation) {
    const contextFor = screen => ({
      package: screen?.package,
      revision: screen?.revision,
      editor: this.focusedEditor(screen),
      screen,
    });
    const originalPackage = String(observation.screen?.package || "");
    let step = this.stepForProtocol2(action, args, contextFor(observation.screen));
    let job = await this.executeProtocol2Job(observation.sessionId, [step], false);

    // A STALE_SCREEN/not_executed result proves Android rejected the swipe
    // before dispatch. Rebinding the same relative gesture to the new revision
    // is safe only while the foreground package and control session are stable.
    if (action === "swipe" && job?.ok === false && job.error === "STALE_SCREEN" && job.outcome === "not_executed") {
      const fresh = await this.observeProtocol2(false);
      if (fresh.sessionId === observation.sessionId && String(fresh.screen?.package || "") === originalPackage) {
        step = this.stepForProtocol2(action, args, contextFor(fresh.screen));
        job = await this.executeProtocol2Job(fresh.sessionId, [step], false);
        return { job, screen: job?.screen || fresh.screen, recovered: true };
      }
    }
    return { job, screen: job?.screen || observation.screen, recovered: false };
  }

  async executeProtocol2Action(action, args = {}) {
    if (action === "apps") return this.appsProtocol2();
    const observed = await this.observeProtocol2(action === "screenshot");
    if (action === "screen" || action === "find_nodes") return observed.screen;
    if (action === "current_app") return { package: observed.screen?.package || null, revision: observed.screen?.revision || null };
    if (action === "screen_hash") return { hash: observed.screen?.revision || null };
    if (action === "screenshot") return observed.screenshot || observed;
    if (action === "media") throw Object.assign(new Error("Media keys are not exposed by WorkDroid protocol 2"), { status: 400 });

    let ready = observed;
    if (action === "open_app") ready = await this.leaveBlockedPackage(observed);
    const executed = await this.executeProtocol2CompatibilityStep(action, args, ready);
    return executed.recovered ? { ...executed.job, recovered_from: "STALE_SCREEN" } : executed.job;
  }

  async executeProtocol2Batch(actions, stopOnError = true) {
    let observed = await this.observeProtocol2(false);
    if (actions.some(item => item?.action === "open_app")) observed = await this.leaveBlockedPackage(observed);
    const readOnly = new Set(["screen", "current_app", "find_nodes", "screen_hash"]);
    const results = [];
    const executableCount = actions.filter(item => !readOnly.has(item?.action)).length;
    if (executableCount > 12) {
      return { ok: false, results: [{ index: 12, ok: false, status: 400, error: "Protocol 2 supports at most 12 executable steps" }] };
    }

    let screen = observed.screen;
    for (let index = 0; index < actions.length; index++) {
      const item = actions[index] || {};
      if (readOnly.has(item.action)) {
        const result = item.action === "current_app"
          ? { package: screen?.package || null, revision: screen?.revision || null }
          : item.action === "screen_hash" ? { hash: screen?.revision || null } : screen;
        results.push({ index, ok: true, action: item.action, result });
        continue;
      }

      try {
        const executed = await this.executeProtocol2CompatibilityStep(String(item.action || ""), item.args || {}, {
          sessionId: observed.sessionId,
          screen,
        });
        const job = executed.job;
        screen = executed.screen;
        if (job?.ok === false) {
          results.push({ index, ok: false, action: item.action, status: 422, error: job.error || job.outcome || "Android operation failed" });
          if (stopOnError) return { ok: false, results, screen };
          continue;
        }
        results.push({
          index, ok: true, action: item.action,
          result: { ...(job?.steps?.[0] || { completed: true }), ...(executed.recovered ? { recovered_from: "STALE_SCREEN" } : {}) },
        });
      } catch (e) {
        results.push({ index, ok: false, action: item.action, status: e?.status || 500, error: e?.message || String(e) });
        if (stopOnError) return { ok: false, results, screen };
        try {
          const refreshed = await this.observeProtocol2(false);
          screen = refreshed.screen;
        } catch {}
      }
    }
    return { ok: results.every(item => item.ok), results, screen };
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
      this.pending.set(requestId, { resolve, reject, timer, socket: ws });
      try {
        ws.send(JSON.stringify(command));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        try { ws.close(1011, "Relay send failed"); } catch {}
        reject(Object.assign(new Error(`WebSocket send failed: ${e?.message || e}`), { status: 502 }));
      }
    });
  }

  async dispatchV2(path, body = {}) {
    const ws = this.phone();
    if (!ws) throw Object.assign(new Error("Android bridge is not connected"), { status: 503 });
    const meta = socketMetadata(ws);
    if (Number(meta.protocol || 1) < 2) {
      throw Object.assign(new Error("Connected Android bridge does not support protocol 2"), { status: 409 });
    }
    const requestId = crypto.randomUUID();
    const command = {
      request_id: requestId,
      path,
      body,
      expires_at: Date.now() + 30_000,
      blocked_packages: [...this.blockedPackages()],
    };
    const timeoutMs = Math.min(35_000, Math.max(1_000, Number(this.env.COMMAND_TIMEOUT_MS || 25_000) + 5_000));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(Object.assign(new Error(`Phone command timed out: ${path}`), { status: 504 }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, socket: ws });
      try {
        ws.send(JSON.stringify(command));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        try { ws.close(1011, "Relay send failed"); } catch {}
        reject(Object.assign(new Error(`WebSocket send failed: ${e?.message || e}`), { status: 502 }));
      }
    });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let data;
    try { data = JSON.parse(message); } catch { return; }
    if (!data.request_id) {
      const meta = socketMetadata(ws);
      try { ws.serializeAttachment({ ...meta, lastHeartbeatAt: Date.now() }); } catch {}
      return;
    }
    const pending = this.pending.get(data.request_id);
    if (!pending) return;
    if (pending.socket !== ws) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.request_id);
    const status = Number(data.status || 200);
    if (status >= 400) {
      pending.reject(Object.assign(new Error(JSON.stringify(data.result || data)), { status: 502 }));
    } else {
      pending.resolve(data.result ?? data);
    }
  }

  failPending(message, socket = null) {
    for (const [id, p] of this.pending) {
      if (socket && p.socket !== socket) continue;
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(message), { status: 503 }));
      this.pending.delete(id);
    }
  }

  async webSocketClose(ws, code, reason) {
    this.failPending(`Android bridge disconnected (${code}: ${reason || "closed"})`, ws);
  }

  async webSocketError(ws, error) {
    this.failPending(`Android bridge WebSocket error: ${error?.message || error}`, ws);
  }
}
