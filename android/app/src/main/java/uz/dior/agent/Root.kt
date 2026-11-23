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

    fun run(user: String, cmd: String): Pair<Boolean, String> {
        if (!isValidUser(user)) {
            return false to "Termux foydalanuvchisi noto'g'ri yoki kiritilmagan (masalan: u0_a285)"
        }
        val inner = (ENV + cmd).replace("'", "'\\''")
        val r = Shell.cmd("su $user -c '$inner'").exec()
        return r.isSuccess to (r.out + r.err).joinToString("\n")
    }

    /**
     * Uzoq davom etadigan buyruqlar (git clone, npm install) uchun: alohida jarayon, vaqt chegarasi bilan.
     * Asosiy root shell band bo'lmaydi, shuning uchun statistika to'xtab qolmaydi.
     */
    fun runLong(user: String, cmd: String, timeoutSec: Long): Pair<Boolean, String> {
        if (!isValidUser(user)) {
            return false to "Termux foydalanuvchisi noto'g'ri yoki kiritilmagan (masalan: u0_a285)"
        }
        val inner = (ENV + cmd).replace("'", "'\\''")
        return try {
            val p = ProcessBuilder("su", "-c", "su $user -c '$inner'").redirectErrorStream(true).start()
            val out = StringBuffer()
            val reader = Thread {
                try {
                    p.inputStream.bufferedReader().forEachLine { if (out.length < 200_000) out.append(it).append('\n') }
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

    /** Android holatini o'qish uchun (Termux muhitisiz). */
    fun raw(cmd: String): String = Shell.cmd(cmd).exec().out.joinToString("\n")

    /** Fon rejimida bajarish (natijani kutmaydi). */
    fun fireAndForget(cmd: String) {
        Shell.cmd("($cmd) >/dev/null 2>&1 &").exec()
    }
}
