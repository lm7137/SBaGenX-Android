package com.sbagenxandroid.sbagenx

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Process
import org.json.JSONObject
import java.util.concurrent.CancellationException
import kotlin.math.max

class PlaybackController(private val runtimeLoader: SbgRuntimeLoader) {
  private val lock = Any()

  @Volatile private var isPlaying = false
  @Volatile private var lastError: String? = null
  @Volatile private var startGeneration: Long = 0

  private var audioTrack: AudioTrack? = null
  private var playbackThread: Thread? = null
  private var bufferFrames: Int = 0
  private var activeSourceName: String? = null

  fun start(text: String, sourceName: String): String {
    stopInternal(join = true)

    val startToken =
        synchronized(lock) {
          startGeneration += 1
          activeSourceName = sourceName
          lastError = null
          bufferFrames = 0
          startGeneration
        }

    val preparedRuntime = runtimeLoader.prepareForPlayback(text, sourceName)
    val prepState = JSONObject(preparedRuntime.stateJson)
    if (isStartCancelled(startToken)) {
      preparedRuntime.mixInput?.decoder?.close()
      return getStateJson()
    }

    if (prepState.optInt("status", -1) != 0 || !prepState.optBoolean("prepared", false)) {
      preparedRuntime.mixInput?.decoder?.close()
      synchronized(lock) {
        lastError = prepState.optString("error").takeIf { it.isNotBlank() }
      }
      return buildStateJson(prepState)
    }

    val sampleRate = prepState.optInt("sampleRate", 44_100)
    val channelCount = prepState.optInt("channels", 2)
    require(channelCount == 2) {
      "Only stereo playback is supported by the current Android backend."
    }

    val frameSizeBytes = channelCount * 4
    val minBufferBytes =
        AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )
    val targetBufferBytes =
        max(
            if (minBufferBytes > 0) minBufferBytes else frameSizeBytes * 2048,
            frameSizeBytes * 2048,
        )

    val track =
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build(),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(targetBufferBytes)
            .build()

    require(track.state == AudioTrack.STATE_INITIALIZED) {
      "AudioTrack failed to initialize."
    }

    val resolvedBufferFrames = max(256, targetBufferBytes / frameSizeBytes)
    if (isStartCancelled(startToken)) {
      preparedRuntime.mixInput?.decoder?.close()
      releaseTrack(track)
      return getStateJson()
    }

    val mixDecoder = preparedRuntime.mixInput?.decoder
    val worker =
        Thread({
          Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
          val audioBuffer = FloatArray(resolvedBufferFrames * channelCount)
          val mixBuffer =
              if (mixDecoder != null) {
                ShortArray(resolvedBufferFrames * channelCount)
              } else {
                null
              }

          try {
            track.play()

            while (shouldContinuePlayback(startToken)) {
              val mixFrameCount =
                  if (mixDecoder != null && mixBuffer != null) {
                    mixDecoder.readFrames(mixBuffer, resolvedBufferFrames) {
                      !shouldContinuePlayback(startToken)
                    }
                  } else {
                    0
                  }

              val renderStatus =
                  SbagenxBridge.nativeRenderIntoBufferWithMix(
                      audioBuffer,
                      resolvedBufferFrames,
                      mixBuffer,
                      mixFrameCount,
                  )
              if (renderStatus != 0) {
                lastError = "Native render failed with status $renderStatus."
                break
              }

              var writtenValues = 0
              while (writtenValues < audioBuffer.size && shouldContinuePlayback(startToken)) {
                val written =
                    track.write(
                        audioBuffer,
                        writtenValues,
                        audioBuffer.size - writtenValues,
                        AudioTrack.WRITE_BLOCKING,
                    )
                if (written < 0) {
                  lastError = "AudioTrack write failed with status $written."
                  return@Thread
                }
                writtenValues += written
              }
            }
          } catch (_: CancellationException) {
          } catch (error: Throwable) {
            lastError = error.message ?: "Unexpected playback error."
          } finally {
            mixDecoder?.close()
            synchronized(lock) {
              if (startGeneration == startToken) {
                isPlaying = false
              }
            }
            releaseTrack(track)
            synchronized(lock) {
              if (audioTrack === track) {
                audioTrack = null
              }
              if (playbackThread === Thread.currentThread()) {
                playbackThread = null
              }
            }
          }
        }, "sbagenx-playback")

    synchronized(lock) {
      lastError = null
      bufferFrames = resolvedBufferFrames
      audioTrack = track
      playbackThread = worker
      isPlaying = true
    }

    worker.start()
    return getStateJson()
  }

  fun stop(): String {
    stopInternal(join = true)
    return getStateJson()
  }

  fun getStateJson(): String = buildStateJson(JSONObject(SbagenxBridge.nativeGetContextState()))

  private fun stopInternal(join: Boolean) {
    val threadToJoin: Thread?
    val trackToPause: AudioTrack?

    synchronized(lock) {
      startGeneration += 1
      isPlaying = false
      threadToJoin = playbackThread
      trackToPause = audioTrack
    }

    trackToPause?.pause()
    trackToPause?.flush()
    try {
      trackToPause?.stop()
    } catch (_: Throwable) {
    }

    if (join && threadToJoin != null && threadToJoin !== Thread.currentThread()) {
      threadToJoin.join(1500)
    }
  }

  private fun isStartCancelled(startToken: Long): Boolean = startGeneration != startToken

  private fun shouldContinuePlayback(startToken: Long): Boolean {
    return isPlaying && startGeneration == startToken
  }

  private fun releaseTrack(track: AudioTrack) {
    try {
      track.pause()
    } catch (_: Throwable) {
    }

    try {
      track.flush()
    } catch (_: Throwable) {
    }

    try {
      track.stop()
    } catch (_: Throwable) {
    }

    track.release()
  }

  private fun buildStateJson(nativeState: JSONObject): String {
    val sourceName = nativeState.optString("sourceName").takeIf { it.isNotBlank() }

    return JSONObject()
        .put("status", nativeState.optInt("status", 0))
        .put("statusText", nativeState.optString("statusText", "ok"))
        .put("prepared", nativeState.optBoolean("prepared", false))
        .put("active", isPlaying)
        .put("sampleRate", nativeState.optInt("sampleRate", 44_100))
        .put("channels", nativeState.optInt("channels", 2))
        .put("bufferFrames", bufferFrames)
        .put("timeSec", nativeState.optDouble("timeSec", 0.0))
        .put("durationSec", nativeState.optDouble("durationSec", 0.0))
        .put("sourceName", sourceName ?: activeSourceName.orEmpty())
        .put("mixActive", nativeState.optBoolean("mixActive", false))
        .put("mixLooping", nativeState.optBoolean("mixLooping", false))
        .put("mixPath", nativeState.optString("mixPath"))
        .put("mixSourceName", nativeState.optString("mixSourceName"))
        .put(
            "lastError",
            lastError ?: nativeState.optString("error").takeIf { it.isNotBlank() }.orEmpty(),
        )
        .toString()
  }
}
