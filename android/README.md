# WorkDroid Next v1.1

Purpose-built Android side of WorkDroid.

WorkDroid Next is the single protocol-2 Android client. It connects outward to the Cloudflare relay, executes guarded multi-step jobs locally, and never opens an inbound server.

## What this build intentionally removes

- embedded Ktor/Netty HTTP server
- inbound port 8765
- Termux integration
- microphone permissions/recording
- SMS/call/contact/location permissions
- overlay permission
- MediaProjection foreground service

## Capabilities

- AccessibilityService UI tree
- screenshots through AccessibilityService
- semantic selectors over text, content descriptions, roles, view IDs, and control state
- guarded tap, replace-text, keyboard editor actions, swipe, and scroll
- Back and Home navigation
- app launching
- event-driven waits and assertions
- revision-checked coordinate gestures
- persistent operation journal for at-most-once execution
- outbound WSS relay connection
- foreground, network, accessibility, app-update, and reboot recovery

## Authentication

Enter the same 256-bit token configured as the Cloudflare relay's `DEVICE_TOKEN` secret. The token is stored privately on-device and blanked from the UI after starting.

The app blocks ChatGPT, common authenticators, and common password managers at the Android command-dispatch layer in addition to relay-side filtering.

## First test

1. Install the APK.
2. Open WorkDroid Next.
3. Tap **Enable Accessibility** and enable WorkDroid Next.
4. Enter the deployed relay origin and matching device token.
5. Tap **Start control session** and allow notifications.
6. Set WorkDroid Next to **Unrestricted** in Android battery settings.
7. From ChatGPT Work, ask it to open Android Settings, choose Display, and report the resulting screen.
