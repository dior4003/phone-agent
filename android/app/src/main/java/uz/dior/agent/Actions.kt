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
}
