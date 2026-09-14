package com.workdroid.bridge

import android.app.Application
import com.workdroid.bridge.auth.PairingManager
import com.workdroid.bridge.client.RelayClient

class BridgeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PairingManager.init(this)
        RelayClient.init(this)
        if (!isWorkDroidNextInstalled()) RelayClient.autoConnect()
    }

    private fun isWorkDroidNextInstalled(): Boolean = runCatching {
        packageManager.getPackageInfo(WORKDROID_NEXT_PACKAGE, 0)
        true
    }.getOrDefault(false)

    private companion object {
        const val WORKDROID_NEXT_PACKAGE = "com.workdroid.bridge.next"
    }
}
