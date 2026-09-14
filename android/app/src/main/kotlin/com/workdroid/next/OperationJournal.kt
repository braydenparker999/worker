package com.workdroid.next

import com.google.gson.JsonObject
import com.google.gson.JsonParser

class OperationJournal(private val store: Store) {
    interface Store {
        fun read(): String
        fun write(value: String): Boolean
    }

    private var entries: JsonObject = JsonParser.parseString(store.read()).asJsonObject

    @Synchronized
    fun begin(id: String, hash: String, now: Long, expiry: Long): String {
        if (entries.has(id)) {
            val old = entries.getAsJsonObject(id)
            Protocol.require(Protocol.string(old, "hash") == hash, "OPERATION_ID_CONFLICT")
            return Protocol.string(old, "outcome", "unknown")
        }
        val next = entries.deepCopy()
        next.keySet().toList().forEach { key ->
            if (next.getAsJsonObject(key).get("retain_until").asLong < now) next.remove(key)
        }
        Protocol.require(next.size() < 512, "OPERATION_HISTORY_FULL")
        next.add(id, Protocol.json("hash", hash, "outcome", "unknown", "retain_until", maxOf(expiry, now) + 86_400_000))
        Protocol.require(store.write(next.toString()), "JOURNAL_WRITE_FAILED")
        entries = next
        return "new"
    }

    @Synchronized
    fun finish(id: String, outcome: String) {
        val next = entries.deepCopy()
        next.getAsJsonObject(id).addProperty("outcome", outcome)
        Protocol.require(store.write(next.toString()), "JOURNAL_WRITE_FAILED")
        entries = next
    }
}
