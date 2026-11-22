package uz.dior.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Prefs(ctx).enabled) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, AgentService::class.java))
        }
    }
}
