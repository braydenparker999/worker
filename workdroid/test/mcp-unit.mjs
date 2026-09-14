import assert from "node:assert/strict";
import { normalizeFlowStep, summarizeScreen, verifiedActionResult, WORKDROID_VERSION } from "../src/mcp.js";
import { selectPhoneSocket, shouldAcceptPhoneSocket } from "../src/phone-sockets.js";

assert.equal(WORKDROID_VERSION, "0.5.7");

assert.deepEqual(verifiedActionResult({ ok: true, result: { ok: true, completed: true } }, "tap"), {
  ok: true,
  completed: true,
});
assert.throws(
  () => verifiedActionResult({ ok: true, result: { ok: false, error: "STALE_SCREEN" } }, "tap"),
  /STALE_SCREEN/,
);

const screen = {
  accessibilityService: true,
  package: "com.example",
  nodes: [
    { nodeId: "0", className: "android.widget.FrameLayout", clickable: false },
    { nodeId: "0.0", className: "android.widget.Button", text: "Send", clickable: true, bounds: { left: 10, top: 20, right: 110, bottom: 70 } },
    { nodeId: "0.1", className: "android.widget.TextView", text: "Hello", clickable: false },
    { nodeId: "0.2", className: "android.widget.Button", contentDescription: "Send", clickable: true },
    { node_id: "0.3", role: "ImageButton", description: "Search Marketplace", clickable: true },
  ],
};

const summary = summarizeScreen(screen, { includeBounds: true });
assert.equal(summary.package, "com.example");
assert.equal(summary.total_nodes, 5);
assert.equal(summary.returned_nodes, 4);
assert.equal(summary.nodes[0].text, "Send");
assert.deepEqual(summary.nodes[0].bounds, { left: 10, top: 20, right: 110, bottom: 70 });
assert.deepEqual(summary.nodes[3], {
  id: "0.3",
  description: "Search Marketplace",
  role: "ImageButton",
  flags: ["clickable"],
});

const described = summarizeScreen(screen, { query: "marketplace", exact: false });
assert.equal(described.returned_nodes, 1);
assert.equal(described.nodes[0].description, "Search Marketplace");

const filtered = summarizeScreen(screen, { query: "hello" });
assert.equal(filtered.returned_nodes, 1);
assert.equal(filtered.nodes[0].text, "Hello");

assert.deepEqual(normalizeFlowStep({
  action: "open_app",
  arguments: { package_name: "com.android.settings" },
}), { action: "open_app", args: { package: "com.android.settings" } });

assert.deepEqual(normalizeFlowStep({
  action: "swipe",
  arguments: { start_x: 1, start_y: 2, end_x: 3, end_y: 4, duration_ms: 500 },
}), { action: "swipe", args: { x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 500 } });

assert.deepEqual(normalizeFlowStep({
  action: "screen_summary",
  arguments: { include_bounds: true, max_nodes: 20 },
}), { action: "screen", args: { bounds: true } });

assert.deepEqual(normalizeFlowStep({
  action: "find_controls",
  arguments: { query: "Send", include_bounds: true, max_nodes: 5 },
}), { action: "find_nodes", args: { text: "Send", bounds: true } });

assert.deepEqual(normalizeFlowStep({
  action: "type_text",
  arguments: { text: "Hello" },
}), { action: "type", args: { text: "Hello", clearFirst: true } });

assert.deepEqual(normalizeFlowStep({
  action: "type_text",
  arguments: { text: " world", replace_existing: false },
}), { action: "type", args: { text: " world", clearFirst: false } });

function socket(readyState, connectedAt, protocol = 1) {
  return {
    readyState,
    deserializeAttachment: () => ({ connectedAt, protocol }),
  };
}

const closingOld = socket(2, 100);
const openOld = socket(1, 200);
const openNew = socket(1, 300);
assert.equal(selectPhoneSocket([closingOld, openOld, openNew]), openNew);
assert.equal(selectPhoneSocket([closingOld]), null);
assert.equal(shouldAcceptPhoneSocket(socket(1, 100, 2), 1), false);
assert.equal(shouldAcceptPhoneSocket(socket(1, 100, 2), 2), true);
assert.equal(shouldAcceptPhoneSocket(socket(1, 100, 1), 2), true);
assert.equal(shouldAcceptPhoneSocket(socket(2, 100, 2), 1), true);

console.log("WorkDroid MCP unit tests passed.");
