package com.workdroid.bridge

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import com.workdroid.bridge.auth.PairingManager
import com.workdroid.bridge.client.RelayClient
import com.workdroid.bridge.service.WorkDroidAccessibilityService

class MainActivity : Activity() {
    private lateinit var a11yStatus: TextView
    private lateinit var relayStatus: TextView
    private lateinit var tokenView: TextView
    private lateinit var urlInput: EditText
    private lateinit var connectButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(12, 12, 12)
        window.navigationBarColor = Color.rgb(12, 12, 12)
        setContentView(buildUi())

        RelayClient.onStatusChanged = { connected, message ->
            relayStatus.text = if (connected) "Relay: connected" else "Relay: $message"
            relayStatus.setTextColor(if (connected) Color.rgb(76, 175, 80) else Color.LTGRAY)
            connectButton.text = if (connected) "CONNECTED" else "CONNECT"
            connectButton.isEnabled = !connected
        }
    }

    override fun onResume() {
        super.onResume()
        updateA11y()
        relayStatus.text = if (RelayClient.isConnected) "Relay: connected" else "Relay: disconnected"
        connectButton.text = if (RelayClient.isConnected) "CONNECTED" else "CONNECT"
        connectButton.isEnabled = !RelayClient.isConnected
    }

    private fun buildUi(): ScrollView {
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(12, 12, 12)) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(28), dp(22), dp(40))
        }
        scroll.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        root.addView(text("WORKDROID BRIDGE", 25f, Color.WHITE, true))
        root.addView(text("ChatGPT Work → secure relay → this Android device", 14f, Color.rgb(170,170,170), false).apply {
            setPadding(0, dp(4), 0, dp(22))
        })

        a11yStatus = text("Accessibility: checking…", 16f, Color.LTGRAY, true)
        relayStatus = text("Relay: disconnected", 16f, Color.LTGRAY, true)
        root.addView(a11yStatus)
        root.addView(relayStatus.apply { setPadding(0, dp(6), 0, dp(18)) })

        root.addView(button("ENABLE ACCESSIBILITY") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })

        root.addView(label("DEVICE TOKEN"))
        tokenView = text(PairingManager.token(), 13f, Color.rgb(120, 210, 255), false).apply {
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setBackgroundColor(Color.rgb(28,28,28))
            setTextIsSelectable(true)
        }
        root.addView(tokenView, matchWrap())

        val tokenButtons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        tokenButtons.addView(button("COPY TOKEN") { copyToken() }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(6) })
        tokenButtons.addView(button("NEW TOKEN") {
            RelayClient.disconnect()
            tokenView.text = PairingManager.regenerate()
            Toast.makeText(this@MainActivity, "New token generated. Update DEVICE_TOKEN in the relay.", Toast.LENGTH_LONG).show()
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(6) })
        root.addView(tokenButtons, matchWrap().apply { topMargin = dp(8) })

        root.addView(label("RELAY URL"))
        urlInput = EditText(this).apply {
            setText(RelayClient.savedUrl().orEmpty())
            hint = "https://workdroid-relay.<account>.workers.dev"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(105,105,105))
            setBackgroundColor(Color.rgb(28,28,28))
            setPadding(dp(12), dp(10), dp(12), dp(10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }
        root.addView(urlInput, matchWrap())

        connectButton = button("CONNECT") {
            val url = urlInput.text.toString().trim()
            if (url.isBlank()) {
                Toast.makeText(this, "Enter the WorkDroid relay URL", Toast.LENGTH_SHORT).show()
                return@button
            }
            runCatching { RelayClient.connect(url) }
                .onFailure { Toast.makeText(this, it.message ?: "Invalid relay URL", Toast.LENGTH_LONG).show() }
        }
        root.addView(connectButton, matchWrap().apply { topMargin = dp(10) })
        root.addView(button("DISCONNECT") { RelayClient.disconnect() }, matchWrap().apply { topMargin = dp(6) })

        root.addView(text(
            "v0.1.0 • outbound WSS only • no local HTTP server • no microphone, SMS, calls, contacts, or location permissions",
            12f, Color.rgb(115,115,115), false
        ).apply { setPadding(0, dp(24), 0, 0); gravity = Gravity.CENTER_HORIZONTAL })

        return scroll
    }

    private fun updateA11y() {
        val enabled = WorkDroidAccessibilityService.instance != null
        a11yStatus.text = if (enabled) "Accessibility: active" else "Accessibility: inactive"
        a11yStatus.setTextColor(if (enabled) Color.rgb(76,175,80) else Color.rgb(255,170,80))
    }

    private fun copyToken() {
        val cb = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cb.setPrimaryClip(ClipData.newPlainText("WorkDroid device token", PairingManager.token()))
        Toast.makeText(this, "Device token copied", Toast.LENGTH_SHORT).show()
    }

    private fun label(value: String) = text(value, 12f, Color.rgb(145,145,145), true).apply {
        setPadding(0, dp(22), 0, dp(7))
    }

    private fun button(value: String, action: () -> Unit) = Button(this).apply {
        text = value
        isAllCaps = false
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.rgb(45,45,45))
        setOnClickListener { action() }
    }

    private fun text(value: String, size: Float, color: Int, bold: Boolean) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun matchWrap() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
