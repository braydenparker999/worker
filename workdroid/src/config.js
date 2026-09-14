export const ACTIONS = Object.freeze({
  screen: ["GET", "/screen"],
  screenshot: ["GET", "/screenshot"],
  apps: ["GET", "/apps"],
  current_app: ["GET", "/current_app"],
  tap: ["POST", "/tap"],
  tap_text: ["POST", "/tap_text"],
  type: ["POST", "/type"],
  swipe: ["POST", "/swipe"],
  open_app: ["POST", "/open_app"],
  press_key: ["POST", "/press_key"],
  scroll: ["POST", "/scroll"],
  wait: ["POST", "/wait"],
  long_press: ["POST", "/long_press"],
  drag: ["POST", "/drag"],
  describe_node: ["POST", "/describe_node"],
  find_nodes: ["POST", "/find_nodes"],
  screen_hash: ["GET", "/screen_hash"],
  diff_screen: ["POST", "/diff_screen"],
  pinch: ["POST", "/pinch"],
  media: ["POST", "/media"],
});

export const DEFAULT_BLOCKED = Object.freeze([
  "com.openai.chatgpt",
  "com.google.android.apps.authenticator2",
  "com.azure.authenticator",
  "com.authy.authy",
  "com.bitwarden.app",
  "com.onepassword.android",
  "com.lastpass.lpandroid",
  "com.workdroid.bridge",
  "com.workdroid.bridge.next",
]);

export const PROTOCOL_2_ENDPOINTS = Object.freeze([
  "apps",
  "observe_device",
  "execute_device",
]);
