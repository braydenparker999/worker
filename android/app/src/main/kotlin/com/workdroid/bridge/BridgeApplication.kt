package com.workdroid.bridge

import android.app.Application
import com.workdroid.bridge.auth.PairingManager
import com.workdroid.bridge.client.RelayClient

class BridgeApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PairingManager.init(this)
        RelayClient.init(this)
        RelayClient.autoConnect()
    }
}
