package uz.dior.agent

import android.Manifest
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
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
    private lateinit var statusPill: TextView
    private lateinit var rootBadge: TextView
    private lateinit var msgView: TextView
    private lateinit var notifBtnView: Button

    private val cBg = Color.parseColor("#0E1522")
    private val cCard = Color.parseColor("#151E2F")
    private val cInput = Color.parseColor("#0B111C")
    private val cLine = Color.parseColor("#26334B")
    private val cInk = Color.parseColor("#E6ECF6")
    private val cMute = Color.parseColor("#94A5BF")
    private val cAccent = Color.parseColor("#2F5BEA")
    private val cOk = Color.parseColor("#4CD09A")
    private val cWarn = Color.parseColor("#F0B24A")
    private val cBad = Color.parseColor("#FF8A80")

    private val tick = object : Runnable {
        override fun run() {
            val st = AgentService.state
            statusPill.text = st
            val color = when {
                st == "Ulangan" -> cOk
                st.contains("Ulanmoqda") || st.contains("qayta") -> cWarn
                else -> cBad
            }
            statusPill.setTextColor(color)
            (statusPill.background as? GradientDrawable)?.setStroke(dp(1), color)
            handler.postDelayed(this, 1500)
        }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun box(bg: Int, stroke: Int = 0, radiusDp: Int = 12) = GradientDrawable().apply {
        setColor(bg)
        cornerRadius = dp(radiusDp).toFloat()
        if (stroke != 0) setStroke(dp(1), stroke)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        supportActionBar?.hide()
        window.statusBarColor = cBg
        window.navigationBarColor = cBg

        val prefs = Prefs(this)

        fun card(title: String, build: LinearLayout.() -> Unit) = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = box(cCard, cLine, 14)
            setPadding(dp(16), dp(14), dp(16), dp(16))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(14) }
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 15f
                setTypeface(null, Typeface.BOLD)
                setTextColor(cInk)
                setPadding(0, 0, 0, dp(6))
            })
            build()
        }

        fun label(text: String) = TextView(this).apply {
            this.text = text
            textSize = 12.5f
            setTextColor(cMute)
            setPadding(0, dp(10), 0, dp(4))
        }

        fun field(value: String, hintText: String, secret: Boolean = false) = EditText(this).apply {
            setText(value)
            hint = hintText
            setTextColor(cInk)
            setHintTextColor(Color.parseColor("#566883"))
            textSize = 14.5f
            background = box(cInput, cLine, 9)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setSingleLine()
            if (secret) inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        fun styledBtn(label: String, bg: Int, fg: Int, stroke: Int = 0, weight: Float = 0f) = Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setTextColor(fg)
            background = box(bg, stroke, 10)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            minHeight = dp(44)
            stateListAnimator = null
            if (weight > 0f) {
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, weight)
            }
        }

        val url = field(prefs.url, "wss://panel.sizningdomen.uz/agent")
        val token = field(prefs.token, "Agent token", secret = true)
        val user = field(prefs.termuxUser, "u0_a285")
        val laravel = field(prefs.laravelDir, "myapp")
        val tgToken = field(prefs.telegramBotToken, "123456:ABC-DEF... (@BotFather)", secret = true)
        val tgChatId = field(prefs.telegramChatId, "Masalan: 123456789 (@userinfobot)")

        statusPill = TextView(this).apply {
            text = AgentService.state
            textSize = 12.5f
            setTypeface(null, Typeface.BOLD)
            setTextColor(cBad)
            background = box(cCard, cBad, 99)
            setPadding(dp(12), dp(4), dp(12), dp(4))
        }
        rootBadge = TextView(this).apply {
            text = "Root: tekshirilmoqda…"
            textSize = 12.5f
            setTextColor(cMute)
            setPadding(0, dp(4), 0, 0)
        }
        msgView = TextView(this).apply {
            textSize = 13.5f
            setTextColor(cOk)
            setPadding(0, dp(8), 0, dp(4))
            visibility = View.GONE
        }

        fun showMsg(text: String, bad: Boolean = false) {
            msgView.text = text
            msgView.setTextColor(if (bad) cBad else cOk)
            msgView.visibility = View.VISIBLE
        }

        fun detectTermuxUser(silent: Boolean = false) {
            Shell.cmd("stat -c %U /data/data/com.termux/files/home 2>/dev/null || stat -c %u /data/data/com.termux/files/home 2>/dev/null").submit { r ->
                val detected = r.out.joinToString("").trim()
                if (r.isSuccess && Root.isValidUser(detected)) {
                    user.setText(detected)
                    prefs.termuxUser = detected
                    if (!silent) showMsg("Termux foydalanuvchisi aniqlandi: $detected")
                } else if (!silent) {
                    showMsg("Aniqlab bo'lmadi (Root ruxsati va Termux o'rnatilganini tekshiring)", true)
                }
            }
        }

        fun save() {
            prefs.url = url.text.toString().trim()
            prefs.token = token.text.toString().trim()
            prefs.termuxUser = user.text.toString().trim()
            prefs.laravelDir = laravel.text.toString().trim().ifEmpty { "myapp" }
            prefs.telegramBotToken = tgToken.text.toString().trim()
            prefs.telegramChatId = tgChatId.text.toString().trim()
        }

        val startBtn = styledBtn("Agentni yoqish", cAccent, Color.WHITE, weight = 1f).apply {
            setOnClickListener {
                save()
                if (!Root.isValidUser(prefs.termuxUser)) {
                    showMsg("Avval Termux foydalanuvchisini kiriting yoki 'Aniqlash' ni bosing", true)
                    return@setOnClickListener
                }
                prefs.enabled = true
                ContextCompat.startForegroundService(this@MainActivity, Intent(this@MainActivity, AgentService::class.java))
                showMsg("Agent ishga tushirildi")
            }
        }
        val stopBtn = styledBtn("O'chirish", Color.TRANSPARENT, cBad, cBad, weight = 1f).apply {
            setOnClickListener {
                prefs.enabled = false
                stopService(Intent(this@MainActivity, AgentService::class.java))
                AgentService.state = "O'chiq"
                showMsg("Agent to'xtatildi")
            }
        }
        val detectBtn = styledBtn("Aniqlash", cInput, cInk, cLine).apply {
            setOnClickListener { detectTermuxUser(false) }
        }
        val batteryBtn = styledBtn("Batareya cheklovini o'chirish", Color.TRANSPARENT, cMute, cLine).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(10) }
            setOnClickListener {
                val pm = getSystemService(PowerManager::class.java)
                if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                    )
                } else {
                    showMsg("Batareya cheklovi allaqachon o'chirilgan")
                }
            }
        }
        val saveBtn = styledBtn("Sozlamalarni saqlash", cAccent, Color.WHITE).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4); bottomMargin = dp(12) }
            setOnClickListener {
                save()
                showMsg("Saqlandi. Telegram sozlamalari ${if (prefs.telegramBotToken.isNotBlank()) "~5 soniyada" else "o'chirilgan holatda"} kuchga kiradi.")
            }
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(16))
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(TextView(this@MainActivity).apply {
                    text = "Phone Agent  v${BuildConfig.VERSION_NAME}"
                    textSize = 21f
                    setTypeface(null, Typeface.BOLD)
                    setTextColor(cInk)
                })
                addView(rootBadge)
            })
            addView(statusPill)
        }

        val rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(cBg)
            setPadding(dp(16), dp(20), dp(16), dp(28))

            addView(header)
            addView(msgView)

            addView(card("Boshqaruv") {
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    addView(startBtn)
                    addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
                    addView(stopBtn)
                })
                addView(batteryBtn)
            })

            addView(card("Server ulanishi") {
                addView(label("Server manzili"))
                addView(url)
                addView(label("Agent token (serverdagi .env dan)"))
                addView(token)
            })

            addView(card("Termux va Loyiha") {
                addView(label("Termux foydalanuvchisi (masalan: u0_a285)"))
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(user.apply {
                        layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    })
                    addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
                    addView(detectBtn)
                })
                addView(label("Laravel loyiha papkasi (Termux home ichida)"))
                addView(laravel)
            })

            notifBtnView = styledBtn("Bildirishnomalarni Telegramga ulash (Ruxsat)", Color.TRANSPARENT, cAccent, cLine).apply {
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(12) }
                setOnClickListener {
                    startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                }
            }
            addView(card("Telegram ogohlantirishlari (ixtiyoriy)") {
                addView(label("Telegram bot tokeni"))
                addView(tgToken)
                addView(label("Telegram chat ID"))
                addView(tgChatId)
                addView(notifBtnView)
            })

            addView(saveBtn)
        }

        setContentView(ScrollView(this).apply {
            setBackgroundColor(cBg)
            isFillViewport = true
            addView(rootLayout)
        })

        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        requestPermissions(perms.toTypedArray(), 1)
        Shell.getShell { shell ->
            if (shell.isRoot) {
                rootBadge.text = "Root: ulangan"
                rootBadge.setTextColor(cOk)
                if (prefs.termuxUser.isBlank()) detectTermuxUser(silent = true)
            } else {
                rootBadge.text = "Root: yo'q (Magisk/KernelSU da ruxsat bering)"
                rootBadge.setTextColor(cBad)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: ""
        if (enabled.contains(packageName)) {
            notifBtnView.text = "✓ Bildirishnomalar Telegramga ulangan"
            notifBtnView.setTextColor(cOk)
        } else {
            notifBtnView.text = "Bildirishnomalarni Telegramga ulash (Ruxsat)"
            notifBtnView.setTextColor(cAccent)
        }
        handler.post(tick)
    }

    override fun onPause() {
        handler.removeCallbacks(tick)
        super.onPause()
    }
}
