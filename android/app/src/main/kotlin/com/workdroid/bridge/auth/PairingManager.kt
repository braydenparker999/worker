package com.workdroid.bridge.auth

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import java.security.SecureRandom

object PairingManager {
    private const val PREFS = "workdroid_prefs"
    private const val KEY_TOKEN = "device_token"
    private val rng = SecureRandom()
    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_TOKEN, null).isNullOrBlank()) regenerate()
    }

    fun token(): String = prefs.getString(KEY_TOKEN, "") ?: ""

    fun regenerate(): String {
        val bytes = ByteArray(32)
        rng.nextBytes(bytes)
        val value = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        prefs.edit().putString(KEY_TOKEN, value).apply()
        return value
    }
}
