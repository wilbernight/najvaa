package com.najvaa.app.net

import com.najvaa.app.crypto.RoomKeys
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.ConnectionSpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import android.util.Log
import com.najvaa.app.BuildConfig
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class StoreEntry(val id: String, val ts: Long, val exp: Long, val blob: Boolean, val iv: String, val ct: String)

sealed interface StoreResult<out T> {
    data class Ok<T>(val value: T) : StoreResult<T>
    data object Claimed : StoreResult<Nothing>
    data object Offline : StoreResult<Nothing>
    data class Http(val code: Int) : StoreResult<Nothing>
}

data class LogPage(val items: List<StoreEntry>, val more: Boolean, val serverTime: Long)

/**
 * The relay's HTTP store (encrypted history and file chunks) and its
 * WebSocket. Requests carry only the password-derived room id and token; the
 * server never sees a key or a plaintext byte.
 */
object Relay {
    private const val TAG = "Najvaa/Relay"
    const val HOST = "najvaa.xyz"
    const val BASE = "https://$HOST"
    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val OCTET = "application/octet-stream".toMediaType()

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectionSpecs(listOf(ConnectionSpec.RESTRICTED_TLS, ConnectionSpec.MODERN_TLS))
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(90, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .followRedirects(false)
            .build()
    }

    private fun request(keys: RoomKeys, path: String): Request.Builder {
        if (BuildConfig.DEBUG) Log.d(TAG, "store $path room=${keys.roomId}")
        return Request.Builder()
            .url(BASE + path)
            .header("Origin", BASE)
            .header("X-Room", keys.roomId)
            .header("X-Room-Auth", keys.storeAuth)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .header("User-Agent", "Najvaa-Android/2.0")
    }

    private inline fun <T> call(block: () -> StoreResult<T>): StoreResult<T> = try {
        block().also { if (BuildConfig.DEBUG && it !is StoreResult.Ok) Log.d(TAG, "store result $it") }
    } catch (e: IOException) {
        if (BuildConfig.DEBUG) Log.d(TAG, "store offline $e")
        StoreResult.Offline
    } catch (e: Exception) {
        if (BuildConfig.DEBUG) Log.d(TAG, "store error $e")
        StoreResult.Offline
    }

    private fun claimedOrHttp(code: Int, body: String?): StoreResult<Nothing> {
        if (code == 403) {
            val claimed = runCatching { JSONObject(body ?: "").optBoolean("claimed") }.getOrDefault(false)
            if (claimed) return StoreResult.Claimed
        }
        return StoreResult.Http(code)
    }

    suspend fun log(keys: RoomKeys, after: Long? = null, before: Long? = null, limit: Int = 500): StoreResult<LogPage> =
        withContext(Dispatchers.IO) {
            call {
                val q = buildString {
                    append("/h/log?limit=").append(limit.coerceIn(1, 1000))
                    if (after != null && after > 0) append("&after=").append(after)
                    if (before != null && before > 0) append("&before=").append(before)
                }
                client.newCall(request(keys, q).get().build()).execute().use { r ->
                    val body = r.body?.string()
                    if (r.code != 200) return@call claimedOrHttp(r.code, body)
                    val root = JSONObject(body ?: "{}")
                    val arr = root.optJSONArray("items") ?: JSONArray()
                    val items = ArrayList<StoreEntry>(arr.length())
                    for (i in 0 until arr.length()) {
                        val it = arr.optJSONObject(i) ?: continue
                        val id = it.optString("id")
                        val iv = it.optString("iv")
                        val ct = it.optString("ct")
                        if (id.isEmpty() || iv.isEmpty() || ct.isEmpty()) continue
                        items += StoreEntry(id, it.optLong("ts"), it.optLong("exp"), it.optBoolean("blob") || it.optInt("blob") == 1, iv, ct)
                    }
                    val date = r.headers.getDate("Date")?.time ?: System.currentTimeMillis()
                    StoreResult.Ok(LogPage(items, root.optBoolean("more"), date))
                }
            }
        }

    suspend fun post(keys: RoomKeys, id: String, iv: String, ct: String, blob: Boolean = false, exp: Long = 0, at: Long = 0): StoreResult<Long> =
        withContext(Dispatchers.IO) {
            call {
                val body = JSONObject().put("id", id).put("iv", iv).put("ct", ct).put("blob", if (blob) 1 else 0).put("exp", exp)
                if (at > 0) body.put("at", at)
                client.newCall(request(keys, "/h/log").post(body.toString().toRequestBody(JSON)).build()).execute().use { r ->
                    val text = r.body?.string()
                    if (r.code != 200) return@call claimedOrHttp(r.code, text)
                    val ts = runCatching { JSONObject(text ?: "").optLong("ts") }.getOrDefault(0L)
                    if (ts <= 0) StoreResult.Http(r.code) else StoreResult.Ok(ts)
                }
            }
        }

    suspend fun putChunk(keys: RoomKeys, id: String, index: Int, ct: ByteArray): StoreResult<Unit> = withContext(Dispatchers.IO) {
        call {
            client.newCall(request(keys, "/h/blob/$id/$index").put(ct.toRequestBody(OCTET)).build()).execute().use { r ->
                if (r.code != 200) claimedOrHttp(r.code, r.body?.string()) else StoreResult.Ok(Unit)
            }
        }
    }

    suspend fun getChunk(keys: RoomKeys, id: String, index: Int): StoreResult<ByteArray> = withContext(Dispatchers.IO) {
        call {
            client.newCall(request(keys, "/h/blob/$id/$index").get().build()).execute().use { r ->
                if (r.code != 200) return@call claimedOrHttp(r.code, null)
                StoreResult.Ok(r.body?.bytes() ?: ByteArray(0))
            }
        }
    }

    suspend fun delete(keys: RoomKeys, ids: List<String>): StoreResult<Unit> = simplePost(keys, "/h/del", JSONObject().put("ids", JSONArray(ids)))

    suspend fun expire(keys: RoomKeys, ids: List<String>, exp: Long): StoreResult<Unit> =
        simplePost(keys, "/h/exp", JSONObject().put("ids", JSONArray(ids)).put("exp", exp))

    suspend fun clear(keys: RoomKeys): StoreResult<Unit> = simplePost(keys, "/h/clear", JSONObject())

    // ── GIF search (the relay proxies Giphy/Tenor so the phone never talks to them) ──
    data class GifItem(val thumb: String, val send: String)
    data class GifPage(val items: List<GifItem>, val more: Boolean)

    /** One page of the relay's GIF search; HTTP 429 means the hourly budget is spent. */
    suspend fun gifSearch(q: String, page: Int): StoreResult<GifPage> = withContext(Dispatchers.IO) {
        call {
            val body = JSONObject().put("q", q.trim().take(50)).put("page", page.coerceIn(0, 12)).toString().toRequestBody(JSON)
            val req = Request.Builder().url("$BASE/gif/search").post(body)
                .header("Origin", BASE).header("Accept", "application/json").header("Cache-Control", "no-store")
                .header("User-Agent", "Najvaa-Android/2.0").build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@call StoreResult.Http(r.code)
                val j = JSONObject(r.body?.string() ?: "{}")
                val arr = j.optJSONArray("items") ?: JSONArray()
                val items = (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val t = o.optString("thumb"); val s = o.optString("send")
                    if (t.startsWith("/gif/m?") && s.startsWith("/gif/m?")) GifItem(t, s) else null
                }
                StoreResult.Ok(GifPage(items, j.optBoolean("more")))
            }
        }
    }

    /** Fetches a GIF/WebP the relay serves; null unless it is a real animated image under 2 MB. */
    suspend fun gifBytes(path: String): Pair<String, ByteArray>? = withContext(Dispatchers.IO) {
        if (!path.startsWith("/gif/m?")) return@withContext null
        runCatching {
            val req = Request.Builder().url(BASE + path).get().header("User-Agent", "Najvaa-Android/2.0").header("Cache-Control", "no-store").build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return@use null
                val type = r.header("Content-Type")?.substringBefore(';')?.trim().orEmpty()
                val bytes = r.body?.bytes() ?: return@use null
                if (!Regex("^image/(gif|webp|png)$").matches(type) || bytes.size > 2 * 1024 * 1024) null else type to bytes
            }
        }.getOrNull()
    }

    data class Usage(val roomBytes: Long, val roomItems: Int, val totalBytes: Long, val capBytes: Long, val maxDays: Int)

    suspend fun usage(keys: RoomKeys): StoreResult<Usage> = withContext(Dispatchers.IO) {
        call {
            client.newCall(request(keys, "/h/usage").get().build()).execute().use { r ->
                val text = r.body?.string()
                if (r.code != 200) return@call claimedOrHttp(r.code, text)
                val o = JSONObject(text ?: "{}")
                StoreResult.Ok(Usage(o.optLong("roomBytes"), o.optInt("roomItems"), o.optLong("totalBytes"), o.optLong("capBytes"), o.optInt("maxDays")))
            }
        }
    }

    private suspend fun simplePost(keys: RoomKeys, path: String, body: JSONObject): StoreResult<Unit> = withContext(Dispatchers.IO) {
        call {
            client.newCall(request(keys, path).post(body.toString().toRequestBody(JSON)).build()).execute().use { r ->
                if (r.code != 200) claimedOrHttp(r.code, r.body?.string()) else StoreResult.Ok(Unit)
            }
        }
    }

    // ── live socket ────────────────────────────────────────────────────────
    interface SocketEvents {
        fun onOpen()
        fun onText(text: String)
        fun onBinary(bytes: ByteArray)
        fun onClosed(code: Int)
    }

    fun socket(keys: RoomKeys, cid: String, fresh: Boolean, events: SocketEvents): WebSocket {
        val url = "wss://$HOST/ws?room=${keys.roomId}&cid=$cid" + if (fresh) "&new=1" else ""
        if (BuildConfig.DEBUG) Log.d(TAG, "socket connect room=${keys.roomId} fresh=$fresh")
        val req = Request.Builder().url(url).header("Origin", BASE).header("User-Agent", "Najvaa-Android/2.0").build()
        return client.newWebSocket(
            req,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "socket open")
                    events.onOpen()
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "socket text ${text.take(40)}")
                    events.onText(text)
                }
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = events.onBinary(bytes.toByteArray())
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (BuildConfig.DEBUG) Log.d(TAG, "socket closed $code $reason")
                    events.onClosed(code)
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                    if (BuildConfig.DEBUG) Log.w(TAG, "socket failure http=${response?.code} $t")
                    events.onClosed(response?.code ?: 1006)
                }
            },
        )
    }
}
