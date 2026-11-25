package uz.dior.agent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class AgentService : Service() {
    companion object {
        /** MainActivity shu qiymatni ko'rsatadi. */
        @Volatile var state: String = "O'chiq"
        @Volatile private var activeWs: WebSocket? = null

        fun sendNotification(app: String, title: String, text: String, time: String) {
            val w = activeWs ?: return
            try {
                val payload = JSONObject()
                    .put("type", "notif")
                    .put("data", JSONObject()
                        .put("app", app)
                        .put("title", title)
                        .put("text", text)
                        .put("time", time))
                    .toString()
                w.send(payload)
            } catch (_: Exception) {}
        }
    }

    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadScheduledExecutor()
    // Buyruqlar statistika oqimidan alohida bajariladi (uzoq buyruq panelni qotirib qo'ymasin)
    private val cmdPool = Executors.newCachedThreadPool()
    @Volatile private var ws: WebSocket? = null
    private var statsTask: ScheduledFuture<*>? = null
    @Volatile private var stopped = false
    private var retryMs = 3000L
    private lateinit var actions: Actions
    private lateinit var walkie: AudioWalkie

    override fun onCreate() {
        super.onCreate()
        actions = Actions(this)
        walkie = AudioWalkie(this)
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel("agent", "Agent", NotificationManager.IMPORTANCE_LOW))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = Notification.Builder(this, "agent")
            .setContentTitle("Phone Agent ishlayapti")
            .setContentText("Masofaviy boshqaruv yoqilgan")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(1, n)
        }
        stopped = false
        connect()
        return START_STICKY
    }

    private fun connect() {
        if (stopped || ws != null) return
        val p = Prefs(this)
        if (p.url.isBlank() || p.token.isBlank()) {
            state = "Server manzili yoki token kiritilmagan"
            return
        }
        val req = try {
            Request.Builder().url(p.url).header("Authorization", "Bearer ${p.token}").build()
        } catch (e: IllegalArgumentException) {
            state = "Server manzili noto'g'ri (wss://... bo'lsin)"
            return
        }
        state = "Ulanmoqda..."
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(w: WebSocket, r: Response) {
                activeWs = w
                retryMs = 3000L
                state = "Ulangan"
                statsTask?.cancel(false)
        walkie.stopMic()
                statsTask = worker.scheduleWithFixedDelay({
                    try {
                        val st = Stats.collect(this@AgentService)
                        val prefs = Prefs(this@AgentService)
                        if (prefs.chargeLimitEnabled) {
                            val bat = st.optInt("battery", -1)
                            if (bat >= prefs.chargeMax) Actions.setCharging(false)
                            else if (bat in 0..prefs.chargeMin) Actions.setCharging(true)
                        }
                        w.send(JSONObject().put("type", "stats").put("data", st).toString())
                    } catch (_: Exception) {
                    }
                }, 0, 5, TimeUnit.SECONDS)
            }

            override fun onMessage(w: WebSocket, text: String) {
                val m = try { JSONObject(text) } catch (_: Exception) { return }
                when (m.optString("type")) {
                    "audio_down" -> walkie.playChunk(m.optString("data"))
                    "ptt_cmd" -> {
                        if (m.optString("op") == "listen_on") {
                            val ok = walkie.startMic { b64 ->
                                try {
                                    w.send(JSONObject().put("type", "audio_up").put("data", b64).toString())
                                } catch (_: Exception) {}
                            }
                            if (!ok) {
                                try {
                                    w.send(JSONObject().put("type", "audio_err").put("error", "Telefonda mikrofon ruxsati berilmagan").toString())
                                } catch (_: Exception) {}
                            }
                        } else if (m.optString("op") == "listen_off") {
                            walkie.stopMic()
                        }
                    }
                    else -> cmdPool.execute { respond(w, text) }
                }
            }

            override fun onClosed(w: WebSocket, code: Int, reason: String) {
                reconnect(w, if (code == 4000) "Boshqa agent ulandi" else "Uzilgan")
            }

            override fun onFailure(w: WebSocket, t: Throwable, r: Response?) {
                val why = if (r?.code == 401) "Token noto'g'ri (401)" else "Uzilgan"
                reconnect(w, why)
            }
        })
    }

    private fun reconnect(w: WebSocket, why: String) {
        if (w !== ws) return
        statsTask?.cancel(false)
        if (activeWs === w) activeWs = null
        ws = null
        if (stopped) return
        state = "$why, ${retryMs / 1000} soniyadan keyin qayta uriniladi"
        worker.schedule({ connect() }, retryMs, TimeUnit.MILLISECONDS)
        retryMs = minOf(retryMs * 2, 60_000L)
    }

    private fun respond(w: WebSocket, text: String) {
        val m = try { JSONObject(text) } catch (e: Exception) { return }
        if (m.optString("type") != "cmd") return
        val (ok, out) = try {
            actions.handle(m)
        } catch (e: Exception) {
            false to (e.message ?: "Xato")
        }
        val act = m.optString("action")
        val limit = if (act == "file" || act == "screenshot") 21_000_000 else 100_000
        w.send(
            JSONObject()
                .put("type", "result").put("id", m.optString("id"))
                .put("ok", ok).put("out", out.take(limit)).toString()
        )
    }

    override fun onDestroy() {
        stopped = true
        state = "O'chiq"
        statsTask?.cancel(true)
        walkie.release()
        activeWs = null
        ws?.close(1000, "stop")
        worker.shutdownNow()
        cmdPool.shutdownNow()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
