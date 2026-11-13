package com.najvaa.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.najvaa.app.R
import com.najvaa.app.data.AppTheme

/**
 * Najvaa's own identity: Persian turquoise ("firouzeh") and saffron on a deep
 * midnight navy. Deliberately not the web app's moss green. Every color is a
 * token; nothing in a screen names a hex value.
 */
@Immutable
data class NajvaaColors(
    val isDark: Boolean,
    val bg: Color,
    val bgElevated: Color,
    val surface1: Color,
    val surface2: Color,
    val surface3: Color,
    val surface4: Color,
    val primary: Color,
    val primaryStrong: Color,
    val primaryTint: Color,
    val primarySoft: Color,
    val onPrimary: Color,
    val accent: Color,
    val accentSoft: Color,
    val onAccent: Color,
    val text: Color,
    val text2: Color,
    val text3: Color,
    val textDisabled: Color,
    val hairline: Color,
    val outline: Color,
    val danger: Color,
    val dangerSoft: Color,
    val success: Color,
    val info: Color,
    val bubbleMe: Color,
    val bubbleMeText: Color,
    val bubblePeer: Color,
    val bubblePeerText: Color,
    val scrim: Color,
    val glow: Color,
) {
    val heroGradient: Brush
        get() = Brush.linearGradient(listOf(primaryStrong, primary, accent.copy(alpha = 0.85f)))
    val buttonGradient: Brush
        get() = Brush.horizontalGradient(listOf(primaryStrong, primary))
    val bgGradient: Brush
        get() = Brush.verticalGradient(listOf(bgElevated, bg))
}

val DarkColors = NajvaaColors(
    isDark = true,
    bg = Color(0xFF0A0E14),
    bgElevated = Color(0xFF0F1620),
    surface1 = Color(0xFF121A25),
    surface2 = Color(0xFF192331),
    surface3 = Color(0xFF212D3D),
    surface4 = Color(0xFF2A384A),
    primary = Color(0xFF3FC1B0),
    primaryStrong = Color(0xFF239C8E),
    primaryTint = Color(0xFFB9F0E7),
    primarySoft = Color(0x243FC1B0),
    onPrimary = Color(0xFF06211E),
    accent = Color(0xFFF4B860),
    accentSoft = Color(0x24F4B860),
    onAccent = Color(0xFF2A1B00),
    text = Color(0xFFEEF2F6),
    text2 = Color(0xFFB1BBC8),
    text3 = Color(0xFF7D8898),
    textDisabled = Color(0xFF4A5565),
    hairline = Color(0x14FFFFFF),
    outline = Color(0x22FFFFFF),
    danger = Color(0xFFF2706C),
    dangerSoft = Color(0x26F2706C),
    success = Color(0xFF5BD08B),
    info = Color(0xFF7FB2FF),
    bubbleMe = Color(0xFF1B5F5A),
    bubbleMeText = Color(0xFFEAFFFB),
    bubblePeer = Color(0xFF1A2432),
    bubblePeerText = Color(0xFFEEF2F6),
    scrim = Color(0xB3000000),
    glow = Color(0x333FC1B0),
)

val LightColors = NajvaaColors(
    isDark = false,
    bg = Color(0xFFF4F6F9),
    bgElevated = Color(0xFFFFFFFF),
    surface1 = Color(0xFFFFFFFF),
    surface2 = Color(0xFFEEF2F6),
    surface3 = Color(0xFFE3E9F0),
    surface4 = Color(0xFFD6DEE8),
    primary = Color(0xFF178F82),
    primaryStrong = Color(0xFF0F6F65),
    primaryTint = Color(0xFF0E4F49),
    primarySoft = Color(0x1F178F82),
    onPrimary = Color(0xFFFFFFFF),
    accent = Color(0xFFD9922B),
    accentSoft = Color(0x24D9922B),
    onAccent = Color(0xFFFFFFFF),
    text = Color(0xFF121821),
    text2 = Color(0xFF4A5563),
    text3 = Color(0xFF7C8797),
    textDisabled = Color(0xFFB5BDC8),
    hairline = Color(0x12000000),
    outline = Color(0x1F000000),
    danger = Color(0xFFD64545),
    dangerSoft = Color(0x1FD64545),
    success = Color(0xFF2E9E5B),
    info = Color(0xFF2F6FD6),
    bubbleMe = Color(0xFFD3F2EC),
    bubbleMeText = Color(0xFF0E3B36),
    bubblePeer = Color(0xFFFFFFFF),
    bubblePeerText = Color(0xFF121821),
    scrim = Color(0x80000000),
    glow = Color(0x26178F82),
)

val LocalNajvaa = staticCompositionLocalOf { DarkColors }

val Vazir = FontFamily(
    Font(R.font.vazirmatn_regular, FontWeight.Normal),
    Font(R.font.vazirmatn_medium, FontWeight.Medium),
    Font(R.font.vazirmatn_semibold, FontWeight.SemiBold),
    Font(R.font.vazirmatn_bold, FontWeight.Bold),
    Font(R.font.vazirmatn_extrabold, FontWeight.ExtraBold),
)

object Type {
    val display = TextStyle(fontFamily = Vazir, fontSize = 30.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold)
    val headline = TextStyle(fontFamily = Vazir, fontSize = 22.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold)
    val title = TextStyle(fontFamily = Vazir, fontSize = 17.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold)
    val subtitle = TextStyle(fontFamily = Vazir, fontSize = 15.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    val body = TextStyle(fontFamily = Vazir, fontSize = 15.sp, lineHeight = 25.sp)
    val bodySmall = TextStyle(fontFamily = Vazir, fontSize = 13.5.sp, lineHeight = 21.sp)
    val label = TextStyle(fontFamily = Vazir, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium)
    val caption = TextStyle(fontFamily = Vazir, fontSize = 11.5.sp, lineHeight = 16.sp)
    val mono = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 22.sp, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
}

object Radius {
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 22.dp
    val xl = 28.dp
}

object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
    val gutter = 20.dp
}

private fun typography(c: NajvaaColors) = Typography(
    displayLarge = Type.display.copy(color = c.text),
    headlineMedium = Type.headline.copy(color = c.text),
    titleLarge = Type.title.copy(color = c.text),
    titleMedium = Type.subtitle.copy(color = c.text),
    bodyLarge = Type.body.copy(color = c.text),
    bodyMedium = Type.bodySmall.copy(color = c.text2),
    labelLarge = Type.label.copy(color = c.text),
    labelSmall = Type.caption.copy(color = c.text3),
)

@Composable
fun NajvaaTheme(theme: AppTheme, fontScale: Float = 1f, content: @Composable () -> Unit) {
    val dark = when (theme) {
        AppTheme.SYSTEM -> isSystemInDarkTheme()
        AppTheme.DARK -> true
        AppTheme.LIGHT -> false
    }
    val c = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = c.primary, onPrimary = c.onPrimary, primaryContainer = c.primarySoft, onPrimaryContainer = c.primaryTint,
            secondary = c.accent, onSecondary = c.onAccent, background = c.bg, onBackground = c.text,
            surface = c.surface1, onSurface = c.text, surfaceVariant = c.surface2, onSurfaceVariant = c.text2,
            surfaceContainer = c.surface2, surfaceContainerHigh = c.surface3, surfaceContainerHighest = c.surface4,
            outline = c.outline, outlineVariant = c.hairline, error = c.danger, onError = Color.White, scrim = Color.Black,
        )
    } else {
        lightColorScheme(
            primary = c.primary, onPrimary = c.onPrimary, primaryContainer = c.primarySoft, onPrimaryContainer = c.primaryTint,
            secondary = c.accent, onSecondary = c.onAccent, background = c.bg, onBackground = c.text,
            surface = c.surface1, onSurface = c.text, surfaceVariant = c.surface2, onSurfaceVariant = c.text2,
            surfaceContainer = c.surface2, surfaceContainerHigh = c.surface3, surfaceContainerHighest = c.surface4,
            outline = c.outline, outlineVariant = c.hairline, error = c.danger, onError = Color.White, scrim = Color.Black,
        )
    }
    val base = LocalDensity.current
    CompositionLocalProvider(
        LocalNajvaa provides c,
        LocalLayoutDirection provides LayoutDirection.Rtl,
        LocalDensity provides Density(base.density, base.fontScale * fontScale),
    ) {
        MaterialTheme(
            colorScheme = scheme,
            typography = typography(c),
            shapes = Shapes(
                extraSmall = RoundedCornerShape(Radius.xs), small = RoundedCornerShape(Radius.sm), medium = RoundedCornerShape(Radius.md),
                large = RoundedCornerShape(Radius.lg), extraLarge = RoundedCornerShape(Radius.xl),
            ),
        ) {
            CompositionLocalProvider(
                LocalTextStyle provides Type.body.copy(color = c.text, textDirection = TextDirection.ContentOrRtl),
                content = content,
            )
        }
    }
}
