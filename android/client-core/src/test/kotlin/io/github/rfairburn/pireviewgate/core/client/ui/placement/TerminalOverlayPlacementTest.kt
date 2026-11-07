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
        val malformed = "{\"version\":1,\"overlays\":[{\"overlay\":\"controls\"}]}\n"
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
            "{\"version\":2,\"overlays\":[]}\n" to StorageFailureReason.UNSUPPORTED_VERSION,
            "{\"version\":1,\"overlays\":[],\"extra\":true}\n" to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":0,\"y\":0,\"grip\":1}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":1001,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[{\"overlay\":\"controls\",\"orientation\":\"portrait\",\"x\":\"1\",\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[" +
                "{\"overlay\":\"keys\",\"orientation\":\"portrait\",\"x\":1,\"y\":2}," +
                "{\"overlay\":\"keys\",\"orientation\":\"portrait\",\"x\":3,\"y\":4}]}\n" to
                StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[{\"overlay\":\"elsewhere\",\"orientation\":\"portrait\",\"x\":0,\"y\":0}]}\n"
                to StorageFailureReason.MALFORMED,
            "{\"version\":1,\"overlays\":[{\"overlay\":\"keys\",\"orientation\":\"sideways\",\"x\":0,\"y\":0}]}\n"
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
        val oversized = "{\"version\":1,\"overlays\":[]}" +
            " ".repeat(TerminalOverlayPlacementDocumentCodec.MAX_DOCUMENT_BYTES)
        assertEquals(
            StorageFailureReason.MALFORMED,
            assertIs<TerminalOverlayPlacementDecodeResult.Invalid>(codec.decode(oversized)).reason,
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
        assertEquals(TerminalOverlayPoint(0, 600), keys)

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

        val floored = TerminalOverlayGeometry.clampToVisible(
            point = TerminalOverlayPoint(350, 0), visibleWidth = 800, visibleHeight = 500,
            overlayWidth = 300, overlayHeight = 100, minimumY = 120,
        )
        assertEquals(TerminalOverlayPoint(350, 120), floored)
        val cannotFitBelowFloor = TerminalOverlayGeometry.clampToVisible(
            point = TerminalOverlayPoint(350, 0), visibleWidth = 800, visibleHeight = 100,
            overlayWidth = 300, overlayHeight = 100, minimumY = 120,
        )
        assertEquals(TerminalOverlayPoint(350, 0), cannotFitBelowFloor)

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
        document.writeText("{\"version\":1,\"overlays\":[{\"overlay\":\"controls\"}]}\n")

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

            val first = moved(TerminalOverlay.CONTROLS, TerminalOverlayOrientation.PORTRAIT, 100, 200)
            val last = allSix()
            holder.commit(first)
            holder.commit(last)
            // Both commands were accepted without waiting for IO; conflation keeps the last.
            assertEquals(last, holder.uiState.value.placement)
            advanceUntilIdle()
            assertEquals(listOf(last), store.writes)
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
