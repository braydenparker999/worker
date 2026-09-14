# WorkDroid Relay — Cloudflare v0.4

This is the preferred always-available relay for the Android/ChatGPT Work experiment.

It lets the custom **WorkDroid Bridge** connect outward over WSS. ChatGPT can control it through a private OAuth-secured MCP connection, while the authenticated `/control` page remains available for diagnostics. No OpenAI API key is used and no model runs in the relay.

```text
ChatGPT Work -- OAuth + MCP --> Cloudflare Worker
                                  |
                           Durable Object
                         (hibernating WebSocket)
                                  ^
                                  | authenticated WSS
                                  |
                          WorkDroid Bridge
                                  |
                         AccessibilityService
```

## Why Cloudflare Durable Objects

A normal always-on server can stay billable just because the phone keeps a WebSocket open. Durable Objects' **WebSocket Hibernation API** keeps the client connection alive while allowing the object to sleep when idle. That is unusually well matched to a phone agent that may sit idle for hours between commands.

## What v0.4 exposes to Work

The `/mcp` endpoint advertises focused tools with schemas and safety annotations:

- connection status, current app, accessibility screen tree, and screenshots
- installed app listing and app launch
- Back, Home, and Recents
- tap by accessible text or coordinates, text entry, and swipes
- media controls and semantic absolute-time media seeking
- compound flows of up to 20 approved actions in one relay round trip

v0.3 makes interactive control substantially leaner:

- `read_screen` returns a compact, deduplicated list of useful controls by default
- `find_controls` searches for a known label or control without sending the full tree to ChatGPT
- `screen_state` uses screen hashes to make unchanged-screen polling cheap
- `run_flow` accepts friendly tool argument names, preserves per-step errors, and compacts screen results
- relay safety checks are reused within a batch instead of adding a hidden phone round trip before nearly every step

v0.4 hardens everyday control reliability:

- the relay selects the newest open phone socket instead of a stale closing connection
- late close/error events only fail commands sent through that same socket
- text entry replaces the focused field by default, avoiding accessibility labels being prefixed to drafts
- callers can set `replace_existing: false` when intentional append behavior is needed

The existing `/control` page also exposes the lower-level relay actions:

- screen accessibility tree
- screenshot
- installed apps / current app
- tap / tap-by-text
- text input
- swipe / scroll / long press / drag / pinch
- app launch
- Back / Home / Recents and other Hermes key actions
- wait/find/describe accessibility nodes
- screen hash/diff
- media controls
- batches of up to 30 actions

It intentionally does **not** expose SMS, calls, contacts, location, microphone, clipboard, arbitrary intents, or broadcasts yet.

The ChatGPT Android package plus common authenticator/password-manager packages are blocked by default at the relay layer.

## Deploy

You need a Cloudflare account with Workers enabled. Durable Objects are available on the Workers Free plan when using SQLite-backed objects; this project uses a SQLite-class migration even though it stores almost nothing.

### Recommended phone-only route: Workers Git integration

From Cloudflare **Workers & Pages**, create/import a Worker from GitHub, select `braydenparker999/worker`, set the production branch to `workdroid-relay-v0.1`, and set the project/root directory to `workdroid`. Cloudflare will run from the included `package.json` and `wrangler.jsonc`.

Add these three Worker secrets (real values must never be committed):

- `DEVICE_TOKEN` — the persistent 256-bit token configured in WorkDroid Bridge.
- `CONTROL_PASSWORD` — a long unique password used to sign into `/control`.
- `SESSION_SECRET` — 32+ random bytes / 64+ hex characters used to sign the Work browser session.

The included `.dev.vars.example` declares the required names.

**Do not rely on the Deploy-to-Cloudflare button for this first test.** As of September 2026 there is a current open Cloudflare issue where the template flow can silently import only a placeholder. Use normal Workers Git integration or Wrangler instead.

### 1. Install Wrangler

```bash
npm install
npx wrangler login
```

### 2. Set three secrets

Use the same persistent device token configured in WorkDroid Bridge for `DEVICE_TOKEN`.

```bash
npx wrangler secret put DEVICE_TOKEN
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Recommended values:

- `DEVICE_TOKEN`: the WorkDroid Bridge 256-bit device token.
- `CONTROL_PASSWORD`: long unique password (20+ random characters).
- `SESSION_SECRET`: 32+ random bytes / 64+ hex characters.

Example session secret generation:

```bash
openssl rand -hex 32
```

### 3. Deploy

```bash
npm run deploy
```

Wrangler returns an HTTPS `workers.dev` URL such as:

```text
https://workdroid-relay.<account>.workers.dev
```

### 4. Connect Android

Install/open WorkDroid Bridge, enable its Accessibility Service, and enter the Worker URL above as the server URL.

Because the URL is HTTPS, the bridge builds a `wss://.../ws` connection automatically.

Tap Connect. The WorkDroid page should then show **Phone connected**.

### 5. Connect ChatGPT Developer mode

1. Enable Developer mode under ChatGPT **Settings → Security and login**.
2. Open **ChatGPT Plugins**, select the plus button, and add a private MCP connection.
3. Use `https://workdroid-relay.<account>.workers.dev/mcp` as the MCP URL.
4. Choose OAuth/CIMD when prompted.
5. Sign in on the WorkDroid authorization page with `CONTROL_PASSWORD`.
6. Add WorkDroid from the Developer mode tools menu in a new Work conversation.

### 6. Prove ChatGPT Work can drive it

Open ChatGPT on the phone, switch to Work, and ask it to visit:

```text
https://workdroid-relay.<account>.workers.dev/control
```

Sign in once with `CONTROL_PASSWORD`. Then try:

> Open Android Settings on my connected phone, open Display, and report the screen you reached.

The relay's batch example performs essentially that sequence.

## Security model

- HTTPS/WSS is provided by Cloudflare.
- The Android socket authenticates with its persistent device token in the Authorization header.
- The Work control page has a separate password and an HMAC-signed, Secure, HttpOnly, SameSite=Strict session cookie.
- MCP uses OAuth 2.1 authorization code flow with PKCE S256, one-time codes, signed access tokens, and refresh tokens.
- OAuth accepts only ChatGPT's documented client metadata and callback URL patterns.
- Failed device and control-password attempts are rate limited in Durable Object storage.
- Device token never appears in a URL.
- Cross-origin state-changing control requests are rejected.
- Sensitive Android capabilities are not exposed in v0.1.
- The relay blocks controlling/reading ChatGPT itself by default to avoid recursive agent loops.

## Protocol compatibility

The bridge protocol remains compatible with `raulvidis/hermes-android`:

```json
// relay -> phone
{
  "request_id": "uuid",
  "method": "GET|POST",
  "path": "/screen",
  "params": {},
  "body": {}
}

// phone -> relay
{
  "request_id": "uuid",
  "status": 200,
  "result": {}
}
```

See `UPSTREAM_LICENSE`.
