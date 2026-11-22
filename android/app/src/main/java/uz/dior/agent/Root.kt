package uz.dior.agent

import com.topjohnwu.superuser.Shell

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

    /** Android holatini o'qish uchun (Termux muhitisiz). */
    fun raw(cmd: String): String = Shell.cmd(cmd).exec().out.joinToString("\n")

    /** Fon rejimida bajarish (natijani kutmaydi). */
    fun fireAndForget(cmd: String) {
        Shell.cmd("($cmd) >/dev/null 2>&1 &").exec()
    }
}
