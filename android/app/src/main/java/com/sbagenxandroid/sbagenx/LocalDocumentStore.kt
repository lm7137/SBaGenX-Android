package com.sbagenxandroid.sbagenx

import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class LocalDocumentStore(reactContext: ReactApplicationContext) {
  private val documentsDir = File(reactContext.filesDir, "documents").apply {
    mkdirs()
  }

  fun listDocuments(): String {
    val docs = JSONArray()

    documentsDir
        .listFiles()
        .orEmpty()
        .filter { it.isFile }
        .sortedByDescending { it.lastModified() }
        .forEach { file ->
          docs.put(buildSummary(file))
        }

    return docs.toString()
  }

  fun saveDocument(name: String, text: String): String {
    val file = File(documentsDir, sanitizeName(name))
    file.writeText(text, Charsets.UTF_8)
    return buildSummary(file).toString()
  }

  fun loadDocument(name: String): String {
    val file = File(documentsDir, sanitizeName(name))

    require(file.isFile) {
      "Document '${file.name}' does not exist in app storage."
    }

    return JSONObject()
        .put("name", file.name)
        .put("sizeBytes", file.length())
        .put("modifiedAtMs", file.lastModified())
        .put("text", file.readText(Charsets.UTF_8))
        .toString()
  }

  private fun sanitizeName(name: String): String {
    val trimmed = name.trim()
    require(trimmed.isNotEmpty()) {
      "Document name must not be empty."
    }
    require(!trimmed.contains('/')) {
      "Document name must not contain path separators."
    }
    require(!trimmed.contains('\\')) {
      "Document name must not contain path separators."
    }

    return trimmed
  }

  private fun buildSummary(file: File): JSONObject =
      JSONObject()
          .put("name", file.name)
          .put("sizeBytes", file.length())
          .put("modifiedAtMs", file.lastModified())
}
