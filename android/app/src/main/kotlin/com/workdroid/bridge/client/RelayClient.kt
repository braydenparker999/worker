package com.workdroid.bridge.client

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.workdroid.bridge.auth.PairingManager
import com.workdroid.bridge.server.CommandDispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.min

object RelayClient {
    private const val PREFS = "workdroid_prefs"
    private const val KEY_URL = "relay_url"
    private val gson = Gson()
    private val client = OkHttpClient.Builder().pingInterval(Duration.ofSeconds(20)).build()
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val commandExecutor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private lateinit var context: Context
    private var socket: WebSocket? = null
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var reconnectAttempt = 0
    private var shouldReconnect = false

    @Volatile var isConnected: Boolean = false
        private set

    var onStatusChanged: ((Boolean, String) -> Unit)? = null

    fun init(ctx: Context) { context = ctx.applicationContext }

    fun savedUrl(): String? = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, null)

    fun connect(url: String) {
        val clean = url.trim().trimEnd('/')
        require(clean.startsWith("https://") || clean.startsWith("wss://") || clean.startsWith("http://") || clean.startsWith("ws://")) {
            "Server URL must begin with https:// or wss://"
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_URL, clean).apply()
        shouldReconnect = true
        reconnectAttempt = 0
        open(clean)
    }

    fun autoConnect() {
        savedUrl()?.takeIf { it.isNotBlank() }?.let { shouldReconnect = true; open(it) }
    }

    fun disconnect() {
        shouldReconnect = false
        reconnectFuture?.cancel(false)
        reconnectFuture = null
        socket?.close(1000, "User disconnected")
        socket = null
        setStatus(false, "Disconnected")
    }

    private fun open(url: String) {
        reconnectFuture?.cancel(false)
        socket?.cancel()
        val request = Request.Builder()
            .url(toWsUrl(url))
            .header("Authorization", "Bearer ${PairingManager.token()}")
            .header("X-WorkDroid-Bridge", "0.1.0")
            .build()
        setStatus(false, "Connecting…")
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempt = 0
                setStatus(true, "Connected")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                commandExecutor.execute { handleCommand(webSocket, text) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                setStatus(false, "Disconnected ($code)")
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                setStatus(false, "Connection failed: ${t.message ?: t.javaClass.simpleName}")
                scheduleReconnect()
            }
        })
    }

    private fun handleCommand(ws: WebSocket, text: String) {
        val parsed = runCatching { JsonParser.parseString(text).asJsonObject }.getOrNull() ?: return
        val requestId = parsed.get("request_id")?.asString ?: return
        try {
            val method = parsed.get("method")?.asString ?: "GET"
            val path = parsed.get("path")?.asString ?: "/"
            val params = parsed.getAsJsonObject("params") ?: JsonObject()
            val body = parsed.getAsJsonObject("body") ?: JsonObject()
            val reply = CommandDispatcher.execute(context, method, path, params, body)
            val payload = JsonObject().apply {
                addProperty("request_id", requestId)
                addProperty("status", reply.status)
                add("result", gson.toJsonTree(reply.result))
            }
            ws.send(gson.toJson(payload))
        } catch (t: Throwable) {
            val payload = JsonObject().apply {
                addProperty("request_id", requestId)
                addProperty("status", 500)
                add("result", gson.toJsonTree(mapOf("error" to (t.message ?: t.javaClass.simpleName))))
            }
            ws.send(gson.toJson(payload))
        }
    }

    @Synchronized
    private fun scheduleReconnect() {
        if (!shouldReconnect || reconnectFuture?.isDone == false) return
        val url = savedUrl() ?: return
        reconnectAttempt++
        val seconds = min(30L, 1L shl min(5, reconnectAttempt - 1))
        reconnectFuture = scheduler.schedule({ if (shouldReconnect) open(url) }, seconds, TimeUnit.SECONDS)
    }

    private fun setStatus(connected: Boolean, message: String) {
        isConnected = connected
        main.post { onStatusChanged?.invoke(connected, message) }
    }

    private fun toWsUrl(url: String): String {
        var base = when {
            url.startsWith("https://") -> "wss://${url.removePrefix("https://")}"
            url.startsWith("http://") -> "ws://${url.removePrefix("http://")}"
            else -> url
        }.trimEnd('/')
        if (!base.endsWith("/ws")) base += "/ws"
        return base
    }
}
