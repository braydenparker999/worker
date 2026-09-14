package com.workdroid.bridge.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Bundle
import android.os.PowerManager
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class WorkDroidAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile var instance: WorkDroidAccessibilityService? = null
            private set
        @Volatile var lastPackage: String? = null
            private set
    }

    override fun onServiceConnected() {
        instance = this
        serviceInfo = serviceInfo.apply {
            eventTypes = AccessibilityEvent.TYPES_ALL_MASK
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            notificationTimeout = 100
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event?.packageName?.toString()?.let { lastPackage = it }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    fun screenTree(includeBounds: Boolean): Map<String, Any?> {
        val root = rootInActiveWindow ?: return mapOf("accessibilityService" to true, "package" to lastPackage, "nodes" to emptyList<Any>())
        val nodes = mutableListOf<Map<String, Any?>>()
        walk(root, "0", nodes, includeBounds)
        return mapOf("accessibilityService" to true, "package" to (root.packageName?.toString() ?: lastPackage), "nodes" to nodes)
    }

    private fun walk(node: AccessibilityNodeInfo, id: String, out: MutableList<Map<String, Any?>>, includeBounds: Boolean) {
        val item = linkedMapOf<String, Any?>(
            "nodeId" to id,
            "text" to node.text?.toString(),
            "contentDescription" to node.contentDescription?.toString(),
            "className" to node.className?.toString(),
            "viewId" to node.viewIdResourceName,
            "clickable" to node.isClickable,
            "editable" to node.isEditable,
            "scrollable" to node.isScrollable,
            "focused" to node.isFocused,
            "enabled" to node.isEnabled
        )
        if (includeBounds) {
            val r = android.graphics.Rect()
            node.getBoundsInScreen(r)
            item["bounds"] = mapOf("left" to r.left, "top" to r.top, "right" to r.right, "bottom" to r.bottom)
        }
        out += item
        for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, "$id.$i", out, includeBounds) }
    }

    fun nodeById(nodeId: String): AccessibilityNodeInfo? {
        val parts = nodeId.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.isEmpty() || parts.first() != 0) return null
        var node = rootInActiveWindow ?: return null
        for (index in parts.drop(1)) node = node.getChild(index) ?: return null
        return node
    }

    fun findNodes(text: String? = null, className: String? = null, clickable: Boolean? = null, limit: Int = 30): List<Map<String, Any?>> {
        val root = rootInActiveWindow ?: return emptyList()
        val all = mutableListOf<Map<String, Any?>>()
        walk(root, "0", all, true)
        return all.asSequence().filter { n ->
            val hay = listOfNotNull(n["text"] as? String, n["contentDescription"] as? String).joinToString(" ")
            (text == null || hay.contains(text, ignoreCase = true)) &&
                (className == null || (n["className"] as? String)?.contains(className, ignoreCase = true) == true) &&
                (clickable == null || n["clickable"] == clickable)
        }.take(limit.coerceIn(1, 100)).toList()
    }

    fun clickNode(node: AccessibilityNodeInfo?): Boolean {
        var current = node ?: return false
        repeat(8) {
            if (current.isClickable && current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            current = current.parent ?: return false
        }
        return false
    }

    fun tapText(text: String, exact: Boolean): Boolean {
        val root = rootInActiveWindow ?: return false
        val match = findNode(root) { node ->
            val values = listOfNotNull(node.text?.toString(), node.contentDescription?.toString())
            values.any { if (exact) it.equals(text, true) else it.contains(text, true) }
        }
        return clickNode(match)
    }

    private fun findNode(root: AccessibilityNodeInfo, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (predicate(root)) return root
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            findNode(child, predicate)?.let { return it }
        }
        return null
    }

    fun typeText(text: String, clearFirst: Boolean): Boolean {
        val root = rootInActiveWindow ?: return false
        val target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: findNode(root) { it.isFocused && it.isEditable }
            ?: findNode(root) { it.isEditable }
            ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, if (clearFirst) text else target.text?.toString().orEmpty() + text)
        }
        return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun tap(x: Int, y: Int, durationMs: Long = 60): Boolean = gesture(Path().apply { moveTo(x.toFloat(), y.toFloat()) }, durationMs)
    fun longPress(x: Int, y: Int, durationMs: Long = 700): Boolean = gesture(Path().apply { moveTo(x.toFloat(), y.toFloat()) }, durationMs)

    fun swipe(direction: String, distance: String): Boolean {
        val dm = resources.displayMetrics
        val w = dm.widthPixels.toFloat(); val h = dm.heightPixels.toFloat()
        val factor = when (distance.lowercase()) { "short" -> .22f; "long" -> .65f; else -> .42f }
        val cx = w / 2f; val cy = h / 2f; val dx = w * factor / 2f; val dy = h * factor / 2f
        val points = when (direction.lowercase()) {
            "down" -> floatArrayOf(cx, cy - dy, cx, cy + dy)
            "left" -> floatArrayOf(cx + dx, cy, cx - dx, cy)
            "right" -> floatArrayOf(cx - dx, cy, cx + dx, cy)
            else -> floatArrayOf(cx, cy + dy, cx, cy - dy)
        }
        return drag(points[0].toInt(), points[1].toInt(), points[2].toInt(), points[3].toInt(), 350)
    }

    fun drag(x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Long = 500): Boolean {
        val path = Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        return gesture(path, durationMs)
    }

    private fun gesture(path: Path, durationMs: Long): Boolean {
        val latch = CountDownLatch(1); val ok = booleanArrayOf(false)
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(20, 5000))).build()
        val accepted = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { ok[0] = true; latch.countDown() }
            override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
        }, null)
        if (!accepted) return false
        latch.await(durationMs + 1500, TimeUnit.MILLISECONDS)
        return ok[0]
    }

    fun scroll(direction: String, nodeId: String?): Boolean {
        val target = nodeId?.let { nodeById(it) } ?: rootInActiveWindow?.let { findNode(it) { n -> n.isScrollable } }
        if (target != null) {
            val action = if (direction.equals("up", true) || direction.equals("left", true)) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            if (target.performAction(action)) return true
        }
        return swipe(if (direction.equals("up", true)) "down" else if (direction.equals("down", true)) "up" else direction, "medium")
    }

    fun waitFor(text: String?, className: String?, timeoutMs: Long): Map<String, Any?>? {
        val deadline = System.currentTimeMillis() + timeoutMs.coerceIn(0, 30_000)
        do {
            val match = findNodes(text, className, null, 1).firstOrNull()
            if (match != null) return match
            Thread.sleep(250)
        } while (System.currentTimeMillis() < deadline)
        return null
    }

    fun pressKey(key: String): Boolean = when (key.lowercase()) {
        "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
        "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
        "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
        "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
        "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
        "lock_screen" -> performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        "take_screenshot" -> performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
        "wake" -> wakeScreen()
        else -> false
    }

    @Suppress("DEPRECATION")
    private fun wakeScreen(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isInteractive) return true
        val lock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "workdroid:wake")
        lock.acquire(1500); lock.release(); return true
    }

    fun screenshotJpeg(quality: Int = 70): Map<String, Any?> {
        val latch = CountDownLatch(1); val result = AtomicReference<Map<String, Any?>>()
        takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
            override fun onSuccess(screenshot: ScreenshotResult) {
                try {
                    val wrapped = Bitmap.wrapHardwareBuffer(screenshot.hardwareBuffer, screenshot.colorSpace)
                    val bitmap = wrapped?.copy(Bitmap.Config.ARGB_8888, false)
                    screenshot.hardwareBuffer.close()
                    if (bitmap == null) result.set(mapOf("error" to "Could not create bitmap")) else {
                        val out = ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 90), out)
                        result.set(mapOf("image" to Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), "mime" to "image/jpeg", "width" to bitmap.width, "height" to bitmap.height))
                        bitmap.recycle()
                    }
                } catch (t: Throwable) { result.set(mapOf("error" to (t.message ?: t.javaClass.simpleName))) } finally { latch.countDown() }
            }
            override fun onFailure(errorCode: Int) { result.set(mapOf("error" to "Screenshot failed", "code" to errorCode)); latch.countDown() }
        })
        latch.await(5, TimeUnit.SECONDS)
        return result.get() ?: mapOf("error" to "Screenshot timed out")
    }
}
