package uz.dior.agent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Base64
import androidx.core.content.ContextCompat

class AudioWalkie(private val ctx: Context) {
    private val sampleRate = 16000
    private var track: AudioTrack? = null
    @Volatile private var recording = false
    private var recThread: Thread? = null

    private fun ensureTrack(): AudioTrack? {
        track?.let { if (it.state == AudioTrack.STATE_INITIALIZED) return it }
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(4096)
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(minBuf * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        if (t.state != AudioTrack.STATE_INITIALIZED) return null
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        am.setStreamVolume(AudioManager.STREAM_MUSIC, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC), 0)
        t.play()
        track = t
        return t
    }

    fun playChunk(b64: String) {
        if (b64.isEmpty()) return
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            ensureTrack()?.write(bytes, 0, bytes.size)
        } catch (_: Exception) {
        }
    }

    fun startMic(onChunk: (String) -> Unit): Boolean {
        if (recording) return true
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(3840)
        val rec = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2
            )
        } catch (_: Exception) {
            return false
        }
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            return false
        }
        recording = true
        rec.startRecording()
        recThread = Thread {
            val buf = ByteArray(1920) // 60ms @ 16kHz 16-bit mono
            try {
                while (recording) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) {
                        val b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)
                        onChunk(b64)
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { rec.stop() } catch (_: Exception) {}
                rec.release()
            }
        }.apply { start() }
        return true
    }

    fun stopMic() {
        recording = false
        recThread?.interrupt()
        recThread = null
    }

    fun release() {
        stopMic()
        try { track?.stop() } catch (_: Exception) {}
        try { track?.release() } catch (_: Exception) {}
        track = null
    }
}
