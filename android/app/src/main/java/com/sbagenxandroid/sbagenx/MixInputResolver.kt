package com.sbagenxandroid.sbagenx

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

data class PreparedMixInput(
    val sourceName: String,
    val samples: ShortArray,
    val looping: Boolean,
)

class MixInputResolver(
    private val context: Context,
    private val documentStore: LocalDocumentStore,
) {
  fun resolve(
      mixPath: String,
      sourceName: String,
      targetSampleRate: Int,
      mixLooperSpec: String? = null,
  ): PreparedMixInput {
    val resolvedSource = stageSource(mixPath, sourceName)
    val explicitLooperSpec = mixLooperSpec?.trim()?.takeIf { it.isNotEmpty() }

    try {
      val decoded = decodeToStereoPcm(resolvedSource.file)
      val outputSamples =
          if (decoded.sampleRate == targetSampleRate || targetSampleRate <= 0) {
            decoded.samples
          } else {
            resampleStereo(decoded.samples, decoded.sampleRate, targetSampleRate)
          }

      if (explicitLooperSpec != null) {
        if (resolvedSource.format !in setOf(MixFormat.OGG, MixFormat.FLAC, MixFormat.MP3)) {
          throw IllegalArgumentException(
              "SBAGEN_LOOPER override is currently supported only for OGG, MP3 and FLAC mix inputs.",
          )
        }

        val effectiveRate = if (targetSampleRate > 0) targetSampleRate else decoded.sampleRate
        val parsed =
            org.json.JSONObject(
                SbagenxBridge.nativeParseMixLooperSpec(
                    explicitLooperSpec,
                    effectiveRate,
                    outputSamples.size / 2,
                    0,
                ),
            )
        if (parsed.optInt("status", -1) != 0) {
          throw IllegalArgumentException(
              parsed.optString("error").ifBlank { "Invalid SBAGEN_LOOPER override." },
          )
        }
      }

      return PreparedMixInput(
          sourceName = resolvedSource.displayName,
          samples = outputSamples,
          looping =
              explicitLooperSpec != null ||
                  resolvedSource.loopingHint ||
                  hasSbagenLooperMetadata(resolvedSource.file),
      )
    } finally {
      resolvedSource.file.delete()
    }
  }

  private fun stageSource(mixPath: String, sourceName: String): StagedMixSource {
    val normalizedPath = stripSectionSuffix(mixPath.trim())
    require(normalizedPath.isNotBlank()) { "Mix path cannot be blank." }

    if (normalizedPath.startsWith("asset://")) {
      return copyAssetToTempFile(normalizedPath.removePrefix("asset://"), normalizedPath, false)
    }

    if (normalizedPath.startsWith("asset:")) {
      return copyAssetToTempFile(normalizedPath.removePrefix("asset:"), normalizedPath, false)
    }

    if (normalizedPath.startsWith("content://")) {
      val uri = Uri.parse(normalizedPath)
      val displayName = queryDisplayName(uri) ?: normalizedPath
      return copyInputStreamToTempFile(
          displayName = displayName,
          loopingHint = false,
          inputStream = context.contentResolver.openInputStream(uri)
              ?: throw IllegalArgumentException("Unable to open mix content URI."),
          preferredExtension = extensionFor(normalizedPath),
          format = inferFormat(displayName),
      )
    }

    if (normalizedPath.startsWith("file://")) {
      val filePath = Uri.parse(normalizedPath).path ?: throw IllegalArgumentException("Invalid file URI.")
      return copyFileToTempFile(File(filePath), normalizedPath)
    }

    val absoluteFile = File(normalizedPath)
    if (absoluteFile.isAbsolute) {
      return copyFileToTempFile(absoluteFile, absoluteFile.absolutePath)
    }

    documentStore.resolveLibraryDocument(normalizedPath, sourceName)?.let { libraryDocument ->
      return copyInputStreamToTempFile(
          displayName = libraryDocument.displayName,
          loopingHint = false,
          inputStream =
              context.contentResolver.openInputStream(libraryDocument.uri)
                  ?: throw IllegalArgumentException("Unable to open mix file '${libraryDocument.relativePath}'."),
          preferredExtension = extensionFor(libraryDocument.relativePath),
          format = inferFormat(libraryDocument.relativePath),
      )
    }

    resolveRelativeFile(normalizedPath, sourceName)?.let { relativeFile ->
      return copyFileToTempFile(relativeFile, relativeFile.absolutePath)
    }

    if (assetExists(normalizedPath)) {
      return copyAssetToTempFile(normalizedPath, "asset:$normalizedPath", false)
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

  private fun copyFileToTempFile(file: File, displayName: String): StagedMixSource {
    require(file.isFile) { "Mix file '$displayName' was not found." }
    return copyInputStreamToTempFile(
        displayName = displayName,
        loopingHint = false,
        inputStream = FileInputStream(file),
        preferredExtension = extensionFor(file.name),
        format = inferFormat(file.name),
    )
  }

  private fun copyAssetToTempFile(
      assetPath: String,
      displayName: String,
      loopingHint: Boolean,
  ): StagedMixSource {
    require(assetExists(assetPath)) { "Mix asset '$assetPath' was not found in the Android bundle." }

    return copyInputStreamToTempFile(
        displayName = displayName,
        loopingHint = loopingHint,
        inputStream = context.assets.open(assetPath),
        preferredExtension = extensionFor(assetPath),
        format = inferFormat(assetPath),
    )
  }

  private fun copyInputStreamToTempFile(
      displayName: String,
      loopingHint: Boolean,
      inputStream: InputStream,
      preferredExtension: String,
      format: MixFormat,
  ): StagedMixSource {
    val tempFile = File.createTempFile("sbxmix-", preferredExtension, context.cacheDir)
    inputStream.use { source ->
      FileOutputStream(tempFile).use { sink ->
        source.copyTo(sink)
      }
    }

    return StagedMixSource(
        displayName = displayName,
        file = tempFile,
        loopingHint = loopingHint,
        format = format,
    )
  }

  private fun assetExists(assetPath: String): Boolean {
    return try {
      context.assets.open(assetPath).use { true }
    } catch (_: Throwable) {
      false
    }
  }

  private fun extensionFor(path: String): String {
    val dot = path.lastIndexOf('.')
    if (dot < 0 || dot >= path.length - 1) {
      return ".bin"
    }

    val raw = path.substring(dot)
    return if (raw.length <= 10) raw else ".bin"
  }

  private fun inferFormat(pathHint: String): MixFormat {
    val normalized = pathHint.lowercase()
    return when {
      normalized.endsWith(".ogg") -> MixFormat.OGG
      normalized.endsWith(".flac") -> MixFormat.FLAC
      normalized.endsWith(".mp3") -> MixFormat.MP3
      normalized.endsWith(".wav") -> MixFormat.WAV
      else -> MixFormat.UNKNOWN
    }
  }

  private fun queryDisplayName(uri: Uri): String? {
    return context.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (!cursor.moveToFirst()) {
            return@use null
          }
          val columnIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (columnIndex >= 0) {
            cursor.getString(columnIndex)
          } else {
            null
          }
        }
  }

  private fun decodeToStereoPcm(file: File): DecodedStereoPcm {
    val extractor = MediaExtractor()
    var decoder: MediaCodec? = null

    try {
      extractor.setDataSource(file.absolutePath)
      val trackIndex = findAudioTrack(extractor)
      require(trackIndex >= 0) { "No audio track was found in mix source '${file.name}'." }

      extractor.selectTrack(trackIndex)
      val inputFormat = extractor.getTrackFormat(trackIndex)
      val mime = inputFormat.getString(MediaFormat.KEY_MIME)
          ?: throw IllegalArgumentException("Unsupported mix format: missing MIME type.")

      decoder = MediaCodec.createDecoderByType(mime)
      decoder.configure(inputFormat, null, null, 0)
      decoder.start()

      val output = StereoShortBuffer()
      val info = MediaCodec.BufferInfo()
      var inputDone = false
      var outputDone = false
      var outputSampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var outputChannelCount = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var pcmEncoding = AudioFormat.ENCODING_PCM_16BIT

      while (!outputDone) {
        if (!inputDone) {
          val inputIndex = decoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inputIndex >= 0) {
            val inputBuffer =
                decoder.getInputBuffer(inputIndex)
                    ?: throw IllegalStateException("MediaCodec returned a null input buffer.")
            val sampleSize = extractor.readSampleData(inputBuffer, 0)

            if (sampleSize < 0) {
              decoder.queueInputBuffer(
                  inputIndex,
                  0,
                  0,
                  0,
                  MediaCodec.BUFFER_FLAG_END_OF_STREAM,
              )
              inputDone = true
            } else {
              decoder.queueInputBuffer(
                  inputIndex,
                  0,
                  sampleSize,
                  extractor.sampleTime,
                  extractor.sampleFlags,
              )
              extractor.advance()
            }
          }
        }

        when (val outputIndex = decoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)) {
          MediaCodec.INFO_TRY_AGAIN_LATER -> Unit
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            val format = decoder.outputFormat
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
              if (info.size > 0) {
                val outputBuffer =
                    decoder.getOutputBuffer(outputIndex)
                        ?: throw IllegalStateException("MediaCodec returned a null output buffer.")
                outputBuffer.position(info.offset)
                outputBuffer.limit(info.offset + info.size)
                output.append(outputBuffer.slice(), pcmEncoding, outputChannelCount)
              }

              if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                outputDone = true
              }
              decoder.releaseOutputBuffer(outputIndex, false)
            }
          }
        }
      }

      val samples = output.toShortArray()
      require(samples.isNotEmpty()) { "Decoded mix stream '${file.name}' did not produce any PCM data." }
      return DecodedStereoPcm(outputSampleRate, samples)
    } finally {
      try {
        decoder?.stop()
      } catch (_: Throwable) {
      }
      decoder?.release()
      extractor.release()
    }
  }

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

  private fun resampleStereo(source: ShortArray, sourceRate: Int, targetRate: Int): ShortArray {
    if (source.isEmpty() || sourceRate <= 0 || targetRate <= 0 || sourceRate == targetRate) {
      return source
    }

    val sourceFrames = source.size / 2
    if (sourceFrames <= 1) {
      return source.copyOf()
    }

    val targetFrames =
        max(1, ((sourceFrames.toLong() * targetRate) / sourceRate).toInt())
    val resampled = ShortArray(targetFrames * 2)
    val positionStep = sourceRate.toDouble() / targetRate.toDouble()
    var sourcePosition = 0.0

    for (frameIndex in 0 until targetFrames) {
      val baseFrame = min(sourcePosition.toInt(), sourceFrames - 1)
      val nextFrame = min(baseFrame + 1, sourceFrames - 1)
      val frac = sourcePosition - baseFrame

      val baseLeft = source[baseFrame * 2].toInt()
      val baseRight = source[baseFrame * 2 + 1].toInt()
      val nextLeft = source[nextFrame * 2].toInt()
      val nextRight = source[nextFrame * 2 + 1].toInt()

      resampled[frameIndex * 2] =
          clampToShort(baseLeft + (nextLeft - baseLeft) * frac)
      resampled[frameIndex * 2 + 1] =
          clampToShort(baseRight + (nextRight - baseRight) * frac)

      sourcePosition += positionStep
    }

    return resampled
  }

  private fun clampToShort(value: Double): Short {
    val clamped = value.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
    return clamped.toShort()
  }

  private fun hasSbagenLooperMetadata(file: File): Boolean {
    FileInputStream(file).use { stream ->
      val overlapSize = SBAGEN_LOOPER_MARKER.size - 1
      val buffer = ByteArray(8192)
      var carry = ByteArray(0)

      while (true) {
        val read = stream.read(buffer)
        if (read < 0) {
          return false
        }

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

  private class StereoShortBuffer {
    private var data = ShortArray(8192)
    private var size = 0

    fun append(buffer: ByteBuffer, pcmEncoding: Int, channelCount: Int) {
      require(channelCount > 0) { "Mix decoder reported an invalid channel count." }
      val ordered = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)

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
    }

    fun toShortArray(): ShortArray = data.copyOf(size)

    private fun appendStereo(left: Short, right: Short) {
      ensureCapacity(size + 2)
      data[size++] = left
      data[size++] = right
    }

    private fun ensureCapacity(requiredSize: Int) {
      if (requiredSize <= data.size) {
        return
      }

      var nextCapacity = data.size
      while (nextCapacity < requiredSize) {
        nextCapacity *= 2
      }
      data = data.copyOf(nextCapacity)
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

  private data class StagedMixSource(
      val displayName: String,
      val file: File,
      val loopingHint: Boolean,
      val format: MixFormat,
  )

  private data class DecodedStereoPcm(
      val sampleRate: Int,
      val samples: ShortArray,
  )

  private enum class MixFormat {
    OGG,
    FLAC,
    MP3,
    WAV,
    UNKNOWN,
  }

  companion object {
    private const val CODEC_TIMEOUT_US = 10_000L
    private val SBAGEN_LOOPER_MARKER = "SBAGEN_LOOPER=".toByteArray(Charsets.US_ASCII)
  }
}
