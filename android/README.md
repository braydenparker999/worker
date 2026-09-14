# WorkDroid Bridge Android v0.1

Purpose-built Android side of WorkDroid.

This exists because the upstream Hermes Android v0.5.0 app starts a Ktor/Netty local HTTP server during `Application.onCreate()`. WorkDroid does not need an inbound LAN server at all: the phone only needs to connect outward to the Cloudflare relay.

## What this build intentionally removes

- embedded Ktor/Netty HTTP server
- inbound port 8765
- Termux integration
- microphone permissions/recording
- SMS/call/contact/location permissions
- overlay permission
- MediaProjection foreground service

## What remains

- AccessibilityService UI tree
- screenshots through AccessibilityService
- tap / tap by text
- type text
- swipe / scroll / long press / drag
- Back / Home / Recents / notifications / quick settings
- app launching
- current app + installed launchable apps
- wait/find/describe nodes
- screen hashes
- outbound WSS relay connection

## Authentication

WorkDroid generates a 256-bit random device token on first launch. Copy that token into the Cloudflare relay's `DEVICE_TOKEN` secret. This replaces Hermes' six-character pairing code.

The app blocks ChatGPT, common authenticators, and common password managers at the Android command-dispatch layer in addition to relay-side filtering.

## First test

1. Install the APK.
2. Open WorkDroid Bridge.
3. Tap **Enable Accessibility** and enable WorkDroid Bridge.
4. Copy the device token and set it as the relay `DEVICE_TOKEN`.
5. Enter the deployed WorkDroid relay HTTPS URL.
6. Tap **Connect**.
7. From ChatGPT Work, ask it to open Android Settings, choose Display, and report the resulting screen.
