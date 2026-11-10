package io.github.rfairburn.pireviewgate.core.protocol.content

/**
 * The model-to-wire side of the codec.
 *
 * Key presence is decided here explicitly: an absent optional key is never
 * written, an explicit null is written only where the wire may say null, and the
 * native serializer's default attributes and default colors stay omitted rather
 * than becoming explicit `false` values.
 */
internal fun frameNode(frame: ContentFrame): WireNode.WireObject = when (frame) {
	is HelloFrame -> wireObject(
		"type" to text(ContentFrameType.HELLO.wireValue),
		"service" to text(frame.service),
		"major" to number(frame.major),
		"minor" to number(frame.minor),
		"capabilities" to stringArray(frame.capabilities),
	)

	is HelloAckFrame -> wireObject(
		"type" to text(ContentFrameType.HELLO_ACK.wireValue),
		"service" to text(frame.service),
		"major" to number(frame.major),
		"minor" to number(frame.minor),
		"capabilities" to stringArray(frame.capabilities),
	)

	is SubscribeFrame -> wireObject(
		"type" to text(ContentFrameType.SUBSCRIBE.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"hostRunId" to text(frame.hostRunId),
		"sessionId" to text(frame.sessionId),
		"cols" to number(frame.cols),
		"rows" to number(frame.rows),
	)

	is SubscribedFrame -> wireObject(
		"type" to text(ContentFrameType.SUBSCRIBED.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"sessionId" to text(frame.sessionId),
		"hostRunId" to text(frame.hostRunId),
	)

	is ResizeFrame -> wireObject(
		"type" to text(ContentFrameType.RESIZE.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"cols" to number(frame.cols),
		"rows" to number(frame.rows),
	)

	is UnsubscribeFrame -> wireObject(
		"type" to text(ContentFrameType.UNSUBSCRIBE.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
	)

	is UnsubscribedFrame -> wireObject(
		"type" to text(ContentFrameType.UNSUBSCRIBED.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
	)

	is EndFrame -> wireObject(
		"type" to text(ContentFrameType.END.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"code" to text(frame.code.wireValue),
	)

	is ErrorFrame -> wireObject(
		"type" to text(ContentFrameType.ERROR.wireValue),
		"code" to text(frame.code.wireValue),
		"subscriptionId" to frame.subscriptionId?.let(::text),
	)

	is ContentBeginFrame -> wireObject(
		"type" to text(ContentFrameType.CONTENT_BEGIN.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"transferId" to text(frame.transferId),
		"hostRunId" to text(frame.hostRunId),
		"sessionId" to text(frame.sessionId),
		// Required on the wire even when the publish names no native conversation.
		"nativeSession" to (frame.nativeSession?.let(::nativeSessionNode) ?: WireNode.WireNull),
		"sequence" to number(frame.sequence),
		"geometry" to geometryNode(frame.geometry),
		"inputModes" to inputModesNode(frame.inputModes),
		"byteLength" to number(frame.byteLength),
		"chunkCount" to number(frame.chunkCount),
		"inputSource" to optionalNativeIoSourceNode(frame.inputSource),
	)

	is ContentChunkFrame -> wireObject(
		"type" to text(ContentFrameType.CONTENT_CHUNK.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"transferId" to text(frame.transferId),
		"index" to number(frame.index),
		"data" to text(Base64Wire.encodeCanonical(frame.data)),
	)

	is ContentEndFrame -> wireObject(
		"type" to text(ContentFrameType.CONTENT_END.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"transferId" to text(frame.transferId),
		"sequence" to number(frame.sequence),
	)

	is InputFrame -> wireObject(
		"type" to text(ContentFrameType.INPUT.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"inputId" to text(frame.inputId),
		"ordinal" to number(frame.ordinal),
		"source" to nativeIoSourceNode(frame.source),
		"inputModes" to inputModesNode(frame.inputModes),
		"kind" to text(frame.kind.wireValue),
		"data" to text(Base64Wire.encodeCanonical(frame.data)),
	)

	is InputBeginFrame -> wireObject(
		"type" to text(ContentFrameType.INPUT_BEGIN.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"inputId" to text(frame.inputId),
		"ordinal" to number(frame.ordinal),
		"source" to nativeIoSourceNode(frame.source),
		"inputModes" to inputModesNode(frame.inputModes),
		"kind" to text(frame.kind.wireValue),
		"byteLength" to number(frame.byteLength),
		"chunkCount" to number(frame.chunkCount),
	)

	is InputChunkFrame -> wireObject(
		"type" to text(ContentFrameType.INPUT_CHUNK.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"inputId" to text(frame.inputId),
		"index" to number(frame.index),
		"data" to text(Base64Wire.encodeCanonical(frame.data)),
	)

	is InputEndFrame -> wireObject(
		"type" to text(ContentFrameType.INPUT_END.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"inputId" to text(frame.inputId),
		"ordinal" to number(frame.ordinal),
	)

	is CopyFrame -> wireObject(
		"type" to text(ContentFrameType.COPY.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"copyId" to text(frame.copyId),
		"sequence" to number(frame.sequence),
		"source" to nativeIoSourceNode(frame.source),
		"dispatchId" to number(frame.dispatchId),
		"event" to copyEventNode(frame.event),
	)

	is CopyBeginFrame -> wireObject(
		"type" to text(ContentFrameType.COPY_BEGIN.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"copyId" to text(frame.copyId),
		"sequence" to number(frame.sequence),
		"source" to nativeIoSourceNode(frame.source),
		"dispatchId" to number(frame.dispatchId),
		"byteLength" to number(frame.byteLength),
		"chunkCount" to number(frame.chunkCount),
	)

	is CopyChunkFrame -> wireObject(
		"type" to text(ContentFrameType.COPY_CHUNK.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"copyId" to text(frame.copyId),
		"index" to number(frame.index),
		"data" to text(Base64Wire.encodeCanonical(frame.data)),
	)

	is CopyEndFrame -> wireObject(
		"type" to text(ContentFrameType.COPY_END.wireValue),
		"subscriptionId" to text(frame.subscriptionId),
		"copyId" to text(frame.copyId),
		"sequence" to number(frame.sequence),
	)
}

/** The complete native viewport as the canonical JSON payload of one transfer. */
internal fun terminalFrameNode(frame: TerminalFrame): WireNode.WireObject = wireObject(
	"cols" to number(frame.cols),
	"rows" to number(frame.rows),
	"lines" to stringArray(frame.lines),
	"cursor" to wireObject(
		"column" to number(frame.cursor.column),
		"row" to number(frame.cursor.row),
		"visible" to bool(frame.cursor.visible),
	),
	"styles" to (frame.styles?.let { styles -> wireArray(styles.map(::styleLineNode)) }),
	"graphics" to (frame.graphics?.let(::graphicsNode)),
)

private fun styleLineNode(style: TerminalLineStyles): WireNode.WireObject = wireObject(
	"line" to number(style.line),
	"runs" to wireArray(style.runs.map(::cellRunNode)),
)

private fun cellRunNode(run: TerminalCellRun): WireNode.WireObject = wireObject(
	"startColumn" to number(run.startColumn),
	"text" to text(run.text),
	"fg" to (run.fg?.let(::colorNode)),
	"bg" to (run.bg?.let(::colorNode)),
	"bold" to attribute(run.bold),
	"dim" to attribute(run.dim),
	"italic" to attribute(run.italic),
	"underline" to attribute(run.underline),
	"inverse" to attribute(run.inverse),
	"blink" to attribute(run.blink),
	"invisible" to attribute(run.invisible),
	"strikethrough" to attribute(run.strikethrough),
	"overline" to attribute(run.overline),
)

private fun colorNode(spec: TerminalColorSpec): WireNode.WireObject = wireObject(
	"mode" to text(spec.mode.wireValue),
	"value" to number(spec.value),
)

private fun inputModesNode(modes: TerminalInputModes): WireNode.WireObject = wireObject(
	"kittyFlags" to number(modes.kittyFlags),
	"applicationCursorKeys" to bool(modes.applicationCursorKeys),
	"applicationKeypad" to bool(modes.applicationKeypad),
	"bracketedPaste" to bool(modes.bracketedPaste),
	"mouseTracking" to text(modes.mouseTracking.wireValue),
	"modifyOtherKeys" to number(modes.modifyOtherKeys),
	"mouseEncoding" to text(modes.mouseEncoding.wireValue),
)

private fun geometryNode(geometry: SessionGeometry): WireNode.WireObject = wireObject(
	"cols" to number(geometry.cols),
	"rows" to number(geometry.rows),
	"revision" to number(geometry.revision),
)

private fun nativeSessionNode(ref: NativeSessionRef): WireNode.WireObject = wireObject(
	"sessionId" to text(ref.sessionId),
	"epoch" to number(ref.epoch),
)

private fun optionalNativeIoSourceNode(field: OptionalNativeIoSource): WireNode? = when (field) {
	is OptionalNativeIoSource.Absent -> null
	is OptionalNativeIoSource.NoSource -> WireNode.WireNull
	is OptionalNativeIoSource.Stated -> nativeIoSourceNode(field.source)
}

private fun nativeIoSourceNode(source: NativeIoInputSource): WireNode.WireObject = when (source) {
	is NativeIoStartupSource -> wireObject(
		"hostRunId" to text(source.hostRunId),
		"sessionId" to text(source.sessionId),
		"phase" to text("startup"),
		"geometry" to geometryNode(source.geometry),
		"viewerRevision" to number(source.viewerRevision),
		"sourceToken" to text(source.sourceToken),
	)

	is NativeIoSource -> wireObject(
		"hostRunId" to text(source.hostRunId),
		"sessionId" to text(source.sessionId),
		"nativeSession" to nativeSessionNode(source.nativeSession),
		"geometry" to geometryNode(source.geometry),
		"viewerRevision" to number(source.viewerRevision),
		"sourceToken" to text(source.sourceToken),
	)
}

private fun copyEventNode(event: NativeIoCopyEvent): WireNode.WireObject = when (event) {
	is NativeIoCopyEvent.Copy -> wireObject(
		"kind" to text("copy"),
		"encoded" to text(event.encoded),
		"sessionId" to text(event.sessionId),
		"sessionEpoch" to number(event.sessionEpoch),
	)

	is NativeIoCopyEvent.Unavailable -> wireObject(
		"kind" to text("unavailable"),
		"reason" to text(event.reason.wireValue),
		"sessionId" to text(event.sessionId),
		"sessionEpoch" to number(event.sessionEpoch),
	)
}

private fun graphicsNode(graphics: TerminalGraphicsFrame): WireNode.WireObject = wireObject(
	"images" to wireArray(graphics.images.map(::graphicsImageNode)),
	"placements" to wireArray(graphics.placements.map(::graphicsPlacementNode)),
	"fallbacks" to wireArray(graphics.fallbacks.map(::graphicsFallbackNode)),
)

private fun graphicsImageNode(image: TerminalGraphicsImage): WireNode.WireObject = wireObject(
	"id" to text(image.id),
	"mimeType" to text(image.mimeType),
	"widthPx" to number(image.widthPx),
	"heightPx" to number(image.heightPx),
	"base64" to text(image.base64),
)

private fun graphicsPlacementNode(placement: TerminalGraphicsPlacement): WireNode.WireObject = wireObject(
	"id" to text(placement.id),
	"imageId" to text(placement.imageId),
	"column" to number(placement.column),
	"row" to number(placement.row),
	"columns" to number(placement.columns),
	"rows" to number(placement.rows),
	"crop" to wireObject(
		"x" to number(placement.crop.x),
		"y" to number(placement.crop.y),
		"width" to number(placement.crop.width),
		"height" to number(placement.crop.height),
	),
	"clip" to clipNode(placement.clip),
)

private fun graphicsFallbackNode(fallback: TerminalGraphicsFallback): WireNode.WireObject = wireObject(
	"id" to text(fallback.id),
	"mimeType" to text(fallback.mimeType),
	"widthPx" to fallback.widthPx?.let(::number),
	"heightPx" to fallback.heightPx?.let(::number),
	"column" to number(fallback.column),
	"row" to number(fallback.row),
	"columns" to number(fallback.columns),
	"rows" to number(fallback.rows),
	"clip" to clipNode(fallback.clip),
)

private fun clipNode(clip: TerminalGraphicsClip): WireNode.WireObject = wireObject(
	"leftColumns" to number(clip.leftColumns),
	"topRows" to number(clip.topRows),
	"rightColumns" to number(clip.rightColumns),
	"bottomRows" to number(clip.bottomRows),
)

private fun stringArray(values: List<String>): WireNode.WireArray =
	wireArray(values.map { value -> WireNode.WireText(value) })

private fun attribute(enabled: Boolean): WireNode? = if (enabled) WireNode.WireBoolean(true) else null

private fun text(value: String): WireNode.WireText = WireNode.WireText(value)

private fun number(value: Int): WireNode.WireNumber = WireNode.WireNumber(value.toLong())

private fun number(value: Long): WireNode.WireNumber = WireNode.WireNumber(value)

private fun bool(value: Boolean): WireNode.WireBoolean = WireNode.WireBoolean(value)
