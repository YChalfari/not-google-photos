package com.notgooglephotos.photosync.media

import com.notgooglephotos.photosync.queue.ItemIntake
import com.notgooglephotos.photosync.queue.MediaKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IntakeRulesTest {
    @Test
    fun cameraPhotosAndVideosGoToTheLibrary() {
        assertEquals(ItemIntake.LIBRARY, decide("DCIM/Camera/IMG_0001.jpg"))
        assertEquals(ItemIntake.LIBRARY, decide("DCIM/IMG_0001.jpg"))
        assertEquals(ItemIntake.LIBRARY, decide("DCIM/Screenshots/screen-recording.mp4", MediaKind.VIDEO))
        assertEquals(ItemIntake.LIBRARY, decide("dcim/camera/clip.mp4", MediaKind.VIDEO))
    }

    @Test
    fun screenshotsAndCameraScansWaitForReview() {
        assertEquals(ItemIntake.REVIEW, decide("DCIM/Screenshots/shot.png"))
        assertEquals(ItemIntake.REVIEW, decide("Pictures/Screenshots/shot.png", includeOtherPhotos = false))
        assertEquals(ItemIntake.REVIEW, decide("DCIM/Camera/Screenshots/shot.png", includeOtherPhotos = false))
        assertEquals(ItemIntake.REVIEW, decide("DCIM/Documents/scan.jpg", includeOtherPhotos = false))
    }

    @Test
    fun otherStillPhotosWaitAndJunkNeverQueues() {
        assertEquals(ItemIntake.REVIEW, decide("Download/receipt.jpg"))
        assertEquals(ItemIntake.REVIEW, decide("WhatsApp/Media/WhatsApp Images/IMG-WA0001.jpg"))
        assertNull(decide("Download/receipt.jpg", includeOtherPhotos = false))
        assertNull(decide("WhatsApp/Media/WhatsApp Images/Sent/IMG.jpg"))
        assertNull(decide("WhatsApp/Media/.Statuses/IMG.jpg"))
        assertNull(decide("WhatsApp/Media/WhatsApp Images/Sent/status.jpg"))
        assertNull(decide("WhatsApp/Media/WhatsApp Stickers/sticker.webp"))
        assertNull(decide("WhatsApp/Media/WhatsApp Animated Gifs/wave.gif"))
        assertNull(decide("Download/joke.gif", mimeType = "image/gif"))
        assertNull(decide("WhatsApp/Media/WhatsApp Documents/file.jpg"))
        assertNull(decide("Download/clip.mp4", MediaKind.VIDEO))
        assertNull(decide("WhatsApp/Media/WhatsApp Voice Notes/note.mp3", MediaKind.VIDEO))
    }

    @Test
    fun onlyCameraFoldersAreDirectBackupTargets() {
        assertEquals(true, IntakeRules.isDirectLibraryFolder("DCIM/"))
        assertEquals(true, IntakeRules.isDirectLibraryFolder("DCIM/Camera/"))
        assertEquals(false, IntakeRules.isDirectLibraryFolder("DCIM/Screenshots/"))
        assertEquals(false, IntakeRules.isDirectLibraryFolder("DCIM/Documents/"))
        assertEquals(false, IntakeRules.isDirectLibraryFolder("Download/"))
        assertEquals(false, IntakeRules.isDirectLibraryFolder("Pictures/WhatsApp/"))
    }

    private fun decide(
        path: String,
        kind: MediaKind = MediaKind.IMAGE,
        mimeType: String = "image/jpeg",
        includeOtherPhotos: Boolean = true,
    ) = IntakeRules.decide(path, kind, mimeType, includeOtherPhotos)
}
