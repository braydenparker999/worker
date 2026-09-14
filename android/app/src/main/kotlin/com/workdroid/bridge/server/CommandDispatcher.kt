package com.workdroid.bridge.server

import android.content.Context
import android.content.Intent
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.workdroid.bridge.service.WorkDroidAccessibilityService
import java.security.MessageDigest

object CommandDispatcher {
    private val gson = Gson()
    private val blockedPackages = setOf(
        "com.openai.chatgpt",
        "com.google.android.apps.authenticator2",
        "com.azure.authenticator",
        "com.authy.authy",
        "com.onepassword.android",
        "com.bitwarden.android"
    )

    data class Reply(val status: Int, val result: Any)

    fun execute(context: Context, method: String, path: String, params: JsonObject, body: JsonObject): Reply {
        return try { dispatch(context, method.uppercase(), path, params, body) }
        catch (t: Throwable) { Reply(500, mapOf("error" to (t.message ?: t.javaClass.simpleName))) }
    }

    private fun service(): WorkDroidAccessibilityService? = WorkDroidAccessibilityService.instance
    private fun currentPackage(): String? = service()?.rootInActiveWindow?.packageName?.toString() ?: WorkDroidAccessibilityService.lastPackage
    private fun blockedForeground(): Boolean = currentPackage()?.let { it in blockedPackages } == true

    private fun dispatch(context: Context, method: String, path: String, params: JsonObject, body: JsonObject): Reply {
        if (path == "/ping") {
            return Reply(200, mapOf(
                "ok" to true,
                "bridge" to "WorkDroid",
                "version" to "0.1.0",
                "accessibilityService" to (service() != null),
                "package" to currentPackage()
            ))
        }

        val svc = service() ?: return Reply(503, mapOf("error" to "Accessibility Service is not enabled"))

        if (blockedForeground() && path in setOf("/screen", "/screenshot", "/tap", "/tap_text", "/type", "/swipe", "/scroll", "/long_press", "/drag", "/find_nodes", "/describe_node", "/wait")) {
            return Reply(403, mapOf("error" to "Foreground package is blocked by WorkDroid safety policy"))
        }

        return when (path) {
            "/screen" -> Reply(200, svc.screenTree(bool(params, "bounds", false)))
            "/screenshot" -> Reply(200, svc.screenshotJpeg())
            "/current_app" -> Reply(200, mapOf("package" to currentPackage()))
            "/apps" -> Reply(200, mapOf("apps" to launchableApps(context)))
            "/screen_hash" -> {
                val current = sha256(gson.toJson(svc.screenTree(false)))
                Reply(200, mapOf("hash" to current))
            }
            "/diff_screen" -> {
                val previous = string(body, "hash") ?: string(params, "hash") ?: ""
                val current = sha256(gson.toJson(svc.screenTree(false)))
                Reply(200, mapOf("changed" to (previous != current), "hash" to current))
            }
            "/find_nodes" -> Reply(200, mapOf("nodes" to svc.findNodes(
                text = string(body, "text"), className = string(body, "className"),
                clickable = nullableBool(body, "clickable"), limit = int(body, "limit", 30)
            )))
            "/describe_node" -> {
                val id = string(body, "nodeId") ?: return Reply(400, mapOf("error" to "nodeId required"))
                val nodes = svc.screenTree(true)["nodes"] as? List<*> ?: emptyList<Any>()
                val node = nodes.filterIsInstance<Map<*, *>>().firstOrNull { it["nodeId"] == id }
                if (node == null) Reply(404, mapOf("error" to "node not found")) else Reply(200, node)
            }
            "/tap" -> {
                val id = string(body, "nodeId")
                val ok = if (id != null) svc.clickNode(svc.nodeById(id)) else svc.tap(int(body, "x", -1), int(body, "y", -1))
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/tap_text" -> {
                val text = string(body, "text") ?: return Reply(400, mapOf("error" to "text required"))
                val ok = svc.tapText(text, bool(body, "exact", false))
                Reply(if (ok) 200 else 404, mapOf("ok" to ok, "text" to text))
            }
            "/type" -> {
                val text = string(body, "text") ?: return Reply(400, mapOf("error" to "text required"))
                val ok = svc.typeText(text, bool(body, "clearFirst", false))
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/swipe" -> {
                val ok = svc.swipe(string(body, "direction") ?: "up", string(body, "distance") ?: "medium")
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/scroll" -> {
                val ok = svc.scroll(string(body, "direction") ?: "down", string(body, "nodeId"))
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/long_press" -> {
                val id = string(body, "nodeId")
                val ok = if (id != null) {
                    val node = svc.nodeById(id)
                    if (node == null) false else {
                        val rect = android.graphics.Rect(); node.getBoundsInScreen(rect)
                        svc.longPress(rect.centerX(), rect.centerY(), int(body, "duration", 700).toLong())
                    }
                } else svc.longPress(int(body, "x", -1), int(body, "y", -1), int(body, "duration", 700).toLong())
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/drag" -> {
                val ok = svc.drag(
                    int(body, "x1", int(body, "startX", -1)), int(body, "y1", int(body, "startY", -1)),
                    int(body, "x2", int(body, "endX", -1)), int(body, "y2", int(body, "endY", -1)),
                    int(body, "duration", 500).toLong()
                )
                Reply(if (ok) 200 else 422, mapOf("ok" to ok))
            }
            "/wait" -> {
                val found = svc.waitFor(string(body, "text"), string(body, "className"), int(body, "timeoutMs", 5000).toLong())
                if (found == null) Reply(408, mapOf("error" to "timeout")) else Reply(200, mapOf("node" to found))
            }
            "/open_app" -> {
                val pkg = string(body, "package") ?: return Reply(400, mapOf("error" to "package required"))
                if (pkg in blockedPackages) return Reply(403, mapOf("error" to "Package is blocked by WorkDroid safety policy"))
                val intent = context.packageManager.getLaunchIntentForPackage(pkg)
                    ?: return Reply(404, mapOf("error" to "No launchable app for package", "package" to pkg))
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                Reply(200, mapOf("ok" to true, "package" to pkg))
            }
            "/press_key" -> {
                val key = string(body, "key") ?: return Reply(400, mapOf("error" to "key required"))
                val ok = svc.pressKey(key)
                Reply(if (ok) 200 else 422, mapOf("ok" to ok, "key" to key))
            }
            else -> Reply(404, mapOf("error" to "Unsupported WorkDroid command", "path" to path, "method" to method))
        }
    }

    private fun launchableApps(context: Context): List<Map<String, String>> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        return context.packageManager.queryIntentActivities(intent, 0).map { ri ->
            mapOf("label" to ri.loadLabel(context.packageManager).toString(), "package" to ri.activityInfo.packageName)
        }.distinctBy { it["package"] }.sortedBy { it["label"]?.lowercase() }
    }

    private fun string(o: JsonObject, key: String): String? = o.get(key)?.takeUnless { it.isJsonNull }?.asString
    private fun bool(o: JsonObject, key: String, default: Boolean): Boolean = runCatching { o.get(key)?.asBoolean }.getOrNull() ?: default
    private fun nullableBool(o: JsonObject, key: String): Boolean? = runCatching { o.get(key)?.asBoolean }.getOrNull()
    private fun int(o: JsonObject, key: String, default: Int): Int = runCatching { o.get(key)?.asInt }.getOrNull() ?: default
    private fun sha256(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
}
