package uz.dior.agent

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class NotifListener : NotificationListenerService() {
    @Volatile private var lastSig = ""
    @Volatile private var lastAt = 0L

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        sbn ?: return
        val pkg = sbn.packageName ?: return
        if (pkg == packageName) return

        val n = sbn.notification ?: return
        // Doimiy fon bildirishnomalarini (masalan, musiqa pleyer, Termux sessiya, tizim) o'tkazib yuboramiz
        if ((n.flags and Notification.FLAG_ONGOING_EVENT) != 0) return
        if ((n.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0) return

        val ex = n.extras ?: return
        val title = (ex.getCharSequence(Notification.EXTRA_TITLE) ?: "").toString().trim()
        val big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT)
        val text = (big ?: ex.getCharSequence(Notification.EXTRA_TEXT) ?: "").toString().trim()
        if (title.isEmpty() && text.isEmpty()) return

        val sig = "$pkg|$title|$text"
        val now = System.currentTimeMillis()
        if (sig == lastSig && now - lastAt < 3000) return
        lastSig = sig
        lastAt = now

        val appName = try {
            val ai = packageManager.getApplicationInfo(pkg, 0)
            packageManager.getApplicationLabel(ai).toString()
        } catch (_: Exception) {
            pkg
        }
        val time = SimpleDateFormat("dd.MM.yyyy HH:mm:ss", Locale.getDefault()).format(Date(sbn.postTime))
        AgentService.sendNotification(appName, title, text.take(1500), time)
    }
}
