package uz.dior.agent

import com.topjohnwu.superuser.Shell
import java.util.concurrent.TimeUnit

/**
 * Buyruqlarni root orqali, lekin Termux foydalanuvchisi nomidan bajaradi
 * (shunda fayllar root egaligiga o'tib ketmaydi).
 */
object Root {
    private val USER = Regex("^(u0_a\\d{1,6}|\\d{4,6})$")

    private const val ENV =
        "export PREFIX=/data/data/com.termux/files/usr; " +
        "export HOME=/data/data/com.termux/files/home; " +
        "export PATH=\$PREFIX/bin:\$PATH; " +
        "export LD_LIBRARY_PATH=\$PREFIX/lib; cd \$HOME; "

    fun isValidUser(user: String) = USER.matches(user)

    /**
     * "su user -c cmd" faqat UID'ni almashtiradi, lekin Termux ilovasiga android tomonidan
     * berilgan qo'shimcha guruhlarni (eng muhimi — "inet" guruhi, tarmoqqa chiqish huquqi)
     * olib o'tmaydi. Shuning uchun fayl bilan ishlash ishlayveradi-yu, git/curl/npm kabi
     * tarmoqqa chiquvchi buyruqlar "ruxsat yo'q" xatosi bilan to'xtaydi.
     *
     * Yechim: su'ga UID bilan birga kerakli qo'shimcha guruhlarni aniq ko'rsatamiz:
     * AID_INET=3003 (tarmoq), AID_NET_RAW=3004 (ping va shunga o'xshash). Bu guruh
     * raqamlari Android'da barcha versiyalarda bir xil va o'zgarmaydi.
     */
    private fun suUserSpec(user: String): String {
        val uid = if (user.startsWith("u0_a")) {
            10000 + (user.removePrefix("u0_a").toIntOrNull() ?: 0)
        } else {
            user.toIntOrNull() ?: 0
        }
        return "$uid:$uid,3003,3004"
    }

    fun run(user: String, cmd: String): Pair<Boolean, String> {
        if (!isValidUser(user)) {
            return false to "Termux foydalanuvchisi noto'g'ri yoki kiritilmagan (masalan: u0_a285)"
        }
        val inner = (ENV + cmd).replace("'", "'\\''")
        val r = Shell.cmd("su ${suUserSpec(user)} -c '$inner'").exec()
        return r.isSuccess to (r.out + r.err).joinToString("\n")
    }

    /**
     * Uzoq davom etadigan buyruqlar (git clone, npm install, fayl o'qish) uchun: alohida
     * jarayon, vaqt chegarasi bilan. Asosiy root shell band bo'lmaydi, shuning uchun
     * statistika to'xtab qolmaydi. [maxOutChars] — odatiy buyruqlar uchun kichik (log
     * suratini saqlash yetarli), fayl o'qishda (base64) buncha katta beriladi.
     */
    fun runLong(user: String, cmd: String, timeoutSec: Long, maxOutChars: Int = 200_000): Pair<Boolean, String> {
        if (!isValidUser(user)) {
            return false to "Termux foydalanuvchisi noto'g'ri yoki kiritilmagan (masalan: u0_a285)"
        }
        val inner = (ENV + cmd).replace("'", "'\\''")
        return try {
            val p = ProcessBuilder("su", "-c", "su ${suUserSpec(user)} -c '$inner'").redirectErrorStream(true).start()
            val out = StringBuffer()
            val reader = Thread {
                try {
                    p.inputStream.bufferedReader().forEachLine { if (out.length < maxOutChars) out.append(it).append('\n') }
                } catch (_: Exception) {
                }
            }
            reader.start()
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                reader.join(1000)
                return false to ("Vaqt tugadi ($timeoutSec soniya)\n" + out.toString().takeLast(1500))
            }
            reader.join(2000)
            (p.exitValue() == 0) to out.toString()
        } catch (e: Exception) {
            false to ("Buyruqni boshlab bo'lmadi: " + (e.message ?: ""))
        }
    }

    /**
     * Ma'lumotni (masalan yuklangan fayl baytlarini) jarayonning STDIN orqali uzatadi.
     * Shunday qilib fayl avval agentning o'z (boshqa UID'dagi) xususiy joyiga yozilmaydi —
     * UID farqidan kelib chiqadigan "ruxsat yo'q" muammosi butunlay oldini olinadi.
     */
    fun writeStdin(user: String, cmd: String, data: ByteArray, timeoutSec: Long): Pair<Boolean, String> {
        if (!isValidUser(user)) {
            return false to "Termux foydalanuvchisi noto'g'ri yoki kiritilmagan (masalan: u0_a285)"
        }
        val inner = (ENV + cmd).replace("'", "'\\''")
        return try {
            val p = ProcessBuilder("su", "-c", "su ${suUserSpec(user)} -c '$inner'").redirectErrorStream(true).start()
            val out = StringBuffer()
            val reader = Thread {
                try {
                    p.inputStream.bufferedReader().forEachLine { if (out.length < 50_000) out.append(it).append('\n') }
                } catch (_: Exception) {
                }
            }
            reader.start()
            p.outputStream.use { it.write(data); it.flush() }
            if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                reader.join(1000)
                return false to "Vaqt tugadi ($timeoutSec soniya)"
            }
            reader.join(2000)
            (p.exitValue() == 0) to out.toString()
        } catch (e: Exception) {
            false to ("Yozib bo'lmadi: " + (e.message ?: ""))
        }
    }

    /** Android holatini o'qish uchun (Termux muhitisiz). */
    fun raw(cmd: String): String = Shell.cmd(cmd).exec().out.joinToString("\n")

    /** Fon rejimida bajarish (natijani kutmaydi). */
    fun fireAndForget(cmd: String) {
        Shell.cmd("($cmd) >/dev/null 2>&1 &").exec()
    }
}
