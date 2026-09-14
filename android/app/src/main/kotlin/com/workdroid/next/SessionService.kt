package com.workdroid.next

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URI
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadLocalRandom
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.function.BooleanSupplier

class SessionService : Service() {
    companion object {
        const val PREFS = "session"
        const val KEY_URL = "url"
        const val KEY_TOKEN = "token"
        const val KEY_ENABLED = "enabled"
        private const val STOP = "com.workdroid.next.STOP"

        @Volatile var instance: SessionService? = null
            private set
        @Volatile var status: String = "Stopped"
            private set
        @Volatile var sessionId: String = ""
            private set

        fun startIfEnabled(context: Context) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (!prefs.getBoolean(KEY_ENABLED, false)) return
            if (!validUrl(prefs.getString(KEY_URL, "").orEmpty()) || prefs.getString(KEY_TOKEN, "").orEmpty().length < 32) return
            runCatching { context.startForegroundService(Intent(context, SessionService::class.java)) }
        }

        fun validUrl(value: String): Boolean = try {
            val uri = URI(value)
            uri.scheme == "https" && uri.host != null && uri.userInfo == null &&
                (uri.path == null || uri.path.isEmpty()) && uri.query == null && uri.fragment == null
        } catch (_: Exception) { false }
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var journal: OperationJournal
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val commands = Executors.newSingleThreadExecutor()
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).connectTimeout(10, TimeUnit.SECONDS).build()
    private val busy = AtomicBoolean(false)
    private val generation = AtomicLong(0)
    private var socket: WebSocket? = null
    private var reconnect: ScheduledFuture<*>? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var attempts = 0
    @Volatile private var running = false
    @Volatile private var pairingRejected = false

    override fun onCreate() {
        super.onCreate()
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        instance = this
        journal = OperationJournal(object : OperationJournal.Store {
            override fun read(): String = prefs.getString("journal", "{}").orEmpty()
            override fun write(value: String): Boolean = prefs.edit().putString("journal", value).commit()
        })
        sessionId = UUID.randomUUID().toString()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("session", "WorkDroid control session", NotificationManager.IMPORTANCE_LOW)
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            stopSession()
            return START_NOT_STICKY
        }
        if (!prefs.getBoolean(KEY_ENABLED, false)) {
            stopSelf()
            return START_NOT_STICKY
        }
        val notification = notification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, 0x40000000) else startForeground(1, notification)
        if (!running) {
            running = true
            pairingRejected = false
            schedule { open() }
            scheduler.scheduleWithFixedDelay({ heartbeat() }, 15, 15, TimeUnit.SECONDS)
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = schedule {
                    if (running && !pairingRejected && socket == null) open()
                }
            }
            networkCallback = callback
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(callback)
        }
        return START_STICKY
    }

    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, SessionService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, "session")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("WorkDroid remote control active")
            .setContentText("Protocol 2 connected or reconnecting · tap Stop to end")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun open() {
        if (!running || pairingRejected) return
        reconnect?.cancel(false)
        reconnect = null
        val gen = generation.incrementAndGet()
        socket?.cancel()
        socket = null
        val base = prefs.getString(KEY_URL, "").orEmpty()
        val token = prefs.getString(KEY_TOKEN, "").orEmpty()
        if (!validUrl(base) || token.length < 32) {
            status = "Invalid pairing configuration"
            return
        }
        sessionId = UUID.randomUUID().toString()
        status = "Connecting"
        val request = Request.Builder()
            .url(base.replaceFirst("https:", "wss:") + "/ws")
            .header("Authorization", "Bearer $token")
            .header("X-WorkDroid-Protocol", "2")
            .header("X-WorkDroid-Session", sessionId)
            .header("X-WorkDroid-Bridge", BuildConfig.VERSION_NAME)
            .build()
        val created = client.newWebSocket(request, listener(gen))
        socket = created
    }

    private fun listener(gen: Long) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = schedule {
            if (running && generation.get() == gen) {
                attempts = 0
                socket = webSocket
                status = "Connected"
                heartbeat()
            } else webSocket.cancel()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!running || generation.get() != gen || text.length > 65_536) return
            val command = runCatching { JsonParser.parseString(text).asJsonObject }.getOrNull() ?: return
            val id = Protocol.string(command, "request_id")
            if (id.isBlank() || id.length > 100) return
            if (!busy.compareAndSet(false, true)) {
                reply(webSocket, id, 409, Protocol.json("error", "BUSY_NOT_EXECUTED"))
                return
            }
            try {
                commands.execute {
                    try { handle(gen, command, webSocket, id) }
                    finally { busy.set(false) }
                }
            } catch (_: RejectedExecutionException) { busy.set(false) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            lost(gen, code)
            webSocket.close(code, null)
        }
        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = lost(gen, code)
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = lost(gen, response?.code ?: 0)
    }

    private fun handle(gen: Long, command: JsonObject, ws: WebSocket, id: String) {
        try {
            Protocol.require(running && generation.get() == gen, "SESSION_CHANGED")
            Protocol.require(runCatching { command.get("expires_at").asLong }.getOrDefault(0) > System.currentTimeMillis(), "COMMAND_EXPIRED")
            val path = Protocol.string(command, "path")
            val body = Protocol.obj(command, "body")
            if (path == "/health") {
                reply(ws, id, 200, health())
                return
            }
            val device = DeviceAccess.instance ?: throw Protocol.Failure("ACCESSIBILITY_DISABLED")
            val relayBlocked = if (command.has("blocked_packages")) command.getAsJsonArray("blocked_packages") else null
            device.restrict(relayBlocked)
            when (path) {
                "/apps" -> reply(ws, id, 200, device.apps())
                "/observe" -> {
                    val screen = device.observe()
                    val result = Protocol.json("session_id", sessionId, "screen", screen)
                    if (body.has("screenshot") && body.get("screenshot").asBoolean) {
                        result.add("screenshot", device.screenshot(Protocol.string(screen, "package"), Protocol.string(screen, "revision")))
                    }
                    reply(ws, id, 200, result)
                }
                "/execute" -> {
                    rejectRelayBlocked(body.getAsJsonArray("steps"), relayBlocked)
                    val result = LocalEngine(device, journal).execute(
                        body, sessionId, System.currentTimeMillis(),
                        BooleanSupplier { running && generation.get() == gen }
                    )
                    if (running && generation.get() == gen && body.has("screenshot") && body.get("screenshot").asBoolean && result.has("screen")) {
                        val screen = result.getAsJsonObject("screen")
                        runCatching { result.add("screenshot", device.screenshot(Protocol.string(screen, "package"), Protocol.string(screen, "revision"))) }
                            .onFailure { result.addProperty("screenshot_error", "SCREENSHOT_UNAVAILABLE_OR_CHANGED") }
                    }
                    reply(ws, id, 200, result)
                }
                else -> reply(ws, id, 400, Protocol.json("error", "PROTOCOL_2_ENDPOINT_REQUIRED"))
            }
        } catch (error: Exception) {
            reply(ws, id, 422, Protocol.json("error", if (error is Protocol.Failure) error.message else "INVALID_OR_FAILED_COMMAND"))
        }
    }

    private fun rejectRelayBlocked(steps: JsonArray?, extra: JsonArray?) {
        if (steps == null || extra == null) return
        val blocked = extra.map { it.asString }.toSet()
        steps.forEach { item ->
            val step = item.asJsonObject
            val expected = Protocol.string(step, "expected_package")
            val action = Protocol.string(step, "action")
            Protocol.require(expected !in blocked || action == "home", "PACKAGE_BLOCKED_BY_RELAY")
            Protocol.require(Protocol.string(step, "package_name") !in blocked, "PACKAGE_BLOCKED_BY_RELAY")
            Protocol.require(Protocol.string(step, "result_package") !in blocked, "PACKAGE_BLOCKED_BY_RELAY")
        }
    }

    private fun lost(gen: Long, code: Int) = schedule {
        if (!running || !generation.compareAndSet(gen, gen + 1)) return@schedule
        socket = null
        if (code == 401 || code == 403) {
            pairingRejected = true
            status = "Pairing rejected; check token"
            return@schedule
        }
        status = "Reconnecting"
        if (reconnect == null || reconnect?.isDone == true) {
            val delay = minOf(30_000L, 500L shl minOf(attempts++, 6)) + ThreadLocalRandom.current().nextInt(250)
            reconnect = scheduler.schedule({ reconnect = null; open() }, delay, TimeUnit.MILLISECONDS)
        }
    }

    private fun schedule(work: () -> Unit) {
        try { scheduler.execute(work) } catch (_: RejectedExecutionException) { }
    }

    private fun heartbeat() {
        if (!running) return
        socket?.send(Protocol.json(
            "event", "heartbeat", "protocol", 2, "session_id", sessionId,
            "accessibility_active", (DeviceAccess.instance != null), "busy", busy.get()
        ).toString())
    }

    private fun health(): JsonObject = Protocol.json(
        "protocol", 2, "version", BuildConfig.VERSION_NAME, "session_id", sessionId,
        "accessibility_active", (DeviceAccess.instance != null), "status", status
    )

    private fun reply(ws: WebSocket, id: String, code: Int, result: JsonObject) {
        if (running && !ws.send(Protocol.json("request_id", id, "status", code, "result", result).toString())) ws.cancel()
    }

    fun stopSession() {
        running = false
        generation.incrementAndGet()
        prefs.edit().putBoolean(KEY_ENABLED, false).commit()
        status = "Stopped"
        socket?.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        generation.incrementAndGet()
        socket?.cancel()
        reconnect?.cancel(false)
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        instance = null
        scheduler.shutdownNow()
        commands.shutdownNow()
        client.dispatcher.executorService.shutdown()
        if (status != "Stopped") status = "Stopped"
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
