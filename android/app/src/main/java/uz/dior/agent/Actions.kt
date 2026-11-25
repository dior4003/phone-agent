package uz.dior.agent

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import org.json.JSONArray
import android.content.ClipData
import android.content.ClipboardManager
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Faqat shu yerda sanalgan amallar bajariladi. Erkin shell YO'Q.
 * Yangi servis kerak bo'lsa SERVICES ga, yangi log kerak bo'lsa logs() ga qo'shing.
 */
class Actions(private val ctx: Context) {
    data class Svc(val start: String, val stop: String, val procs: List<String>)

    companion object {
        fun setCharging(enable: Boolean) {
            val v = if (enable) "1" else "0"
            val inv = if (enable) "0" else "1"
            Root.raw(
                "if [ -f /sys/class/power_supply/battery/charging_enabled ]; then echo $v > /sys/class/power_supply/battery/charging_enabled; " +
                "elif [ -f /sys/class/power_supply/battery/battery_charging_enabled ]; then echo $v > /sys/class/power_supply/battery/battery_charging_enabled; " +
                "elif [ -f /sys/class/power_supply/battery/input_suspend ]; then echo $inv > /sys/class/power_supply/battery/input_suspend; fi"
            )
        }
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
        private val PM2_OPS = setOf("start", "stop", "restart", "delete")

        // Loyiha yuklash uchun: faqat https:// manzillar, qobiq belgilarisiz (;, |, &, $, `, ', ", bo'sh joy)
        // Birinchi segment (host + ixtiyoriy https://token@host kabi autentifikatsiya) uzunroq
        // chegaraga ega — GitHub'ning "fine-grained" shaxsiy tokenlari 90+ belgi bo'lishi mumkin.
        private val REPO_URL = Regex("^https://[A-Za-z0-9@:%._+-]{1,220}(/[A-Za-z0-9._+-]{1,80}){1,6}(\\.git)?$")
        private val SCRIPT_NAME = Regex("^[A-Za-z0-9_:.-]{1,40}$")
        private val PKG_NAME = Regex("^[a-zA-Z0-9._]{3,120}$")
        private val NET_OPS = setOf("status", "wifi_on", "wifi_off", "bt_on", "bt_off", "data_on", "data_off")
        private const val MAX_FILE_BYTES = 15 * 1024 * 1024 // server/src/app.js dagi MAX_FILE_BYTES bilan bir xil
    }

    private val prefs = Prefs(ctx)
    private val user get() = prefs.termuxUser
    private var torchCameraId: String? = null
    @Volatile private var torchOn = false

    private fun shQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

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
            "flashlight" -> flashlight(op)
            "file" -> file(op, target, m)
            "shell" -> shell(m.optString("cmd"), m.optString("cwd", "."))
            "apps" -> apps(op, target)
            "battery_limit" -> batteryLimit(op, m)
            "screenshot" -> screenshot()
            "clipboard" -> clipboard(op, m.optString("text"))
            "backup" -> backup()
            else -> false to "Noma'lum amal"
        }
    }

    private fun service(op: String, target: String): Pair<Boolean, String> {
        if (target.startsWith("pm2:")) {
            if (op !in PM2_OPS) return false to "Noto'g'ri amal"
            val name = target.removePrefix("pm2:")
            if (!NAME.matches(name)) return false to "Noto'g'ri nom"
            val qName = shQuote(name)
            val cmd = if (op == "delete") {
                "pm2 delete $qName 2>&1 && (pm2 save --force >/dev/null 2>&1 || true)"
            } else {
                "pm2 $op $qName 2>&1 && (pm2 save --force >/dev/null 2>&1 || true)"
            }
            return Root.run(user, cmd)
        }
        if (op !in OPS) return false to "Noto'g'ri amal"
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
            return Root.run(user, "pm2 logs ${shQuote(name)} --lines $lines --nostream --no-color 2>&1")
        }
        val path = logs()[target] ?: return false to "Ruxsat etilmagan log"
        return Root.run(user, "tail -n $lines $path")
    }

    private fun extractPm2Json(out: String): String {
        val line = out.lines().lastOrNull {
            val t = it.trim()
            t == "[]" || t.startsWith("[{")
        }?.trim()
        if (!line.isNullOrEmpty()) return line
        val idxObj = out.indexOf("[{")
        if (idxObj >= 0) return out.substring(idxObj).trim()
        if (out.contains("[]")) return "[]"
        return ""
    }

    private fun pm2list(): Pair<Boolean, String> {
        val (ok, out) = Root.run(user, "command -v pm2 >/dev/null 2>&1 || { echo __NOPM2__; exit 127; }; pm2 jlist --no-color 2>&1")
        if (out.contains("__NOPM2__")) return false to "Termux'da pm2 o'rnatilmagan (npm install -g pm2)"
        val jsonStr = extractPm2Json(out)
        if (!ok && jsonStr.isEmpty()) return false to out.ifBlank { "pm2 topilmadi yoki ishlamayapti" }
        if (jsonStr.isEmpty()) return true to "[]"
        return try {
            val src = JSONArray(jsonStr)
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
                        .put("cwd", env?.optString("pm_cwd") ?: "")
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
     * Yangi loyihani git orqali yuklab, ishga tushirish va yangilash.
     * Erkin buyruq YO'Q: faqat "clone", "install", "scripts", "run", "update", "remove".
     */
    private fun deploy(op: String, target: String, m: JSONObject): Pair<Boolean, String> {
        if (!NAME.matches(target)) return false to "Noto'g'ri papka nomi"
        val qTarget = shQuote(target)
        return when (op) {
            "clone" -> {
                val repo = m.optString("repo")
                if (!REPO_URL.matches(repo)) return false to "Noto'g'ri repo manzili (https://... bilan boshlanishi kerak)"
                val cmd = "command -v git >/dev/null 2>&1 || { echo NOGIT; exit 127; }; " +
                    "if [ -e $qTarget ]; then echo EXISTS; exit 3; fi; " +
                    "GIT_TERMINAL_PROMPT=0 git clone --depth 1 -- ${shQuote(repo)} $qTarget 2>&1"
                val (ok, out) = Root.runLong(user, cmd, 600)
                if (out.trim() == "NOGIT") return false to "Termux'da git o'rnatilmagan. Termux'da bajaring: pkg install git"
                if (out.trim() == "EXISTS") return false to "\"$target\" papkasi allaqachon bor. Boshqa nom bering yoki avval uni o'chiring"
                if (!ok) return false to out.takeLast(2000)
                true to "Yuklab olindi: $target"
            }
            "install" -> {
                val installCmd = "test -d $qTarget || { echo 'Papka topilmadi'; exit 9; }; cd $qTarget && { " +
                    "if [ -f package.json ]; then npm install --no-audit --no-fund 2>&1; " +
                    "elif [ -f requirements.txt ]; then " +
                    "(python3 -m venv .venv 2>/dev/null || true); " +
                    "if [ -x .venv/bin/pip ]; then .venv/bin/pip install -r requirements.txt 2>&1; " +
                    "else pip install -r requirements.txt 2>&1; fi; " +
                    "elif [ -f composer.json ]; then composer install --no-interaction 2>&1; " +
                    "else echo 'Bogliqlik fayli topilmadi, davom etilmoqda'; fi; }"
                val (ok, out) = Root.runLong(user, installCmd, 900)
                if (!ok) false to out.takeLast(2000) else true to "O'rnatildi: $target"
            }
            "scripts" -> {
                val (okPkg, outPkg) = Root.run(user, "cat $qTarget/package.json 2>/dev/null")
                if (okPkg && outPkg.isNotBlank()) {
                    return try {
                        val scripts = JSONObject(outPkg).optJSONObject("scripts") ?: JSONObject()
                        true to scripts.toString()
                    } catch (e: Exception) {
                        false to "package.json o'qib bo'lmadi"
                    }
                }
                val (_, detected) = Root.run(
                    user,
                    "cd $qTarget 2>/dev/null || exit 0; " +
                        "for f in main.py app.py bot.py run.py server.py manage.py; do [ -f \"\$f\" ] && echo \"py:\$f\"; done; " +
                        "[ -f artisan ] && echo 'php:artisan'; " +
                        "{ [ -f index.php ] || [ -f public/index.php ]; } && echo 'php:server'"
                )
                val scripts = JSONObject()
                for (line in detected.lines().map { it.trim() }.filter { it.isNotEmpty() }) {
                    when {
                        line == "py:manage.py" -> scripts.put("python:manage.py", "python3 manage.py runserver 0.0.0.0:8000")
                        line.startsWith("py:") -> {
                            val f = line.removePrefix("py:")
                            scripts.put("python:$f", "python3 $f")
                        }
                        line == "php:artisan" -> scripts.put("php:artisan", "php artisan serve --host=0.0.0.0 --port=8000")
                        line == "php:server" -> scripts.put("php:server", "php -S 0.0.0.0:8000")
                    }
                }
                true to scripts.toString()
            }
            "run" -> {
                val script = m.optString("script")
                if (!SCRIPT_NAME.matches(script)) return false to "Noto'g'ri skript nomi"
                val qScript = shQuote(script)
                val startCmd = when {
                    script.startsWith("python:") -> {
                        val pyFile = script.removePrefix("python:")
                        val qPy = shQuote(pyFile)
                        val (_, ex) = Root.run(user, "test -f $qTarget/$qPy && echo __OK__")
                        if (!ex.contains("__OK__")) return false to "$pyFile topilmadi"
                        val args = if (pyFile == "manage.py") "$qPy runserver 0.0.0.0:8000" else qPy
                        "PY=\$(command -v python3); [ -x .venv/bin/python ] && PY=.venv/bin/python; " +
                            "pm2 start \"\$PY\" --name $qTarget -- $args 2>&1"
                    }
                    script == "php:artisan" -> {
                        "pm2 start \"\$(command -v php)\" --name $qTarget -- artisan serve --host=0.0.0.0 --port=8000 2>&1"
                    }
                    script == "php:server" -> {
                        val docRoot = if (Root.run(user, "test -d $qTarget/public && echo 1").second.contains("1")) " -t public" else ""
                        "pm2 start \"\$(command -v php)\" --name $qTarget -- -S 0.0.0.0:8000$docRoot 2>&1"
                    }
                    else -> {
                        val (okCat, out) = Root.run(user, "cat $qTarget/package.json 2>/dev/null")
                        val exists = okCat && try { JSONObject(out).optJSONObject("scripts")?.has(script) == true } catch (e: Exception) { false }
                        if (!exists) return false to "Bu skript package.json \"scripts\" ichida topilmadi"
                        "pm2 start \"\$(command -v node)\" --name $qTarget -- \"\$_NPM\" run $qScript 2>&1"
                    }
                }
                val cmd = "command -v pm2 >/dev/null 2>&1 || { echo 'Termuxda pm2 ornatilmagan (npm install -g pm2)'; exit 127; }; " +
                    "(cd $qTarget && (pm2 delete $qTarget >/dev/null 2>&1 || true) && $startCmd) && (pm2 save --force >/dev/null 2>&1 || true)"
                val (okRun, runOut) = Root.run(user, cmd)
                if (!okRun) false to runOut.takeLast(1500) else true to "Ishga tushirildi: $target ($script)"
            }
            "update" -> {
                // Loyiha papkasini aniqlash: avval $HOME/<target>, bo'lmasa pm2 jlist dagi pm_cwd
                var projDir = target
                val (_, checkHome) = Root.run(user, "test -d $qTarget/.git && echo __GIT__")
                if (!checkHome.contains("__GIT__")) {
                    val (okList, listOut) = Root.run(user, "pm2 jlist --no-color 2>/dev/null")
                    val jsonStr = extractPm2Json(listOut)
                    if (okList && jsonStr.isNotEmpty()) {
                        try {
                            val arr = JSONArray(jsonStr)
                            for (i in 0 until arr.length()) {
                                val p = arr.getJSONObject(i)
                                if (p.optString("name") == target) {
                                    val cwd = p.optJSONObject("pm2_env")?.optString("pm_cwd") ?: ""
                                    if (cwd.isNotEmpty()) projDir = cwd
                                    break
                                }
                            }
                        } catch (_: Exception) {}
                    }
                }
                val qDir = shQuote(projDir)
                val cmd = "if [ ! -d $qDir/.git ]; then echo __NOGITDIR__; exit 5; fi; " +
                    "cd $qDir && GIT_TERMINAL_PROMPT=0 git pull --ff-only 2>&1 || exit 6; " +
                    "if [ -f package.json ]; then npm install --no-audit --no-fund 2>&1 || exit 7; fi; " +
                    "pm2 restart $qTarget 2>&1 && pm2 save --force >/dev/null 2>&1 || true"
                val (okUpd, outUpd) = Root.runLong(user, cmd, 600)
                if (outUpd.contains("__NOGITDIR__")) {
                    return false to "\"$target\" papkasida git repozitoriy topilmadi"
                }
                if (!okUpd) return false to outUpd.takeLast(2000)
                true to "Yangilandi va qayta ishga tushirildi: $target\n${outUpd.takeLast(1000)}"
            }
            "remove" -> {
                Root.run(user, "pm2 delete $qTarget >/dev/null 2>&1 || true; pm2 save --force >/dev/null 2>&1 || true; rm -rf -- $qTarget")
            }
            else -> false to "Noto'g'ri amal"
        }
    }

    /** Chaqmoq (orqa kamera fonari): yoqish/o'chirish. Root talab qilmaydi. */
    private fun flashlight(op: String): Pair<Boolean, String> {
        if (op !in setOf("on", "off", "status")) return false to "Noto'g'ri amal"
        if (op == "status") return true to JSONObject().put("on", torchOn).toString()
        val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = torchCameraId ?: try {
            cm.cameraIdList.firstOrNull { id ->
                cm.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
        } catch (e: Exception) { null }
        if (id == null) return false to "Chaqmoq (flash) topilmadi"
        torchCameraId = id
        return try {
            val on = op == "on"
            cm.setTorchMode(id, on)
            torchOn = on
            true to if (on) "Chaqmoq yoqildi" else "Chaqmoq o'chirildi"
        } catch (e: Exception) {
            false to "Bajarib bo'lmadi: ${e.message}"
        }
    }

    /** Berilgan nisbiy yo'lni tekshiradi: "/" bilan boshlanmasin, ".." bo'lmasin. */
    private fun safeRel(raw: String): String? {
        val norm = raw.replace('\\', '/').trim()
        if (norm.isEmpty() || norm == ".") return "."
        if (norm.startsWith("/") || norm.length > 400) return null
        for (s in norm.split("/")) {
            if (s.isEmpty() || s == "." || s == "..") return null
            if (s.any { it.code < 32 }) return null
        }
        return norm
    }

    /**
     * Fayl menejeri: faqat Termux foydalanuvchisi uy papkasi ichida (tizim fayllariga yo'l yopiq).
     * list/read/write/mkdir/delete/unzip — erkin shell buyrug'i yo'q.
     */
    private fun fRun(isSd: Boolean, cmd: String): Pair<Boolean, String> =
        if (isSd) Root.runAsRoot("cd /sdcard && { $cmd ; }") else Root.run(user, cmd)

    private fun fRunLong(isSd: Boolean, cmd: String, timeoutSec: Long, maxOutChars: Int = 200_000): Pair<Boolean, String> =
        if (isSd) Root.runRootLong("cd /sdcard && { $cmd ; }", timeoutSec, maxOutChars) else Root.runLong(user, cmd, timeoutSec, maxOutChars)

    private fun fWriteStdin(isSd: Boolean, cmd: String, data: ByteArray, timeoutSec: Long): Pair<Boolean, String> =
        if (isSd) Root.writeRootStdin("cd /sdcard && { $cmd ; }", data, timeoutSec) else Root.writeStdin(user, cmd, data, timeoutSec)

    private fun file(op: String, targetRaw: String, m: JSONObject): Pair<Boolean, String> {
        val rel = safeRel(targetRaw) ?: return false to "Noto'g'ri yo'l"
        val isSd = m.optString("root") == "sdcard"
        val qRel = shQuote(rel)
        return when (op) {
            "list" -> {
                val cmd = "if [ ! -d $qRel ]; then echo __NODIR__; exit 4; fi; " +
                    "cd $qRel || exit 4; " +
                    "for f in * .[!.]* ..?*; do " +
                    "[ -e \"\$f\" ] || [ -L \"\$f\" ] || continue; " +
                    "if [ -d \"\$f\" ]; then t=d; else t=f; fi; " +
                    "sz=\$(stat -c %s \"\$f\" 2>/dev/null || wc -c < \"\$f\" 2>/dev/null || echo 0); " +
                    "mt=\$(stat -c %Y \"\$f\" 2>/dev/null || echo 0); " +
                    "printf '%s\\t%s\\t%s\\t%s\\n' \"\$t\" \"\$sz\" \"\$mt\" \"\$f\"; " +
                    "done"
                val (ok, out) = fRun(isSd, cmd)
                if (out.trim() == "__NODIR__") return false to "Papka topilmadi"
                if (!ok) return false to out.take(1500)
                val arr = JSONArray()
                for (line in out.split("\n")) {
                    if (line.isBlank()) continue
                    val parts = line.split("\t")
                    if (parts.size < 4) continue
                    arr.put(
                        JSONObject()
                            .put("type", parts[0])
                            .put("size", parts[1].toLongOrNull() ?: 0L)
                            .put("mtime", parts[2].toLongOrNull() ?: 0L)
                            .put("name", parts.subList(3, parts.size).joinToString("\t"))
                    )
                }
                true to arr.toString()
            }
            "read" -> {
                if (rel == ".") return false to "Fayl tanlanmagan"
                val (_, sz) = fRun(isSd, "stat -c %s $qRel 2>/dev/null || wc -c < $qRel 2>/dev/null || echo -1")
                val size = sz.trim().toLongOrNull() ?: -1
                if (size < 0) return false to "Fayl topilmadi"
                if (size > MAX_FILE_BYTES) return false to "Fayl juda katta (limit ${MAX_FILE_BYTES / 1024 / 1024} MB)"
                val maxOut = (MAX_FILE_BYTES.toLong() * 4 / 3 + 4096).toInt()
                val (ok, out) = fRunLong(isSd, "base64 -w0 $qRel 2>/dev/null || base64 $qRel 2>/dev/null | tr -d '\\n'", 120, maxOut)
                if (!ok || out.isBlank()) return false to "O'qib bo'lmadi"
                true to out.trim()
            }
            "write" -> {
                if (rel == ".") return false to "Fayl nomi kerak"
                val b64 = m.optString("data")
                if (b64.isEmpty()) return false to "Ma'lumot bo'sh"
                val bytes = try {
                    android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
                } catch (e: Exception) {
                    return false to "Noto'g'ri ma'lumot (base64)"
                }
                if (bytes.size > MAX_FILE_BYTES) return false to "Fayl juda katta (limit ${MAX_FILE_BYTES / 1024 / 1024} MB)"
                val cmd = "mkdir -p -- \"\$(dirname $qRel)\" 2>/dev/null; cat > $qRel && echo __OK__ || echo __FAIL__"
                val (ok, out) = fWriteStdin(isSd, cmd, bytes, 120)
                if (!ok || !out.contains("__OK__")) return false to "Yozib bo'lmadi: ${out.take(500)}"
                true to "Saqlandi: $rel"
            }
            "mkdir" -> if (rel == ".") false to "Papka nomi kerak" else fRun(isSd, "mkdir -p -- $qRel")
            "rename" -> {
                if (rel == ".") return false to "Bu papka nomini o'zgartirib bo'lmaydi"
                val dest = safeRel(m.optString("dest")) ?: return false to "Noto'g'ri yangi nom"
                if (dest == ".") return false to "Yangi nom kiriting"
                val qDest = shQuote(dest)
                val (okMv, outMv) = fRun(isSd, "mkdir -p -- \"\$(dirname $qDest)\" 2>/dev/null; mv -n -- $qRel $qDest 2>&1")
                if (!okMv) false to outMv.ifBlank { "Nomini o'zgartirib bo'lmadi" } else true to "O'zgartirildi: $dest"
            }
            "copy" -> {
                if (rel == ".") return false to "Fayl tanlanmagan"
                val dest = safeRel(m.optString("dest")) ?: return false to "Noto'g'ri manzil"
                if (dest == ".") return false to "Yangi nom kiriting"
                val qDest = shQuote(dest)
                val (okCp, outCp) = fRun(isSd, "mkdir -p -- \"\$(dirname $qDest)\" 2>/dev/null; cp -r -- $qRel $qDest 2>&1")
                if (!okCp) false to outCp.ifBlank { "Nusxalab bo'lmadi" } else true to "Nusxalandi: $dest"
            }
            "delete" -> if (rel == ".") false to "Bu papkani o'chirib bo'lmaydi" else fRun(isSd, "rm -rf -- $qRel")
            "unzip" -> {
                if (rel == ".") return false to "Zip fayl tanlanmagan"
                val dest = safeRel(m.optString("dest")) ?: return false to "Noto'g'ri manzil papka"
                val qDest = shQuote(dest)
                val cmd = "command -v unzip >/dev/null 2>&1 || { echo __NOUNZIP__; exit 127; }; " +
                    "test -f $qRel || { echo __NOFILE__; exit 4; }; " +
                    "mkdir -p -- $qDest && unzip -o -q $qRel -d $qDest 2>&1 && echo __OK__ || echo __FAIL__"
                val (ok, out) = fRunLong(isSd, cmd, 300)
                if (out.contains("__NOUNZIP__")) return false to "Termux'da unzip o'rnatilmagan. Bajaring: pkg install unzip"
                if (out.contains("__NOFILE__")) return false to "Zip fayl topilmadi"
                if (!ok || !out.contains("__OK__")) return false to out.take(1500)
                true to "Yoyildi: $dest"
            }
            else -> false to "Noto'g'ri amal"
        }
    }

    private fun shell(cmdRaw: String, cwdRaw: String): Pair<Boolean, String> {
        val cmd = cmdRaw.trim()
        if (cmd.isEmpty()) return false to "Buyruq bo'sh"
        if (cmd.length > 2000) return false to "Buyruq juda uzun (maksimum 2000 belgi)"
        val cwd = safeRel(cwdRaw) ?: "."
        val qCwd = shQuote(cwd)
        val wrapped = "cd $qCwd 2>/dev/null || cd \"\$HOME\"; { $cmd ; } 2>&1; __rc=\$?; printf '\n__CWD__:%s\n' \"\$(pwd)\"; exit \$__rc"
        val (ok, rawOut) = Root.runLong(user, wrapped, 300)
        val lines = rawOut.lines()
        val cwdLine = lines.lastOrNull { it.startsWith("__CWD__:") }
        val newCwdAbs = cwdLine?.removePrefix("__CWD__:")?.trim() ?: ""
        val homePrefix = "/data/data/com.termux/files/home"
        val newCwd = when {
            newCwdAbs == homePrefix -> "."
            newCwdAbs.startsWith("$homePrefix/") -> newCwdAbs.removePrefix("$homePrefix/")
            else -> cwd
        }
        val cleanOut = lines.filterNot { it.startsWith("__CWD__:") }.joinToString("\n").trimEnd().takeLast(30_000)
        val payload = JSONObject().put("out", cleanOut).put("cwd", newCwd).toString()
        return ok to payload
    }


    private fun runningThirdPartyApps(): List<Triple<String, Int, Long>> {
        val pkgsOut = Root.raw("pm list packages -3 2>/dev/null")
        val thirdParty = pkgsOut.lines()
            .map { it.trim().removePrefix("package:") }
            .filter { it.isNotEmpty() && !it.startsWith("com.termux") && it != ctx.packageName }
            .toSet()
        if (thirdParty.isEmpty()) return emptyList()
        val psOut = Root.raw("ps -A -o PID,RSS,NAME 2>/dev/null")
        val map = linkedMapOf<String, Pair<Int, Long>>()
        for (line in psOut.lines().drop(1)) {
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 3) continue
            val pid = parts[0].toIntOrNull() ?: continue
            val rssKb = parts[1].toLongOrNull() ?: 0L
            val name = parts[2].substringBefore(":")
            if (name in thirdParty) {
                val prev = map[name]
                if (prev == null) map[name] = pid to rssKb
                else map[name] = prev.first to (prev.second + rssKb)
            }
        }
        return map.entries
            .map { Triple(it.key, it.value.first, it.value.second / 1024L) }
            .sortedByDescending { it.third }
    }

    private fun apps(op: String, target: String): Pair<Boolean, String> {
        return when (op) {
            "list" -> {
                val arr = JSONArray()
                for ((pkg, pid, memMb) in runningThirdPartyApps()) {
                    arr.put(JSONObject().put("pkg", pkg).put("pid", pid).put("memMb", memMb))
                }
                true to arr.toString()
            }
            "stop" -> {
                if (!PKG_NAME.matches(target)) return false to "Noto'g'ri paket nomi"
                if (target.startsWith("com.termux") || target == ctx.packageName) {
                    return false to "Termux va Phone Agent'ni to'xtatib bo'lmaydi"
                }
                Root.raw("am force-stop $target")
                true to "To'xtatildi: $target"
            }
            "optimize" -> {
                val running = runningThirdPartyApps()
                for ((pkg, _, _) in running) {
                    Root.raw("am force-stop $pkg")
                }
                Root.raw("am kill-all; sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true")
                true to "Optimizatsiya qilindi: ${running.size} ta fon ilova to'xtatildi va RAM kesh tozalandi"
            }
            else -> false to "Noto'g'ri amal"
        }
    }


    private fun batteryLimit(op: String, m: JSONObject): Pair<Boolean, String> {
        if (op == "set") {
            prefs.chargeLimitEnabled = m.optBoolean("enabled", false)
            if (m.has("min")) prefs.chargeMin = m.optInt("min", 50)
            if (m.has("max")) prefs.chargeMax = m.optInt("max", 80)
            if (!prefs.chargeLimitEnabled) setCharging(true)
        }
        return true to JSONObject()
            .put("enabled", prefs.chargeLimitEnabled)
            .put("min", prefs.chargeMin)
            .put("max", prefs.chargeMax)
            .toString()
    }

    private fun screenshot(): Pair<Boolean, String> {
        val (ok, out) = Root.runRootLong(
            "TMP=/data/local/tmp/_pa_shot.png; rm -f \$TMP; " +
                "/system/bin/screencap -p \$TMP 2>/dev/null && base64 \$TMP 2>/dev/null; " +
                "rm -f \$TMP",
            20,
            12_000_000
        )
        val b64 = out.replace("\n", "").replace("\r", "").trim()
        return if (!ok || !b64.startsWith("iVBOR")) {
            false to "Ekran rasmini olib bo'lmadi: ${out.take(300)}"
        } else {
            true to b64
        }
    }

    private fun clipboard(op: String, text: String): Pair<Boolean, String> {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val latch = CountDownLatch(1)
        var resText = ""
        Handler(Looper.getMainLooper()).post {
            try {
                if (op == "set") {
                    cm.setPrimaryClip(ClipData.newPlainText("phone-agent", text))
                    resText = "Buferga yozildi"
                } else {
                    val clip = cm.primaryClip
                    resText = if (clip != null && clip.itemCount > 0) (clip.getItemAt(0).coerceToText(ctx)?.toString() ?: "") else ""
                }
            } finally {
                latch.countDown()
            }
        }
        latch.await(3, TimeUnit.SECONDS)
        return true to JSONObject().put("text", resText).toString()
    }

    private fun backup(): Pair<Boolean, String> {
        val cmd = "TS=\$(date +%Y%m%d-%H%M); OUT=\"backup-\$TS.tar.gz\"; " +
            "tar --exclude='node_modules' --exclude='.git' --exclude='.pm2' --exclude='.npm' --exclude='.cache' --exclude='backup-*.tar.gz' -czf \"\$OUT\" . 2>&1 && echo \"__FILE__:\$OUT\""
        val (ok, out) = Root.runLong(user, cmd, 300)
        val fileLine = out.lines().lastOrNull { it.startsWith("__FILE__:") }
        if (!ok || fileLine == null) return false to out.takeLast(1500).ifBlank { "Zaxira yaratib bo'lmadi" }
        val fname = fileLine.removePrefix("__FILE__:").trim()
        return true to "Zaxira yaratildi (Fayllar bo'limida): $fname"
    }
}
