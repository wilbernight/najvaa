package com.najvaa.app.ui.components

import android.view.inputmethod.EditorInfo
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.najvaa.app.core.fa
import com.najvaa.app.core.spacedCode
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.delay

// ── chrome ─────────────────────────────────────────────────────────────────

/** Full-screen scaffold: gradient background, optional top bar, safe-area aware content. */
@Composable
fun NajvaaScreen(
    title: String? = null,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    leading: @Composable (() -> Unit)? = null,
    bottom: @Composable (() -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = LocalNajvaa.current
    Column(Modifier.fillMaxSize().background(c.bgGradient)) {
        if (title != null || onBack != null || leading != null) {
            TopBar(title = title, subtitle = subtitle, onBack = onBack, leading = leading, actions = actions)
        } else {
            Spacer(Modifier.statusBarsPadding())
        }
        Box(Modifier.weight(1f).fillMaxWidth(), content = content)
        bottom?.let {
            Box(Modifier.navigationBarsPadding()) { it() }
        }
    }
}

@Composable
fun TopBar(
    title: String?,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    leading: @Composable (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = LocalNajvaa.current
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = Space.sm, vertical = Space.sm).heightIn(min = 52.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (onBack != null) RoundIconButton(NajvaaIcons.Back, "بازگشت", onClick = onBack)
        leading?.invoke()
        Column(Modifier.weight(1f).padding(horizontal = Space.sm)) {
            if (title != null) Text(title, style = Type.title, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = Type.caption, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        actions()
    }
}

@Composable
fun RoundIconButton(
    icon: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = LocalNajvaa.current.text,
    container: Color = Color.Transparent,
    size: Dp = 44.dp,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.9f else 1f, spring(stiffness = 600f), label = "press")
    Box(
        modifier
            .size(size)
            .scale(scale)
            .clip(CircleShape)
            .background(container)
            .clickable(interaction, indication = androidx.compose.material3.ripple(bounded = true), enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = if (enabled) tint else LocalNajvaa.current.textDisabled, modifier = Modifier.size(22.dp))
    }
}

// ── buttons ────────────────────────────────────────────────────────────────

@Composable
fun PrimaryButton(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val c = LocalNajvaa.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.97f else 1f, spring(stiffness = 700f), label = "press")
    val haptic = LocalHapticFeedback.current
    val active = enabled && !loading
    Box(
        modifier
            .fillMaxWidth()
            .height(54.dp)
            .scale(scale)
            .then(if (active) Modifier.shadow(14.dp, RoundedCornerShape(Radius.lg), ambientColor = c.glow, spotColor = c.glow) else Modifier)
            .clip(RoundedCornerShape(Radius.lg))
            .background(if (active) c.buttonGradient else SolidColor(c.surface3))
            .clickable(interaction, indication = androidx.compose.material3.ripple(), enabled = active) {
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (loading) {
                Spinner(color = c.onPrimary, size = 18.dp)
                Spacer(Modifier.width(10.dp))
            } else if (icon != null) {
                Icon(icon, null, tint = if (active) c.onPrimary else c.textDisabled, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(text, style = Type.subtitle, color = if (active) c.onPrimary else c.textDisabled)
        }
    }
}

@Composable
fun SoftButton(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val c = LocalNajvaa.current
    val fg = if (danger) c.danger else c.primaryTint
    val bg = if (danger) c.dangerSoft else c.primarySoft
    Row(
        modifier
            .height(48.dp)
            .clip(RoundedCornerShape(Radius.md))
            .background(bg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = fg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = Type.label.copy(fontSize = 14.sp), color = if (enabled) fg else c.textDisabled)
    }
}

@Composable
fun GhostButton(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Row(
        modifier
            .height(46.dp)
            .clip(RoundedCornerShape(Radius.md))
            .border(1.dp, c.outline, RoundedCornerShape(Radius.md))
            .clickable(onClick = onClick)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = c.text2, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = Type.label.copy(fontSize = 14.sp), color = c.text)
    }
}

@Composable
fun Spinner(color: Color = LocalNajvaa.current.primary, size: Dp = 22.dp) {
    androidx.compose.material3.CircularProgressIndicator(color = color, strokeWidth = 2.dp, modifier = Modifier.size(size))
}

// ── inputs ─────────────────────────────────────────────────────────────────

/** Asks the keyboard not to learn from this field (incognito), when the user wants that. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun IncognitoInput(enabled: Boolean, content: @Composable () -> Unit) {
    if (!enabled) {
        content()
        return
    }
    InterceptPlatformTextInput(
        interceptor = { request, next ->
            val wrapped = PlatformTextInputMethodRequest { info ->
                val connection = request.createInputConnection(info)
                info.imeOptions = info.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
                connection
            }
            next.startInputMethod(wrapped)
        },
        content = content,
    )
}

@Composable
fun NajvaaField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String = "",
    leading: ImageVector? = null,
    trailing: @Composable (() -> Unit)? = null,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Done,
    onImeAction: () -> Unit = {},
    visualTransformation: VisualTransformation = VisualTransformation.None,
    singleLine: Boolean = true,
    error: String? = null,
    hint: String? = null,
    textStyle: TextStyle = Type.body,
    enabled: Boolean = true,
    incognito: Boolean = false,
    textDirection: TextDirection = TextDirection.ContentOrRtl,
) {
    val c = LocalNajvaa.current
    var focused by remember { mutableStateOf(false) }
    val border by animateColorAsState(
        when {
            error != null -> c.danger
            focused -> c.primary
            else -> c.outline
        },
        tween(160), label = "border",
    )
    Column(modifier) {
        if (label != null) {
            Text(label, style = Type.label, color = c.text2, modifier = Modifier.padding(bottom = 6.dp, start = 4.dp))
        }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 54.dp)
                .clip(RoundedCornerShape(Radius.md))
                .background(c.surface1)
                .border(1.5.dp, border, RoundedCornerShape(Radius.md))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (leading != null) {
                Icon(leading, null, tint = if (focused) c.primary else c.text3, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(10.dp))
            }
            IncognitoInput(enabled = incognito) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused },
                    textStyle = textStyle.copy(color = c.text, textDirection = textDirection),
                    cursorBrush = SolidColor(c.primary),
                    singleLine = singleLine,
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction, autoCorrectEnabled = !incognito),
                    keyboardActions = KeyboardActions(onAny = { onImeAction() }),
                    visualTransformation = visualTransformation,
                    decorationBox = { inner ->
                        Box {
                            if (value.isEmpty()) Text(placeholder, style = textStyle, color = c.text3)
                            inner()
                        }
                    },
                )
            }
            trailing?.invoke()
        }
        AnimatedVisibility(error != null || hint != null) {
            Text(
                error ?: hint ?: "",
                style = Type.caption,
                color = if (error != null) c.danger else c.text3,
                modifier = Modifier.padding(top = 6.dp, start = 4.dp),
            )
        }
    }
}

@Composable
fun PasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = "رمز",
    placeholder: String = "رمز",
    imeAction: ImeAction = ImeAction.Done,
    onImeAction: () -> Unit = {},
    error: String? = null,
    hint: String? = null,
    strength: Boolean = false,
    incognito: Boolean = true,
) {
    val c = LocalNajvaa.current
    var visible by remember { mutableStateOf(false) }
    Column(modifier) {
        NajvaaField(
            value = value,
            onValueChange = onValueChange,
            label = label,
            placeholder = placeholder,
            leading = NajvaaIcons.Key,
            keyboardType = KeyboardType.Password,
            imeAction = imeAction,
            onImeAction = onImeAction,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation('●'),
            error = error,
            hint = hint,
            incognito = incognito,
            textDirection = TextDirection.Ltr,
            textStyle = Type.body.copy(letterSpacing = if (visible) 0.sp else 2.sp),
            trailing = {
                RoundIconButton(if (visible) NajvaaIcons.EyeOff else NajvaaIcons.Eye, if (visible) "پنهان کردن" else "نمایش", size = 36.dp, tint = c.text3) { visible = !visible }
            },
        )
        if (strength) StrengthMeter(value)
    }
}

fun passwordScore(p: String): Int {
    if (p.isEmpty()) return 0
    var s = 0
    if (p.length >= 8) s++
    if (p.length >= 12) s++
    if (p.any { it.isDigit() } && p.any { it.isLetter() }) s++
    if (p.any { !it.isLetterOrDigit() } || p.any { it.isUpperCase() } && p.any { it.isLowerCase() }) s++
    return s.coerceIn(0, 4)
}

@Composable
fun StrengthMeter(password: String) {
    val c = LocalNajvaa.current
    val score = passwordScore(password)
    val color = when (score) {
        0, 1 -> c.danger
        2 -> c.accent
        3 -> c.primary
        else -> c.success
    }
    val label = when {
        password.isEmpty() -> ""
        score <= 1 -> "ضعیف"
        score == 2 -> "متوسط"
        score == 3 -> "خوب"
        else -> "عالی"
    }
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(4) { i ->
            val on = i < score
            val bar by animateColorAsState(if (on) color else c.surface3, tween(200), label = "bar")
            Box(Modifier.weight(1f).height(4.dp).clip(CircleShape).background(bar))
            if (i < 3) Spacer(Modifier.width(4.dp))
        }
        Spacer(Modifier.width(10.dp))
        Text(label, style = Type.caption, color = color, modifier = Modifier.widthIn(min = 32.dp))
    }
}

/** Seven-digit room code with Persian digits, grouped 3 + 4. */
@Composable
fun CodeField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, error: String? = null, autoFocus: Boolean = false) {
    val c = LocalNajvaa.current
    val focus = remember { FocusRequester() }
    androidx.compose.runtime.LaunchedEffect(autoFocus) { if (autoFocus) focus.requestFocus() }
    Column(modifier) {
        Text("کد اتاق", style = Type.label, color = c.text2, modifier = Modifier.padding(bottom = 6.dp, start = 4.dp))
        Box {
            BasicTextField(
                value = value,
                onValueChange = { raw -> onValueChange(com.najvaa.app.core.latinDigits(raw).filter { it.isDigit() }.take(7)) },
                modifier = Modifier.fillMaxWidth().height(64.dp).alpha(0f).focusRequester(focus),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Next),
            )
            Row(
                Modifier.fillMaxWidth().height(64.dp).clip(RoundedCornerShape(Radius.md)).background(c.surface1)
                    .border(1.5.dp, if (error != null) c.danger else c.outline, RoundedCornerShape(Radius.md))
                    .clickable { focus.requestFocus() },
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.runtime.CompositionLocalProvider(androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Ltr) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        for (i in 0 until 7) {
                            if (i == 3) Spacer(Modifier.width(14.dp))
                            val ch = value.getOrNull(i)
                            val active = i == value.length
                            Box(
                                Modifier.width(30.dp).height(42.dp)
                                    .border(1.5.dp, if (active) c.primary else Color.Transparent, RoundedCornerShape(8.dp)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(if (ch != null) fa(ch.toString()) else "·", style = Type.mono.copy(fontFamily = com.najvaa.app.ui.theme.Vazir, letterSpacing = 0.sp), color = if (ch != null) c.text else c.text3)
                            }
                            if (i != 2 && i != 6) Spacer(Modifier.width(2.dp))
                        }
                    }
                }
            }
        }
        AnimatedVisibility(error != null) {
            Text(error ?: "", style = Type.caption, color = c.danger, modifier = Modifier.padding(top = 6.dp, start = 4.dp))
        }
    }
}

// ── panels and rows ────────────────────────────────────────────────────────

@Composable
fun Panel(modifier: Modifier = Modifier, padding: PaddingValues = PaddingValues(0.dp), content: @Composable ColumnScope.() -> Unit) {
    val c = LocalNajvaa.current
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radius.lg))
            .background(c.surface1)
            .border(1.dp, c.hairline, RoundedCornerShape(Radius.lg))
            .padding(padding),
        content = content,
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, style = Type.label, color = LocalNajvaa.current.text3, modifier = modifier.padding(start = 6.dp, bottom = 8.dp, top = 4.dp))
}

@Composable
fun SettingRow(
    icon: ImageVector,
    title: String,
    subtitle: String? = null,
    iconTint: Color = LocalNajvaa.current.primary,
    danger: Boolean = false,
    trailing: @Composable (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    val c = LocalNajvaa.current
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(if (danger) c.dangerSoft else iconTint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = if (danger) c.danger else iconTint, modifier = Modifier.size(19.dp))
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.body.copy(fontSize = 15.sp), color = if (danger) c.danger else c.text)
            if (subtitle != null) Text(subtitle, style = Type.caption.copy(lineHeight = 17.sp), color = c.text3, modifier = Modifier.padding(top = 2.dp))
        }
        if (trailing != null) {
            Spacer(Modifier.width(8.dp))
            trailing()
        } else if (onClick != null) {
            Icon(NajvaaIcons.Forward, null, tint = c.text3, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
fun SwitchRow(icon: ImageVector, title: String, subtitle: String? = null, checked: Boolean, onChange: (Boolean) -> Unit) {
    val c = LocalNajvaa.current
    SettingRow(icon, title, subtitle, onClick = { onChange(!checked) }, trailing = {
        Switch(
            checked = checked, onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedThumbColor = c.onPrimary, checkedTrackColor = c.primary, uncheckedThumbColor = c.text3, uncheckedTrackColor = c.surface3, uncheckedBorderColor = c.outline),
        )
    })
}

@Composable
fun Divider(modifier: Modifier = Modifier, inset: Dp = 66.dp) {
    Box(modifier.fillMaxWidth().padding(start = inset).height(1.dp).background(LocalNajvaa.current.hairline))
}

@Composable
fun Chip(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, tint: Color = LocalNajvaa.current.primaryTint, bg: Color = LocalNajvaa.current.primarySoft, onClick: (() -> Unit)? = null) {
    Row(
        modifier.clip(CircleShape).background(bg).then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(13.dp))
            Spacer(Modifier.width(5.dp))
        }
        Text(text, style = Type.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = tint)
    }
}

@Composable
fun Badge(count: Int, modifier: Modifier = Modifier) {
    val c = LocalNajvaa.current
    Box(modifier.heightIn(min = 22.dp).widthIn(min = 22.dp).clip(CircleShape).background(c.primary).padding(horizontal = 7.dp), contentAlignment = Alignment.Center) {
        Text(fa(if (count > 99) "99+" else count.toString()), style = Type.caption.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = c.onPrimary)
    }
}

/** A room's identity mark: a hue from the code and its first digits. */
@Composable
fun RoomAvatar(code: String, title: String, size: Dp = 50.dp, online: Boolean = false, modifier: Modifier = Modifier) {
    val c = LocalNajvaa.current
    val hue = remember(code) { (code.hashCode().toUInt() % 360u).toFloat() }
    val a = Color.hsl(hue, 0.55f, if (c.isDark) 0.42f else 0.5f)
    val b = Color.hsl((hue + 40f) % 360f, 0.6f, if (c.isDark) 0.28f else 0.38f)
    val initial = title.trim().firstOrNull { it.isLetterOrDigit() }?.toString() ?: fa(code.take(1))
    Box(modifier.size(size)) {
        Box(
            Modifier.fillMaxSize().clip(RoundedCornerShape(size * 0.34f)).background(Brush.linearGradient(listOf(a, b))),
            contentAlignment = Alignment.Center,
        ) {
            Text(initial, style = Type.title.copy(fontSize = (size.value * 0.4f).sp), color = Color.White.copy(alpha = 0.95f))
        }
        if (online) {
            Box(Modifier.align(Alignment.BottomEnd).size(size * 0.3f).clip(CircleShape).background(c.bg), contentAlignment = Alignment.Center) {
                Box(Modifier.size(size * 0.19f).clip(CircleShape).background(c.success))
            }
        }
    }
}

@Composable
fun CodeDisplay(code: String, modifier: Modifier = Modifier, onCopy: (() -> Unit)? = null) {
    val c = LocalNajvaa.current
    Row(
        modifier.clip(RoundedCornerShape(Radius.md)).background(c.surface2).then(if (onCopy != null) Modifier.clickable(onClick = onCopy) else Modifier).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(fa(spacedCode(code)), style = Type.headline.copy(letterSpacing = 3.sp, textDirection = TextDirection.Ltr), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
        if (onCopy != null) Icon(NajvaaIcons.Copy, "کپی", tint = c.text3, modifier = Modifier.size(20.dp))
    }
}

// ── feedback ───────────────────────────────────────────────────────────────

@Composable
fun BoxScope.ToastHost(toast: com.najvaa.app.Toast?, onDone: () -> Unit) {
    val c = LocalNajvaa.current
    androidx.compose.runtime.LaunchedEffect(toast) {
        if (toast != null) {
            delay(if (toast.warn) 4_200 else 2_600)
            onDone()
        }
    }
    AnimatedVisibility(
        visible = toast != null,
        enter = fadeIn(tween(160)) + slideInVertically(tween(200)) { it / 2 },
        exit = fadeOut(tween(160)) + slideOutVertically(tween(200)) { it / 2 },
        modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(horizontal = 24.dp, vertical = 96.dp),
    ) {
        val t = toast ?: return@AnimatedVisibility
        Row(
            Modifier
                .shadow(18.dp, RoundedCornerShape(Radius.md), ambientColor = Color.Black.copy(alpha = 0.4f), spotColor = Color.Black.copy(alpha = 0.4f))
                .clip(RoundedCornerShape(Radius.md))
                .background(if (c.isDark) c.surface3 else c.text)
                .padding(horizontal = 16.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (t.warn) NajvaaIcons.Warning else NajvaaIcons.Info, null, tint = if (t.warn) c.accent else c.primary, modifier = Modifier.size(17.dp))
            Spacer(Modifier.width(9.dp))
            Text(t.text, style = Type.bodySmall, color = if (c.isDark) c.text else c.bg)
        }
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirm: String,
    danger: Boolean = false,
    dismiss: String = "انصراف",
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = LocalNajvaa.current
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface2,
        titleContentColor = c.text,
        textContentColor = c.text2,
        shape = RoundedCornerShape(Radius.lg),
        title = { Text(title, style = Type.title) },
        text = { Text(text, style = Type.body) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(confirm, style = Type.subtitle, color = if (danger) c.danger else c.primary) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(dismiss, style = Type.subtitle, color = c.text2) } },
    )
}

@Composable
fun EmptyState(icon: ImageVector, title: String, text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    val c = LocalNajvaa.current
    Column(modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(88.dp).clip(RoundedCornerShape(30.dp)).background(c.primarySoft), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = c.primary, modifier = Modifier.size(38.dp))
        }
        Spacer(Modifier.height(18.dp))
        Text(title, style = Type.title, color = c.text, textAlign = TextAlign.Center)
        Spacer(Modifier.height(6.dp))
        Text(text, style = Type.bodySmall, color = c.text2, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.height(20.dp))
            action()
        }
    }
}

@Composable
fun Banner(text: String, icon: ImageVector = NajvaaIcons.Warning, tint: Color = LocalNajvaa.current.accent, modifier: Modifier = Modifier, action: String? = null, onAction: (() -> Unit)? = null) {
    val c = LocalNajvaa.current
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(tint.copy(alpha = 0.14f)).border(1.dp, tint.copy(alpha = 0.3f), RoundedCornerShape(Radius.md)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(text, style = Type.bodySmall, color = c.text, modifier = Modifier.weight(1f))
        if (action != null && onAction != null) {
            Text(action, style = Type.label, color = tint, modifier = Modifier.clickable(onClick = onAction).padding(start = 8.dp))
        }
    }
}

@Composable
fun SheetItem(icon: ImageVector, text: String, danger: Boolean = false, subtitle: String? = null, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.sm)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = if (danger) c.danger else c.text2, modifier = Modifier.size(21.dp))
        Spacer(Modifier.width(14.dp))
        Column {
            Text(text, style = Type.body, color = if (danger) c.danger else c.text)
            if (subtitle != null) Text(subtitle, style = Type.caption, color = c.text3)
        }
    }
}

@Composable
fun SheetHandle() {
    Box(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.width(36.dp).height(4.dp).clip(CircleShape).background(LocalNajvaa.current.outline))
    }
}

@Composable
fun rememberHaptic(): () -> Unit {
    val h = LocalHapticFeedback.current
    return { h.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
}

val SheetShape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)

@Composable
fun sheetBorder(): BorderStroke = BorderStroke(1.dp, LocalNajvaa.current.hairline)

/** The Najva mark ("Nun-bubble") on the site-green tile, same artwork as the launcher icon. */
@Composable
fun NajvaLogo(size: Dp, modifier: Modifier = Modifier) {
    Box(
        modifier.size(size).clip(RoundedCornerShape(size * 0.23f)).background(Color(0xFF4F7F64)),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            androidx.compose.ui.res.painterResource(com.najvaa.app.R.drawable.ic_launcher_foreground), "نجوا",
            modifier = Modifier.size(size * 1.08f),
        )
    }
}
