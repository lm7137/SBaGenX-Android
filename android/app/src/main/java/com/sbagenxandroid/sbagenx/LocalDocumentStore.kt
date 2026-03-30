package com.sbagenxandroid.sbagenx

import android.content.Context
import android.content.res.AssetManager
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class LibraryResolvedDocument(
    val relativePath: String,
    val displayName: String,
    val uri: Uri,
)

private data class StoredDocumentSummary(
    val name: String,
    val sizeBytes: Long,
    val modifiedAtMs: Long,
    val sourceName: String,
)

private sealed interface DocumentStoreBackend {
  data class Library(val root: DocumentFile, val label: String, val treeUri: Uri) : DocumentStoreBackend

  data object Sandbox : DocumentStoreBackend
}

class LocalDocumentStore(private val reactContext: ReactApplicationContext) {
  private val assetManager: AssetManager = reactContext.assets
  private val preferences =
      reactContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
  private val documentsDir = File(reactContext.filesDir, "documents").apply {
    mkdirs()
  }
  private val librarySeedLock = Any()

  @Volatile private var librarySeedGeneration = 0L

  init {
    seedBundledExamplesToSandbox()
    queueLibrarySeed()
  }

  fun getStoreInfo(): String {
    return when (val backend = getActiveBackend()) {
      is DocumentStoreBackend.Library ->
          JSONObject()
              .put("mode", "library")
              .put("label", backend.label)
              .put("treeUri", backend.treeUri.toString())
              .put("portableDocumentStorage", true)
              .toString()
      DocumentStoreBackend.Sandbox ->
          JSONObject()
              .put("mode", "sandbox")
              .put("label", "App sandbox")
              .put("treeUri", "")
              .put("portableDocumentStorage", false)
              .toString()
    }
  }

  fun setLibraryFolder(treeUri: Uri): String {
    preferences.edit().putString(PREFERENCE_LIBRARY_TREE_URI, treeUri.toString()).apply()

    val root = getLibraryRoot()
    require(root != null) { "Unable to access the selected library folder." }
    queueLibrarySeed()
    return getStoreInfo()
  }

  fun getCurrentLibraryTreeUri(): Uri? {
    val rawUri = preferences.getString(PREFERENCE_LIBRARY_TREE_URI, null) ?: return null
    return Uri.parse(rawUri)
  }

  fun listDocuments(): String {
    val summaries =
        when (val backend = getActiveBackend()) {
          is DocumentStoreBackend.Library -> listLibraryDocuments(backend)
          DocumentStoreBackend.Sandbox -> listSandboxDocuments()
        }

    val docs = JSONArray()
    summaries.forEach { summary ->
      docs.put(
          JSONObject()
              .put("name", summary.name)
              .put("sizeBytes", summary.sizeBytes)
              .put("modifiedAtMs", summary.modifiedAtMs)
              .put("sourceName", summary.sourceName),
      )
    }
    return docs.toString()
  }

  fun saveDocument(name: String, text: String): String {
    val normalizedName = normalizeRelativePathString(name)

    return when (val backend = getActiveBackend()) {
      is DocumentStoreBackend.Library -> saveLibraryDocument(backend, normalizedName, text)
      DocumentStoreBackend.Sandbox -> saveSandboxDocument(normalizedName, text)
    }
  }

  fun loadDocument(name: String): String {
    val normalizedName = normalizeRelativePathString(name)

    return when (val backend = getActiveBackend()) {
      is DocumentStoreBackend.Library -> loadLibraryDocument(backend, normalizedName)
      DocumentStoreBackend.Sandbox -> loadSandboxDocument(normalizedName)
    }
  }

  fun loadPickedDocument(uri: Uri): String {
    val text =
        reactContext.contentResolver.openInputStream(uri)?.bufferedReader(Charsets.UTF_8)?.use { reader ->
          reader.readText()
        } ?: throw IllegalArgumentException("Unable to open the selected document for reading.")

    val pickedDocument = DocumentFile.fromSingleUri(reactContext, uri)
    val relativePath = getLibraryRoot()?.let { root -> findRelativePathByUri(root, "", uri) }
    val name =
        relativePath
            ?: pickedDocument?.name
            ?: uri.lastPathSegment?.substringAfterLast('/')
            ?: "picked.sbg"
    val sourceName = relativePath?.let { "$LIBRARY_SOURCE_PREFIX$it" } ?: uri.toString()
    val sizeBytes = pickedDocument?.length() ?: text.toByteArray(Charsets.UTF_8).size.toLong()
    val modifiedAtMs = pickedDocument?.lastModified() ?: 0L

    return buildStoredDocumentJson(
        name = name,
        sizeBytes = sizeBytes,
        modifiedAtMs = modifiedAtMs,
        sourceName = sourceName,
        text = text,
    )
  }

  fun resolveLibraryDocument(path: String, sourceName: String): LibraryResolvedDocument? {
    val root = getLibraryRoot() ?: return null
    val candidatePaths = linkedSetOf<String>()

    if (path.startsWith(LIBRARY_SOURCE_PREFIX)) {
      candidatePaths += normalizeRelativePathString(path.removePrefix(LIBRARY_SOURCE_PREFIX))
    } else {
      val normalizedPath = normalizeRelativePathString(path)
      if (sourceName.startsWith(LIBRARY_SOURCE_PREFIX)) {
        val sourceRelative = sourceName.removePrefix(LIBRARY_SOURCE_PREFIX)
        val parent = parentRelativePath(sourceRelative)
        if (!parent.isNullOrBlank()) {
          candidatePaths += "$parent/$normalizedPath"
        }
      }
      candidatePaths += normalizedPath
    }

    candidatePaths.forEach { candidatePath ->
      val file = findTreeFile(root, candidatePath)
      if (file != null && file.isFile) {
        return LibraryResolvedDocument(
            relativePath = candidatePath,
            displayName = file.name ?: candidatePath.substringAfterLast('/'),
            uri = file.uri,
        )
      }
    }

    return null
  }

  private fun saveSandboxDocument(name: String, text: String): String {
    val file = resolveSandboxDocumentFile(name)
    file.parentFile?.mkdirs()
    file.writeText(text, Charsets.UTF_8)
    return buildStoredDocumentJson(
        name = name,
        sizeBytes = file.length(),
        modifiedAtMs = file.lastModified(),
        sourceName = file.absolutePath,
        text = null,
    )
  }

  private fun loadSandboxDocument(name: String): String {
    val file = resolveSandboxDocumentFile(name)
    require(file.isFile) {
      "Document '$name' does not exist in app storage."
    }

    return buildStoredDocumentJson(
        name = name,
        sizeBytes = file.length(),
        modifiedAtMs = file.lastModified(),
        sourceName = file.absolutePath,
        text = file.readText(Charsets.UTF_8),
    )
  }

  private fun saveLibraryDocument(
      backend: DocumentStoreBackend.Library,
      name: String,
      text: String,
  ): String {
    val file = findOrCreateTreeFile(backend.root, name, mimeForDocument(name))
    reactContext.contentResolver.openOutputStream(file.uri, "wt")?.bufferedWriter(Charsets.UTF_8)?.use { writer ->
      writer.write(text)
    } ?: throw IllegalArgumentException("Unable to open document '$name' for writing.")

    return buildStoredDocumentJson(
        name = name,
        sizeBytes = file.length(),
        modifiedAtMs = file.lastModified(),
        sourceName = "$LIBRARY_SOURCE_PREFIX$name",
        text = null,
    )
  }

  private fun loadLibraryDocument(
      backend: DocumentStoreBackend.Library,
      name: String,
  ): String {
    val file = findTreeFile(backend.root, name)
    require(file != null && file.isFile) {
      "Document '$name' does not exist in the selected library folder."
    }

    val text =
        reactContext.contentResolver.openInputStream(file.uri)?.bufferedReader(Charsets.UTF_8)?.use { reader ->
          reader.readText()
        } ?: throw IllegalArgumentException("Unable to open document '$name' for reading.")

    return buildStoredDocumentJson(
        name = name,
        sizeBytes = file.length(),
        modifiedAtMs = file.lastModified(),
        sourceName = "$LIBRARY_SOURCE_PREFIX$name",
        text = text,
    )
  }

  private fun listSandboxDocuments(): List<StoredDocumentSummary> {
    return documentsDir
        .walkTopDown()
        .filter { it.isFile && isListedDocument(it.name) }
        .map { file ->
          StoredDocumentSummary(
              name = file.relativeTo(documentsDir).invariantSeparatorsPath,
              sizeBytes = file.length(),
              modifiedAtMs = file.lastModified(),
              sourceName = file.absolutePath,
          )
        }
        .sortedBy { it.name.lowercase() }
        .toList()
  }

  private fun listLibraryDocuments(
      backend: DocumentStoreBackend.Library,
  ): List<StoredDocumentSummary> {
    val result = ArrayList<StoredDocumentSummary>()
    walkTreeDocuments(backend.root, "") { relativePath, file ->
      if (!isListedDocument(file.name.orEmpty())) {
        return@walkTreeDocuments
      }

      result.add(
          StoredDocumentSummary(
              name = relativePath,
              sizeBytes = file.length(),
              modifiedAtMs = file.lastModified(),
              sourceName = "$LIBRARY_SOURCE_PREFIX$relativePath",
          ),
      )
    }
    return result.sortedBy { it.name.lowercase() }
  }

  private fun walkTreeDocuments(
      directory: DocumentFile,
      relativePrefix: String,
      visitor: (relativePath: String, file: DocumentFile) -> Unit,
  ) {
    directory.listFiles().sortedBy { it.name.orEmpty().lowercase() }.forEach { child ->
      val childName = child.name ?: return@forEach
      val childPath = if (relativePrefix.isBlank()) childName else "$relativePrefix/$childName"
      when {
        child.isDirectory -> walkTreeDocuments(child, childPath, visitor)
        child.isFile -> visitor(childPath, child)
      }
    }
  }

  private fun findRelativePathByUri(
      directory: DocumentFile,
      relativePrefix: String,
      targetUri: Uri,
  ): String? {
    directory.listFiles().forEach { child ->
      val childName = child.name ?: return@forEach
      val childPath = if (relativePrefix.isBlank()) childName else "$relativePrefix/$childName"
      when {
        child.uri == targetUri && child.isFile -> return childPath
        child.isDirectory -> {
          val nested = findRelativePathByUri(child, childPath, targetUri)
          if (nested != null) {
            return nested
          }
        }
      }
    }

    return null
  }

  private fun getActiveBackend(): DocumentStoreBackend {
    val libraryRoot = getLibraryRoot()
    if (libraryRoot != null) {
      return DocumentStoreBackend.Library(
          root = libraryRoot,
          label = libraryRoot.name ?: "Selected library folder",
          treeUri = libraryRoot.uri,
      )
    }
    return DocumentStoreBackend.Sandbox
  }

  private fun getLibraryRoot(): DocumentFile? {
    val rawUri = preferences.getString(PREFERENCE_LIBRARY_TREE_URI, null) ?: return null
    val root = DocumentFile.fromTreeUri(reactContext, Uri.parse(rawUri)) ?: return null
    if (!root.exists() || !root.isDirectory) {
      preferences.edit().remove(PREFERENCE_LIBRARY_TREE_URI).apply()
      return null
    }
    return root
  }

  private fun buildStoredDocumentJson(
      name: String,
      sizeBytes: Long,
      modifiedAtMs: Long,
      sourceName: String,
      text: String?,
  ): String {
    val json =
        JSONObject()
            .put("name", name)
            .put("sizeBytes", sizeBytes)
            .put("modifiedAtMs", modifiedAtMs)
            .put("sourceName", sourceName)

    if (text != null) {
      json.put("text", text)
    }

    return json.toString()
  }

  private fun seedBundledExamplesToSandbox() {
    copyAssetTreeToSandbox("examples")
  }

  private fun copyAssetTreeToSandbox(assetPath: String) {
    val entries = assetManager.list(assetPath).orEmpty()
    if (entries.isEmpty()) {
      val target = resolveSandboxDocumentFile(assetPath)
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
      copyAssetTreeToSandbox("$assetPath/$entry")
    }
  }

  private fun seedBundledExamplesToLibrary(root: DocumentFile) {
    copyAssetTreeToLibrary(root, "examples")
  }

  private fun seedBundledMixesToLibrary(root: DocumentFile) {
    listOf("river1.ogg", "river2.ogg").forEach { assetPath ->
      copyAssetTreeToLibrary(root, assetPath)
    }
  }

  private fun queueLibrarySeed() {
    val generation =
        synchronized(librarySeedLock) {
          librarySeedGeneration += 1
          librarySeedGeneration
        }

    Thread(
            {
              synchronized(librarySeedLock) {
                if (generation != librarySeedGeneration) {
                  return@synchronized
                }

                val root = getLibraryRoot() ?: return@synchronized
                try {
                  seedBundledExamplesToLibrary(root)
                  seedBundledMixesToLibrary(root)
                } catch (_: Throwable) {
                }
              }
            },
            "sbagenx-library-seed",
        )
        .start()
  }

  private fun copyAssetTreeToLibrary(root: DocumentFile, assetPath: String) {
    val entries = assetManager.list(assetPath).orEmpty()
    if (entries.isEmpty()) {
      val target = findOrCreateTreeFile(root, assetPath, mimeForAsset(assetPath))
      reactContext.contentResolver.openOutputStream(target.uri, "w")?.use { output ->
        assetManager.open(assetPath).use { input ->
          input.copyTo(output)
        }
      } ?: throw IllegalArgumentException("Unable to seed asset '$assetPath' into the library folder.")
      return
    }

    entries.forEach { entry ->
      copyAssetTreeToLibrary(root, "$assetPath/$entry")
    }
  }

  private fun findTreeFile(root: DocumentFile, relativePath: String): DocumentFile? {
    val segments = normalizeRelativePath(relativePath)
    var current = root
    for ((index, segment) in segments.withIndex()) {
      val next = current.findFile(segment) ?: return null
      if (index == segments.lastIndex) {
        return next
      }
      if (!next.isDirectory) {
        return null
      }
      current = next
    }
    return null
  }

  private fun findOrCreateTreeFile(
      root: DocumentFile,
      relativePath: String,
      mimeType: String,
  ): DocumentFile {
    val segments = normalizeRelativePath(relativePath)
    val fileName = segments.last()
    val parentDirectory = ensureTreeDirectory(root, segments.dropLast(1))
    val existing = parentDirectory.findFile(fileName)

    if (existing != null) {
      require(existing.isFile) { "Path '$relativePath' points to a directory, not a file." }
      return existing
    }

    val legacyMatches =
        parentDirectory.listFiles().filter { child ->
          child.isFile && matchesManagedFileName(child.name.orEmpty(), fileName)
        }
    if (legacyMatches.isNotEmpty()) {
      legacyMatches.drop(1).forEach { duplicate ->
        runCatching { duplicate.delete() }
      }

      val primary = legacyMatches.first()
      if ((primary.name ?: "") == fileName) {
        return primary
      }

      if (runCatching { primary.renameTo(fileName) }.getOrDefault(false)) {
        parentDirectory.findFile(fileName)?.let { renamed ->
          if (renamed.isFile) {
            return renamed
          }
        }
      }

      runCatching { primary.delete() }
    }

    return parentDirectory.createFile(mimeType, fileName)
        ?: throw IllegalArgumentException("Unable to create document '$relativePath'.")
  }

  private fun matchesManagedFileName(candidateName: String, expectedName: String): Boolean {
    if (candidateName.equals(expectedName, ignoreCase = true)) {
      return true
    }

    return canonicalizeManagedFileName(candidateName)
        .equals(expectedName.lowercase(), ignoreCase = false)
  }

  private fun canonicalizeManagedFileName(name: String): String {
    var working = name.lowercase()

    if (working.endsWith(".txt")) {
      working = working.removeSuffix(".txt")
    }

    working = working.replace(Regex(""" \(\d+\)(?=(\.[^./\\]+)?$)"""), "")
    return working
  }

  private fun ensureTreeDirectory(root: DocumentFile, segments: List<String>): DocumentFile {
    var current = root
    segments.forEach { segment ->
      val existing = current.findFile(segment)
      current =
          when {
            existing == null -> current.createDirectory(segment)
            existing.isDirectory -> existing
            else -> throw IllegalArgumentException("Path segment '$segment' is not a directory.")
          } ?: throw IllegalArgumentException("Unable to create directory '$segment'.")
    }
    return current
  }

  private fun resolveSandboxDocumentFile(name: String): File {
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

  private fun normalizeRelativePathString(name: String): String = normalizeRelativePath(name).joinToString("/")

  private fun parentRelativePath(path: String): String? {
    val normalized = normalizeRelativePath(path)
    if (normalized.size <= 1) {
      return ""
    }
    return normalized.dropLast(1).joinToString("/")
  }

  private fun isListedDocument(name: String): Boolean =
      name.endsWith(".sbg", ignoreCase = true) ||
          name.endsWith(".sbgf", ignoreCase = true)

  private fun mimeForDocument(path: String): String {
    return when {
      path.endsWith(".sbg", ignoreCase = true) -> "application/octet-stream"
      path.endsWith(".sbgf", ignoreCase = true) -> "application/octet-stream"
      else -> "application/octet-stream"
    }
  }

  private fun mimeForAsset(path: String): String {
    return when {
      path.endsWith(".sbg", ignoreCase = true) -> "application/octet-stream"
      path.endsWith(".sbgf", ignoreCase = true) -> "application/octet-stream"
      path.endsWith(".sbxseq", ignoreCase = true) -> "application/octet-stream"
      path.endsWith(".c", ignoreCase = true) -> "text/x-csrc"
      else -> "application/octet-stream"
    }
  }

  companion object {
    const val LIBRARY_SOURCE_PREFIX = "library://"

    private const val PREFERENCES_NAME = "sbagenx-storage"
    private const val PREFERENCE_LIBRARY_TREE_URI = "library_tree_uri"
  }
}
