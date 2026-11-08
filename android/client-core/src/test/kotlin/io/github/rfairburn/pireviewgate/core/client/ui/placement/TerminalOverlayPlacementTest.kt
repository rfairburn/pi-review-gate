package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.DocumentRead
import io.github.rfairburn.pireviewgate.core.hosts.DocumentWriteResult
import io.github.rfairburn.pireviewgate.core.hosts.SingleDocumentStorage
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Off-device checks for the cosmetic terminal overlay placement: independent slots,
 * strict bounded UI-only persistence, defaulted-load repair of only that document,
 * normal refusal of unsafe storage, and the ordered single-writer last-state rule.
 */
class TerminalOverlayPlacementTest {

    private lateinit var root: File

    @BeforeTest
    fun setUp() {
        root = Files.createTempDirectory("prg-terminal-placement-").toFile()
    }

    @AfterTest
    fun tearDown() {
        root.deleteRecursively()
    }

    private val document: File
        get() = File(
            File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME),
            TerminalOverlayPlacementStorage.DOCUMENT_NAME,
        )

    private fun moved(
        overlay: TerminalOverlay,
        orientation: TerminalOverlayOrientation,
        x: Int,
        y: Int,
    ): TerminalOverlayPlacement =
        TerminalOverlayPlacement.DEFAULT.withPosition(overlay, orientation, TerminalOverlayPosition(x, y))

    private fun allSix(): TerminalOverlayPlacement =
        TerminalOverlayPlacement.DEFAULT
            .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, TerminalOverlayPosition(1000, 0))
            .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.LANDSCAPE, TerminalOverlayPosition(900, 10))
            .withPosition(TerminalOverlay.STATUS, TerminalOverlayOrientation.PORTRAIT, TerminalOverlayPosition(1000, 120))
            .withPosition(TerminalOverlay.STATUS, TerminalOverlayOrientation.LANDSCAPE, TerminalOverlayPosition(800, 200))
            .withPosition(TerminalOverlay.KEYS, TerminalOverlayOrientation.PORTRAIT, TerminalOverlayPosition(500, 1000))
            .withPosition(TerminalOverlay.KEYS, TerminalOverlayOrientation.LANDSCAPE, TerminalOverlayPosition(250, 750))

    /** The Keys layout defaults are the current docked behavior, so the six positions alone still round-trip. */
    private fun allSixWithKeysLayouts(
        portrait: TerminalKeysLayout,
        landscape: TerminalKeysLayout,
    ): TerminalOverlayPlacement =
        allSix()
            .withKeysLayout(TerminalOverlayOrientation.PORTRAIT, portrait)
            .withKeysLayout(TerminalOverlayOrientation.LANDSCAPE, landscape)

    @Test
    fun `a fresh read creates no placement file directory or lock`() {
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementRead.Fresh, store.read())
        assertTrue(root.listFiles().isNullOrEmpty(), "a fresh read must create nothing")
        store.close()
    }

    @Test
    fun `all three overlays persist independently in both orientations`() {
        val saved = allSix()
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(saved))
        store.close()

        val text = document.readText()
        val keys = Regex("\"([A-Za-z]+)\"\\s*:").findAll(text).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("version", "overlays", "overlay", "orientation", "x", "y"), keys)
        assertFalse(text.contains("host"))
        assertFalse(text.contains("session"))
        assertFalse(text.contains("viewport"))

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read())
        assertEquals(saved, read.placement)
        reopened.close()

        // One slot is one independent value; its siblings in both orientations stay put.
        val changed = saved.withPosition(
            TerminalOverlay.CONTROLS,
            TerminalOverlayOrientation.PORTRAIT,
            TerminalOverlayPosition(12, 34),
        )
        assertEquals(TerminalOverlayPosition(900, 10), changed.controlsLandscape)
        assertEquals(TerminalOverlayPosition(1000, 120), changed.statusPortrait)
        assertEquals(TerminalOverlayPosition(800, 200), changed.statusLandscape)
        assertEquals(TerminalOverlayPosition(500, 1000), changed.keysPortrait)
        assertEquals(TerminalOverlayPosition(250, 750), changed.keysLandscape)
    }

    @Test
    fun `sequential completed drags publish in order and the last state survives a reopen`() {
        val first = moved(TerminalOverlay.KEYS, TerminalOverlayOrientation.PORTRAIT, 100, 200)
        val second = first.withPosition(
            TerminalOverlay.STATUS,
            TerminalOverlayOrientation.PORTRAIT,
            TerminalOverlayPosition(300, 400),
        )
        val last = second.withPosition(
            TerminalOverlay.CONTROLS,
            TerminalOverlayOrientation.LANDSCAPE,
            TerminalOverlayPosition(500, 600),
        )
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(first))
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(second))
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(last))
        store.close()

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(last, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `a refused unreadable or unsafe storage observation is reported and never bypassed`() {
        for (reason in listOf(
            StorageFailureReason.UNREADABLE,
            StorageFailureReason.UNSAFE_OBJECT,
            StorageFailureReason.MISSING_INITIALIZED,
        )) {
            val fake = RefusingStorage(reason)
            val store = FileTerminalOverlayPlacementStore(fake)
            assertEquals(
                reason,
                assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
            )
            val refusal = assertIs<TerminalOverlayPlacementWriteResult.Refused>(
                store.write(moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 1, 2)),
            )
            assertEquals(reason, refusal.reason)
            assertEquals(1, fake.writeAttempts, "the normal storage seam saw the attempt and still refused")
            assertEquals(0, fake.published, "no successful publication was claimed")
            store.close()
        }
    }

    @Test
    fun `an untouched default slot stays a default rather than a frozen coordinate`() {
        val onlyControls = moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 750, 250)
        val store = TerminalOverlayPlacementStorage.openStore(root)
        store.write(onlyControls)
        store.close()

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read())
        assertEquals(onlyControls, read.placement)
        assertNull(read.placement.statusPortrait)
        assertNull(read.placement.keysLandscape)
        reopened.close()
    }

    @Test
    fun `malformed placement defaults with a warning and the next save repairs only that document`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val unrelated = File(root, "other-private-document.json")
        unrelated.writeText("{\"keep\":true}\n")
        val malformed = "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\"}]}\n"
        document.writeText(malformed)

        val store = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read())
        assertEquals(StorageFailureReason.MALFORMED, read.reason)
        assertEquals(malformed, document.readText(), "a refused load must leave the bad UI document untouched")

        val repaired = allSix()
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(repaired))
        store.close()
        assertEquals("{\"keep\":true}\n", unrelated.readText(), "repair must never touch another private document")

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(repaired, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `an empty placement document is repaired by the next completed drag save`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val unrelated = File(root, "other-private-document.json")
        unrelated.writeText("{\"keep\":true}\n")
        document.writeBytes(ByteArray(0))

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )
        assertEquals(0L, document.length(), "loading must not repair before a completed drag")

        val repaired = allSix()
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(repaired))
        val again = repaired.withPosition(
            TerminalOverlay.STATUS,
            TerminalOverlayOrientation.PORTRAIT,
            TerminalOverlayPosition(111, 222),
        )
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(again),
            "the repaired handle can keep saving")
        store.close()
        assertEquals("{\"keep\":true}\n", unrelated.readText(), "repair must touch only the UI placement document")
        assertTrue(document.length() > 0L)

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(again, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `an oversized placement document is repaired by the next completed drag save`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val unrelated = File(root, "other-private-document.json")
        unrelated.writeText("{\"keep\":true}\n")
        val oversized = ByteArray(5_000) { 0x78 }
        document.writeBytes(oversized)

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )
        assertEquals(
            oversized.size.toLong(),
            document.length(),
            "loading must neither read nor repair the oversized document",
        )

        val repaired = allSix()
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(repaired))
        val again = repaired.withPosition(
            TerminalOverlay.STATUS,
            TerminalOverlayOrientation.PORTRAIT,
            TerminalOverlayPosition(111, 222),
        )
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(again),
            "the repaired handle can keep saving")
        store.close()
        assertEquals("{\"keep\":true}\n", unrelated.readText(), "repair must touch only the UI placement document")
        assertTrue(document.length() <= TerminalOverlayPlacementStorage.MAX_DOCUMENT_BYTES.toLong())

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(again, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `an oversized placement changed to valid data before the repair save is not overwritten`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val unrelated = File(root, "other-private-document.json")
        unrelated.writeText("{\"keep\":true}\n")
        document.writeBytes(ByteArray(5_000))
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )

        val replacement = moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.LANDSCAPE, 321, 123)
        val foreign = TerminalOverlayPlacementDocumentCodec.encode(replacement)
        document.writeText(foreign)
        val refusal = assertIs<TerminalOverlayPlacementWriteResult.Refused>(store.write(allSix()))
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertEquals(foreign, document.readText(), "newer valid placement data is not overwritten")
        assertEquals("{\"keep\":true}\n", unrelated.readText(), "refusal must touch only the UI placement document")
        store.close()

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(replacement, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `an empty placement document changed before the repair save is not overwritten`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        document.writeBytes(ByteArray(0))
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )

        val foreign = TerminalOverlayPlacementDocumentCodec.encode(
            moved(TerminalOverlay.STATUS, TerminalOverlayOrientation.LANDSCAPE, 321, 123),
        )
        document.writeText(foreign)
        val refusal = assertIs<TerminalOverlayPlacementWriteResult.Refused>(store.write(allSix()))
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertEquals(foreign, document.readText(), "newer non-empty placement data is not overwritten")
        store.close()
    }

    @Test
    fun `text-unreadable placement defaults then a normal save replaces it`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val invalidUtf8 = byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d)
        document.writeBytes(invalidUtf8)

        val store = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read())
        assertEquals(StorageFailureReason.UNREADABLE, read.reason)
        assertTrue(document.readBytes().contentEquals(invalidUtf8))

        val repaired = moved(TerminalOverlay.STATUS, TerminalOverlayOrientation.PORTRAIT, 600, 300)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(repaired))
        store.close()

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(repaired, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `unsafe symlink storage is refused and never bypassed`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val outside = File(root, "outside.json")
        outside.writeText("{\"outside\":true}\n")
        try {
            Files.createSymbolicLink(document.toPath(), outside.toPath())
        } catch (_: Exception) {
            return // Filesystem does not support symlinks; the refusal path is still unit-checked below.
        }

        val store = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read())
        assertEquals(StorageFailureReason.UNSAFE_OBJECT, read.reason)
        val refused = assertIs<TerminalOverlayPlacementWriteResult.Refused>(
            store.write(moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 10, 10)),
        )
        assertTrue(
            refused.reason == StorageFailureReason.UNSAFE_OBJECT || refused.reason == StorageFailureReason.CHANGED,
            "the observed unsafe object is not published over",
        )
        assertTrue(Files.isSymbolicLink(document.toPath()), "the unsafe object must stay untouched")
        assertEquals("{\"outside\":true}\n", outside.readText())
        store.close()
    }

    @Test
    fun `an oversized symlink placement is refused and its target stays untouched`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val outside = File(root, "outside-oversized.json")
        outside.writeBytes(ByteArray(5_000) { 0x79 })
        try {
            Files.createSymbolicLink(document.toPath(), outside.toPath())
        } catch (_: Exception) {
            return // Filesystem does not support symlinks; the refusal path is unit-checked above.
        }

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.UNSAFE_OBJECT,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )
        val refused = assertIs<TerminalOverlayPlacementWriteResult.Refused>(
            store.write(moved(TerminalOverlay.KEYS, TerminalOverlayOrientation.LANDSCAPE, 10, 10)),
        )
        assertTrue(
            refused.reason == StorageFailureReason.UNSAFE_OBJECT || refused.reason == StorageFailureReason.CHANGED,
            "the oversized symlink is not replaced through the size repair",
        )
        assertTrue(Files.isSymbolicLink(document.toPath()), "the unsafe object must stay untouched")
        assertEquals(5_000L, outside.length())
        store.close()
    }

    @Test
    fun `an initialized container without its document refuses to create one`() {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(
            StorageFailureReason.MISSING_INITIALIZED,
            assertIs<TerminalOverlayPlacementRead.Defaulted>(store.read()).reason,
        )
        assertEquals(
            StorageFailureReason.CHANGED,
            assertIs<TerminalOverlayPlacementWriteResult.Refused>(
                store.write(moved(TerminalOverlay.KEYS, TerminalOverlayOrientation.PORTRAIT, 0, 0)),
            ).reason,
        )
        assertFalse(document.exists())
        store.close()
    }

    @Test
    fun `a stale placement handle cannot overwrite newer bytes`() {
        val first = TerminalOverlayPlacementStorage.openStore(root)
        val second = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, first.write(allSix()))
        val newer = document.readText()

        val refusal = assertIs<TerminalOverlayPlacementWriteResult.Refused>(
            second.write(moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 1, 2)),
        )
        assertEquals(StorageFailureReason.CHANGED, refusal.reason)
        assertEquals(newer, document.readText())
        first.close()
        second.close()
    }

    @Test
    fun `codec refuses unknown extra duplicate out-of-range and oversized data`() {
        val codec = TerminalOverlayPlacementDocumentCodec
        val rejected = listOf(
            "{\"version\":3,\"overlays\":[]}\n" to StorageFailureReason.UNSUPPORTED_VERSION,
            "{\"version\":0,\"overlays\":[]}\n" to StorageFailureReason.UNSUPPORTED_VERSION,
            "{\"version\":2,\"overlays\":[],\"extra\":true}\n" to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":0,\"y\":0,\"grip\":1}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":1001,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":\"1\",\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":-1,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":null,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":1}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[" +
                "{\"overlay\":\"keys\",\"orientation\":\"portrait\",\"x\":1,\"y\":2}," +
                "{\"overlay\":\"keys\",\"orientation\":\"portrait\",\"x\":3,\"y\":4}]}\n" to
                StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"elsewhere\",\"orientation\":\"portrait\",\"x\":0,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":2,\"overlays\":[{\"overlay\":\"keys\",\"orientation\":\"sideways\",\"x\":0,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "[]\n" to StorageFailureReason.MALFORMED,
        )
        for ((body, reason) in rejected) {
            val decoded = assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(codec.decode(body))
            assertEquals(reason, decoded.reason, body.take(100))
        }
        val invalidUtf8 = codec.decode(byteArrayOf(0x7b, 0xC3.toByte(), 0x28, 0x7d))
        assertEquals(
            StorageFailureReason.UNREADABLE,
            assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(invalidUtf8).reason,
        )
        val oversized = "{\"version\":2,\"overlays\":[]}" +
            " ".repeat(TerminalOverlayPlacementDocumentCodec.MAX_DOCUMENT_BYTES)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(codec.decode(oversized)).reason,
        )
    }

    @Test
    fun `a version other than two is refused as unsupported rather than read leniently`() {
        val codec = TerminalOverlayPlacementDocumentCodec
        for (version in listOf(2, 0, 1, 3, 99)) {
            val body = "{\"version\":$version,\"overlays\":[]}\n"
            val decoded = codec.decode(body)
            when (version) {
                2 -> assertIs<TerminalOverlayPlacementDecodeResult.Valid>(decoded, body)
                else -> assertEquals(
                    StorageFailureReason.UNSUPPORTED_VERSION,
                    assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(decoded, body).reason,
                    body,
                )
            }
        }
    }

    @Test
    fun `keys docking and floating size round-trip independently in both orientations`() {
        val floatingSize = TerminalKeysFloatingSize(420, 300)
        val retainedSize = TerminalKeysFloatingSize(600, 400)
        val saved = allSixWithKeysLayouts(
            portrait = TerminalKeysLayout(docked = false, floatingSize = floatingSize),
            landscape = TerminalKeysLayout(docked = true, floatingSize = retainedSize),
        )

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(saved))
        store.close()

        // Fixed slot and field order: the same state always produces the same bytes, a
        // floating Keys writes docked:false, and a docked Keys keeps its remembered size.
        assertEquals(
            """{"version":2,"overlays":[""" +
                """{"overlay":"controls","orientation":"portrait","x":1000,"y":0},""" +
                """{"overlay":"controls","orientation":"landscape","x":900,"y":10},""" +
                """{"overlay":"status","orientation":"portrait","x":1000,"y":120},""" +
                """{"overlay":"status","orientation":"landscape","x":800,"y":200},""" +
                """{"overlay":"keys","orientation":"portrait","x":500,"y":1000,"docked":false,"w":420,"h":300},""" +
                """{"overlay":"keys","orientation":"landscape","x":250,"y":750,"w":600,"h":400}]}""" + "\n",
            document.readText(),
        )
        assertTrue(document.length() <= TerminalOverlayPlacementStorage.MAX_DOCUMENT_BYTES.toLong())

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read())
        assertEquals(saved, read.placement)
        assertEquals(TerminalOverlayPosition(500, 1000), read.placement.keysPortrait)
        assertEquals(floatingSize, read.placement.keysPortraitLayout.floatingSize)
        assertFalse(read.placement.keysPortraitLayout.docked)
        assertEquals(TerminalOverlayPosition(250, 750), read.placement.keysLandscape)
        assertEquals(retainedSize, read.placement.keysLandscapeLayout.floatingSize)
        assertTrue(read.placement.keysLandscapeLayout.docked)
        // Controls and status keep their own positions and have no Keys layout at all.
        assertEquals(TerminalOverlayPosition(1000, 0), read.placement.controlsPortrait)
        assertEquals(TerminalOverlayPosition(800, 200), read.placement.statusLandscape)
        reopened.close()
    }

    @Test
    fun `toggling keys docking keeps both sizes and positions and leaves the other orientation alone`() {
        val portraitSize = TerminalKeysFloatingSize(420, 300)
        val landscapeSize = TerminalKeysFloatingSize(600, 400)
        val floating = allSixWithKeysLayouts(
            portrait = TerminalKeysLayout(docked = false, floatingSize = portraitSize),
            landscape = TerminalKeysLayout(docked = false, floatingSize = landscapeSize),
        )

        val dockedAgain = floating.withKeysLayout(
            TerminalOverlayOrientation.PORTRAIT,
            floating.keysLayout(TerminalOverlayOrientation.PORTRAIT).copy(docked = true),
        )

        // Docking is a layout toggle only: it clears neither position nor size, in
        // either orientation, and it never touches the other orientation's layout.
        assertEquals(TerminalOverlayPosition(500, 1000), dockedAgain.keysPortrait)
        assertEquals(portraitSize, dockedAgain.keysPortraitLayout.floatingSize)
        assertTrue(dockedAgain.keysPortraitLayout.docked)
        assertEquals(TerminalOverlayPosition(250, 750), dockedAgain.keysLandscape)
        assertEquals(landscapeSize, dockedAgain.keysLandscapeLayout.floatingSize)
        assertFalse(dockedAgain.keysLandscapeLayout.docked)

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(dockedAgain))
        store.close()
        assertTrue(document.readText().contains("""{"overlay":"keys","orientation":"portrait","x":500,"y":1000,"w":420,"h":300}"""))
        assertTrue(document.readText().contains("""{"overlay":"keys","orientation":"landscape","x":250,"y":750,"docked":false,"w":600,"h":400}"""))

        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(dockedAgain, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
        reopened.close()
    }

    @Test
    fun `a keys layout change without a position round-trips no position instead of an invented one`() {
        val codec = TerminalOverlayPlacementDocumentCodec
        val poppedOut = TerminalOverlayPlacement.DEFAULT
            .withKeysLayout(TerminalOverlayOrientation.PORTRAIT, TerminalKeysLayout(docked = false))
        assertEquals(
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false}]}""" + "\n",
            codec.encode(poppedOut),
        )
        val decodedPopout = assertIs<TerminalOverlayPlacementDecodeResult.Valid>(codec.decode(codec.encode(poppedOut))).placement
        assertEquals(poppedOut, decodedPopout)
        assertNull(decodedPopout.keysPortrait, "no coordinate is invented before the first drag")
        assertNull(decodedPopout.keysPortraitLayout.floatingSize)
        assertFalse(decodedPopout.keysPortraitLayout.docked)
        assertEquals(TerminalKeysLayout.DEFAULT, decodedPopout.keysLandscapeLayout)
        assertNull(decodedPopout.keysLandscape)

        val resized = TerminalOverlayPlacement.DEFAULT
            .withKeysLayout(
                TerminalOverlayOrientation.LANDSCAPE,
                TerminalKeysLayout(docked = false, floatingSize = TerminalKeysFloatingSize(600, 400)),
            )
        assertEquals(
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"landscape","docked":false,"w":600,"h":400}]}""" + "\n",
            codec.encode(resized),
        )
        assertEquals(resized, assertIs<TerminalOverlayPlacementDecodeResult.Valid>(codec.decode(codec.encode(resized))).placement)

        // A remembered size while docked is still non-default state and still round-trips.
        val dockedWithSize = TerminalOverlayPlacement.DEFAULT
            .withKeysLayout(
                TerminalOverlayOrientation.PORTRAIT,
                TerminalKeysLayout(docked = true, floatingSize = TerminalKeysFloatingSize(600, 400)),
            )
        assertEquals(
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","w":600,"h":400}]}""" + "\n",
            codec.encode(dockedWithSize),
        )
        assertEquals(dockedWithSize, assertIs<TerminalOverlayPlacementDecodeResult.Valid>(codec.decode(codec.encode(dockedWithSize))).placement)

        val store = TerminalOverlayPlacementStorage.openStore(root)
        assertEquals(TerminalOverlayPlacementWriteResult.Published, store.write(poppedOut))
        store.close()
        val reopened = TerminalOverlayPlacementStorage.openStore(root)
        val read = assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read())
        assertEquals(poppedOut, read.placement)
        assertNull(read.placement.keysPortrait)
        reopened.close()
    }

    @Test
    fun `the codec refuses malformed keys layout data in every shape`() {
        val codec = TerminalOverlayPlacementDocumentCodec
        val rejected = listOf(
            // A Keys entry with no position, no docking state, and no size is empty.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait"}]}""" to
                StorageFailureReason.MALFORMED,
            // A half position and a half size are never remembered values.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":200,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","y":700,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","w":420,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","h":300,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            // docked is a real JSON boolean only.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":"false"}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":1}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":null}]}""" to
                StorageFailureReason.MALFORMED,
            // Sizes are real integers in 1..1000, never quoted, null, fractional, or out of range.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":0,"h":300}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":420,"h":0}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":1001,"h":300}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":-1,"h":300}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":"420","h":300}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":420.5,"h":300}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"w":null,"h":null}]}""" to
                StorageFailureReason.MALFORMED,
            // Positions stay strict even on a Keys entry that also carries layout data.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":1001,"y":700,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":-5,"y":700,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":null,"y":null,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":200,"y":"700","docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            // Keys-only fields never appear on controls or status.
            """{"version":2,"overlays":[{"overlay":"controls","orientation":"portrait","x":0,"y":0,"docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"controls","orientation":"portrait","x":0,"y":0,"w":10,"h":10}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"status","orientation":"landscape","x":0,"y":0,"w":10,"h":10}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"status","orientation":"landscape","docked":true}]}""" to
                StorageFailureReason.MALFORMED,
            // Unknown fields, duplicate slots, and the six-slot bound still refuse.
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false,"grip":1}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false},{"overlay":"keys","orientation":"portrait","x":1,"y":2}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","x":1,"y":2},{"overlay":"keys","orientation":"portrait"}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"up","docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"somewhere","orientation":"portrait","docked":false}]}""" to
                StorageFailureReason.MALFORMED,
            """{"version":2,"overlays":[{"overlay":"keys","orientation":"portrait","docked":false},""" +
                """{"overlay":"keys","orientation":"landscape","docked":false},""" +
                """{"overlay":"controls","orientation":"portrait","x":1,"y":1},""" +
                """{"overlay":"controls","orientation":"landscape","x":2,"y":2},""" +
                """{"overlay":"status","orientation":"portrait","x":3,"y":3},""" +
                """{"overlay":"status","orientation":"landscape","x":4,"y":4},""" +
                """{"overlay":"keys","orientation":"portrait","x":5,"y":5}]}""" to
                StorageFailureReason.MALFORMED,
        )
        for ((body, reason) in rejected) {
            val decoded = assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(codec.decode("$body\n"), body.take(140))
            assertEquals(reason, decoded.reason, body.take(140))
        }
    }

    @Test
    fun `keys layout accessors preserve every position and both orientations independently`() {
        val portraitSize = TerminalKeysFloatingSize(420, 300)
        val base = allSix().withKeysLayout(
            TerminalOverlayOrientation.PORTRAIT,
            TerminalKeysLayout(docked = false, floatingSize = portraitSize),
        )
        assertEquals(TerminalKeysLayout.DEFAULT, base.keysLandscapeLayout)
        assertEquals(base.keysPortraitLayout, base.keysLayout(TerminalOverlayOrientation.PORTRAIT))
        assertEquals(TerminalKeysLayout.DEFAULT, base.keysLayout(TerminalOverlayOrientation.LANDSCAPE))

        // A completed drag rewrites exactly one position; both Keys layouts survive.
        val moved = base
            .withPosition(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, TerminalOverlayPosition(12, 34))
            .withPosition(TerminalOverlay.KEYS, TerminalOverlayOrientation.LANDSCAPE, TerminalOverlayPosition(99, 88))
        assertEquals(TerminalKeysLayout.DEFAULT, moved.keysLandscapeLayout)
        assertEquals(portraitSize, moved.keysPortraitLayout.floatingSize)
        assertFalse(moved.keysPortraitLayout.docked)
        assertEquals(TerminalOverlayPosition(12, 34), moved.controlsPortrait)
        assertEquals(TerminalOverlayPosition(99, 88), moved.keysLandscape)

        // A docking or resize command rewrites exactly one layout; all six positions and
        // the other orientation survive.
        val layoutOnly = moved.withKeysLayout(
            TerminalOverlayOrientation.LANDSCAPE,
            TerminalKeysLayout(docked = false, floatingSize = TerminalKeysFloatingSize(1, 1000)),
        )
        assertEquals(TerminalOverlayPosition(12, 34), layoutOnly.controlsPortrait)
        assertEquals(TerminalOverlayPosition(900, 10), layoutOnly.controlsLandscape)
        assertEquals(TerminalOverlayPosition(1000, 120), layoutOnly.statusPortrait)
        assertEquals(TerminalOverlayPosition(800, 200), layoutOnly.statusLandscape)
        assertEquals(TerminalOverlayPosition(500, 1000), layoutOnly.keysPortrait)
        assertEquals(TerminalOverlayPosition(99, 88), layoutOnly.keysLandscape)
        assertEquals(portraitSize, layoutOnly.keysPortraitLayout.floatingSize)
        assertEquals(TerminalKeysFloatingSize(1, 1000), layoutOnly.keysLandscapeLayout.floatingSize)

        // A natural floating size is expressible without giving up the docking state.
        val naturalSize = layoutOnly.withKeysLayout(
            TerminalOverlayOrientation.LANDSCAPE,
            TerminalKeysLayout(docked = false),
        )
        assertNull(naturalSize.keysLandscapeLayout.floatingSize)
        assertFalse(naturalSize.keysLandscapeLayout.docked)
        assertEquals(TerminalOverlayPosition(99, 88), naturalSize.keysLandscape)

        assertEquals(TerminalKeysLayout.DEFAULT, TerminalOverlayPlacement.DEFAULT.keysLandscapeLayout)
        assertEquals(TerminalKeysLayout.DEFAULT, TerminalKeysLayout())
        assertTrue(TerminalKeysLayout.DEFAULT.docked)
        assertNull(TerminalKeysLayout.DEFAULT.floatingSize)
    }

    @Test
    fun `a keys floating size is bounded to one through one thousand permille per component`() {
        TerminalKeysFloatingSize(1, 1000)
        TerminalKeysFloatingSize(500, 500)
        for (bad in listOf(0, -1, 1_001, Int.MIN_VALUE, Int.MAX_VALUE)) {
            assertFailsWith<IllegalArgumentException> { TerminalKeysFloatingSize(bad, 500) }
            assertFailsWith<IllegalArgumentException> { TerminalKeysFloatingSize(500, bad) }
        }
    }

    @Test
    fun `the default placement encodes an empty version two document`() {
        val body = TerminalOverlayPlacementDocumentCodec.encode(TerminalOverlayPlacement.DEFAULT)
        assertEquals("""{"version":2,"overlays":[]}""" + "\n", body)
        assertEquals(
            TerminalOverlayPlacement.DEFAULT,
            assertIs<TerminalOverlayPlacementDecodeResult.Valid>(
                TerminalOverlayPlacementDocumentCodec.decode(body),
            ).placement,
        )
    }

    @Test
    fun `default slots and permille positions resolve clamped and round-trip`() {
        val controls = TerminalOverlayGeometry.resolveDefault(
            TerminalOverlay.CONTROLS, stableWidth = 1000, stableHeight = 800,
            overlayWidth = 300, overlayHeight = 100, controlsSlotHeight = 100,
        )
        assertEquals(TerminalOverlayPoint(700, 0), controls)
        val status = TerminalOverlayGeometry.resolveDefault(
            TerminalOverlay.STATUS, stableWidth = 1000, stableHeight = 800,
            overlayWidth = 300, overlayHeight = 100, controlsSlotHeight = 100,
        )
        assertEquals(TerminalOverlayPoint(700, 100), status)
        val keys = TerminalOverlayGeometry.resolveDefault(
            TerminalOverlay.KEYS, stableWidth = 1000, stableHeight = 800,
            overlayWidth = 1000, overlayHeight = 200, controlsSlotHeight = 0,
        )
        assertEquals(TerminalOverlayPoint(0, 300), keys)
        // A never-placed floating panel is detached from the bottom edge with free space
        // on every side, rather than anchored where a docked band sits. The default is a
        // display value: it is not a remembered position and writes nothing.
        val detached = TerminalOverlayGeometry.resolveDefault(
            TerminalOverlay.KEYS, stableWidth = 1000, stableHeight = 800,
            overlayWidth = 400, overlayHeight = 200, controlsSlotHeight = 0,
        )
        assertEquals(TerminalOverlayPoint(300, 300), detached)
        assertTrue(detached.y + 200 < 800,
            "A default panel must leave free space below it: $detached")
        assertTrue(detached.x + 400 < 1000,
            "A default panel must leave free space beside it: $detached")

        // Moving the controls slot is not an input here, so the status default stays put.
        val statusAfterControlsMove = TerminalOverlayGeometry.resolveDefault(
            TerminalOverlay.STATUS, stableWidth = 1000, stableHeight = 800,
            overlayWidth = 300, overlayHeight = 100, controlsSlotHeight = 100,
        )
        assertEquals(status, statusAfterControlsMove)

        val explicit = TerminalOverlayGeometry.resolve(
            stableWidth = 1000, stableHeight = 800, overlayWidth = 300, overlayHeight = 100,
            position = TerminalOverlayPosition(500, 500),
        )
        assertEquals(TerminalOverlayPoint(350, 350), explicit)
        val clamped = TerminalOverlayGeometry.clampToVisible(
            point = explicit, visibleWidth = 800, visibleHeight = 500,
            overlayWidth = 300, overlayHeight = 100,
        )
        assertEquals(TerminalOverlayPoint(350, 350), clamped)
        val imeClamped = TerminalOverlayGeometry.clampToVisible(
            point = TerminalOverlayPoint(350, 700), visibleWidth = 800, visibleHeight = 500,
            overlayWidth = 300, overlayHeight = 100,
        )
        assertEquals(TerminalOverlayPoint(350, 400), imeClamped)

        // One extent smaller than the overlay itself still clamps into free space rather
        // than inventing a floor or a second slot: the point lands on the only legal top.
        val smallerThanOverlay = TerminalOverlayGeometry.clampToVisible(
            point = TerminalOverlayPoint(350, 700), visibleWidth = 800, visibleHeight = 100,
            overlayWidth = 300, overlayHeight = 100,
        )
        assertEquals(TerminalOverlayPoint(350, 0), smallerThanOverlay)

        val roundTrip = TerminalOverlayGeometry.toPosition(
            point = TerminalOverlayPoint(500, 400), stableWidth = 1000, stableHeight = 800,
            overlayWidth = 300, overlayHeight = 100,
        )
        assertEquals(TerminalOverlayPosition(714, 571), roundTrip)
        assertEquals(
            TerminalOverlayPoint(500, 400),
            TerminalOverlayGeometry.resolve(1000, 800, 300, 100, roundTrip),
        )
    }

    @Test
    fun `a completed drag repairs an empty real placement document`() = runTest {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        document.writeBytes(ByteArray(0))
        val holder = TerminalOverlayPlacementHolder(
            openStore = { TerminalOverlayPlacementStorage.openStore(root) },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertTrue(holder.uiState.value.ready)
            assertEquals(TerminalOverlayPlacementWarning.LOADED_DEFAULTS, holder.uiState.value.warning)
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)

            val repaired = allSix()
            holder.commit(repaired)
            advanceUntilIdle()
            assertNull(holder.uiState.value.warning)
            assertEquals(repaired, holder.uiState.value.placement)

            val reopened = TerminalOverlayPlacementStorage.openStore(root)
            assertEquals(repaired, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
            reopened.close()
        } finally {
            holder.close()
        }
    }

    @Test
    fun `holder defaults warns and a completed drag repairs a real malformed document`() = runTest {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        val unrelated = File(root, "other-private-document.json")
        unrelated.writeText("{\"keep\":true}\n")
        document.writeText("{\"version\":2,\"overlays\":[{\"overlay\":\"controls\"}]}\n")

        val holder = TerminalOverlayPlacementHolder(
            openStore = { TerminalOverlayPlacementStorage.openStore(root) },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertEquals(TerminalOverlayPlacementWarning.LOADED_DEFAULTS, holder.uiState.value.warning)
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)
            assertTrue(holder.uiState.value.ready)

            val repaired = allSix()
            holder.commit(repaired)
            advanceUntilIdle()
            assertNull(holder.uiState.value.warning)
            assertEquals(repaired, holder.uiState.value.placement)
            assertEquals("{\"keep\":true}\n", unrelated.readText())

            val reopened = TerminalOverlayPlacementStorage.openStore(root)
            assertEquals(repaired, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
            reopened.close()
        } finally {
            holder.close()
        }
    }

    @Test
    fun `holder defaults warns and a completed drag repairs a real oversized document`() = runTest {
        val container = File(root, TerminalOverlayPlacementStorage.CONTAINER_DIR_NAME)
        assertTrue(container.mkdirs())
        document.writeBytes(ByteArray(5_000))
        val holder = TerminalOverlayPlacementHolder(
            openStore = { TerminalOverlayPlacementStorage.openStore(root) },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertEquals(TerminalOverlayPlacementWarning.LOADED_DEFAULTS, holder.uiState.value.warning)
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)
            assertTrue(holder.uiState.value.ready)

            val repaired = allSix()
            holder.commit(repaired)
            advanceUntilIdle()
            assertNull(holder.uiState.value.warning)
            assertEquals(repaired, holder.uiState.value.placement)

            val reopened = TerminalOverlayPlacementStorage.openStore(root)
            assertEquals(repaired, assertIs<TerminalOverlayPlacementRead.Saved>(reopened.read()).placement)
            reopened.close()
        } finally {
            holder.close()
        }
    }

    @Test
    fun `holder publishes a loaded six-slot placement with no warning`() = runTest {
        val saved = allSix()
        val store = RecordingStore(read = TerminalOverlayPlacementRead.Saved(saved))
        val holder = TerminalOverlayPlacementHolder(
            openStore = { store },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertEquals(saved, holder.uiState.value.placement)
            assertNull(holder.uiState.value.warning)
            assertTrue(holder.uiState.value.ready)
        } finally {
            holder.close()
        }
    }

    @Test
    fun `an early drag before completed load cannot erase saved slots`() = runTest {
        val saved = allSix()
        val store = RecordingStore(read = TerminalOverlayPlacementRead.Saved(saved))
        val holder = TerminalOverlayPlacementHolder(
            openStore = { store },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            // The load coroutine is queued but has not run: this is the delayed-load
            // window in which placement-dependent composition must not accept drags.
            holder.start()
            val early = moved(TerminalOverlay.KEYS, TerminalOverlayOrientation.PORTRAIT, 10, 20)
            holder.commit(early)
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)
            assertFalse(holder.uiState.value.ready)

            advanceUntilIdle()
            assertTrue(holder.uiState.value.ready)
            assertEquals(saved, holder.uiState.value.placement, "The five other saved slots are still present")
            assertNull(holder.uiState.value.warning)
            assertTrue(store.writes.isEmpty(), "An ignored early interaction writes nothing")
        } finally {
            holder.close()
        }
    }

    @Test
    fun `single writer publishes the last completed six-slot state and never blocks commit`() = runTest {
        val store = RecordingStore()
        val holder = TerminalOverlayPlacementHolder(
            openStore = { store },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)
            assertNull(holder.uiState.value.warning)
            assertTrue(holder.uiState.value.ready)

            // The idle single writer is already suspended in its conflated receive. The
            // first snapshot is handed straight to that waiting receiver (it is owned,
            // not pending), so only snapshots queued behind it can be conflated: the
            // middle one is replaced by the last before the writer asks again.
            val first = moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 100, 200)
            val middle = moved(TerminalOverlay.KEYS, TerminalOverlayOrientation.LANDSCAPE, 30, 40)
            val last = allSix()
            holder.commit(first)
            holder.commit(middle)
            holder.commit(last)
            // All three commands returned without any IO having run, and the visible
            // state is already the newest completed six-slot snapshot.
            assertTrue(store.writes.isEmpty(), "commit never runs or waits for the IO write")
            assertEquals(last, holder.uiState.value.placement)
            advanceUntilIdle()
            // One writer, in commit order: the snapshot it already owned, then the last
            // state. The unconsumed middle snapshot never reaches the store.
            assertEquals(listOf(first, last), store.writes)
            assertEquals(last, store.writes.last(), "the last completed state is what persists")
            assertEquals(last, holder.uiState.value.placement)
            assertNull(holder.uiState.value.warning)

            // The writer is serving again: a later completed drag is written after, never
            // interleaved with or reordered before, the earlier ones.
            val again = moved(TerminalOverlay.STATUS, TerminalOverlayOrientation.PORTRAIT, 7, 8)
            holder.commit(again)
            assertEquals(listOf(first, last), store.writes, "commit still does not wait for IO")
            assertEquals(again, holder.uiState.value.placement)
            advanceUntilIdle()
            assertEquals(listOf(first, last, again), store.writes)
            assertEquals(again, holder.uiState.value.placement)
            assertNull(holder.uiState.value.warning)
        } finally {
            holder.close()
        }
    }

    @Test
    fun `defaulted load warns and a completed drag repairs through the same normal handle`() = runTest {
        val store = RecordingStore(read = TerminalOverlayPlacementRead.Defaulted(StorageFailureReason.MALFORMED))
        val holder = TerminalOverlayPlacementHolder(
            openStore = { store },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            assertEquals(TerminalOverlayPlacementWarning.LOADED_DEFAULTS, holder.uiState.value.warning)
            assertEquals(TerminalOverlayPlacement.DEFAULT, holder.uiState.value.placement)
            assertTrue(holder.uiState.value.ready)

            val repaired = allSix()
            holder.commit(repaired)
            advanceUntilIdle()
            assertEquals(listOf(repaired), store.writes)
            assertNull(holder.uiState.value.warning)
            assertEquals(repaired, holder.uiState.value.placement)
        } finally {
            holder.close()
        }
    }

    @Test
    fun `a refused write warns and a later drag uses a fresh normal handle`() = runTest {
        val failing = RecordingStore(
            writeResult = TerminalOverlayPlacementWriteResult.Refused(
                StorageFailureReason.WRITE_FAILED,
                commitAttempted = true,
            ),
        )
        val succeeding = RecordingStore()
        val stores = listOf(failing, succeeding)
        var nextStore = 0
        val holder = TerminalOverlayPlacementHolder(
            openStore = { stores[nextStore++] },
            dispatcher = StandardTestDispatcher(testScheduler),
        )
        try {
            holder.start()
            advanceUntilIdle()
            val first = moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 10, 20)
            holder.commit(first)
            advanceUntilIdle()
            assertEquals(TerminalOverlayPlacementWarning.SAVE_FAILED, holder.uiState.value.warning)
            assertTrue(holder.uiState.value.ready)
            assertTrue(failing.closed, "the uncertain handle is discarded, not permanently reused")

            val second = allSix()
            holder.commit(second)
            advanceUntilIdle()
            assertEquals(listOf(second), succeeding.writes)
            assertNull(holder.uiState.value.warning)
            assertEquals(second, holder.uiState.value.placement)
        } finally {
            holder.close()
        }
    }

    private class RecordingStore(
        private val read: TerminalOverlayPlacementRead = TerminalOverlayPlacementRead.Fresh,
        private val writeResult: TerminalOverlayPlacementWriteResult = TerminalOverlayPlacementWriteResult.Published,
    ) : TerminalOverlayPlacementStore {
        val writes = mutableListOf<TerminalOverlayPlacement>()
        var closed = false

        override fun read(): TerminalOverlayPlacementRead = read

        override fun write(placement: TerminalOverlayPlacement): TerminalOverlayPlacementWriteResult {
            writes += placement
            return writeResult
        }

        override fun close() {
            closed = true
        }
    }

    private class RefusingStorage(
        private val reason: StorageFailureReason,
    ) : SingleDocumentStorage {
        var writeAttempts = 0
        var published = 0

        override fun read(): DocumentRead = DocumentRead.Refused(reason)

        override fun write(bytes: ByteArray): DocumentWriteResult {
            writeAttempts += 1
            return DocumentWriteResult.Refused(reason)
        }
    }
}
