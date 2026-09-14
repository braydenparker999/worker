package com.workdroid.next

import android.os.SystemClock
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.util.function.BooleanSupplier

class LocalEngine(private val device: DeviceAccess, private val journal: OperationJournal) {
    fun execute(job: JsonObject, session: String, now: Long, active: BooleanSupplier): JsonObject {
        val started = SystemClock.elapsedRealtime()
        val results = JsonArray()
        var attempted = false
        val id = runCatching { Protocol.string(job, "operation_id") }.getOrDefault("")
        try {
            Protocol.validateJob(job, session, now)
            val fingerprint = Protocol.hash(Protocol.canonical(job).toString())
            val previous = journal.begin(id, fingerprint, now, job.get("expires_at").asLong)
            if (previous != "new") {
                return Protocol.json(
                    "ok", false, "operation_id", id, "outcome", previous, "replayed", false,
                    "error", "ALREADY_ATTEMPTED_OBSERVE_BEFORE_RETRY"
                )
            }
            val deadline = started + minOf(
                Protocol.int(job, "timeout_ms", Protocol.MAX_DURATION_MS).toLong(),
                job.get("expires_at").asLong - now
            )
            val permitted = BooleanSupplier { active.asBoolean && SystemClock.elapsedRealtime() < deadline }

            job.getAsJsonArray("steps").forEach { entry ->
                check(permitted)
                val step = entry.asJsonObject
                val stepStarted = SystemClock.elapsedRealtime()
                val action = Protocol.string(step, "action")
                val before = safeObserve(step)
                when (action) {
                    "wait_for" -> waitFor(step, permitted, deadline)
                    "assert" -> {
                        completeTree(before)
                        Protocol.unique(before.getAsJsonArray("nodes"), Protocol.obj(step, "target"))
                    }
                    else -> {
                        if (step.has("revision")) Protocol.require(step.get("revision") == before.get("revision"), "STALE_SCREEN")
                        check(permitted)
                        attempted = true
                        device.perform(step, permitted)
                        if (action == "open_app") waitForPackage(step, permitted, deadline)
                        if (step.has("until")) {
                            val expected = Protocol.string(
                                step, "result_package",
                                Protocol.string(step, "package_name", Protocol.string(step, "expected_package"))
                            )
                            waitFor(Protocol.json("expected_package", expected, "target", step.get("until")), permitted, deadline)
                        } else {
                            settle(permitted, minOf(deadline, SystemClock.elapsedRealtime() + 650))
                        }
                    }
                }
                results.add(Protocol.json(
                    "index", results.size(), "action", action, "ok", true,
                    "elapsed_ms", SystemClock.elapsedRealtime() - stepStarted
                ))
            }
            check(permitted)
            val screen = device.observe()
            journal.finish(id, "completed")
            return Protocol.json(
                "ok", true, "operation_id", id, "outcome", "completed", "steps", results,
                "screen", screen, "elapsed_ms", SystemClock.elapsedRealtime() - started
            )
        } catch (error: Exception) {
            val outcome = if (attempted) "unknown_or_partial" else "not_executed"
            if (id.isNotBlank()) runCatching { journal.finish(id, outcome) }
            val code = if (error is Protocol.Failure) error.message else "DEVICE_EXECUTION_FAILED"
            val response = Protocol.json(
                "ok", false, "operation_id", id, "outcome", outcome, "error", code ?: "DEVICE_EXECUTION_FAILED",
                "steps", results, "failed_index", results.size(), "elapsed_ms", SystemClock.elapsedRealtime() - started
            )
            if (active.asBoolean) runCatching { response.add("screen", device.observe()) }
            return response
        }
    }

    private fun safeObserve(step: JsonObject): JsonObject {
        val screen = device.observe()
        val pkg = Protocol.string(screen, "package")
        Protocol.require(pkg == Protocol.string(step, "expected_package"), "FOREGROUND_CHANGED")
        val blocked = screen.has("blocked") && screen.get("blocked").asBoolean
        Protocol.require(!blocked || Protocol.string(step, "action") == "home", "PACKAGE_BLOCKED")
        return screen
    }

    private fun waitForPackage(step: JsonObject, permitted: BooleanSupplier, deadline: Long) {
        val source = Protocol.string(step, "expected_package")
        val destination = Protocol.string(step, "package_name")
        while (true) {
            check(permitted)
            val version = device.eventVersion()
            val screen = device.observe()
            val pkg = Protocol.string(screen, "package")
            if (pkg == destination && screen.getAsJsonArray("nodes").size() > 0) return
            Protocol.require(pkg == source || pkg == destination, "UNEXPECTED_APP_DURING_LAUNCH")
            device.awaitEvent(version, minOf(200, maxOf(1, deadline - SystemClock.elapsedRealtime())))
        }
    }

    private fun waitFor(step: JsonObject, permitted: BooleanSupplier, deadline: Long) {
        val target = Protocol.obj(step, "target")
        Protocol.validateSelector(target)
        while (true) {
            check(permitted)
            val version = device.eventVersion()
            val screen = safeObserve(step)
            completeTree(screen)
            try {
                Protocol.unique(screen.getAsJsonArray("nodes"), target)
                return
            } catch (error: Protocol.Failure) {
                if (error.message != "TARGET_NOT_FOUND") throw error
            }
            device.awaitEvent(version, minOf(200, maxOf(1, deadline - SystemClock.elapsedRealtime())))
        }
    }

    private fun settle(permitted: BooleanSupplier, deadline: Long) {
        while (SystemClock.elapsedRealtime() < deadline) {
            check(permitted)
            val version = device.eventVersion()
            device.awaitEvent(version, minOf(100, maxOf(1, deadline - SystemClock.elapsedRealtime())))
            if (version == device.eventVersion()) return
        }
    }

    private fun check(permitted: BooleanSupplier) = Protocol.require(permitted.asBoolean, "CANCELLED_OR_EXPIRED")
    private fun completeTree(screen: JsonObject) = Protocol.require(!screen.get("truncated").asBoolean, "TREE_TRUNCATED_REFINE_SCREEN")
}
