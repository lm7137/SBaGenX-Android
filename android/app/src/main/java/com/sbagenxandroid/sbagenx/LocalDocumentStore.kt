package com.sbagenxandroid.sbagenx

import android.content.res.AssetManager
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class LocalDocumentStore(reactContext: ReactApplicationContext) {
  private val assetManager: AssetManager = reactContext.assets
  private val documentsDir = File(reactContext.filesDir, "documents").apply {
    mkdirs()
  }

  init {
    seedBundledExamples()
  }

  fun listDocuments(): String {
    val docs = JSONArray()

    documentsDir
        .walkTopDown()
        .filter { it.isFile && isListedDocument(it.name) }
        .sortedBy { relativeName(it).lowercase() }
        .forEach { file ->
          docs.put(buildSummary(file))
        }

    return docs.toString()
  }

  fun saveDocument(name: String, text: String): String {
    val file = resolveDocumentFile(name)
    file.parentFile?.mkdirs()
    file.writeText(text, Charsets.UTF_8)
    return buildSummary(file).toString()
  }

  fun loadDocument(name: String): String {
    val file = resolveDocumentFile(name)
    val relativeName = relativeName(file)

    require(file.isFile) {
      "Document '$relativeName' does not exist in app storage."
    }

    return JSONObject()
        .put("name", relativeName)
        .put("sizeBytes", file.length())
        .put("modifiedAtMs", file.lastModified())
        .put("text", file.readText(Charsets.UTF_8))
        .toString()
  }

  private fun seedBundledExamples() {
    copyAssetTree("examples")
  }

  private fun copyAssetTree(assetPath: String) {
    val entries = assetManager.list(assetPath).orEmpty()
    if (entries.isEmpty()) {
      val target = resolveDocumentFile(assetPath)
      if (target.isFile) {
        return
      }

      target.parentFile?.mkdirs()
      assetManager.open(assetPath).use { input ->
        target.outputStream().use { output ->
          input.copyTo(output)
        }
      }
      return
    }

    entries.forEach { entry ->
      val childPath = "$assetPath/$entry"
      copyAssetTree(childPath)
    }
  }

  private fun isListedDocument(name: String): Boolean =
      name.endsWith(".sbg", ignoreCase = true) ||
          name.endsWith(".sbgf", ignoreCase = true)

  private fun resolveDocumentFile(name: String): File {
    val normalized = normalizeRelativePath(name)
    val target = normalized.fold(documentsDir) { parent, segment ->
      File(parent, segment)
    }
    val canonicalDocumentsDir = documentsDir.canonicalFile
    val canonicalTarget = target.canonicalFile

    require(
        canonicalTarget.path == canonicalDocumentsDir.path ||
            canonicalTarget.path.startsWith("${canonicalDocumentsDir.path}${File.separator}"),
    ) {
      "Document path must stay within app storage."
    }

    return canonicalTarget
  }

  private fun normalizeRelativePath(name: String): List<String> {
    val trimmed = name.trim()
    require(trimmed.isNotEmpty()) {
      "Document name must not be empty."
    }

    val segments =
        trimmed
            .replace('\\', '/')
            .split('/')
            .filter { it.isNotBlank() && it != "." }

    require(segments.isNotEmpty()) {
      "Document name must not be empty."
    }
    require(segments.none { it == ".." }) {
      "Document name must not contain parent-directory segments."
    }

    return segments
  }

  private fun relativeName(file: File): String = file.relativeTo(documentsDir).invariantSeparatorsPath

  private fun buildSummary(file: File): JSONObject =
      JSONObject()
          .put("name", relativeName(file))
          .put("sizeBytes", file.length())
          .put("modifiedAtMs", file.lastModified())
}
