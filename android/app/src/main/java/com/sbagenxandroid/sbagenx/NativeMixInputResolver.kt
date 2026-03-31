package com.sbagenxandroid.sbagenx

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream

data class PreparedNativeMixInput(
    val requestedMixPath: String,
    val filePath: String,
    val pathHint: String,
    val sourceName: String,
    val mixSection: Int,
    val deleteOnRelease: Boolean,
)

class NativeMixInputResolver(
    private val context: Context,
    private val documentStore: LocalDocumentStore,
) {
  fun resolve(mixPath: String, sourceName: String): PreparedNativeMixInput {
    val parsedPath = parseMixPath(mixPath)
    require(parsedPath.basePath.isNotBlank()) { "Mix path cannot be blank." }

    if (parsedPath.basePath.startsWith("asset://")) {
      return copyAssetToTempFile(
          parsedPath = parsedPath,
          assetPath = parsedPath.basePath.removePrefix("asset://"),
          displayName = parsedPath.basePath,
      )
    }

    if (parsedPath.basePath.startsWith("asset:")) {
      return copyAssetToTempFile(
          parsedPath = parsedPath,
          assetPath = parsedPath.basePath.removePrefix("asset:"),
          displayName = parsedPath.basePath,
      )
    }

    if (parsedPath.basePath.startsWith("content://")) {
      val uri = Uri.parse(parsedPath.basePath)
      val displayName = queryDisplayName(uri) ?: parsedPath.basePath
      return copyInputStreamToTempFile(
          parsedPath = parsedPath,
          displayName = displayName,
          inputStream =
              context.contentResolver.openInputStream(uri)
                  ?: throw IllegalArgumentException("Unable to open mix content URI."),
      )
    }

    if (parsedPath.basePath.startsWith("file://")) {
      val filePath =
          Uri.parse(parsedPath.basePath).path ?: throw IllegalArgumentException("Invalid file URI.")
      return useFile(
          parsedPath = parsedPath,
          file = File(filePath),
          displayName = parsedPath.basePath,
      )
    }

    val absoluteFile = File(parsedPath.basePath)
    if (absoluteFile.isAbsolute) {
      return useFile(
          parsedPath = parsedPath,
          file = absoluteFile,
          displayName = absoluteFile.absolutePath,
      )
    }

    documentStore.resolveLibraryDocument(parsedPath.basePath, sourceName)?.let { libraryDocument ->
      return copyInputStreamToTempFile(
          parsedPath = parsedPath,
          displayName = libraryDocument.displayName,
          inputStream =
              context.contentResolver.openInputStream(libraryDocument.uri)
                  ?: throw IllegalArgumentException(
                      "Unable to open mix file '${libraryDocument.relativePath}'.",
                  ),
      )
    }

    resolveRelativeFile(parsedPath.basePath, sourceName)?.let { relativeFile ->
      return useFile(
          parsedPath = parsedPath,
          file = relativeFile,
          displayName = relativeFile.absolutePath,
      )
    }

    if (assetExists(parsedPath.basePath)) {
      return copyAssetToTempFile(
          parsedPath = parsedPath,
          assetPath = parsedPath.basePath,
          displayName = "asset:${parsedPath.basePath}",
      )
    }

    throw IllegalArgumentException(
        "Mix source '$mixPath' could not be resolved from app assets, file paths, or content URIs.",
    )
  }

  private fun parseMixPath(mixPath: String): ParsedMixPath {
    val trimmed = mixPath.trim()
    val hashIndex = trimmed.lastIndexOf('#')
    if (hashIndex <= 0 || hashIndex == trimmed.length - 1) {
      return ParsedMixPath(trimmed, -1)
    }

    val suffix = trimmed.substring(hashIndex + 1)
    if (suffix.all { it.isDigit() }) {
      return ParsedMixPath(trimmed.substring(0, hashIndex), suffix.toIntOrNull() ?: -1)
    }

    return ParsedMixPath(trimmed, -1)
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

  private fun useFile(
      parsedPath: ParsedMixPath,
      file: File,
      displayName: String,
  ): PreparedNativeMixInput {
    require(file.isFile) { "Mix file '$displayName' was not found." }
    return PreparedNativeMixInput(
        requestedMixPath = parsedPath.basePath,
        filePath = file.absolutePath,
        pathHint = hintName(displayName),
        sourceName = displayName,
        mixSection = parsedPath.mixSection,
        deleteOnRelease = false,
    )
  }

  private fun copyAssetToTempFile(
      parsedPath: ParsedMixPath,
      assetPath: String,
      displayName: String,
  ): PreparedNativeMixInput {
    require(assetExists(assetPath)) { "Mix asset '$assetPath' was not found in the Android bundle." }
    return copyInputStreamToTempFile(
        parsedPath = parsedPath,
        displayName = displayName,
        inputStream = context.assets.open(assetPath),
    )
  }

  private fun copyInputStreamToTempFile(
      parsedPath: ParsedMixPath,
      displayName: String,
      inputStream: InputStream,
  ): PreparedNativeMixInput {
    val tempFile =
        File.createTempFile(
            "sbxmix-",
            extensionFor(displayName),
            context.cacheDir,
        )
    inputStream.use { source ->
      FileOutputStream(tempFile).use { sink ->
        source.copyTo(sink)
      }
    }

    return PreparedNativeMixInput(
        requestedMixPath = parsedPath.basePath,
        filePath = tempFile.absolutePath,
        pathHint = hintName(displayName),
        sourceName = displayName,
        mixSection = parsedPath.mixSection,
        deleteOnRelease = true,
    )
  }

  private fun assetExists(assetPath: String): Boolean {
    return try {
      context.assets.open(assetPath).use { true }
    } catch (_: Throwable) {
      false
    }
  }

  private fun hintName(displayName: String): String {
    val normalized = displayName.substringAfterLast('/')
    return normalized.ifBlank { "mix.bin" }
  }

  private fun extensionFor(path: String): String {
    val dot = path.lastIndexOf('.')
    if (dot < 0 || dot >= path.length - 1) {
      return ".bin"
    }

    val raw = path.substring(dot)
    return if (raw.length <= 10) raw else ".bin"
  }

  private fun queryDisplayName(uri: Uri): String? {
    return context.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          if (!cursor.moveToFirst()) {
            return@use null
          }

          val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (column >= 0) cursor.getString(column) else null
        }
  }

  private data class ParsedMixPath(
      val basePath: String,
      val mixSection: Int,
  )
}
