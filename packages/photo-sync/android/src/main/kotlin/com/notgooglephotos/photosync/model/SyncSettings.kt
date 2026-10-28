package com.notgooglephotos.photosync.model

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalTime

/** Backup settings as stored on the phone. The device token is stored separately, encrypted. */
data class SyncSettings(
    val enabled: Boolean = true,
    val homeUrl: String? = null,
    val remoteUrl: String? = null,
    val serverId: String? = null,
    val folders: List<String> = DEFAULT_FOLDERS,
    val includeVideos: Boolean = true,
    val wifiOnly: Boolean = true,
    /** First backup and videos wait until the phone is plugged in. */
    val requireCharging: Boolean = true,
    val videosOnlyWhileCharging: Boolean = true,
    val reminderTime: LocalTime? = DEFAULT_REMINDER_TIME,
    val unreachableNudgeDays: Int = 3,
) {
    val hasServer: Boolean get() = homeUrl != null || remoteUrl != null

    /** Stable key for "which items are in scope", so the scanner knows when a full rescan is needed. */
    val selectionKey: String get() = folders.sorted().joinToString("|") + "|videos=$includeVideos"

    fun toJson(): JSONObject = JSONObject()
        .put("enabled", enabled)
        .put("homeUrl", homeUrl ?: JSONObject.NULL)
        .put("remoteUrl", remoteUrl ?: JSONObject.NULL)
        .put("serverId", serverId ?: JSONObject.NULL)
        .put("folders", JSONArray(folders))
        .put("includeVideos", includeVideos)
        .put("wifiOnly", wifiOnly)
        .put("requireCharging", requireCharging)
        .put("videosOnlyWhileCharging", videosOnlyWhileCharging)
        .put("reminderTime", reminderTime?.let(TimeOfDay::format) ?: JSONObject.NULL)
        .put("unreachableNudgeDays", unreachableNudgeDays)

    /** Applies the keys present in [patch]; absent keys keep their current value. */
    fun merge(patch: JSONObject): SyncSettings {
        var next = this
        if (patch.has("enabled")) next = next.copy(enabled = patch.getBoolean("enabled"))
        if (patch.has("homeUrl")) next = next.copy(homeUrl = patch.optStringOrNull("homeUrl")?.let(ServerAddress::validateHome))
        if (patch.has("remoteUrl")) next = next.copy(remoteUrl = patch.optStringOrNull("remoteUrl")?.let(ServerAddress::validateRemote))
        if (patch.has("serverId")) next = next.copy(serverId = patch.optStringOrNull("serverId")?.trim()?.ifEmpty { null })
        if (patch.has("folders")) next = next.copy(folders = normalizeFolders(patch.getJSONArray("folders").strings()))
        if (patch.has("includeVideos")) next = next.copy(includeVideos = patch.getBoolean("includeVideos"))
        if (patch.has("wifiOnly")) next = next.copy(wifiOnly = patch.getBoolean("wifiOnly"))
        if (patch.has("requireCharging")) next = next.copy(requireCharging = patch.getBoolean("requireCharging"))
        if (patch.has("videosOnlyWhileCharging")) {
            next = next.copy(videosOnlyWhileCharging = patch.getBoolean("videosOnlyWhileCharging"))
        }
        if (patch.has("reminderTime")) next = next.copy(reminderTime = patch.optStringOrNull("reminderTime")?.let(TimeOfDay::parse))
        if (patch.has("unreachableNudgeDays")) {
            val days = patch.getInt("unreachableNudgeDays")
            require(days in 0..60) { "unreachableNudgeDays must be between 0 and 60" }
            next = next.copy(unreachableNudgeDays = days)
        }
        return next
    }

    companion object {
        val DEFAULT_FOLDERS = listOf("DCIM/")
        val DEFAULT_REMINDER_TIME: LocalTime = LocalTime.of(21, 0)

        fun fromJson(json: JSONObject): SyncSettings = SyncSettings(
            enabled = json.optBoolean("enabled", true),
            homeUrl = json.optStringOrNull("homeUrl"),
            remoteUrl = json.optStringOrNull("remoteUrl"),
            serverId = json.optStringOrNull("serverId"),
            folders = json.optJSONArray("folders")?.strings()?.let(::normalizeFolders) ?: DEFAULT_FOLDERS,
            includeVideos = json.optBoolean("includeVideos", true),
            wifiOnly = json.optBoolean("wifiOnly", true),
            requireCharging = json.optBoolean("requireCharging", true),
            videosOnlyWhileCharging = json.optBoolean("videosOnlyWhileCharging", true),
            reminderTime = if (json.has("reminderTime")) json.optStringOrNull("reminderTime")?.let(TimeOfDay::parse) else DEFAULT_REMINDER_TIME,
            unreachableNudgeDays = json.optInt("unreachableNudgeDays", 3),
        )

        /** Folder ids are storage-relative paths with exactly one trailing slash and no leading slash. */
        fun normalizeFolder(raw: String): String {
            val trimmed = raw.trim().trim('/')
            require(trimmed.isNotEmpty()) { "Folder ids can't be empty" }
            val parts = trimmed.split('/')
            require(parts.none { it == ".." }) { "Folder ids can't contain '..'" }
            // MediaStore spells the camera bucket "DCIM" on every device; accept any casing.
            val head = if (parts[0].equals("dcim", ignoreCase = true)) "DCIM" else parts[0]
            return (listOf(head) + parts.drop(1)).joinToString("/") + "/"
        }

        fun normalizeFolders(raw: List<String>): List<String> = raw.map(::normalizeFolder).distinct().sorted()

        /** True when [next] backs up something [previous] did not: a wider folder or videos newly included. */
        fun grew(previous: SyncSettings, next: SyncSettings): Boolean {
            if (next.includeVideos && !previous.includeVideos) return true
            return next.folders.any { folder -> previous.folders.none { old -> folder.startsWith(old, ignoreCase = true) } }
        }

        /** True when [relativePath] (for example "DCIM/Camera/") is inside one of [folders]. */
        fun isSelected(relativePath: String, folders: List<String>): Boolean {
            val path = if (relativePath.endsWith('/')) relativePath else "$relativePath/"
            return folders.any { path.startsWith(it, ignoreCase = true) }
        }
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (!has(key) || isNull(key)) null else getString(key).takeIf { it.isNotBlank() }

internal fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
