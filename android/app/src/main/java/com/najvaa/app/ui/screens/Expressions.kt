package com.najvaa.app.ui.screens

import android.content.Context
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.em
import java.io.File
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.najvaa.app.core.latinDigits
import com.najvaa.app.net.Relay
import com.najvaa.app.net.StoreResult
import com.najvaa.app.ui.components.AnimatedImage
import com.najvaa.app.ui.components.AnimatedImageFill
import com.najvaa.app.ui.components.NajvaaField
import com.najvaa.app.ui.components.Spinner
import com.najvaa.app.ui.icons.NajvaaIcons
import com.najvaa.app.ui.theme.LocalNajvaa
import com.najvaa.app.ui.theme.Radius
import com.najvaa.app.ui.theme.Type
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONObject
import java.text.BreakIterator

// ── emoji data (the web client's index, bundled) ──────────────────────────

class EmojiIndex(val groups: List<Pair<String, List<String>>>, private val keywords: Map<String, String>) {
    val all: Set<String> = groups.flatMap { it.second }.map(::bare).toHashSet()

    fun search(q: String): List<String> {
        val terms = fold(q).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (terms.isEmpty()) return emptyList()
        return groups.flatMap { it.second }.filter { g -> val k = keywords[g] ?: return@filter false; terms.all { k.contains(it) } }.take(240)
    }

    companion object {
        @Volatile private var cached: EmojiIndex? = null

        fun bare(g: String): String = g.replace("️", "")
        private fun fold(s: String): String =
            latinDigits(s.lowercase()).replace("‌", "").replace('ي', 'ی').replace('ك', 'ک')

        fun load(context: Context): EmojiIndex = cached ?: synchronized(this) {
            cached ?: runCatching {
                val j = JSONObject(context.assets.open("emoji-index.json").bufferedReader().use { it.readText() })
                val g = j.getJSONArray("g")
                val groups = (0 until g.length()).map { i ->
                    val row = g.getJSONArray(i)
                    val list = row.getJSONArray(1)
                    row.getString(0) to (0 until list.length()).map { list.getString(it) }
                }
                val k = j.optJSONObject("k")
                val kw = HashMap<String, String>()
                if (k != null) for (key in k.keys()) kw[key] = fold(k.optString(key))
                EmojiIndex(groups, kw)
            }.getOrElse { EmojiIndex(emptyList(), emptyMap()) }.also { cached = it }
        }
    }
}

/** 1-3 emoji and nothing else: such messages are shown big and animated, like the web. */
fun bigEmojiOf(text: String, index: EmojiIndex): List<String>? {
    val t = text.trim()
    if (t.isEmpty() || t.length > 40) return null
    val it = BreakIterator.getCharacterInstance()
    it.setText(t)
    val out = ArrayList<String>()
    var start = it.first()
    var end = it.next()
    while (end != BreakIterator.DONE) {
        val g = t.substring(start, end)
        if (g.isNotBlank()) {
            if (EmojiIndex.bare(g) !in index.all) return null
            out += g
            if (out.size > 3) return null
        }
        start = end
        end = it.next()
    }
    return out.takeIf { it.isNotEmpty() }
}

private fun emojiKey(g: String): String = g.codePoints().toArray().map { Integer.toHexString(it) }.filter { it != "fe0f" }.joinToString("-")

/**
 * The web client's emoji artwork. Still images (64 px WebP, the same files the
 * web shows inline) are bundled, so they draw instantly, offline and without
 * telling the relay which emoji are used. Animated ones (for big emoji) are
 * too large to bundle and come from the relay once, then from a disk cache.
 */
object EmojiArt {
    private val still = LruCache<String, ImageBitmap>(900)
    private val missing = HashSet<String>()
    private val animated = LruCache<String, ByteArray>(8 * 1024 * 1024)

    fun cachedStill(g: String): ImageBitmap? = still.get(emojiKey(g))

    suspend fun still(context: Context, g: String): ImageBitmap? {
        val key = emojiKey(g)
        still.get(key)?.let { return it }
        if (synchronized(missing) { key in missing }) return null
        return withContext(Dispatchers.IO) {
            runCatching { context.assets.open("emoji/s/$key.webp").use { BitmapFactory.decodeStream(it) }?.asImageBitmap() }.getOrNull()
        }?.also { still.put(key, it) } ?: run { synchronized(missing) { missing += key }; null }
    }

    fun cachedAnimated(g: String): ByteArray? = synchronized(animated) { animated.get(emojiKey(g)) }

    suspend fun animated(context: Context, g: String): ByteArray? = withContext(Dispatchers.IO) {
        val key = emojiKey(g)
        synchronized(animated) { animated.get(key) }?.let { return@withContext it }
        val dir = File(context.cacheDir, "emoji-a").apply { mkdirs() }
        val f = File(dir, "$key.webp")
        val bytes = if (f.isFile) runCatching { f.readBytes() }.getOrNull() else runCatching {
            val req = Request.Builder().url("${Relay.BASE}/emoji/a/$key.webp").header("User-Agent", "Najvaa-Android/2.0").build()
            Relay.client.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.bytes() else null }
        }.getOrNull()?.takeIf { it.size in 1..1_500_000 }?.also { runCatching { f.writeBytes(it) } }
        bytes?.also { synchronized(animated) { animated.put(key, it) } }
    }
}

/** One emoji drawn with the web's artwork; falls back to the font glyph if there is no image. */
@Composable
fun EmojiImage(glyph: String, size: Dp, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val bmp by produceState(EmojiArt.cachedStill(glyph), glyph) { if (value == null) value = EmojiArt.still(ctx, glyph) }
    val b = bmp
    if (b != null) Image(b, glyph, modifier.size(size), filterQuality = FilterQuality.Medium)
    else Box(modifier.size(size), contentAlignment = Alignment.Center) { Text(glyph, fontSize = (size.value * 0.78f).sp) }
}

/** A big, animated emoji like the web's emoji-only messages; the still image shows until it loads. */
@Composable
fun BigEmoji(glyph: String, size: Int) {
    val ctx = LocalContext.current
    val bytes by produceState(EmojiArt.cachedAnimated(glyph), glyph) { if (value == null) value = EmojiArt.animated(ctx, glyph) }
    val b = bytes
    Box(Modifier.size(size.dp), contentAlignment = Alignment.Center) {
        if (b != null) AnimatedImageFill(bytes = b, placeholder = { EmojiImage(glyph, size.dp) })
        else EmojiImage(glyph, size.dp)
    }
}

/**
 * Message text with every emoji swapped for the web's image, sized to the
 * line. Returns null when the text has no emoji, so plain text stays plain.
 */
fun emojiText(text: String, index: EmojiIndex?): Pair<AnnotatedString, Map<String, InlineTextContent>>? {
    if (index == null || text.none { it.isSurrogate() || it.code in 0x2100..0x2BFF || it.code in 0x3030..0x303D || it.code == 0x00A9 || it.code == 0x00AE }) return null
    val it = BreakIterator.getCharacterInstance()
    it.setText(text)
    val keys = LinkedHashSet<String>()
    var found = false
    val out = buildAnnotatedString {
        var start = it.first()
        var end = it.next()
        while (end != BreakIterator.DONE) {
            val g = text.substring(start, end)
            if (EmojiIndex.bare(g) in index.all) {
                found = true
                keys += g
                appendInlineContent("e:$g", g)
            } else append(g)
            start = end
            end = it.next()
        }
    }
    if (!found) return null
    val inline = keys.associate { g ->
        "e:$g" to InlineTextContent(Placeholder(1.3.em, 1.3.em, PlaceholderVerticalAlign.TextCenter)) { EmojiImage(g, 22.dp, Modifier.fillMaxSize()) }
    }
    return out to inline
}

// ── the expressions sheet: emoji | GIF ────────────────────────────────────

@Composable
fun ExpressionsSheet(initialGif: Boolean, gifEnabled: Boolean, onEmoji: (String) -> Unit, onGif: (String, ByteArray) -> Unit) {
    val c = LocalNajvaa.current
    var gif by remember { mutableStateOf(initialGif && gifEnabled) }
    Column(Modifier.fillMaxWidth().height(460.dp)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TabPill("ایموجی", !gif, Modifier.weight(1f)) { gif = false }
            if (gifEnabled) TabPill("گیف", gif, Modifier.weight(1f)) { gif = true }
        }
        Spacer(Modifier.height(6.dp))
        if (gif) GifPicker(onGif) else EmojiPicker(onEmoji)
    }
}

@Composable
private fun TabPill(text: String, on: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalNajvaa.current
    Box(
        modifier.clip(CircleShape).background(if (on) c.primary else c.surface3).clickable(onClick = onClick).padding(vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.label, color = if (on) c.onPrimary else c.text2) }
}

@Composable
private fun EmojiPicker(onEmoji: (String) -> Unit) {
    val c = LocalNajvaa.current
    val ctx = LocalContext.current
    val index by produceState<EmojiIndex?>(null) { value = withContext(Dispatchers.IO) { EmojiIndex.load(ctx) } }
    var query by remember { mutableStateOf("") }
    var group by remember { mutableStateOf(0) }
    val idx = index
    Column(Modifier.fillMaxSize()) {
        NajvaaField(query, { query = it.take(40) }, placeholder = "جستجوی ایموجی (فارسی یا انگلیسی)", leading = NajvaaIcons.Search, modifier = Modifier.padding(horizontal = 16.dp), incognito = true)
        if (idx == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Spinner() }
            return@Column
        }
        if (query.isBlank()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                idx.groups.forEachIndexed { i, (_, list) ->
                    Box(
                        Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)).background(if (i == group) c.primarySoft else c.surface2).clickable { group = i },
                        contentAlignment = Alignment.Center,
                    ) { list.firstOrNull()?.let { EmojiImage(it, 24.dp) } }
                }
            }
        }
        val list = if (query.isBlank()) idx.groups.getOrNull(group)?.second.orEmpty() else idx.search(query)
        if (list.isEmpty()) {
            Text("ایموجی‌ای پیدا نشد", style = Type.bodySmall, color = c.text3, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(24.dp))
        }
        LazyVerticalGrid(GridCells.Adaptive(46.dp), Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
            items(list, key = { it }) { e ->
                Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(12.dp)).clickable { onEmoji(e) }, contentAlignment = Alignment.Center) {
                    EmojiImage(e, 32.dp)
                }
            }
        }
    }
}

private val GIF_TOPICS = listOf(
    "❤️ عاشقانه" to "love", "😂 خنده" to "laugh", "😘 بوس" to "kiss", "🤗 بغل" to "hug", "😢 ناراحت" to "sad",
    "😍 دلتنگ" to "miss you", "👋 سلام" to "hello", "🙏 ممنون" to "thank you", "🎂 تولد" to "happy birthday", "😴 شب بخیر" to "good night",
)

@Composable
private fun GifPicker(onGif: (String, ByteArray) -> Unit) {
    val c = LocalNajvaa.current
    val scope = rememberCoroutineScope()
    var input by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("love") }
    var page by remember { mutableStateOf(0) }
    var more by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val items = remember { mutableStateListOf<Relay.GifItem>() }
    val previews = remember { mutableStateMapOf<String, Pair<String, ByteArray>>() }
    val gate = remember { Semaphore(6) }
    val grid = rememberLazyGridState()
    var seq by remember { mutableStateOf(0) }

    suspend fun load(q: String, p: Int, s: Int) {
        loading = true
        val r = Relay.gifSearch(q, p)
        if (s != seq) return
        loading = false
        when (r) {
            is StoreResult.Ok -> {
                val seen = items.map { it.send }.toHashSet()
                items.addAll(r.value.items.filter { it.send !in seen })
                more = r.value.more
                page = p
                if (items.isEmpty()) error = "چیزی پیدا نشد"
            }
            is StoreResult.Http -> error = if (r.code == 429) "سقف جستجوی این ساعت پر شده؛ کمی بعد دوباره امتحان کنید" else if (r.code == 503) "جستجوی گیف روی سرور خاموش است" else "جستجو انجام نشد"
            else -> error = "اتصال برقرار نیست"
        }
    }

    LaunchedEffect(query) {
        val s = ++seq
        items.clear(); previews.clear(); error = null; more = false; page = 0
        load(query, 0, s)
    }
    LaunchedEffect(grid, query) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.distinctUntilChanged().collect { last ->
            if (more && !loading && last >= items.size - 6) load(query, page + 1, seq)
        }
    }

    Column(Modifier.fillMaxSize()) {
        NajvaaField(
            input, { input = it.take(50) }, placeholder = "جستجوی گیف (انگلیسی بهتر جواب می‌دهد)", leading = NajvaaIcons.Search,
            modifier = Modifier.padding(horizontal = 16.dp), incognito = true,
            onImeAction = { if (input.isNotBlank()) query = input.trim() },
            trailing = if (input.isBlank()) null else ({ Text("جستجو", style = Type.label, color = c.primary, modifier = Modifier.clip(RoundedCornerShape(Radius.sm)).clickable { query = input.trim() }.padding(10.dp)) }),
        )
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            GIF_TOPICS.forEach { (label, q) ->
                val on = query == q
                Text(
                    label, style = Type.label, color = if (on) c.onPrimary else c.text,
                    modifier = Modifier.clip(CircleShape).background(if (on) c.primary else c.surface3).clickable { input = ""; query = q }.padding(horizontal = 12.dp, vertical = 7.dp),
                )
            }
        }
        Box(Modifier.fillMaxSize()) {
            if (items.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (loading) Spinner() else Text(error ?: "", style = Type.bodySmall, color = c.text3, textAlign = TextAlign.Center, modifier = Modifier.padding(24.dp))
                }
            }
            LazyVerticalGrid(GridCells.Fixed(3), state = grid, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)) {
                items(items, key = { it.send }) { it ->
                    val p = previews[it.send]
                    LaunchedEffect(it.send) {
                        if (previews[it.send] == null) gate.withPermit { Relay.gifBytes(it.send)?.let { b -> previews[it.send] = b } }
                    }
                    Box(
                        Modifier.padding(3.dp).aspectRatio(1f).clip(RoundedCornerShape(Radius.sm)).background(c.surface3)
                            .clickable(enabled = p != null) { p?.let { (type, bytes) -> onGif(type, bytes) } },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (p != null) AnimatedImageFill(bytes = p.second, placeholder = { Spinner(size = 16.dp) }) else Spinner(size = 16.dp)
                    }
                }
                if (more) item(span = { GridItemSpan(maxLineSpan) }) {
                    Box(Modifier.fillMaxWidth().padding(14.dp), contentAlignment = Alignment.Center) { Spinner(size = 18.dp) }
                }
            }
        }
    }
}
