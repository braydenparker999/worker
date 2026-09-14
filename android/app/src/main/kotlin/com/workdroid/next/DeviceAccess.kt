package com.workdroid.next

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.function.BooleanSupplier

class DeviceAccess : AccessibilityService() {
    companion object {
        @Volatile var instance: DeviceAccess? = null
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    private val events = Object()
    private var version = 0L
    @Volatile private var restricted = Protocol.blocked

    fun restrict(extra: JsonArray?) {
        restricted = Protocol.blocked + (extra?.mapNotNull { runCatching { it.asString }.getOrNull() } ?: emptyList())
    }

    override fun onServiceConnected() {
        instance = this
        serviceInfo = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            notificationTimeout = 50
        }
        signal()
        SessionService.startIfEnabled(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = signal()
    override fun onInterrupt() = signal()

    override fun onDestroy() {
        if (instance === this) instance = null
        signal()
        super.onDestroy()
    }

    private fun signal() = synchronized(events) {
        version++
        events.notifyAll()
    }

    fun eventVersion(): Long = synchronized(events) { version }
    fun awaitEvent(seen: Long, millis: Long) = synchronized(events) {
        if (version == seen) events.wait(maxOf(1, millis))
    }

    private fun <T> onMain(task: Callable<T>): T {
        Protocol.require(Looper.myLooper() != Looper.getMainLooper(), "EXECUTOR_THREAD_REQUIRED")
        val future = FutureTask(task)
        main.post(future)
        return try {
            future.get(3_000, TimeUnit.MILLISECONDS)
        } catch (error: ExecutionException) {
            val cause = error.cause
            if (cause is Protocol.Failure) throw cause
            throw Protocol.Failure("ANDROID_CALL_FAILED")
        } catch (_: Exception) {
            future.cancel(false)
            main.removeCallbacks(future)
            throw Protocol.Failure("ANDROID_CALL_TIMEOUT")
        }
    }

    private fun unlocked() = Protocol.require(
        !(getSystemService(KeyguardManager::class.java)?.isKeyguardLocked ?: true),
        "DEVICE_LOCKED"
    )

    fun observe(): JsonObject = onMain(Callable { snapshot() })

    fun apps(): JsonObject {
        unlocked()
        val apps = JsonArray()
        val seen = mutableSetOf<String>()
        val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        packageManager.queryIntentActivities(query, 0).forEach { item ->
            val pkg = item.activityInfo.packageName
            if (pkg !in restricted && seen.add(pkg)) {
                apps.add(Protocol.json("package", pkg, "label", item.loadLabel(packageManager).toString()))
            }
        }
        return Protocol.json("apps", apps, "scope", "launchable apps visible to Android package queries")
    }

    private fun snapshot(): JsonObject {
        unlocked()
        val root = rootInActiveWindow ?: throw Protocol.Failure("NO_ACTIVE_WINDOW")
        try {
            val pkg = root.packageName?.toString().orEmpty()
            val blocked = pkg in restricted
            val nodes = JsonArray()
            val visits = intArrayOf(0)
            if (!blocked) collect(root, "0", nodes, visits, 0)
            return Protocol.json(
                "package", pkg, "window_id", root.windowId, "nodes", nodes, "blocked", blocked,
                "truncated", visits[0] >= 600, "observed_at", System.currentTimeMillis()
            ).also { it.addProperty("revision", Protocol.hash("$pkg:${root.windowId}:$nodes")) }
        } finally {
            root.recycle()
        }
    }

    private fun collect(node: AccessibilityNodeInfo, path: String, out: JsonArray, visits: IntArray, depth: Int) {
        if (depth > 40 || visits[0] >= 600) {
            visits[0] = 600
            return
        }
        visits[0]++
        if (node.isVisibleToUser) {
            val row = nodeData(node, path)
            if (node.isClickable || node.isEditable || node.isScrollable || node.text != null || node.contentDescription != null) out.add(row)
        }
        for (index in 0 until node.childCount) {
            if (visits[0] >= 600) break
            node.getChild(index)?.let { child ->
                try { collect(child, "$path.$index", out, visits, depth + 1) } finally { child.recycle() }
            }
        }
    }

    private fun nodeData(node: AccessibilityNodeInfo, path: String): JsonObject {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val role = node.className?.toString().orEmpty().substringAfterLast('.')
        val hint = node.isShowingHintText
        return Protocol.json(
            "node_id", path,
            "role", role,
            "text", if (node.isPassword || hint) "" else node.text?.toString().orEmpty(),
            "description", if (node.isPassword) "" else node.contentDescription?.toString().orEmpty(),
            "view_id", node.viewIdResourceName.orEmpty(),
            "clickable", node.isClickable,
            "editable", node.isEditable,
            "focused", node.isFocused,
            "scrollable", node.isScrollable,
            "enabled", node.isEnabled,
            "password", node.isPassword,
            "hint", hint,
            "bounds", Protocol.json("left", bounds.left, "top", bounds.top, "right", bounds.right, "bottom", bounds.bottom)
        )
    }

    private fun resolve(path: String): AccessibilityNodeInfo {
        Protocol.require(path.matches(Regex("0(?:\\.\\d+)*")), "INVALID_NODE_PATH")
        var current = rootInActiveWindow ?: throw Protocol.Failure("NO_ACTIVE_WINDOW")
        try {
            for (part in path.split('.').drop(1)) {
                val next = current.getChild(part.toInt())
                current.recycle()
                current = next ?: throw Protocol.Failure("TARGET_DISAPPEARED")
            }
            return current
        } catch (error: Exception) {
            runCatching { current.recycle() }
            throw error
        }
    }

    private fun uniqueNode(selector: JsonObject): AccessibilityNodeInfo {
        val screen = snapshot()
        Protocol.require(!screen.get("truncated").asBoolean, "TREE_TRUNCATED_REFINE_SCREEN")
        val match = Protocol.unique(screen.getAsJsonArray("nodes"), selector)
        Protocol.require(!match.get("password").asBoolean, "PASSWORD_SCREEN")
        return resolve(Protocol.string(match, "node_id"))
    }

    fun perform(step: JsonObject, permitted: BooleanSupplier) {
        when (Protocol.string(step, "action")) {
            "swipe", "tap_point" -> gesture(step, permitted)
            else -> onMain(Callable { performOnMain(step, permitted); Unit })
        }
    }

    private fun performOnMain(step: JsonObject, permitted: BooleanSupplier) {
        guard(step, permitted)
        when (val action = Protocol.string(step, "action")) {
            "open_app" -> {
                val pkg = Protocol.string(step, "package_name")
                val intent = packageManager.getLaunchIntentForPackage(pkg) ?: throw Protocol.Failure("APP_NOT_LAUNCHABLE")
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
            }
            "tap" -> uniqueNode(Protocol.obj(step, "target")).useNode { Protocol.require(click(it), "TAP_FAILED") }
            "replace_text" -> uniqueNode(Protocol.obj(step, "target")).useNode { node ->
                Protocol.require(node.isEditable && !node.isPassword, "TARGET_NOT_EDITABLE")
                if (step.has("expected_text")) Protocol.require(node.text?.toString().orEmpty() == Protocol.string(step, "expected_text"), "TEXT_CHANGED")
                val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, Protocol.string(step, "text")) }
                Protocol.require(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "REPLACE_TEXT_FAILED")
            }
            "scroll" -> uniqueNode(Protocol.obj(step, "target")).useNode { node ->
                val command = if (Protocol.string(step, "direction", "forward") == "backward")
                    AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                Protocol.require(node.performAction(command), "SCROLL_FAILED")
            }
            "editor_action" -> uniqueNode(Protocol.obj(step, "target")).useNode { node ->
                Protocol.require(node.isEditable && !node.isPassword, "TARGET_NOT_EDITABLE")
                Protocol.require(node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id), "EDITOR_ACTION_FAILED")
            }
            "back" -> Protocol.require(performGlobalAction(GLOBAL_ACTION_BACK), "GLOBAL_ACTION_FAILED")
            "home" -> Protocol.require(performGlobalAction(GLOBAL_ACTION_HOME), "GLOBAL_ACTION_FAILED")
            else -> throw Protocol.Failure("UNSUPPORTED_ACTION_$action")
        }
    }

    private inline fun AccessibilityNodeInfo.useNode(block: (AccessibilityNodeInfo) -> Unit) {
        try { block(this) } finally { recycle() }
    }

    private fun guard(step: JsonObject, permitted: BooleanSupplier) {
        Protocol.require(permitted.asBoolean, "CANCELLED_OR_EXPIRED")
        unlocked()
        val root = rootInActiveWindow ?: throw Protocol.Failure("NO_ACTIVE_WINDOW")
        try {
            val pkg = root.packageName?.toString().orEmpty()
            Protocol.require(pkg == Protocol.string(step, "expected_package"), "FOREGROUND_CHANGED")
            Protocol.require(pkg !in restricted || Protocol.string(step, "action") == "home", "PACKAGE_BLOCKED")
        } finally { root.recycle() }
        if (step.has("revision")) Protocol.require(step.get("revision") == snapshot().get("revision"), "STALE_SCREEN")
    }

    private fun click(node: AccessibilityNodeInfo): Boolean {
        var current: AccessibilityNodeInfo? = AccessibilityNodeInfo.obtain(node)
        repeat(7) {
            val value = current ?: return false
            if (value.isClickable && value.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                value.recycle()
                current = null
                return true
            }
            val parent = value.parent
            value.recycle()
            current = parent
        }
        current?.recycle()
        return false
    }

    private fun gesture(step: JsonObject, permitted: BooleanSupplier) {
        val done = CountDownLatch(1)
        val success = AtomicBoolean(false)
        onMain(Callable {
            guard(step, permitted)
            val root = rootInActiveWindow ?: throw Protocol.Failure("NO_ACTIVE_WINDOW")
            val area = Rect()
            try { root.getBoundsInScreen(area) } finally { root.recycle() }
            val point = Protocol.string(step, "action") == "tap_point"
            val x1 = Protocol.int(step, "x1", -1)
            val y1 = Protocol.int(step, "y1", -1)
            val x2 = if (point) x1 else Protocol.int(step, "x2", -1)
            val y2 = if (point) y1 else Protocol.int(step, "y2", -1)
            Protocol.require(area.contains(x1, y1) && area.contains(x2, y2), "COORDINATES_OUTSIDE_WINDOW")
            val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); if (!point) lineTo(x2.toFloat(), y2.toFloat()) }
            val duration = Protocol.int(step, "duration_ms", if (point) 60 else 300).toLong()
            val description = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build()
            Protocol.require(dispatchGesture(description, object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { success.set(true); done.countDown() }
                override fun onCancelled(gestureDescription: GestureDescription?) { done.countDown() }
            }, main), "GESTURE_REJECTED")
        })
        try {
            Protocol.require(done.await(5, TimeUnit.SECONDS) && success.get(), "GESTURE_UNCONFIRMED")
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw Protocol.Failure("CANCELLED")
        }
    }

    fun screenshot(expectedPackage: String, expectedRevision: String): JsonObject {
        val before = observe()
        Protocol.require(Protocol.string(before, "package") == expectedPackage && Protocol.string(before, "revision") == expectedRevision, "STALE_SCREEN")
        Protocol.require(!before.get("blocked").asBoolean && !before.get("truncated").asBoolean, "SCREENSHOT_BLOCKED")
        before.getAsJsonArray("nodes").forEach { Protocol.require(!it.asJsonObject.get("password").asBoolean, "PASSWORD_SCREEN") }
        val future = CompletableFuture<JsonObject>()
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(capture: ScreenshotResult) {
                try {
                    val after = snapshot()
                    Protocol.require(Protocol.string(after, "package") == expectedPackage && Protocol.string(after, "revision") == expectedRevision, "SCREEN_CHANGED_DURING_CAPTURE")
                    val hardware = Bitmap.wrapHardwareBuffer(capture.hardwareBuffer, capture.colorSpace)
                        ?: throw Protocol.Failure("SCREENSHOT_UNAVAILABLE")
                    val bitmap = hardware.copy(Bitmap.Config.ARGB_8888, false)
                        ?: throw Protocol.Failure("SCREENSHOT_UNAVAILABLE")
                    val width = minOf(1080, bitmap.width)
                    val scaled = Bitmap.createScaledBitmap(bitmap, width, maxOf(1, bitmap.height * width / bitmap.width), true)
                    val bytes = ByteArrayOutputStream()
                    scaled.compress(Bitmap.CompressFormat.JPEG, 65, bytes)
                    future.complete(Protocol.json(
                        "image", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP), "mimeType", "image/jpeg",
                        "device_width", bitmap.width, "device_height", bitmap.height,
                        "image_width", scaled.width, "image_height", scaled.height,
                        "coordinate_space", "original device pixels", "revision", expectedRevision
                    ))
                    if (scaled !== bitmap) scaled.recycle()
                    bitmap.recycle()
                    hardware.recycle()
                    capture.hardwareBuffer.close()
                } catch (error: Exception) { future.completeExceptionally(error) }
            }
            override fun onFailure(errorCode: Int) { future.completeExceptionally(Protocol.Failure("SCREENSHOT_UNAVAILABLE")) }
        })
        return try { future.get(3, TimeUnit.SECONDS) } catch (_: Exception) { throw Protocol.Failure("SCREENSHOT_UNAVAILABLE_OR_CHANGED") }
    }
}
