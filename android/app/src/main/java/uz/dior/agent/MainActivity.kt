package uz.dior.agent

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.topjohnwu.superuser.Shell

class MainActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var stateView: TextView
    private val tick = object : Runnable {
        override fun run() {
            stateView.text = "Agent holati: ${AgentService.state}"
            handler.postDelayed(this, 1500)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = Prefs(this)

        fun label(text: String) = TextView(this).apply {
            this.text = text
            textSize = 13f
            alpha = 0.7f
            setPadding(0, dp(14), 0, dp(2))
        }

        fun field(value: String, hintText: String, secret: Boolean = false) = EditText(this).apply {
            setText(value)
            hint = hintText
            setSingleLine()
            if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        val url = field(prefs.url, "wss://panel.sizningdomen.uz/agent")
        val token = field(prefs.token, "Agent token", secret = true)
        val user = field(prefs.termuxUser, "u0_a285")
        val laravel = field(prefs.laravelDir, "myapp")
        val tgToken = field(prefs.telegramBotToken, "123456:ABC-DEF... (@BotFather)", secret = true)
        val tgChatId = field(prefs.telegramChatId, "Masalan: 123456789 (@userinfobot)")
        val rootView = TextView(this).apply { text = "Root: tekshirilmoqda..." }
        stateView = TextView(this).apply { textSize = 15f; setPadding(0, dp(10), 0, dp(10)) }

        fun save() {
            prefs.url = url.text.toString().trim()
            prefs.token = token.text.toString().trim()
            prefs.termuxUser = user.text.toString().trim()
            prefs.laravelDir = laravel.text.toString().trim().ifEmpty { "myapp" }
            prefs.telegramBotToken = tgToken.text.toString().trim()
            prefs.telegramChatId = tgChatId.text.toString().trim()
        }

        val saveBtn = Button(this).apply {
            text = "Saqlash"
            setOnClickListener {
                save()
                stateView.text = "Saqlandi. Telegram sozlamalari ${if (prefs.telegramBotToken.isNotBlank()) "~5 soniyada" else "o'chirilgan holatda"} kuchga kiradi."
            }
        }
        val startBtn = Button(this).apply {
            text = "Agentni yoqish"
            setOnClickListener {
                save()
                if (!Root.isValidUser(prefs.termuxUser)) {
                    stateView.text = "Termux foydalanuvchisini kiriting (Termux'da: whoami)"
                    return@setOnClickListener
                }
                prefs.enabled = true
                ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, AgentService::class.java))
            }
        }
        val stopBtn = Button(this).apply {
            text = "Agentni o'chirish"
            setOnClickListener {
                prefs.enabled = false
                stopService(Intent(this@MainActivity, AgentService::class.java))
                AgentService.state = "O'chiq"
            }
        }
        val batteryBtn = Button(this).apply {
            text = "Batareya cheklovini o'chirish"
            setOnClickListener {
                val pm = getSystemService(PowerManager::class.java)
                if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                    )
                }
            }
        }

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(28))
            addView(TextView(this@MainActivity).apply { text = "Phone Agent"; textSize = 24f })
            addView(label("Server manzili"))
            addView(url)
            addView(label("Agent token (serverdagi .env dan)"))
            addView(token)
            addView(label("Termux foydalanuvchisi (Termux'da: whoami)"))
            addView(user)
            addView(label("Laravel loyiha papkasi (Termux home ichida)"))
            addView(laravel)
            addView(label("Telegram bot tokeni (ixtiyoriy, ogohlantirish uchun)"))
            addView(tgToken)
            addView(label("Telegram chat ID (ixtiyoriy)"))
            addView(tgChatId)
            addView(rootView as View)
            addView(stateView)
            addView(saveBtn)
            addView(startBtn)
            addView(stopBtn)
            addView(batteryBtn)
        }
        setContentView(ScrollView(this).apply { addView(col) })

        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        // Magisk root so'rovi ilova ochiq paytida chiqishi uchun
        Shell.getShell { shell ->
            rootView.text = if (shell.isRoot) "Root: bor" else "Root: yo'q (Magisk'da ruxsat bering)"
        }
    }

    override fun onResume() {
        super.onResume()
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }
}
