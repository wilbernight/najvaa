package com.najvaa.app

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import com.najvaa.app.service.SyncJobService

class NajvaaApp : Application() {
    val controller: AppController by lazy { AppController(this) }

    override fun onCreate() {
        super.onCreate()
        SyncJobService.schedule(this)
        val cm = getSystemService(ConnectivityManager::class.java)
        runCatching {
            cm?.registerNetworkCallback(
                NetworkRequest.Builder().build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        controller.onNetworkBack()
                    }
                },
            )
        }
    }
}
