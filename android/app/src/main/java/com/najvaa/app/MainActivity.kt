package com.najvaa.app

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.najvaa.app.data.AppTheme
import com.najvaa.app.ui.NajvaaRoot
import com.najvaa.app.ui.theme.NajvaaTheme

class MainActivity : FragmentActivity() {

    val controller: AppController get() = (application as NajvaaApp).controller

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (controller.settings.value.lockOnScreenOff) controller.lock()
        }
    }

    private var captureCallback: Any? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT),
        )
        window.decorView.layoutDirection = View.LAYOUT_DIRECTION_RTL
        intent?.getStringExtra("room")?.let { controller.requestOpen(it) }

        setContent {
            val settings by controller.settings.collectAsState()
            LaunchedEffect(settings.blockScreenshots) {
                // Debug builds stay capturable so QA can take screenshots; release always honours the setting.
                if (settings.blockScreenshots && !BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            NajvaaTheme(theme = settings.theme, fontScale = settings.fontScale) {
                NajvaaRoot(controller, this)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("room")?.let { controller.requestOpen(it) }
    }

    fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onStart() {
        super.onStart()
        controller.cancelScheduledLock()
        registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
        if (Build.VERSION.SDK_INT >= 34) {
            val cb = Activity.ScreenCaptureCallback {
                controller.activeRoom.value?.let { controller.engine(it)?.reportScreenshot() }
                controller.toast("طرف مقابل از تلاش برای عکس‌گرفتن خبردار شد", warn = true)
            }
            captureCallback = cb
            runCatching { registerScreenCaptureCallback(mainExecutor, cb) }
        }
        controller.onNetworkBack()
    }

    override fun onStop() {
        super.onStop()
        runCatching { unregisterReceiver(screenOff) }
        if (Build.VERSION.SDK_INT >= 34) {
            (captureCallback as? Activity.ScreenCaptureCallback)?.let { runCatching { unregisterScreenCaptureCallback(it) } }
        }
        if (isChangingConfigurations) return
        controller.scheduleLock()
    }
}
