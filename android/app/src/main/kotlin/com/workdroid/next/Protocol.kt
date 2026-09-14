package com.workdroid.next

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.TreeSet

object Protocol {
    const val VERSION = 2
    const val MAX_STEPS = 12
    const val MAX_DURATION_MS = 15_000
    private val gson = Gson()

    val actions = setOf(
        "open_app", "tap", "tap_point", "replace_text", "scroll", "swipe",
        "back", "home", "wait_for", "assert", "editor_action"
    )
    val blocked = setOf(
        "com.openai.chatgpt", "com.google.android.apps.authenticator2", "com.azure.authenticator",
        "com.authy.authy", "com.bitwarden.app", "com.bitwarden.android", "com.onepassword.android",
        "com.lastpass.lpandroid", "com.workdroid.bridge", BuildConfig.APPLICATION_ID
    )
    private val selectorFields = setOf("text", "description", "view_id", "role", "focused", "editable", "scrollable", "exact")
    private val stepFields = setOf(
        "action", "expected_package", "target", "package_name", "text", "expected_text", "direction",
        "editor_action", "revision", "x1", "x2", "y1", "y2", "duration_ms", "until", "result_package"
    )

    class Failure(code: String) : RuntimeException(code)

    fun require(ok: Boolean, code: String) {
        if (!ok) throw Failure(code)
    }

    fun string(o: JsonObject, key: String, fallback: String = ""): String =
        if (!o.has(key) || o.get(key).isJsonNull) fallback else o.get(key).asString

    fun int(o: JsonObject, key: String, fallback: Int): Int =
        runCatching { if (o.has(key)) o.get(key).asInt else fallback }.getOrDefault(fallback)

    fun obj(o: JsonObject, key: String): JsonObject =
        if (o.has(key) && o.get(key).isJsonObject) o.getAsJsonObject(key) else JsonObject()

    fun json(vararg pairs: Any?): JsonObject {
        val out = JsonObject()
        var i = 0
        while (i + 1 < pairs.size) {
            out.add(pairs[i] as String, gson.toJsonTree(pairs[i + 1]))
            i += 2
        }
        return out
    }

    fun hash(text: String): String = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(StandardCharsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun canonical(element: JsonElement): JsonElement = when {
        element.isJsonObject -> JsonObject().also { out ->
            TreeSet(element.asJsonObject.keySet()).forEach { key -> out.add(key, canonical(element.asJsonObject.get(key))) }
        }
        element.isJsonArray -> JsonArray().also { out -> element.asJsonArray.forEach { out.add(canonical(it)) } }
        element.isJsonNull -> JsonNull.INSTANCE
        else -> element.deepCopy()
    }

    fun validateJob(job: JsonObject, session: String, now: Long) {
        require(setOf("operation_id", "session_id", "expires_at", "timeout_ms", "steps", "screenshot").containsAll(job.keySet()), "UNKNOWN_JOB_FIELD")
        require(string(job, "operation_id").matches(Regex("[A-Za-z0-9_-]{8,100}")), "INVALID_OPERATION_ID")
        require(string(job, "session_id") == session, "SESSION_CHANGED")
        val expires = runCatching { job.get("expires_at").asLong }.getOrDefault(0)
        require(expires > now && expires <= now + 30_000, "EXPIRED_OR_INVALID_DEADLINE")
        val timeout = int(job, "timeout_ms", MAX_DURATION_MS)
        require(timeout in 100..MAX_DURATION_MS, "INVALID_TIMEOUT")
        val steps = runCatching { job.getAsJsonArray("steps") }.getOrNull()
        require(steps != null && steps.size() in 1..MAX_STEPS, "INVALID_STEPS")
        steps!!.forEach { validateStep(it.asJsonObject) }
    }

    private fun validateStep(step: JsonObject) {
        require(stepFields.containsAll(step.keySet()), "UNKNOWN_STEP_FIELD")
        val action = string(step, "action")
        require(action in actions, "UNSUPPORTED_ACTION")
        val expected = string(step, "expected_package")
        require(expected.isNotBlank(), "EXPECTED_PACKAGE_REQUIRED")
        require(expected !in blocked || action == "home", "PACKAGE_BLOCKED")
        if (step.has("until")) validateSelector(step.getAsJsonObject("until"))
        if (step.has("result_package")) require(string(step, "result_package") !in blocked, "PACKAGE_BLOCKED")
        when (action) {
            "open_app" -> {
                val destination = string(step, "package_name")
                require(destination.isNotBlank() && destination !in blocked, "DESTINATION_BLOCKED_OR_MISSING")
            }
            "tap", "replace_text", "scroll", "wait_for", "assert", "editor_action" -> validateSelector(obj(step, "target"))
        }
        if (action == "replace_text") require(step.has("text") && string(step, "text").length <= 4_000, "INVALID_TEXT")
        if (action == "scroll") require(string(step, "direction", "forward") in setOf("forward", "backward"), "INVALID_DIRECTION")
        if (action == "editor_action") require(string(step, "editor_action") in setOf("search", "go", "done", "send"), "INVALID_EDITOR_ACTION")
        if (action == "swipe" || action == "tap_point") {
            require(string(step, "revision").isNotBlank(), "REVISION_REQUIRED_FOR_COORDINATES")
            val keys = if (action == "tap_point") listOf("x1", "y1") else listOf("x1", "y1", "x2", "y2")
            keys.forEach { require(int(step, it, -1) in 0..10_000, "INVALID_COORDINATES") }
            require(int(step, "duration_ms", if (action == "tap_point") 60 else 300) in 20..5_000, "INVALID_GESTURE_DURATION")
        }
    }

    fun validateSelector(selector: JsonObject) {
        require(selector.size() > 0 && selectorFields.containsAll(selector.keySet()), "INVALID_SELECTOR")
        val semantic = listOf("text", "description", "view_id", "role").any { string(selector, it).isNotBlank() }
        val state = listOf("focused", "editable", "scrollable").any { selector.has(it) }
        require(semantic || state, "EMPTY_SELECTOR")
    }

    fun unique(nodes: JsonArray, selector: JsonObject): JsonObject {
        validateSelector(selector)
        val matches = nodes.map { it.asJsonObject }.filter { matches(it, selector) }
        require(matches.isNotEmpty(), "TARGET_NOT_FOUND")
        require(matches.size == 1, "AMBIGUOUS_TARGET")
        return matches.first()
    }

    private fun matches(node: JsonObject, selector: JsonObject): Boolean {
        val exact = !selector.has("exact") || selector.get("exact").asBoolean
        for (key in listOf("text", "description", "view_id", "role")) {
            if (!selector.has(key)) continue
            val expected = string(selector, key)
            val actual = string(node, key)
            if (if (exact) !actual.equals(expected, true) else !actual.contains(expected, true)) return false
        }
        for (key in listOf("focused", "editable", "scrollable")) {
            if (selector.has(key) && runCatching { node.get(key).asBoolean }.getOrDefault(false) != selector.get(key).asBoolean) return false
        }
        return true
    }
}
