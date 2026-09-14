package com.workdroid.next

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.Base64
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.security.SecureRandom

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var accessibilityStatus: TextView
    private lateinit var relayStatus: TextView
    private lateinit var urlInput: EditText
    private lateinit var tokenInput: EditText
    private val refresh = object : Runnable {
        override fun run() {
            accessibilityStatus.text = if (DeviceAccess.instance != null) "Accessibility: active" else "Accessibility: inactive"
            accessibilityStatus.setTextColor(if (DeviceAccess.instance != null) green else orange)
            relayStatus.text = "Session: ${SessionService.status}"
            relayStatus.setTextColor(if (SessionService.status == "Connected") green else Color.LTGRAY)
            handler.postDelayed(this, 700)
        }
    }

    private val green = Color.rgb(90, 210, 125)
    private val orange = Color.rgb(255, 175, 85)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(10, 10, 12)
        window.navigationBarColor = Color.rgb(10, 10, 12)
        setContentView(buildUi())
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    private fun buildUi(): ScrollView {
        val prefs = getSharedPreferences(SessionService.PREFS, MODE_PRIVATE)
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(10, 10, 12)) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(30), dp(22), dp(42))
        }
        scroll.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(text("WORKDROID NEXT", 26f, Color.WHITE, true))
        root.addView(text("Protocol 2 · fast phone-local execution", 14f, Color.rgb(170, 170, 175), false).apply {
            setPadding(0, dp(4), 0, dp(22))
        })

        accessibilityStatus = text("Accessibility: checking…", 16f, Color.LTGRAY, true)
        relayStatus = text("Session: ${SessionService.status}", 16f, Color.LTGRAY, true)
        root.addView(accessibilityStatus)
        root.addView(relayStatus.apply { setPadding(0, dp(6), 0, dp(18)) })

        root.addView(button("1 · ENABLE ACCESSIBILITY") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })

        root.addView(label("RELAY ORIGIN"))
        urlInput = input("https://workdroid-relay.braydenparker999.workers.dev", false).apply {
            setText(prefs.getString(SessionService.KEY_URL, "https://workdroid-relay.braydenparker999.workers.dev"))
        }
        root.addView(urlInput, matchWrap())

        root.addView(label("DEVICE TOKEN"))
        tokenInput = input("Paste the relay device token", true)
        root.addView(tokenInput, matchWrap())

        val tokenButtons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        tokenButtons.addView(button("GENERATE") {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            tokenInput.setText(Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
            tokenInput.inputType = InputType.TYPE_CLASS_TEXT
            Toast.makeText(this, "Generated token. The relay secret must match it.", Toast.LENGTH_LONG).show()
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(5) })
        tokenButtons.addView(button("COPY") {
            val value = tokenInput.text.toString().trim().ifBlank { prefs.getString(SessionService.KEY_TOKEN, "").orEmpty() }
            (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("WorkDroid device token", value))
            Toast.makeText(this, "Token copied", Toast.LENGTH_SHORT).show()
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(5) })
        root.addView(tokenButtons, matchWrap().apply { topMargin = dp(8) })

        root.addView(button("2 · START CONTROL SESSION") { startSession() }, matchWrap().apply { topMargin = dp(16) })
        root.addView(button("STOP REMOTE CONTROL") {
            SessionService.instance?.stopSession() ?: prefs.edit().putBoolean(SessionService.KEY_ENABLED, false).commit()
            Toast.makeText(this, "WorkDroid stopped", Toast.LENGTH_SHORT).show()
        }, matchWrap().apply { topMargin = dp(7) })

        root.addView(button("OPEN BATTERY SETTINGS") {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }, matchWrap().apply { topMargin = dp(18) })

        root.addView(text(
            "Keep WorkDroid unrestricted in Battery settings. It reconnects after network changes, accessibility restarts, app updates, and phone reboots. The visible notification always provides Stop.",
            12f, Color.rgb(135, 135, 140), false
        ).apply { setPadding(0, dp(18), 0, 0); gravity = Gravity.CENTER_HORIZONTAL })
        root.addView(text("v${BuildConfig.VERSION_NAME} · protocol 2 only", 12f, Color.rgb(100, 100, 105), false).apply {
            setPadding(0, dp(14), 0, 0); gravity = Gravity.CENTER_HORIZONTAL
        })
        return scroll
    }

    private fun startSession() {
        if (DeviceAccess.instance == null) {
            Toast.makeText(this, "Enable WorkDroid Next accessibility first", Toast.LENGTH_LONG).show()
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            Toast.makeText(this, "Allow notifications, then tap Start again", Toast.LENGTH_LONG).show()
            return
        }
        val prefs = getSharedPreferences(SessionService.PREFS, MODE_PRIVATE)
        val url = urlInput.text.toString().trim().trimEnd('/')
        val token = tokenInput.text.toString().trim().ifBlank { prefs.getString(SessionService.KEY_TOKEN, "").orEmpty() }
        if (!SessionService.validUrl(url) || token.length < 32) {
            Toast.makeText(this, "Enter the HTTPS relay origin and matching device token", Toast.LENGTH_LONG).show()
            return
        }
        if (!prefs.edit().putString(SessionService.KEY_URL, url).putString(SessionService.KEY_TOKEN, token)
                .putBoolean(SessionService.KEY_ENABLED, true).commit()) {
            Toast.makeText(this, "Could not save pairing", Toast.LENGTH_LONG).show()
            return
        }
        tokenInput.setText("")
        startForegroundService(Intent(this, SessionService::class.java))
        Toast.makeText(this, "Connecting WorkDroid protocol 2…", Toast.LENGTH_SHORT).show()
    }

    private fun input(hintText: String, password: Boolean) = EditText(this).apply {
        hint = hintText
        setTextColor(Color.WHITE)
        setHintTextColor(Color.rgb(105, 105, 110))
        setBackgroundColor(Color.rgb(28, 28, 32))
        setPadding(dp(12), dp(11), dp(12), dp(11))
        inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setSingleLine(true)
    }

    private fun label(value: String) = text(value, 12f, Color.rgb(150, 150, 155), true).apply {
        setPadding(0, dp(20), 0, dp(7))
    }

    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.rgb(45, 45, 50))
        setOnClickListener { action() }
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }
}
