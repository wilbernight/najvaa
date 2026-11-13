package com.najvaa.app.service

import android.app.Service
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import android.util.Log
import com.najvaa.app.BuildConfig
import com.najvaa.app.NajvaaApp
import com.najvaa.app.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Keeps the process (and so the open room engines with their sockets) alive
 * while the app is in the background, when the user turned on background
 * delivery. It holds no key of its own: locking the vault hard stops it.
 */
class ConnectionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val controller = (application as NajvaaApp).controller
        controller.notifier.ensureChannels(controller.settings.value)
        val notification = controller.notifier.serviceNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.SERVICE_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(Notifier.SERVICE_ID, notification)
        }
        if (!controller.hasLiveEngines) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        // Swiping the app away is a request to stop: forget keys as well.
        (application as NajvaaApp).controller.lockHard()
        stopSelf()
    }

    companion object {
        fun start(context: Context) {
            runCatching { ContextCompat.startForegroundService(context, Intent(context, ConnectionService::class.java)) }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, ConnectionService::class.java)) }
        }
    }
}

/** Periodic catch-up when engines are alive but the socket was cut by the OS. */
class SyncJobService : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    override fun onStartJob(params: JobParameters?): Boolean {
        val controller = (application as NajvaaApp).controller
        if (BuildConfig.DEBUG) Log.d("Najvaa/Job", "sync job; engines=${controller.hasLiveEngines}")
        if (!controller.hasLiveEngines) return false
        scope.launch {
            runCatching { controller.syncAll() }.onFailure { if (BuildConfig.DEBUG) Log.w("Najvaa/Job", "sync failed $it") }
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters?): Boolean {
        scope.cancel()
        return true
    }

    companion object {
        private const val JOB_ID = 41

        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java) ?: return
            val job = JobInfo.Builder(JOB_ID, ComponentName(context, SyncJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build()
            runCatching { scheduler.schedule(job) }
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) SyncJobService.schedule(context)
    }
}
