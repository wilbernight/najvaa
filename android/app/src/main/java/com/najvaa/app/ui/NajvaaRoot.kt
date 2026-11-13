package com.najvaa.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.najvaa.app.AppController
import com.najvaa.app.MainActivity
import com.najvaa.app.Toast
import com.najvaa.app.ui.components.ToastHost
import com.najvaa.app.ui.screens.ChatScreen
import com.najvaa.app.ui.screens.CreateRoomScreen
import com.najvaa.app.ui.screens.HomeScreen
import com.najvaa.app.ui.screens.JoinRoomScreen
import com.najvaa.app.ui.screens.LockScreen
import com.najvaa.app.ui.screens.ManageScreen
import com.najvaa.app.ui.screens.OnboardingScreen
import com.najvaa.app.ui.screens.RoomInfoScreen
import com.najvaa.app.ui.screens.SettingsScreen
import com.najvaa.app.ui.screens.SetupScreen
import com.najvaa.app.ui.screens.SoundScreen
import com.najvaa.app.ui.theme.LocalNajvaa

sealed interface Screen {
    data object Onboarding : Screen
    data object Setup : Screen
    data object Lock : Screen
    data object Home : Screen
    data object Create : Screen
    data object Join : Screen
    data class Chat(val roomId: String, val focus: String? = null) : Screen
    data class Manage(val roomId: String) : Screen
    data class RoomInfo(val roomId: String) : Screen
    data object Settings : Screen
    data object Sound : Screen
}

class Nav(initial: Screen) {
    val stack = mutableStateListOf(initial)
    var forward by mutableStateOf(true)
    val current: Screen get() = stack.last()

    fun push(s: Screen) {
        forward = true
        stack.add(s)
    }

    fun pop() {
        if (stack.size > 1) {
            forward = false
            stack.removeAt(stack.lastIndex)
        }
    }

    fun reset(s: Screen) {
        forward = false
        stack.clear()
        stack.add(s)
    }

    fun openChat(roomId: String, focus: String? = null) {
        forward = true
        stack.clear()
        stack.add(Screen.Home)
        stack.add(Screen.Chat(roomId, focus))
    }
}

@Composable
fun NajvaaRoot(controller: AppController, activity: MainActivity) {
    val c = LocalNajvaa.current
    val locked by controller.locked.collectAsState()
    val pendingOpen by controller.pendingOpen.collectAsState()
    val nav = remember {
        Nav(
            when {
                !controller.isSetUp -> if (controller.onboarded) Screen.Setup else Screen.Onboarding
                else -> Screen.Lock
            },
        )
    }
    var toast by remember { mutableStateOf<Toast?>(null) }

    LaunchedEffect(Unit) { controller.toasts.collect { toast = it } }

    LaunchedEffect(locked) {
        if (locked && controller.isSetUp && nav.current != Screen.Lock && nav.current != Screen.Setup && nav.current != Screen.Onboarding) {
            nav.reset(Screen.Lock)
        }
    }

    LaunchedEffect(pendingOpen, locked) {
        val id = pendingOpen ?: return@LaunchedEffect
        if (!locked && controller.room(id) != null) nav.openChat(id)
    }

    LaunchedEffect(nav.current) {
        val s = nav.current
        if (s is Screen.Chat) controller.openRoom(s.roomId) else if (s !is Screen.RoomInfo && s !is Screen.Manage) controller.closeRoom()
    }

    BackHandler(enabled = nav.stack.size > 1) { nav.pop() }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        AnimatedContent(
            targetState = nav.current,
            transitionSpec = {
                val forward = nav.forward
                if (targetState is Screen.Lock || initialState is Screen.Lock) {
                    fadeIn(tween(220)) togetherWith fadeOut(tween(160))
                } else if (forward) {
                    (slideInHorizontally(tween(260)) { -it / 5 } + fadeIn(tween(220))) togetherWith (slideOutHorizontally(tween(260)) { it / 5 } + fadeOut(tween(180)))
                } else {
                    (slideInHorizontally(tween(260)) { it / 5 } + fadeIn(tween(220))) togetherWith (slideOutHorizontally(tween(260)) { -it / 5 } + fadeOut(tween(180)))
                }
            },
            label = "screen",
        ) { screen ->
            when (screen) {
                Screen.Onboarding -> OnboardingScreen(onDone = { controller.finishOnboarding(); nav.reset(Screen.Setup) })
                Screen.Setup -> SetupScreen(controller, activity, onDone = { nav.reset(Screen.Home) })
                Screen.Lock -> LockScreen(controller, activity, onUnlocked = { nav.reset(Screen.Home) }, onWiped = { nav.reset(Screen.Onboarding) })
                Screen.Home -> HomeScreen(
                    controller, activity,
                    onOpen = { nav.push(Screen.Chat(it)) },
                    onCreate = { nav.push(Screen.Create) },
                    onJoin = { nav.push(Screen.Join) },
                    onSettings = { nav.push(Screen.Settings) },
                    onInfo = { nav.push(Screen.RoomInfo(it)) },
                )
                Screen.Create -> CreateRoomScreen(controller, onBack = { nav.pop() }, onOpen = { nav.openChat(it) })
                Screen.Join -> JoinRoomScreen(controller, onBack = { nav.pop() }, onOpen = { nav.openChat(it) })
                is Screen.Chat -> ChatScreen(
                    controller, activity, screen.roomId, onBack = { nav.pop() }, onInfo = { nav.push(Screen.RoomInfo(screen.roomId)) },
                    focus = screen.focus, onManage = { nav.push(Screen.Manage(screen.roomId)) },
                )
                is Screen.RoomInfo -> RoomInfoScreen(controller, screen.roomId, onBack = { nav.pop() }, onDeleted = { nav.reset(Screen.Home) }, onManage = { nav.push(Screen.Manage(screen.roomId)) })
                is Screen.Manage -> ManageScreen(controller, screen.roomId, onBack = { nav.pop() }, onOpenMessage = { id -> nav.openChat(screen.roomId, id) })
                Screen.Settings -> SettingsScreen(controller, activity, onBack = { nav.pop() }, onSound = { nav.push(Screen.Sound) }, onWiped = { nav.reset(Screen.Onboarding) })
                Screen.Sound -> SoundScreen(controller, activity, onBack = { nav.pop() })
            }
        }
        ToastHost(toast) { toast = null }
    }
}
