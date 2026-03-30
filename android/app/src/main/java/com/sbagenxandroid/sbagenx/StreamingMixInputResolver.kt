package com.sbagenxandroid.sbagenx

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CancellationException
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

data class PreparedStreamingMixInput(
    val sourceName: String,
    val looping: Boolean,
    val decoder: StreamingMixInputResolver.StreamingMixDecoder,
)

class StreamingMixInputResolver(
    private val context: Context,
    private val documentStore: LocalDocumentStore,
) {
  fun open(
      mixPath: String,
      sourceName: String,
      targetSampleRate: Int,
  ): PreparedStreamingMixInput {
    val source = resolveSource(mixPath, sourceName)
    val looping = source.loopingHint || hasSbagenLooperMetadata(source)
    return PreparedStreamingMixInput(
        sourceName = source.displayName,
        looping = looping,
        decoder =
            StreamingMixDecoder(
                context = context,
                source = source,
                targetSampleRate = targetSampleRate.coerceAtLeast(1),
                looping = looping,
            ),
    )
  }

  private fun resolveSource(mixPath: String, sourceName: String): MixStreamSource {
    val normalizedPath = stripSectionSuffix(mixPath.trim())
    require(normalizedPath.isNotBlank()) { "Mix path cannot be blank." }

    if (normalizedPath.startsWith("asset://")) {
      return AssetMixStreamSource(
          assetPath = normalizedPath.removePrefix("asset://"),
          displayName = normalizedPath,
          loopingHint = true,
      )
    }

    if (normalizedPath.startsWith("asset:")) {
      return AssetMixStreamSource(
          assetPath = normalizedPath.removePrefix("asset:"),
          displayName = normalizedPath,
          loopingHint = true,
      )
    }

    if (normalizedPath.startsWith("content://")) {
      return UriMixStreamSource(
          uri = Uri.parse(normalizedPath),
          displayName = normalizedPath,
          loopingHint = false,
      )
    }

    if (normalizedPath.startsWith("file://")) {
      val filePath = Uri.parse(normalizedPath).path ?: throw IllegalArgumentException("Invalid file URI.")
      return FileMixStreamSource(
          file = File(filePath),
          displayName = normalizedPath,
          loopingHint = false,
      )
    }

    val absoluteFile = File(normalizedPath)
    if (absoluteFile.isAbsolute) {
      return FileMixStreamSource(
          file = absoluteFile,
          displayName = absoluteFile.absolutePath,
          loopingHint = false,
      )
    }

    documentStore.resolveLibraryDocument(normalizedPath, sourceName)?.let { libraryDocument ->
      return UriMixStreamSource(
          uri = libraryDocument.uri,
          displayName = libraryDocument.displayName,
          loopingHint = false,
      )
    }

    resolveRelativeFile(normalizedPath, sourceName)?.let { relativeFile ->
      return FileMixStreamSource(
          file = relativeFile,
          displayName = relativeFile.absolutePath,
          loopingHint = false,
      )
    }

    if (assetExists(normalizedPath)) {
      return AssetMixStreamSource(
          assetPath = normalizedPath,
          displayName = "asset:$normalizedPath",
          loopingHint = true,
      )
    }

    throw IllegalArgumentException(
        "Mix source '$mixPath' could not be resolved from app assets, file paths, or content URIs.",
    )
  }

  private fun stripSectionSuffix(path: String): String {
    val hashIndex = path.lastIndexOf('#')
    if (hashIndex <= 0 || hashIndex == path.length - 1) {
      return path
    }

    val suffix = path.substring(hashIndex + 1)
    if (suffix.all { it.isDigit() }) {
      throw IllegalArgumentException(
          "Mix sections (#n) are not supported by the Android runtime yet.",
      )
    }

    return path
  }

  private fun resolveRelativeFile(mixPath: String, sourceName: String): File? {
    if (sourceName.isBlank()) {
      return null
    }

    val directSource = File(sourceName)
    if (directSource.isAbsolute) {
      return directSource.parentFile?.resolve(mixPath)?.takeIf { it.isFile }
    }

    if (sourceName.startsWith("file://")) {
      val filePath = Uri.parse(sourceName).path ?: return null
      return File(filePath).parentFile?.resolve(mixPath)?.takeIf { it.isFile }
    }

    return null
  }

  private fun assetExists(assetPath: String): Boolean {
    return try {
      context.assets.open(assetPath).use { true }
    } catch (_: Throwable) {
      false
    }
  }

  private fun hasSbagenLooperMetadata(source: MixStreamSource): Boolean {
    source.openMetadataStream(context)?.use { stream ->
      val overlapSize = SBAGEN_LOOPER_MARKER.size - 1
      val buffer = ByteArray(8192)
      var carry = ByteArray(0)
      var scannedBytes = 0

      while (scannedBytes < MAX_LOOPER_SCAN_BYTES) {
        val read = stream.read(buffer, 0, min(buffer.size, MAX_LOOPER_SCAN_BYTES - scannedBytes))
        if (read < 0) {
          return false
        }
        scannedBytes += read

        val chunk = ByteArray(carry.size + read)
        System.arraycopy(carry, 0, chunk, 0, carry.size)
        System.arraycopy(buffer, 0, chunk, carry.size, read)
        if (indexOf(chunk, SBAGEN_LOOPER_MARKER) >= 0) {
          return true
        }

        val keep = min(overlapSize, chunk.size)
        carry = chunk.copyOfRange(chunk.size - keep, chunk.size)
      }
    }

    return false
  }

  private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
    if (needle.isEmpty() || haystack.size < needle.size) {
      return -1
    }

    val maxStart = haystack.size - needle.size
    for (start in 0..maxStart) {
      var matched = true
      for (offset in needle.indices) {
        if (haystack[start + offset] != needle[offset]) {
          matched = false
          break
        }
      }
      if (matched) {
        return start
      }
    }

    return -1
  }

  sealed interface MixStreamSource {
    val displayName: String
    val loopingHint: Boolean

    fun openDataSource(context: Context): OpenedDataSource

    fun openMetadataStream(context: Context): InputStream?
  }

  private data class FileMixStreamSource(
      val file: File,
      override val displayName: String,
      override val loopingHint: Boolean,
  ) : MixStreamSource {
    override fun openDataSource(context: Context): OpenedDataSource {
      require(file.isFile) { "Mix file '$displayName' was not found." }
      return FileDataSource(file)
    }

    override fun openMetadataStream(context: Context): InputStream? {
      return if (file.isFile) FileInputStream(file) else null
    }
  }

  private data class UriMixStreamSource(
      val uri: Uri,
      override val displayName: String,
      override val loopingHint: Boolean,
  ) : MixStreamSource {
    override fun openDataSource(context: Context): OpenedDataSource {
      return UriDataSource(context, uri, displayName)
    }

    override fun openMetadataStream(context: Context): InputStream? {
      return context.contentResolver.openInputStream(uri)
    }
  }

  private data class AssetMixStreamSource(
      val assetPath: String,
      override val displayName: String,
      override val loopingHint: Boolean,
  ) : MixStreamSource {
    override fun openDataSource(context: Context): OpenedDataSource {
      require(assetExists(context, assetPath)) {
        "Mix asset '$assetPath' was not found in the Android bundle."
      }

      return try {
        AssetDescriptorDataSource(context.assets.openFd(assetPath))
      } catch (_: Throwable) {
        TempAssetDataSource(context, assetPath)
      }
    }

    override fun openMetadataStream(context: Context): InputStream? {
      return try {
        context.assets.open(assetPath)
      } catch (_: Throwable) {
        null
      }
    }

    private fun assetExists(context: Context, assetPath: String): Boolean {
      return try {
        context.assets.open(assetPath).use { true }
      } catch (_: Throwable) {
        false
      }
    }
  }

  sealed interface OpenedDataSource : Closeable {
    fun setDataSource(extractor: MediaExtractor)
  }

  private class FileDataSource(private val file: File) : OpenedDataSource {
    override fun setDataSource(extractor: MediaExtractor) {
      extractor.setDataSource(file.absolutePath)
    }

    override fun close() = Unit
  }

  private class UriDataSource(
      private val context: Context,
      private val uri: Uri,
      private val displayName: String,
  ) : OpenedDataSource {
    override fun setDataSource(extractor: MediaExtractor) {
      try {
        extractor.setDataSource(context, uri, emptyMap())
      } catch (error: Throwable) {
        throw IllegalArgumentException(
            error.message ?: "Unable to open mix source '$displayName'.",
            error,
        )
      }
    }

    override fun close() = Unit
  }

  private class AssetDescriptorDataSource(
      private val descriptor: AssetFileDescriptor,
  ) : OpenedDataSource {
    override fun setDataSource(extractor: MediaExtractor) {
      extractor.setDataSource(
          descriptor.fileDescriptor,
          descriptor.startOffset,
          descriptor.length,
      )
    }

    override fun close() {
      descriptor.close()
    }
  }

  private class TempAssetDataSource(
      private val context: Context,
      private val assetPath: String,
  ) : OpenedDataSource {
    private val tempFile by lazy {
      val suffix =
          assetPath.substringAfterLast('.', missingDelimiterValue = "bin").let { ".$it" }
      val file = File.createTempFile("sbxasset-", suffix, context.cacheDir)
      context.assets.open(assetPath).use { input ->
        FileOutputStream(file).use { output ->
          input.copyTo(output)
        }
      }
      file
    }

    override fun setDataSource(extractor: MediaExtractor) {
      extractor.setDataSource(tempFile.absolutePath)
    }

    override fun close() {
      tempFile.delete()
    }
  }

  class StreamingMixDecoder internal constructor(
      private val context: Context,
      private val source: MixStreamSource,
      private val targetSampleRate: Int,
      val looping: Boolean,
  ) : Closeable {
    private val decodedFrames = StereoFrameQueue()

    private var openedDataSource: OpenedDataSource? = null
    private var extractor: MediaExtractor? = null
    private var decoder: MediaCodec? = null
    private var inputDone = false
    private var outputDone = false
    private var streamEnded = false
    private var outputSampleRate = targetSampleRate
    private var outputChannelCount = 2
    private var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
    private var sourceFrameCursor = 0.0

    fun readFrames(
        output: ShortArray,
        requestedFrames: Int,
        isCancelled: (() -> Boolean)? = null,
    ): Int {
      require(requestedFrames >= 0) { "requestedFrames must not be negative." }
      require(output.size >= requestedFrames * 2) {
        "Output buffer is too small for $requestedFrames stereo frames."
      }
      if (requestedFrames == 0) {
        return 0
      }

      ensureDecoderOpen()

      val step = outputSampleRate.toDouble() / targetSampleRate.toDouble()
      var producedFrames = 0

      while (producedFrames < requestedFrames) {
        ensureNotCancelled(isCancelled)
        if (!ensureFramesAvailable(sourceFrameCursor, isCancelled)) {
          break
        }

        val baseFrame = min(sourceFrameCursor.toInt(), decodedFrames.frameCount - 1)
        val nextFrame =
            if (decodedFrames.frameCount > baseFrame + 1) {
              baseFrame + 1
            } else {
              baseFrame
            }
        val frac = sourceFrameCursor - baseFrame

        output[producedFrames * 2] =
            interpolateSample(
                decodedFrames.leftAt(baseFrame),
                decodedFrames.leftAt(nextFrame),
                frac,
            )
        output[producedFrames * 2 + 1] =
            interpolateSample(
                decodedFrames.rightAt(baseFrame),
                decodedFrames.rightAt(nextFrame),
                frac,
            )

        producedFrames += 1
        sourceFrameCursor += step
        val discardFrames = sourceFrameCursor.toInt()
        if (discardFrames > 0) {
          decodedFrames.discardFrames(discardFrames)
          sourceFrameCursor -= discardFrames.toDouble()
        }
      }

      return producedFrames
    }

    override fun close() {
      closeDecoder()
      decodedFrames.clear()
    }

    private fun ensureDecoderOpen() {
      if (decoder != null) {
        return
      }

      val nextDataSource = source.openDataSource(context)
      val nextExtractor = MediaExtractor()

      try {
        nextDataSource.setDataSource(nextExtractor)
        val trackIndex = findAudioTrack(nextExtractor)
        require(trackIndex >= 0) {
          "No audio track was found in mix source '${source.displayName}'."
        }

        nextExtractor.selectTrack(trackIndex)
        val inputFormat = nextExtractor.getTrackFormat(trackIndex)
        val mime = inputFormat.getString(MediaFormat.KEY_MIME)
            ?: throw IllegalArgumentException("Unsupported mix format: missing MIME type.")

        val nextDecoder = MediaCodec.createDecoderByType(mime)
        nextDecoder.configure(inputFormat, null, null, 0)
        nextDecoder.start()

        openedDataSource = nextDataSource
        extractor = nextExtractor
        decoder = nextDecoder
        inputDone = false
        outputDone = false
        streamEnded = false
        outputSampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        outputChannelCount = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        pcmEncoding = AudioFormat.ENCODING_PCM_16BIT
      } catch (error: Throwable) {
        nextExtractor.release()
        nextDataSource.close()
        throw error
      }
    }

    private fun restartDecoder() {
      closeDecoder()
      ensureDecoderOpen()
    }

    private fun closeDecoder() {
      try {
        decoder?.stop()
      } catch (_: Throwable) {
      }
      decoder?.release()
      decoder = null
      extractor?.release()
      extractor = null
      openedDataSource?.close()
      openedDataSource = null
      inputDone = false
      outputDone = false
      streamEnded = false
    }

    private fun ensureFramesAvailable(
        cursor: Double,
        isCancelled: (() -> Boolean)?,
    ): Boolean {
      while (true) {
        val baseFrame = cursor.toInt()
        val availableFrames = decodedFrames.frameCount

        if (availableFrames > baseFrame + 1) {
          return true
        }

        if (outputDone) {
          if (looping) {
            restartDecoder()
            continue
          }
          return availableFrames > baseFrame
        }

        if (!decodeNextChunk(isCancelled)) {
          outputDone = true
        }
      }
    }

    private fun decodeNextChunk(isCancelled: (() -> Boolean)?): Boolean {
      val activeDecoder = decoder ?: return false
      val activeExtractor = extractor ?: return false
      val info = MediaCodec.BufferInfo()

      while (true) {
        ensureNotCancelled(isCancelled)

        if (!inputDone) {
          val inputIndex = activeDecoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputIndex >= 0) {
            val inputBuffer =
                activeDecoder.getInputBuffer(inputIndex)
                    ?: throw IllegalStateException("MediaCodec returned a null input buffer.")
            val sampleSize = activeExtractor.readSampleData(inputBuffer, 0)
            if (sampleSize < 0) {
              activeDecoder.queueInputBuffer(
                  inputIndex,
                  0,
                  0,
                  0,
                  MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              inputDone = true
            } else {
              activeDecoder.queueInputBuffer(
                  inputIndex,
                  0,
                  sampleSize,
                  activeExtractor.sampleTime,
                  activeExtractor.sampleFlags,
              )
              activeExtractor.advance()
            }
          }
        }

        when (val outputIndex = activeDecoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> {
            if (inputDone) {
              return false
            }
          }
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = activeDecoder.outputFormat
            outputSampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            outputChannelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            pcmEncoding =
                if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) {
                  format.getInteger(MediaFormat.KEY_PCM_ENCODING)
                } else {
                  AudioFormat.ENCODING_PCM_16BIT
                }
          }
          else -> {
            if (outputIndex >= 0) {
              var appendedFrames = 0
              if (info.size > 0) {
                val outputBuffer =
                    activeDecoder.getOutputBuffer(outputIndex)
                        ?: throw IllegalStateException("MediaCodec returned a null output buffer.")
                outputBuffer.position(info.offset)
                outputBuffer.limit(info.offset + info.size)
                appendedFrames =
                    decodedFrames.append(
                        outputBuffer.slice(),
                        pcmEncoding,
                        outputChannelCount,
                    )
              }

              val reachedEnd = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
              activeDecoder.releaseOutputBuffer(outputIndex, false)
              if (reachedEnd) {
                outputDone = true
              }
              if (appendedFrames > 0) {
                return true
              }
              if (reachedEnd) {
                return false
              }
            }
          }
        }
      }
    }

    private fun interpolateSample(current: Short, next: Short, frac: Double): Short {
      val currentValue = current.toInt()
      val nextValue = next.toInt()
      val interpolated = currentValue + (nextValue - currentValue) * frac
      return interpolated.roundToInt()
          .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
          .toShort()
    }

    private fun ensureNotCancelled(isCancelled: (() -> Boolean)?) {
      if (isCancelled?.invoke() == true) {
        throw CancellationException("Mix streaming cancelled.")
      }
    }
  }

  private class StereoFrameQueue {
    private var data = ShortArray(8192)
    private var start = 0
    private var size = 0

    val frameCount: Int
      get() = size / 2

    fun clear() {
      start = 0
      size = 0
    }

    fun append(buffer: ByteBuffer, pcmEncoding: Int, channelCount: Int): Int {
      require(channelCount > 0) { "Mix decoder reported an invalid channel count." }
      val ordered = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
      val beforeSize = size

      while (ordered.hasRemaining()) {
        var left: Short = 0
        var right: Short = 0
        for (channelIndex in 0 until channelCount) {
          val sample = readSample(ordered, pcmEncoding)
          when (channelIndex) {
            0 -> left = sample
            1 -> right = sample
          }
        }

        if (channelCount == 1) {
          right = left
        }

        appendStereo(left, right)
      }

      return (size - beforeSize) / 2
    }

    fun leftAt(frameIndex: Int): Short = sampleAt(frameIndex * 2)

    fun rightAt(frameIndex: Int): Short = sampleAt(frameIndex * 2 + 1)

    fun discardFrames(frameCount: Int) {
      if (frameCount <= 0 || size == 0) {
        return
      }

      val discardShorts = min(frameCount * 2, size)
      start = (start + discardShorts) % data.size
      size -= discardShorts
      if (size == 0) {
        start = 0
      }
    }

    private fun appendStereo(left: Short, right: Short) {
      ensureCapacity(size + 2)
      data[(start + size) % data.size] = left
      data[(start + size + 1) % data.size] = right
      size += 2
    }

    private fun sampleAt(index: Int): Short {
      require(index in 0 until size) { "Requested sample index $index outside queue of size $size." }
      return data[(start + index) % data.size]
    }

    private fun ensureCapacity(requiredSize: Int) {
      if (requiredSize <= data.size) {
        return
      }

      var nextCapacity = data.size
      while (nextCapacity < requiredSize) {
        nextCapacity *= 2
      }

      val nextData = ShortArray(nextCapacity)
      for (index in 0 until size) {
        nextData[index] = data[(start + index) % data.size]
      }
      data = nextData
      start = 0
    }

    private fun readSample(buffer: ByteBuffer, pcmEncoding: Int): Short {
      return when (pcmEncoding) {
        AudioFormat.ENCODING_PCM_16BIT -> buffer.short
        AudioFormat.ENCODING_PCM_FLOAT -> {
          val normalized = buffer.float.coerceIn(-1.0f, 1.0f)
          (normalized * Short.MAX_VALUE.toFloat()).roundToInt().toShort()
        }
        AudioFormat.ENCODING_PCM_8BIT -> (((buffer.get().toInt() and 0xff) - 128) shl 8).toShort()
        AudioFormat.ENCODING_PCM_32BIT -> (buffer.int shr 16).toShort()
        else ->
            throw IllegalArgumentException(
                "Unsupported decoded PCM encoding: $pcmEncoding",
            )
      }
    }
  }

  companion object {
    private val SBAGEN_LOOPER_MARKER = "SBAGEN_LOOPER=".toByteArray(Charsets.US_ASCII)
    private const val MAX_LOOPER_SCAN_BYTES = 262_144
    private const val CODEC_TIMEOUT_US = 10_000L

    private fun findAudioTrack(extractor: MediaExtractor): Int {
      for (trackIndex in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(trackIndex)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) {
          return trackIndex
        }
      }

      return -1
    }
  }
}
