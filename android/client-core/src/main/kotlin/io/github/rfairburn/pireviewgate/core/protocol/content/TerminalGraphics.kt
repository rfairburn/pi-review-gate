package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * The only MIME type the native graphics subset carries. A payload declaring
 * anything else is refused rather than reinterpreted.
 */
const val TERMINAL_GRAPHICS_PNG_MIME_TYPE: String = "image/png"

/**
 * A validated PNG retained for the hosted terminal's current images. [base64] is
 * canonical base64 PNG; raw child escape or control bytes are never included.
 */
data class TerminalGraphicsImage(
	/** The image id, or a surface-local id when the child omitted one. */
	val id: String,
	val mimeType: String,
	val widthPx: Int,
	val heightPx: Int,
	val base64: String,
)

/** Pixel-space source rectangle within the PNG. */
data class TerminalGraphicsCrop(val x: Long, val y: Long, val width: Long, val height: Long)

/** Cell-space clipping for an image placement at the viewport edge. */
data class TerminalGraphicsClip(
	val leftColumns: Int,
	val topRows: Int,
	val rightColumns: Int,
	val bottomRows: Int,
)

/** An immutable placement expressed in original terminal-cell coordinates. */
data class TerminalGraphicsPlacement(
	val id: String,
	val imageId: String,
	val column: Int,
	val row: Int,
	val columns: Int,
	val rows: Int,
	val crop: TerminalGraphicsCrop,
	val clip: TerminalGraphicsClip,
)

/**
 * The payload-free alternative for a visible placement, including when its image
 * data was rejected or the downstream renderer cannot use PNGs.
 */
data class TerminalGraphicsFallback(
	val id: String,
	val mimeType: String,
	/** Pixel width when the native frame stated one; a peer-declared u32 value. */
	val widthPx: Long? = null,
	/** Pixel height when the native frame stated one; a peer-declared u32 value. */
	val heightPx: Long? = null,
	val column: Int,
	val row: Int,
	val columns: Int,
	val rows: Int,
	val clip: TerminalGraphicsClip,
)

/** Typed image placements and payload-free fallback alternatives for one frame. */
data class TerminalGraphicsFrame(
	val images: List<TerminalGraphicsImage>,
	val placements: List<TerminalGraphicsPlacement>,
	val fallbacks: List<TerminalGraphicsFallback>,
)

/** Result of the shared native PNG validation. */
data class TerminalGraphicsPng(val widthPx: Int, val heightPx: Int, val byteLength: Int)
