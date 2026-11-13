package com.najvaa.app.ui.screens

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.najvaa.app.ui.components.GhostButton
import com.najvaa.app.ui.components.PrimaryButton
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Space
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.launch

private data class Page(val icon: ImageVector, val title: String, val text: String)

private val pages = listOf(
    Page(NajvaaIcons.Chat, "نجوا؛ گفتگوی دونفره، بی‌واسطه", "بدون شماره، ایمیل یا حساب کاربری. یک کد هفت‌رقمی و یک رمز، همه‌ی چیزی است که لازم دارید."),
    Page(NajvaaIcons.Shield, "رمزنگاری سرتاسری، روی خود گوشی", "کلیدها فقط از رمز اتاق و فقط روی دستگاه‌ها ساخته می‌شوند. سرور تنها نسخه‌ی رمزشده را جابه‌جا می‌کند."),
    Page(NajvaaIcons.Lock, "هر اتاق، گاوصندوق خودش", "هر اتاق در فایلی جدا و با رمز خودش ذخیره می‌شود. رمز برنامه بدون رمز اتاق، هیچ پیامی را باز نمی‌کند."),
)

@Composable
fun OnboardingScreen(onDone: () -> Unit) {
    val c = LocalNajvaa.current
    val pager = rememberPagerState { pages.size }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().background(c.bgGradient).statusBarsPadding().navigationBarsPadding()) {
        Box(Modifier.fillMaxWidth().padding(top = 24.dp), contentAlignment = Alignment.Center) { Hero() }
        HorizontalPager(pager, modifier = Modifier.weight(1f)) { i ->
            val p = pages[i]
            Column(Modifier.fillMaxSize().padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                if (i == 0) com.najvaa.app.ui.components.NajvaLogo(64.dp)
                else Box(Modifier.size(64.dp).clip(RoundedCornerShape(22.dp)).background(c.primarySoft), contentAlignment = Alignment.Center) {
                    Icon(p.icon, null, tint = c.primary, modifier = Modifier.size(30.dp))
                }
                Spacer(Modifier.height(22.dp))
                Text(p.title, style = Type.headline, color = c.text, textAlign = TextAlign.Center)
                Spacer(Modifier.height(10.dp))
                Text(p.text, style = Type.body, color = c.text2, textAlign = TextAlign.Center)
            }
        }
        Row(Modifier.fillMaxWidth().padding(bottom = 22.dp), horizontalArrangement = Arrangement.Center) {
            repeat(pages.size) { i ->
                val active = pager.currentPage == i
                val w by animateDpAsState(if (active) 22.dp else 7.dp, tween(220), label = "dot")
                val col by animateColorAsState(if (active) c.primary else c.outline, tween(220), label = "dotc")
                Box(Modifier.padding(horizontal = 3.dp).height(7.dp).width(w).clip(CircleShape).background(col))
            }
        }
        Column(Modifier.padding(horizontal = Space.gutter).padding(bottom = 16.dp)) {
            if (pager.currentPage < pages.lastIndex) {
                PrimaryButton("ادامه", icon = NajvaaIcons.Forward) { scope.launch { pager.animateScrollToPage(pager.currentPage + 1) } }
                Spacer(Modifier.height(10.dp))
                GhostButton("رد کردن", modifier = Modifier.fillMaxWidth(), onClick = onDone)
            } else {
                PrimaryButton("شروع", icon = NajvaaIcons.Sparkle, onClick = onDone)
                Spacer(Modifier.height(56.dp))
            }
        }
    }
}

/** Two whispering bubbles, drawn rather than imported, in the brand gradient. */
@Composable
private fun Hero() {
    val c = LocalNajvaa.current
    Canvas(Modifier.size(220.dp, 170.dp)) {
        val w = size.width
        val h = size.height
        drawCircle(Brush.radialGradient(listOf(c.glow, c.glow.copy(alpha = 0f))), radius = w * 0.45f, center = Offset(w * 0.5f, h * 0.5f))
        val big = Path().apply {
            addRoundRect(androidx.compose.ui.geometry.RoundRect(w * 0.12f, h * 0.18f, w * 0.68f, h * 0.62f, androidx.compose.ui.geometry.CornerRadius(h * 0.2f)))
            moveTo(w * 0.22f, h * 0.6f); lineTo(w * 0.16f, h * 0.76f); lineTo(w * 0.34f, h * 0.62f); close()
        }
        drawPath(big, Brush.linearGradient(listOf(c.primaryStrong, c.primary)))
        val small = Path().apply {
            addRoundRect(androidx.compose.ui.geometry.RoundRect(w * 0.5f, h * 0.5f, w * 0.9f, h * 0.84f, androidx.compose.ui.geometry.CornerRadius(h * 0.16f)))
            moveTo(w * 0.82f, h * 0.83f); lineTo(w * 0.88f, h * 0.95f); lineTo(w * 0.72f, h * 0.84f); close()
        }
        drawPath(small, c.accent)
        val stroke = Stroke(width = 5f, cap = StrokeCap.Round)
        for (i in 0 until 3) {
            val y = h * (0.3f + i * 0.09f)
            drawLine(c.onPrimary.copy(alpha = 0.7f), Offset(w * 0.22f, y), Offset(w * (0.58f - i * 0.08f), y), strokeWidth = stroke.width, cap = stroke.cap)
        }
        drawCircle(c.onAccent.copy(alpha = 0.7f), radius = 5f, center = Offset(w * 0.62f, h * 0.67f))
        drawCircle(c.onAccent.copy(alpha = 0.7f), radius = 5f, center = Offset(w * 0.7f, h * 0.67f))
        drawCircle(c.onAccent.copy(alpha = 0.7f), radius = 5f, center = Offset(w * 0.78f, h * 0.67f))
    }
}
