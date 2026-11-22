package uz.dior.agent

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Faqat shu yerda sanalgan amallar bajariladi. Erkin shell YO'Q.
 * Yangi servis kerak bo'lsa SERVICES ga, yangi log kerak bo'lsa logs() ga qo'shing.
 */
class Actions(private val ctx: Context) {
    data class Svc(val start: String, val stop: String, val procs: List<String>)

    companion object {
        val SERVICES = linkedMapOf(
            "mariadb" to Svc(
                "nohup mysqld_safe >/dev/null 2>&1 &",
                "mysqladmin -u \$(whoami) shutdown",
                listOf("mariadbd", "mysqld")
            ),
            "nginx" to Svc("nginx", "nginx -s stop", listOf("nginx")),
            "php-fpm" to Svc("php-fpm", "pkill -x php-fpm", listOf("php-fpm"))
        )
        private val NAME = Regex("^[A-Za-z0-9_-]{1,40}$")
        private val DIR = Regex("^[A-Za-z0-9_./-]{1,80}$")
        private val OPS = setOf("start", "stop", "restart")

        // Loyiha yuklash uchun: faqat https:// manzillar, qobiq belgilarisiz (;, |, &, $, `, ', ", bo'sh joy)
        private val REPO_URL = Regex("^https://[A-Za-z0-9@:%._+-]{1,80}(/[A-Za-z0-9._+-]{1,80}){1,6}(\\.git)?$")
        private val SCRIPT_NAME = Regex("^[A-Za-z0-9_:.-]{1,40}$")
        private val NET_OPS = setOf("status", "wifi_on", "wifi_off", "bt_on", "bt_off", "data_on", "data_off")
    }

    private val prefs = Prefs(ctx)
    private val user get() = prefs.termuxUser

    /** Ko'rsatish mumkin bo'lgan loglar (nom -> yo'l). */
    fun logs(): Map<String, String> {
        val m = linkedMapOf("nginx" to "\$PREFIX/var/log/nginx/error.log")
        val dir = prefs.laravelDir
        if (DIR.matches(dir) && !dir.contains("..")) {
            m["laravel"] = "\$HOME/$dir/storage/logs/laravel.log"
        }
        return m
    }

    fun handle(m: JSONObject): Pair<Boolean, String> {
        val op = m.optString("op")
        val target = m.optString("target")
        return when (m.optString("action")) {
            "service" -> service(op, target)
            "logs" -> logs(target, m.optInt("lines", 100).coerceIn(10, 500))
            "pm2list" -> pm2list()
            "device" -> device(op)
            "network" -> network(op)
            "brightness" -> brightness(op, m.optInt("value", -1))
            "find" -> find(op)
            "deploy" -> deploy(op, target, m)
            else -> false to "Noma'lum amal"
        }
    }

    private fun service(op: String, target: String): Pair<Boolean, String> {
        if (op !in OPS) return false to "Noto'g'ri amal"
        if (target.startsWith("pm2:")) {
            val name = target.removePrefix("pm2:")
            if (!NAME.matches(name)) return false to "Noto'g'ri nom"
            return Root.run(user, "pm2 $op $name")
        }
        val s = SERVICES[target] ?: return false to "Ruxsat etilmagan servis"
        return when (op) {
            "start" -> Root.run(user, s.start)
            "stop" -> Root.run(user, s.stop)
            else -> {
                Root.run(user, s.stop)
                Thread.sleep(2000)
                Root.run(user, s.start)
            }
        }
    }

    private fun logs(target: String, lines: Int): Pair<Boolean, String> {
        if (target.startsWith("pm2:")) {
            val name = target.removePrefix("pm2:")
            if (!NAME.matches(name)) return false to "Noto'g'ri nom"
            return Root.run(user, "pm2 logs $name --lines $lines --nostream")
        }
        val path = logs()[target] ?: return false to "Ruxsat etilmagan log"
        return Root.run(user, "tail -n $lines $path")
    }

    private fun pm2list(): Pair<Boolean, String> {
        val (ok, out) = Root.run(user, "pm2 jlist")
        val start = out.indexOf('[')
        if (!ok || start < 0) return false to "pm2 topilmadi yoki ishlamayapti"
        return try {
            val src = JSONArray(out.substring(start))
            val dst = JSONArray()
            for (i in 0 until src.length()) {
                val p = src.getJSONObject(i)
                val env = p.optJSONObject("pm2_env")
                dst.put(
                    JSONObject()
                        .put("name", p.optString("name"))
                        .put("status", env?.optString("status") ?: "?")
                        .put("mem", p.optJSONObject("monit")?.optLong("memory") ?: 0L)
                        .put("restarts", env?.optInt("restart_time") ?: 0)
                )
            }
            true to dst.toString()
        } catch (e: Exception) {
            false to "pm2 javobini o'qib bo'lmadi"
        }
    }

    private fun device(op: String): Pair<Boolean, String> {
        if (op != "reboot") return false to "Noto'g'ri amal"
        // Javob panelga yetib borishi uchun 3 soniya kutiladi
        Root.fireAndForget("sleep 3; reboot")
        return true to "Telefon 3 soniyadan keyin qayta yoqiladi"
    }

    /** Wi-Fi / Bluetooth / mobil internet: holatini o'qish va yoqish/o'chirish (root, "svc" orqali). */
    private fun network(op: String): Pair<Boolean, String> {
        if (op !in NET_OPS) return false to "Noto'g'ri amal"
        if (op == "status") {
            val wifiOn = Root.raw("settings get global wifi_on").trim() == "1"
            val btOn = Root.raw("settings get secure bluetooth_on").trim() == "1"
            val dataOn = Root.raw("settings get global mobile_data").trim() != "0"
            val j = JSONObject().put("wifi", wifiOn).put("bluetooth", btOn).put("mobileData", dataOn)
            return true to j.toString()
        }
        val (cmd, label) = when (op) {
            "wifi_on" -> "svc wifi enable" to "Wi-Fi yoqildi"
            "wifi_off" -> "svc wifi disable" to "Wi-Fi o'chirildi"
            "bt_on" -> "svc bluetooth enable" to "Bluetooth yoqildi"
            "bt_off" -> "svc bluetooth disable" to "Bluetooth o'chirildi"
            "data_on" -> "svc data enable" to "Mobil internet yoqildi"
            "data_off" -> "svc data disable" to "Mobil internet o'chirildi"
            else -> return false to "Noto'g'ri amal"
        }
        Root.raw(cmd)
        return true to label
    }

    /** Ekran yorqinligi: o'qish (0-255) va o'rnatish. Avtomatik yorqinlik o'rnatilganda o'chiriladi. */
    private fun brightness(op: String, value: Int): Pair<Boolean, String> {
        return when (op) {
            "get" -> {
                val v = Root.raw("settings get system screen_brightness").trim().toIntOrNull() ?: -1
                true to JSONObject().put("value", v).toString()
            }
            "set" -> {
                if (value !in 0..255) return false to "Qiymat 0 dan 255 gacha bo'lishi kerak"
                Root.raw("settings put system screen_brightness_mode 0")
                Root.raw("settings put system screen_brightness $value")
                true to "Yorqinlik o'rnatildi"
            }
            else -> false to "Noto'g'ri amal"
        }
    }

    /** "Telefonni topish": signal/jim rejimidan qat'iy nazar baland ovoz chaladi. Root talab qilmaydi. */
    private fun find(op: String): Pair<Boolean, String> {
        return when (op) {
            "ring" -> { Finder.start(ctx); true to "Ovoz chalinmoqda" }
            "stop" -> { Finder.stop(); true to "Ovoz to'xtatildi" }
            "status" -> true to JSONObject().put("ringing", Finder.isRinging()).toString()
            else -> false to "Noto'g'ri amal"
        }
    }

    /**
     * Yangi loyihani git orqali yuklab, ishga tushirish.
     * Erkin buyruq YO'Q: faqat "clone" (https manzildan), "scripts" (package.json dagi
     * tayyor skriptlar ro'yxatini o'qish) va "run" (shu ro'yxatdan tanlangan skriptni
     * pm2 orqali ishga tushirish, masalan "npm run dev").
     */
    private fun deploy(op: String, target: String, m: JSONObject): Pair<Boolean, String> {
        if (!NAME.matches(target)) return false to "Noto'g'ri papka nomi"
        return when (op) {
            "clone" -> {
                val repo = m.optString("repo")
                if (!REPO_URL.matches(repo)) return false to "Noto'g'ri repo manzili (https://... bilan boshlanishi kerak)"
                val (ok, out) = Root.run(user, "test -e $target && echo EXISTS || git clone --depth 1 -- '$repo' $target")
                if (out.trim() == "EXISTS") return false to "Bu nomda papka allaqachon bor"
                if (!ok) return false to out.take(2000)
                true to "Yuklab olindi: $target"
            }
            "install" -> Root.run(user, "test -d $target || exit 9; cd $target && npm install --no-audit --no-fund")
            "scripts" -> {
                val (ok, out) = Root.run(user, "cat $target/package.json 2>/dev/null")
                if (!ok || out.isBlank()) return false to "package.json topilmadi (avval \"npm install\" bosilganmi?)"
                try {
                    val scripts = JSONObject(out).optJSONObject("scripts") ?: JSONObject()
                    true to scripts.toString()
                } catch (e: Exception) {
                    false to "package.json o'qib bo'lmadi"
                }
            }
            "run" -> {
                val script = m.optString("script")
                if (!SCRIPT_NAME.matches(script)) return false to "Noto'g'ri skript nomi"
                // Himoya: faqat package.json ichida haqiqatan mavjud skriptni ishga tushiramiz
                val (okCat, out) = Root.run(user, "cat $target/package.json 2>/dev/null")
                val exists = okCat && try { JSONObject(out).optJSONObject("scripts")?.has(script) == true } catch (e: Exception) { false }
                if (!exists) return false to "Bu skript package.json \"scripts\" ichida topilmadi"
                Root.run(user, "cd $target && pm2 start npm --name '$target' -- run '$script'")
            }
            "remove" -> Root.run(user, "pm2 delete '$target' >/dev/null 2>&1; rm -rf -- $target")
            else -> false to "Noto'g'ri amal"
        }
    }
}
