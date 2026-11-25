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

    /** Telegram bot tokeni (ogohlantirishlar uchun). Serverdagi .env o'rniga shu yerdan ham sozlash mumkin. */
    var telegramBotToken: String
        get() = sp.getString("tgToken", "") ?: ""
        set(v) = sp.edit().putString("tgToken", v).apply()

    /** Telegram chat ID (shaxsiy yoki guruh). */
    var telegramChatId: String
        get() = sp.getString("tgChatId", "") ?: ""
        set(v) = sp.edit().putString("tgChatId", v).apply()

    var chargeLimitEnabled: Boolean
        get() = sp.getBoolean("chargeLimitEnabled", false)
        set(v) = sp.edit().putBoolean("chargeLimitEnabled", v).apply()

    var chargeMin: Int
        get() = sp.getInt("chargeMin", 50)
        set(v) = sp.edit().putInt("chargeMin", v.coerceIn(20, 90)).apply()

    var chargeMax: Int
        get() = sp.getInt("chargeMax", 80)
        set(v) = sp.edit().putInt("chargeMax", v.coerceIn(30, 95)).apply()
}
