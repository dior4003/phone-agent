package uz.dior.agent

import android.content.Context

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("agent", Context.MODE_PRIVATE)

    var url: String
        get() = sp.getString("url", "") ?: ""
        set(v) = sp.edit().putString("url", v).apply()

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) = sp.edit().putString("token", v).apply()

    /** Termux foydalanuvchisi, masalan u0_a285 (Termux'da `whoami`). */
    var termuxUser: String
        get() = sp.getString("termuxUser", "") ?: ""
        set(v) = sp.edit().putString("termuxUser", v).apply()

    /** Laravel loyiha papkasi (Termux home ichida), masalan myapp. */
    var laravelDir: String
        get() = sp.getString("laravelDir", "myapp") ?: "myapp"
        set(v) = sp.edit().putString("laravelDir", v).apply()

    var enabled: Boolean
        get() = sp.getBoolean("enabled", false)
        set(v) = sp.edit().putBoolean("enabled", v).apply()
}
