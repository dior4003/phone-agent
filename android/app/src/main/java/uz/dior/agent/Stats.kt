package uz.dior.agent

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object Stats {
    fun collect(ctx: Context): JSONObject {
        val j = JSONObject()

        val mem = File("/proc/meminfo").readLines().associate {
            val p = it.split(":")
            p[0] to (p.getOrNull(1)?.trim()?.split(Regex("\\s+"))?.get(0)?.toLongOrNull() ?: 0L)
        }
        j.put("ramTotalMb", (mem["MemTotal"] ?: 0L) / 1024)
        j.put("ramAvailMb", (mem["MemAvailable"] ?: 0L) / 1024)

        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = b?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = b?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        j.put("battery", if (level >= 0 && scale > 0) level * 100 / scale else 0)
        j.put("tempC", (b?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0)
        j.put("charging", (b?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0)

        val fs = StatFs(Environment.getDataDirectory().path)
        j.put("diskTotalGb", fs.totalBytes / 1e9)
        j.put("diskFreeGb", fs.availableBytes / 1e9)

        j.put("uptimeSec", SystemClock.elapsedRealtime() / 1000)
        j.put("load", Root.raw("cat /proc/loadavg").trim().split(" ").firstOrNull()?.toDoubleOrNull() ?: 0.0)
        j.put("device", Build.MODEL)
        j.put("android", Build.VERSION.RELEASE)
        j.put("agentVersion", BuildConfig.VERSION_NAME)

        // Telegram sozlamalari ilovadan kiritilgan bo'lsa, serverga shu yerdan boradi
        // (server bularni lastStats'ga saqlamaydi va panelga yubormaydi — faqat Alerts uchun ishlatadi).
        val prefs = Prefs(ctx)
        if (prefs.telegramBotToken.isNotBlank()) j.put("telegramBotToken", prefs.telegramBotToken)
        if (prefs.telegramChatId.isNotBlank()) j.put("telegramChatId", prefs.telegramChatId)

        // Servislar holati: bitta shell chaqiruvida
        val script = Actions.SERVICES.entries.joinToString("; ") { (name, s) ->
            val check = s.procs.joinToString(" || ") { "pidof $it" }
            "if ($check) >/dev/null 2>&1; then echo $name=1; else echo $name=0; fi"
        }
        val svc = JSONObject()
        Root.raw(script).lines().forEach {
            val kv = it.trim().split("=")
            if (kv.size == 2) svc.put(kv[0], kv[1] == "1")
        }
        j.put("services", svc)
        j.put("logs", JSONArray(Actions(ctx).logs().keys.toList()))
        return j
    }
}
