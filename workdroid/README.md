# WorkDroid Relay — Cloudflare v0.1

This is the preferred always-available relay for the Android/ChatGPT Work experiment.

It lets the **stock MIT-licensed Hermes Android Bridge** connect outward over WSS, while ChatGPT Work operates a tiny authenticated control page over HTTPS. No OpenAI API key is used and no model runs in the relay.

```text
ChatGPT Android -> Work cloud browser -> Cloudflare Worker
                                           |
                                    Durable Object
                                  (hibernating WebSocket)
                                           ^
                                           | WSS
                                           |
                                 Hermes Android Bridge
                                           |
                                  AccessibilityService
```

## Why Cloudflare Durable Objects

A normal always-on server can stay billable just because the phone keeps a WebSocket open. Durable Objects' **WebSocket Hibernation API** keeps the client connection alive while allowing the object to sleep when idle. That is unusually well matched to a phone agent that may sit idle for hours between commands.

## What v0.1 exposes to Work

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

### 1. Install Wrangler

```bash
npm install
npx wrangler login
```

### 2. Set three secrets

The stock Hermes Bridge shows a six-character pairing code. Use that exact code for `DEVICE_TOKEN`.

```bash
npx wrangler secret put DEVICE_TOKEN
npx wrangler secret put CONTROL_PASSWORD
npx wrangler secret put SESSION_SECRET
```

Recommended values:

- `DEVICE_TOKEN`: the Hermes-generated six-character code.
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

Install/open the stock Hermes Android Bridge, enable its Accessibility Service, and enter the Worker URL above as the server URL.

Because the URL is HTTPS, the Hermes client builds a `wss://.../ws` connection automatically.

Tap Connect. The WorkDroid page should then show **Phone connected**.

### 5. Prove ChatGPT Work can drive it

Open ChatGPT on the phone, switch to Work, and ask it to visit:

```text
https://workdroid-relay.<account>.workers.dev/control
```

Sign in once with `CONTROL_PASSWORD`. Then try:

> Open Android Settings on my connected phone, open Display, and report the screen you reached.

The relay's batch example performs essentially that sequence.

## Security model

- HTTPS/WSS is provided by Cloudflare.
- The Android socket authenticates with the Hermes pairing token in the Authorization header.
- The Work control page has a separate password and an HMAC-signed, Secure, HttpOnly, SameSite=Strict session cookie.
- Failed device and control-password attempts are rate limited in Durable Object storage.
- Device token never appears in a URL.
- Cross-origin state-changing control requests are rejected.
- Sensitive Android capabilities are not exposed in v0.1.
- The relay blocks controlling/reading ChatGPT itself by default to avoid recursive agent loops.

## Known weakness before long-term use

The stock Hermes app uses a six-character device pairing token. Rate limiting makes opportunistic brute force difficult, and TLS prevents passive interception, but a six-character credential is still not the security level we want for permanent full-device control.

After the Work proof succeeds, v0.2 should fork the Android bridge and replace the pairing token with a persistent 256-bit device credential. The Hermes code is MIT licensed, so that is straightforward.

## Protocol compatibility

The bridge protocol matches `raulvidis/hermes-android`:

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
