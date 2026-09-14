import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const NAVIGATION = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const CONSEQUENTIAL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const WORKDROID_VERSION = "0.5.1";

async function relayJson(stub, path, body) {
  const response = await stub.fetch(new Request(`https://relay.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data = await response.json().catch(() => ({ error: `Relay returned HTTP ${response.status}` }));
  if (!response.ok) {
    throw new Error(data.error || `Relay returned HTTP ${response.status}`);
  }
  return data;
}

async function action(stub, name, args = {}) {
  const data = await relayJson(stub, "/action", { action: name, args });
  if (data.ok === false) throw new Error(data.error || `Android action failed: ${name}`);
  return data.result;
}

function compactJson(value, max = 18_000) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= max ? text : `${text.slice(0, max)}\n…result truncated…`;
}

function toolResult(summary, result) {
  return {
    structuredContent: { result },
    content: [{ type: "text", text: `${summary}\n${compactJson(result)}` }],
  };
}

function nodeLabel(node) {
  return String(node?.text || node?.contentDescription || node?.content_description || node?.label || "").trim();
}

function limitedText(value, max = 500) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function compactNode(node, includeBounds = false) {
  const out = {};
  const id = node?.nodeId ?? node?.node_id ?? node?.id;
  const text = limitedText(node?.text);
  const description = limitedText(node?.contentDescription || node?.content_description);
  const viewId = limitedText(node?.viewId ?? node?.view_id, 300);
  const className = String(node?.className || node?.class_name || "");
  if (id !== undefined) out.id = id;
  if (text) out.text = text;
  if (description && description !== text) out.description = description;
  if (viewId) out.view_id = viewId;
  if (className) out.role = className.split(".").pop();
  const flags = ["clickable", "editable", "scrollable", "focused", "checked", "selected"]
    .filter(key => node?.[key] === true);
  if (flags.length) out.flags = flags;
  if (includeBounds) {
    const bounds = boundsOf(node);
    if (bounds) out.bounds = bounds;
  }
  return out;
}

function screenNodes(screen) {
  if (Array.isArray(screen?.nodes)) return screen.nodes;
  if (Array.isArray(screen?.result?.nodes)) return screen.result.nodes;
  return allObjects(screen).filter(node => node && (
    node.nodeId !== undefined || node.node_id !== undefined
  ));
}

export function summarizeScreen(screen, { includeBounds = false, maxNodes = 60, query = "", exact = false } = {}) {
  const nodes = screenNodes(screen);
  const needle = String(query || "").trim().toLocaleLowerCase();
  const seen = new Set();
  const useful = [];
  for (const node of nodes) {
    const label = nodeLabel(node);
    const searchable = [label, node?.viewId, node?.view_id, node?.className, node?.class_name]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    if (needle && (exact ? label.toLocaleLowerCase() !== needle : !searchable.includes(needle))) continue;
    if (!needle && !label && !node?.clickable && !node?.editable && !node?.scrollable && !node?.focused) continue;
    const compact = compactNode(node, includeBounds);
    const key = JSON.stringify(compact);
    if (seen.has(key)) continue;
    seen.add(key);
    useful.push(compact);
    if (useful.length >= maxNodes) break;
  }
  return {
    package: screen?.package || screen?.packageName || screen?.result?.package || null,
    accessibility_active: screen?.accessibilityService ?? screen?.accessibility_service ?? true,
    total_nodes: nodes.length,
    returned_nodes: useful.length,
    truncated: useful.length < nodes.filter(node => {
      const label = nodeLabel(node);
      const searchable = [label, node?.viewId, node?.view_id, node?.className, node?.class_name]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      return needle
        ? (exact ? label.toLocaleLowerCase() === needle : searchable.includes(needle))
        : !!(label || node?.clickable || node?.editable || node?.scrollable || node?.focused);
    }).length,
    nodes: useful,
  };
}

function normalizeFlowArgs(actionName, args = {}) {
  const normalized = { ...args };
  if (actionName === "open_app") {
    normalized.package = args.package ?? args.package_name;
    delete normalized.package_name;
  }
  if (actionName === "screen" || actionName === "screen_summary") {
    normalized.bounds = args.bounds ?? args.include_bounds ?? false;
    delete normalized.include_bounds;
    delete normalized.max_nodes;
  }
  if (actionName === "swipe") {
    normalized.x1 = args.x1 ?? args.start_x;
    normalized.y1 = args.y1 ?? args.start_y;
    normalized.x2 = args.x2 ?? args.end_x;
    normalized.y2 = args.y2 ?? args.end_y;
    normalized.durationMs = args.durationMs ?? args.duration_ms ?? 350;
    for (const key of ["start_x", "start_y", "end_x", "end_y", "duration_ms"]) delete normalized[key];
  }
  if (actionName === "wait" || actionName === "wait_for_text") {
    normalized.timeoutMs = args.timeoutMs ?? args.timeout_ms ?? 5_000;
    delete normalized.timeout_ms;
  }
  if (actionName === "find_controls") {
    normalized.text = args.text ?? args.query;
    normalized.bounds = args.bounds ?? args.include_bounds ?? true;
    delete normalized.query;
    delete normalized.include_bounds;
    delete normalized.max_nodes;
  }
  if (actionName === "type" || actionName === "type_text") {
    normalized.clearFirst = args.clearFirst ?? args.replace_existing ?? true;
    delete normalized.replace_existing;
  }
  return normalized;
}

export function normalizeFlowStep(step) {
  const aliases = {
    screen_summary: "screen",
    type_text: "type",
    wait_for_text: "wait",
    find_controls: "find_nodes",
  };
  return {
    action: aliases[step.action] || step.action,
    args: normalizeFlowArgs(step.action, step.arguments || {}),
  };
}

function compactFlowResults(data, steps) {
  if (!Array.isArray(data?.results)) return data;
  return {
    ...data,
    results: data.results.map(item => {
      const step = steps[item.index] || {};
      if (!item.ok) return item;
      if (["screen", "screen_summary"].includes(step.action)) {
        return { ...item, result: summarizeScreen(item.result, {
          includeBounds: !!step.arguments?.include_bounds,
          maxNodes: Number(step.arguments?.max_nodes || 60),
        }) };
      }
      if (step.action === "find_controls") {
        return { ...item, result: summarizeScreen(item.result, {
          includeBounds: step.arguments?.include_bounds !== false,
          maxNodes: Number(step.arguments?.max_nodes || 30),
          query: step.arguments?.query || step.arguments?.text || "",
          exact: !!step.arguments?.exact,
        }) };
      }
      return item;
    }),
  };
}

function extractImage(result) {
  for (const object of allObjects(result)) {
    const data = object?.image || object?.base64 || object?.data;
    const mimeType = object?.mimeType || object?.mime_type || "image/jpeg";
    if (typeof data === "string" && data.length > 100) return { data, mimeType };
  }
  return null;
}

function allObjects(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (!Array.isArray(value)) out.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") allObjects(child, out);
  }
  return out;
}

function directText(object) {
  return Object.entries(object)
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
}

function boundsOf(object) {
  const raw = object.bounds || object.boundsInScreen || object.rect || object.frame;
  if (raw && typeof raw === "object") {
    const left = Number(raw.left ?? raw.x ?? raw[0]);
    const top = Number(raw.top ?? raw.y ?? raw[1]);
    const right = Number(raw.right ?? (Number.isFinite(left) ? left + Number(raw.width) : raw[2]));
    const bottom = Number(raw.bottom ?? (Number.isFinite(top) ? top + Number(raw.height) : raw[3]));
    if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) return { left, top, right, bottom };
  }
  if (typeof raw === "string") {
    const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length >= 4 && numbers[2] > numbers[0] && numbers[3] > numbers[1]) {
      return { left: numbers[0], top: numbers[1], right: numbers[2], bottom: numbers[3] };
    }
  }
  return null;
}

function parseTimestamp(value) {
  const parts = value.split(":").map(Number);
  if (parts.some(x => !Number.isFinite(x))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function timestampsIn(value) {
  const text = compactJson(value, 80_000);
  return [...text.matchAll(/\b(?:\d{1,2}:)?\d{1,3}:\d{2}\b/g)]
    .map(match => parseTimestamp(match[0]))
    .filter(Number.isFinite);
}

function rangeOf(object) {
  const candidates = [object.rangeInfo, object.range, object.progressInfo, object.progress, object];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const current = Number(candidate.current ?? candidate.value ?? candidate.progress);
    const max = Number(candidate.max ?? candidate.maximum);
    const min = Number(candidate.min ?? candidate.minimum ?? 0);
    if ([current, max, min].every(Number.isFinite) && max > min && current >= min) return { current, max, min };
  }
  return null;
}

async function seekMedia(stub, positionSeconds, suppliedDuration) {
  const screen = await action(stub, "screen", { bounds: true });
  const objects = allObjects(screen);
  const sliders = objects.map(object => {
    const text = directText(object);
    const bounds = boundsOf(object);
    const range = rangeOf(object);
    let score = 0;
    if (/seek.?bar|slider/i.test(text)) score += 6;
    if (/progress/i.test(text)) score += 3;
    if (/duration|elapsed|position/i.test(text)) score += 2;
    if (bounds && bounds.right - bounds.left > 150) score += 2;
    if (range) score += 2;
    return { object, text, bounds, range, score };
  }).filter(item => item.bounds && item.score >= 4).sort((a, b) => b.score - a.score);

  if (!sliders.length) throw new Error("No accessible media seek bar was found. Open the player controls and try again.");
  const slider = sliders[0];
  const times = timestampsIn(screen).filter(seconds => seconds > 0);
  let duration = Number(suppliedDuration);
  if (!Number.isFinite(duration) || duration <= 0) {
    if (slider.range && slider.range.max > 100 && slider.range.max >= positionSeconds) duration = slider.range.max;
    else duration = Math.max(0, ...times.filter(seconds => seconds >= positionSeconds));
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("The seek bar is accessible, but its duration is not. Call read_screen first or provide duration_seconds.");
  }
  if (positionSeconds < 0 || positionSeconds > duration) throw new Error(`position_seconds must be between 0 and ${duration}`);

  const ratio = Math.max(0, Math.min(1, positionSeconds / duration));
  const x = Math.round(slider.bounds.left + (slider.bounds.right - slider.bounds.left) * ratio);
  const y = Math.round((slider.bounds.top + slider.bounds.bottom) / 2);
  const result = await action(stub, "tap", { x, y });
  return { position_seconds: positionSeconds, duration_seconds: duration, ratio, coordinates: { x, y }, result };
}

function createServer(stub) {
  const server = new McpServer(
    { name: "workdroid", version: WORKDROID_VERSION },
    {
      instructions: "WorkDroid controls the owner's connected Android phone. For protocol 2, observe_device returns a revision-bound screen and execute_device runs up to 12 verified steps locally on the phone. Prefer those two tools for fast multi-step work. Familiar focused tools remain available as compatibility helpers. Never claim an action succeeded unless the returned result confirms it. Sensitive packages are blocked by both relay and phone.",
    },
  );

  server.registerTool("phone_status", {
    title: "Check connected phone",
    description: "Use this first when the user asks to control their Android phone or when connection state is uncertain.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => toolResult("WorkDroid phone status", await relayJson(stub, "/status")));

  server.registerTool("observe_device", {
    title: "Observe Android device",
    description: "Read the foreground package and compact accessibility tree in one protocol-2 observation. Use before execute_device to obtain the exact package and screen revision.",
    inputSchema: {
      screenshot: z.boolean().optional().default(false),
      include_bounds: z.boolean().optional().default(true),
      max_nodes: z.number().int().min(10).max(200).optional().default(80),
    },
    annotations: READ_ONLY,
  }, async ({ screenshot, include_bounds, max_nodes }) => {
    const data = await relayJson(stub, "/observe", { screenshot });
    const result = data.result || data;
    const screen = result.screen || result;
    const compact = {
      session_id: result.session_id || null,
      screen: summarizeScreen(screen, { includeBounds: include_bounds, maxNodes: max_nodes }),
      revision: screen?.revision || null,
    };
    const image = extractImage(result.screenshot);
    if (!image) return toolResult("Android device observation", compact);
    return {
      structuredContent: { result: compact },
      content: [
        { type: "text", text: `Android device observation\n${compactJson(compact)}` },
        { type: "image", data: image.data, mimeType: image.mimeType },
      ],
    };
  });

  const selectorSchema = z.object({
    text: z.string().max(300).optional(),
    description: z.string().max(300).optional(),
    view_id: z.string().max(400).optional(),
    role: z.string().max(200).optional(),
    focused: z.boolean().optional(),
    editable: z.boolean().optional(),
    scrollable: z.boolean().optional(),
    exact: z.boolean().optional(),
  });
  const deviceStepSchema = z.object({
    action: z.enum(["open_app", "tap", "tap_point", "replace_text", "scroll", "swipe", "back", "home", "wait_for", "assert", "editor_action"]),
    expected_package: z.string().min(1).max(300),
    target: selectorSchema.optional(),
    package_name: z.string().max(300).optional(),
    text: z.string().max(4_000).optional(),
    expected_text: z.string().max(4_000).optional(),
    direction: z.enum(["forward", "backward"]).optional(),
    editor_action: z.enum(["search", "go", "done", "send"]).optional(),
    revision: z.string().max(200).optional(),
    x1: z.number().int().min(0).max(10_000).optional(),
    y1: z.number().int().min(0).max(10_000).optional(),
    x2: z.number().int().min(0).max(10_000).optional(),
    y2: z.number().int().min(0).max(10_000).optional(),
    duration_ms: z.number().int().min(50).max(1_500).optional(),
    until: selectorSchema.optional(),
    result_package: z.string().max(300).optional(),
  });

  server.registerTool("execute_device", {
    title: "Execute verified Android steps",
    description: "Run 1-12 ordered protocol-2 steps locally on the phone. Every step must name the exact expected foreground package. Coordinate gestures also require the revision returned by observe_device. Use editor_action send only when the user authorized sending.",
    inputSchema: {
      steps: z.array(deviceStepSchema).min(1).max(12),
      screenshot: z.boolean().optional().default(false),
      timeout_ms: z.number().int().min(100).max(15_000).optional().default(15_000),
    },
    annotations: CONSEQUENTIAL,
  }, async ({ steps, screenshot, timeout_ms }) => {
    const status = await relayJson(stub, "/status");
    if (Number(status.protocol || 1) < 2 || !status.session_id) throw new Error("A connected WorkDroid protocol-2 session is required");
    const now = Date.now();
    const data = await relayJson(stub, "/execute", {
      operation_id: crypto.randomUUID(),
      session_id: status.session_id,
      expires_at: now + 25_000,
      timeout_ms,
      steps,
      screenshot,
    });
    const result = data.result || data;
    const image = extractImage(result.screenshot);
    if (!image) return toolResult("Android protocol-2 execution", result);
    return {
      structuredContent: { result: { ...result, screenshot: "<image attached>" } },
      content: [
        { type: "text", text: `Android protocol-2 execution\n${compactJson({ ...result, screenshot: "<image attached>" })}` },
        { type: "image", data: image.data, mimeType: image.mimeType },
      ],
    };
  });

  server.registerTool("current_app", {
    title: "Get foreground app",
    description: "Use this to identify the app currently visible on the connected Android phone.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => toolResult("Foreground Android app", await action(stub, "current_app")));

  server.registerTool("read_screen", {
    title: "Read Android screen",
    description: "Use this to inspect the current Android screen. Compact mode is the fast default; request full only for low-level debugging.",
    inputSchema: {
      include_bounds: z.boolean().optional().default(false).describe("Include touch coordinates and node rectangles when interaction is needed."),
      detail: z.enum(["compact", "full"]).optional().default("compact"),
      max_nodes: z.number().int().min(10).max(200).optional().default(60),
    },
    annotations: READ_ONLY,
  }, async ({ include_bounds, detail, max_nodes }) => {
    const result = await action(stub, "screen", { bounds: include_bounds });
    return toolResult(detail === "full" ? "Full Android accessibility tree" : "Compact Android screen", detail === "full"
      ? result
      : summarizeScreen(result, { includeBounds: include_bounds, maxNodes: max_nodes }));
  });

  server.registerTool("find_controls", {
    title: "Find visible Android controls",
    description: "Use this instead of reading the whole screen when you know part of a label, description, view ID, or control type.",
    inputSchema: {
      query: z.string().min(1).max(300),
      exact: z.boolean().optional().default(false),
      include_bounds: z.boolean().optional().default(true),
      max_nodes: z.number().int().min(1).max(100).optional().default(30),
    },
    annotations: READ_ONLY,
  }, async ({ query, exact, include_bounds, max_nodes }) => {
    let result;
    try {
      result = await action(stub, "find_nodes", { text: query, exact, bounds: include_bounds });
    } catch {
      result = await action(stub, "screen", { bounds: include_bounds });
    }
    return toolResult(`Android controls matching: ${query}`, summarizeScreen(result, {
      includeBounds: include_bounds, maxNodes: max_nodes, query, exact,
    }));
  });

  server.registerTool("screen_state", {
    title: "Check Android screen state",
    description: "Use this for polling. With a previous hash it returns immediately when the visible screen has not changed, avoiding another full tree in the response.",
    inputSchema: {
      previous_hash: z.string().max(500).optional(),
      include_bounds: z.boolean().optional().default(false),
      max_nodes: z.number().int().min(10).max(200).optional().default(60),
    },
    annotations: READ_ONLY,
  }, async ({ previous_hash, include_bounds, max_nodes }) => {
    const state = await action(stub, "screen_hash");
    const rawHash = state?.hash ?? state?.screenHash ?? state?.screen_hash;
    const currentHash = String(rawHash ?? JSON.stringify(state ?? null));
    if (previous_hash && currentHash === previous_hash) {
      return toolResult("Android screen is unchanged", { changed: false, hash: currentHash });
    }
    const screen = await action(stub, "screen", { bounds: include_bounds });
    return toolResult("Android screen state", {
      changed: previous_hash ? currentHash !== previous_hash : null,
      hash: currentHash,
      screen: summarizeScreen(screen, { includeBounds: include_bounds, maxNodes: max_nodes }),
    });
  });

  server.registerTool("capture_screen", {
    title: "Capture Android screen",
    description: "Use this when visual inspection is necessary and the accessibility tree is insufficient.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => {
    const result = await action(stub, "screenshot");
    const image = extractImage(result);
    if (!image) return toolResult("Screenshot response did not contain an image", result);
    return { content: [{ type: "text", text: "Current Android screenshot." }, { type: "image", data: image.data, mimeType: image.mimeType }] };
  });

  server.registerTool("list_apps", {
    title: "List Android apps",
    description: "Use this to find the installed package name before launching an app when the package is unknown.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => toolResult("Installed Android applications", await action(stub, "apps")));

  server.registerTool("open_app", {
    title: "Open Android app",
    description: "Use this to launch a specific installed Android application by package name.",
    inputSchema: {
      package_name: z.string().min(3).max(220).describe("Exact Android package name, for example com.android.settings."),
    },
    annotations: NAVIGATION,
  }, async ({ package_name }) => toolResult(`Opened ${package_name}`, await action(stub, "open_app", { package: package_name })));

  server.registerTool("press_key", {
    title: "Press Android navigation key",
    description: "Use this for Android Back, Home, or Recents navigation.",
    inputSchema: { key: z.enum(["back", "home", "recents"]) },
    annotations: NAVIGATION,
  }, async ({ key }) => toolResult(`Pressed Android ${key}`, await action(stub, "press_key", { key })));

  server.registerTool("tap_text", {
    title: "Tap visible text",
    description: "Use this to tap a visible Android control by its accessibility text. Inspect the screen first when the label may be ambiguous.",
    inputSchema: {
      text: z.string().min(1).max(300),
      exact: z.boolean().optional().default(true),
    },
    annotations: CONSEQUENTIAL,
  }, async ({ text, exact }) => toolResult(`Tapped text: ${text}`, await action(stub, "tap_text", { text, exact })));

  server.registerTool("tap", {
    title: "Tap Android coordinates",
    description: "Use this only when a visible target cannot be selected by text and its coordinates were obtained from read_screen or capture_screen.",
    inputSchema: {
      x: z.number().int().min(0).max(10_000),
      y: z.number().int().min(0).max(10_000),
    },
    annotations: CONSEQUENTIAL,
  }, async ({ x, y }) => toolResult(`Tapped Android coordinates ${x}, ${y}`, await action(stub, "tap", { x, y })));

  server.registerTool("type_text", {
    title: "Type on Android",
    description: "Use this to enter text into the currently focused Android field. It replaces existing field content by default and does not press Send or submit by itself.",
    inputSchema: {
      text: z.string().min(1).max(4_000),
      replace_existing: z.boolean().optional().default(true),
    },
    annotations: CONSEQUENTIAL,
  }, async ({ text, replace_existing }) => toolResult("Entered text into the focused field", await action(stub, "type", {
    text,
    clearFirst: replace_existing,
  })));

  server.registerTool("swipe", {
    title: "Swipe Android screen",
    description: "Use this for scrolling, seeking, or other gestures when coordinates are known.",
    inputSchema: {
      start_x: z.number().int().min(0).max(10_000),
      start_y: z.number().int().min(0).max(10_000),
      end_x: z.number().int().min(0).max(10_000),
      end_y: z.number().int().min(0).max(10_000),
      duration_ms: z.number().int().min(50).max(5_000).optional().default(350),
    },
    annotations: NAVIGATION,
  }, async args => toolResult("Completed Android swipe", await action(stub, "swipe", {
    x1: args.start_x, y1: args.start_y, x2: args.end_x, y2: args.end_y, durationMs: args.duration_ms,
  })));

  server.registerTool("media_control", {
    title: "Control Android media",
    description: "Use this for playback controls on the connected Android phone.",
    inputSchema: { command: z.enum(["play", "pause", "play_pause", "next", "previous", "stop"]) },
    annotations: NAVIGATION,
  }, async ({ command }) => toolResult(`Media command: ${command}`, await action(stub, "media", { action: command })));

  server.registerTool("seek_media", {
    title: "Seek current media",
    description: "Use this to move the current visible media player to an absolute time. It locates the accessible seek bar and taps the calculated position.",
    inputSchema: {
      position_seconds: z.number().min(0).max(86_400).describe("Absolute target position from the beginning of the media."),
      duration_seconds: z.number().positive().max(86_400).optional().describe("Total duration, only when it cannot be inferred from the visible player."),
    },
    annotations: NAVIGATION,
  }, async ({ position_seconds, duration_seconds }) => toolResult("Media seek completed", await seekMedia(stub, position_seconds, duration_seconds)));

  const flowActions = ["screen_summary", "screen", "current_app", "open_app", "press_key", "tap", "tap_text", "type_text", "type", "swipe", "wait_for_text", "wait", "media", "find_controls", "screen_hash"];
  server.registerTool("run_flow", {
    title: "Run Android action flow",
    description: "Use this for a short, ordered Android workflow that benefits from one reliable relay round trip. Prefer focused tools for single actions.",
    inputSchema: {
      steps: z.array(z.object({
        action: z.enum(flowActions),
        arguments: z.record(z.string(), z.unknown()).optional().default({}),
      })).min(1).max(20),
      stop_on_error: z.boolean().optional().default(true),
    },
    annotations: CONSEQUENTIAL,
  }, async ({ steps, stop_on_error }) => {
    const data = await relayJson(stub, "/batch", {
      actions: steps.map(normalizeFlowStep),
      stop_on_error,
    });
    return toolResult("Android flow results", compactFlowResults(data, steps));
  });

  return server;
}

export async function handleMcp(request, stub, authInfo) {
  const server = createServer(stub);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request, { authInfo });
}
