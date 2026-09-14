import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const NAVIGATION = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const CONSEQUENTIAL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

async function relayJson(stub, path, body) {
  const response = await stub.fetch(new Request(`https://relay.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const data = await response.json().catch(() => ({ error: `Relay returned HTTP ${response.status}` }));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Relay returned HTTP ${response.status}`);
  }
  return data;
}

async function action(stub, name, args = {}) {
  const data = await relayJson(stub, "/action", { action: name, args });
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

function extractImage(result) {
  const data = result?.image || result?.data?.image || result?.screenshot || result?.base64;
  const mimeType = result?.mimeType || result?.mime_type || "image/jpeg";
  return typeof data === "string" && data.length > 100 ? { data, mimeType } : null;
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
    { name: "workdroid", version: "0.2.0" },
    {
      instructions: "WorkDroid controls the owner's connected Android phone. Inspect phone status and the current screen before ambiguous touches. Prefer semantic tools such as open_app, tap_text, media_control, and seek_media. Use run_flow only for short, deliberate sequences. Never claim an action succeeded unless the returned result confirms it. Sensitive packages are blocked by the relay.",
    },
  );

  server.registerTool("phone_status", {
    title: "Check connected phone",
    description: "Use this first when the user asks to control their Android phone or when connection state is uncertain.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => toolResult("WorkDroid phone status", await relayJson(stub, "/status")));

  server.registerTool("current_app", {
    title: "Get foreground app",
    description: "Use this to identify the app currently visible on the connected Android phone.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, async () => toolResult("Foreground Android app", await action(stub, "current_app")));

  server.registerTool("read_screen", {
    title: "Read Android screen",
    description: "Use this to inspect the current Android accessibility tree before choosing a control or reporting what is visible.",
    inputSchema: {
      include_bounds: z.boolean().optional().default(false).describe("Include touch coordinates and node rectangles when interaction is needed."),
    },
    annotations: READ_ONLY,
  }, async ({ include_bounds }) => toolResult("Current Android accessibility tree", await action(stub, "screen", { bounds: include_bounds })));

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
    description: "Use this to enter text into the currently focused Android field. It does not press Send or submit by itself.",
    inputSchema: { text: z.string().min(1).max(4_000) },
    annotations: CONSEQUENTIAL,
  }, async ({ text }) => toolResult("Entered text into the focused field", await action(stub, "type", { text })));

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

  const flowActions = ["screen", "current_app", "open_app", "press_key", "tap", "tap_text", "type", "swipe", "wait", "media"];
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
      actions: steps.map(step => ({ action: step.action, args: step.arguments })),
      stop_on_error,
    });
    return toolResult("Android flow results", data);
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

