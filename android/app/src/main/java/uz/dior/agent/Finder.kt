package uz.dior.agent

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper

/**
 * "Telefonni topish" — signal/jim rejimidan qat'iy nazar baland ovoz chaladi
 * (ALARM ovoz oqimi orqali, chunki u jim rejimda ham eshitiladi).
 * Xavfsizlik uchun 2 daqiqadan keyin o'zi to'xtaydi.
 */
object Finder {
    private const val AUTO_STOP_MS = 120_000L
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var player: MediaPlayer? = null
    private var savedVolume: Int? = null
    private var am: AudioManager? = null

    @Synchronized
    fun start(ctx: Context) {
        if (player != null) return // allaqachon chalinmoqda
        val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am = audio
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        savedVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
        audio.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)

        val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
        val mp = MediaPlayer()
        try {
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            mp.setDataSource(ctx, uri)
            mp.isLooping = true
            mp.setOnPreparedListener { it.start() }
            mp.prepareAsync()
            player = mp
            handler.postDelayed({ stop() }, AUTO_STOP_MS)
        } catch (e: Exception) {
            mp.release()
            player = null
            restoreVolume()
        }
    }

    @Synchronized
    fun stop() {
        handler.removeCallbacksAndMessages(null)
        player?.let { p ->
            try { if (p.isPlaying) p.stop() } catch (_: Exception) {}
            p.release()
        }
        player = null
        restoreVolume()
    }

    fun isRinging() = player != null

    private fun restoreVolume() {
        val v = savedVolume
        if (v != null) try { am?.setStreamVolume(AudioManager.STREAM_ALARM, v, 0) } catch (_: Exception) {}
        savedVolume = null
    }
}
