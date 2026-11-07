package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.HelloAckFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoCopyEvent
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputKind
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoStartupSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeSessionRef
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.SessionGeometry
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribedFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.core.protocol.content.INPUT_MODES
import io.github.rfairburn.pireviewgate.core.protocol.content.contentSource
import io.github.rfairburn.pireviewgate.core.protocol.content.sampleFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.startupSource

/**
 * Deterministic in-memory fixtures for the selected-content endpoint suites.
 *
 * Everything here is hand-built and in-memory: no socket, no coroutine, no
 * Android type, and no product runtime. The harness is a verification driver only
 * — it mirrors what a real adapter does with the endpoint's effects (record them,
 * report each write's phase, arm and fire the endpoint's deadlines) so the state
 * machine can be proven without any transport or UI dependency.
 */

internal const val HOST_ID = "host-1"
internal const val RUN_ID = "run-1"
internal const val ROW_ID = "instance-1"
internal const val SUB_ID = "subscription-1"
internal const val SELECTION_GENERATION = 4L
internal const val CONNECTION_GENERATION = 9L

internal val TARGET_GEOMETRY: SessionGeometry = SessionGeometry(cols = 12, rows = 3, revision = 0)

internal fun endpointTarget(
	hostId: String = HOST_ID,
	ownerRunId: String = RUN_ID,
	rowId: String = ROW_ID,
): ContentEndpointTarget = ContentEndpointTarget(
	hostId = HostId.parse(hostId),
	connectionGeneration = CONNECTION_GENERATION,
	selectionGeneration = SELECTION_GENERATION,
	ownerRunId = ownerRunId,
	rowId = rowId,
)

/** A deterministic id supplier: ids are stable, so every run of a test is the same run. */
internal class CountingIds(private val prefix: String = "id") {
	private var next = 0

	fun next(): String {
		next += 1
		return "$prefix-$next"
	}
}

internal fun endpointConfig(
	viewport: ContentViewportRequest = ContentViewportRequest(cols = 80, rows = 24),
	nativeIo: ContentNativeIoOptions? = null,
	inputPolicy: ContentInputPolicy = ContentInputPolicy(enabled = false, generation = 0L),
	ids: CountingIds = CountingIds("sub"),
	deadlines: ContentDeadlineSettings = ContentDeadlineSettings.DEFAULT,
	target: ContentEndpointTarget = endpointTarget(),
): ContentEndpointConfig = ContentEndpointConfig(
	target = target,
	viewport = viewport,
	nativeIo = nativeIo,
	bounds = ContentBounds.DEFAULT,
	deadlines = deadlines,
	inputPolicy = inputPolicy,
	ids = ContentIdSupplier { ids.next() },
)

/** The native IO opt-in: the extension plus, optionally, startup input. */
internal fun nativeIoOptions(startup: Boolean = true): ContentNativeIoOptions = ContentNativeIoOptions(
	offeredCapabilities = buildList {
		add(ContentProtocol.NATIVE_IO_CAPABILITY)
		if (startup) add(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY)
	},
)

/** One acknowledgement of exactly the baseline capability. */
internal fun ackFrame(capabilities: List<String> = listOf(ContentProtocol.REQUIRED_CAPABILITY)): HelloAckFrame =
	HelloAckFrame(
		service = ContentProtocol.SERVICE,
		major = ContentProtocol.MAJOR,
		minor = ContentProtocol.MINOR,
		capabilities = capabilities,
	)

internal fun subscribedFrame(
	subscriptionId: String = SUB_ID,
	hostRunId: String = RUN_ID,
	sessionId: String = ROW_ID,
): SubscribedFrame = SubscribedFrame(subscriptionId, sessionId, hostRunId)

/**
 * Encode one complete viewport into its begin/chunk/end frames.
 *
 * The payload is produced by the landed codec and split at the codec's own chunk
 * bound, so a multi-chunk test exercises real paging rather than an approximation.
 */
internal fun transferFrames(
	frame: TerminalFrame,
	subscriptionId: String = SUB_ID,
	transferId: String = "transfer-1",
	hostRunId: String = RUN_ID,
	sessionId: String = ROW_ID,
	nativeSession: NativeSessionRef? = NativeSessionRef("native-session-1", 3),
	sequence: Long = 1L,
	geometry: SessionGeometry = SessionGeometry(cols = frame.cols, rows = frame.rows, revision = 0),
	inputModes: TerminalInputModes = INPUT_MODES,
	inputSource: OptionalNativeIoSource = OptionalNativeIoSource.Absent,
	bounds: ContentBounds = ContentBounds.DEFAULT,
	chunkBytes: Int = bounds.maxChunkPayloadBytes,
): List<ContentFrame> {
	val payload = ContentProtocol.encodeTerminalPayload(frame, bounds)
	val chunkCount = (payload.size + chunkBytes - 1) / chunkBytes
	val frames = ArrayList<ContentFrame>(chunkCount + 2)
	frames.add(
		ContentBeginFrame(
			subscriptionId = subscriptionId,
			transferId = transferId,
			hostRunId = hostRunId,
			sessionId = sessionId,
			nativeSession = nativeSession,
			sequence = sequence,
			geometry = geometry,
			inputModes = inputModes,
			byteLength = payload.size,
			chunkCount = chunkCount,
			inputSource = inputSource,
		),
	)
	for (index in 0 until chunkCount) {
		frames.add(
			ContentChunkFrame(
				subscriptionId = subscriptionId,
				transferId = transferId,
				index = index.toLong(),
				data = payload.copyOfRange(index * chunkBytes, minOf((index + 1) * chunkBytes, payload.size)),
			),
		)
	}
	frames.add(ContentEndFrame(subscriptionId, transferId, sequence))
	return frames
}

/** The frames of one inline native copy. */
internal fun inlineCopyFrames(
	copyId: String = "copy-1",
	subscriptionId: String = SUB_ID,
	sequence: Long = 1L,
	source: NativeIoSource = contentSource(geometry = TARGET_GEOMETRY),
	dispatchId: Long = 11L,
	encoded: String = "aGVsbG8=",
): List<ContentFrame> = listOf(
	CopyFrame(
		subscriptionId = subscriptionId,
		copyId = copyId,
		sequence = sequence,
		source = source,
		dispatchId = dispatchId,
		event = NativeIoCopyEvent.Copy(
			encoded = encoded,
			sessionId = source.nativeSession.sessionId,
			sessionEpoch = source.nativeSession.epoch,
		),
	),
)

/** The frames of one paged native copy of [encoded], split at [chunkBytes] characters. */
internal fun pagedCopyFrames(
	encoded: String,
	subscriptionId: String = SUB_ID,
	copyId: String = "copy-1",
	sequence: Long = 1L,
	source: NativeIoSource = contentSource(geometry = TARGET_GEOMETRY),
	dispatchId: Long = 11L,
	chunkBytes: Int = 8,
): List<ContentFrame> {
	val pages = ((encoded.length + chunkBytes - 1) / chunkBytes).coerceAtLeast(1)
	val frames = ArrayList<ContentFrame>(pages + 2)
	frames.add(
		CopyBeginFrame(
			subscriptionId = subscriptionId,
			copyId = copyId,
			sequence = sequence,
			source = source,
			dispatchId = dispatchId,
			byteLength = encoded.length,
			chunkCount = pages,
		),
	)
	for (index in 0 until pages) {
		val slice = encoded.substring(index * chunkBytes, minOf((index + 1) * chunkBytes, encoded.length))
		frames.add(
			CopyChunkFrame(
				subscriptionId = subscriptionId,
				copyId = copyId,
				index = index.toLong(),
				data = slice.toByteArray(Charsets.ISO_8859_1),
			),
		)
	}
	frames.add(CopyEndFrame(subscriptionId, copyId, sequence))
	return frames
}

/**
 * A verification-only driver of one [ContentEndpoint].
 *
 * It records the effects and events each step produces, reports every write as
 * invoked and then completed unless a test says otherwise, and mirrors the armed
 * deadline set so a test can fire exactly what the endpoint armed.
 */
internal class ContentEndpointHarness(
	val endpoint: ContentEndpoint,
	startNanos: Long = 0L,
) {
	var nowNanos: Long = startNanos
		private set

	/** The next publish sequence this driver uses, so successive commits never repeat one. */
	var nextSequence: Long = 1L
		private set

	val events = ArrayList<ContentEndpointEvent>()
	val effects = ArrayList<ContentSendEffect>()
	var armed: List<ContentDeadline> = emptyList()
		private set

	init {
		observe(endpoint.start(nowNanos))
	}

	val observation: ContentEndpointObservation get() = endpoint.observe()

	/** Deliver one inbound frame and record what the endpoint produced. */
	fun deliver(frame: ContentFrame, advanceMillis: Long = 0L): ContentEndpointStep {
		nowNanos += advanceMillis * 1_000_000L
		return observe(endpoint.onFrame(frame, nowNanos))
	}

	/** Deliver every frame of a staged sequence in order. */
	fun deliverAll(frames: List<ContentFrame>, advanceMillis: Long = 0L) {
		frames.forEach { deliver(it, advanceMillis) }
	}

	fun resize(cols: Int, rows: Int, advanceMillis: Long = 0L): ContentEndpointStep {
		nowNanos += advanceMillis * 1_000_000L
		return observe(endpoint.resize(cols, rows, nowNanos))
	}

	fun stop(advanceMillis: Long = 0L): ContentEndpointStep {
		nowNanos += advanceMillis * 1_000_000L
		return observe(endpoint.stop(nowNanos))
	}

	fun channelLost(advanceMillis: Long = 0L): ContentEndpointStep {
		nowNanos += advanceMillis * 1_000_000L
		return observe(endpoint.onChannelLost(nowNanos))
	}

	/** Advance the caller's clock without firing anything. */
	fun advance(millis: Long) {
		nowNanos += millis * 1_000_000L
	}

	/** Fire the armed deadline of [kind], honoring the endpoint's own due time. */
	fun fire(kind: ContentDeadlineKind): ContentEndpointStep {
		val due = armed.firstOrNull { it.kind == kind } ?: return observe(
			ContentEndpointStep(endpoint.observe(), emptyList(), emptyList(), armed),
		)
		nowNanos = maxOf(nowNanos, due.dueAtNanos)
		return observe(endpoint.onDeadline(kind, nowNanos))
	}

	fun report(effect: ContentSendEffect, vararg phases: ContentSendPhase) {
		phases.forEach { phase -> observe(endpoint.reportSend(effect.effectId, phase, nowNanos)) }
	}

	/** Submit one input and record its admitted effects so [settleAllEffects] can write them. */
	fun admit(request: ContentInputRequest, authorized: Boolean = true): ContentInputAdmission {
		val admission = endpoint.submitInput(request, authorized, nowNanos)
		if (admission is ContentInputAdmission.Accepted) effects += admission.effects
		return admission
	}

	fun invoke(effect: ContentSendEffect) = report(effect, ContentSendPhase.INVOKED)

	fun complete(effect: ContentSendEffect) = report(effect, ContentSendPhase.COMPLETED)

	fun failWrite(effect: ContentSendEffect) = report(effect, ContentSendPhase.FAILED)

	/** The transport re-checked the guard, found it stale, and never invoked the write. */
	fun drop(effect: ContentSendEffect) = report(effect, ContentSendPhase.DROPPED)

	/**
	 * Write every effect the endpoint has issued since the last call, HONORING the
	 * guard contract: a still-current effect is invoked and then completed, and an
	 * effect whose guard went stale is reported as dropped, exactly as a correct
	 * transport must behave.
	 */
	fun settleAllEffects(): List<ContentSendEffect> {
		val issued = effects.toList()
		effects.clear()
		issued.forEach { effect ->
			if (endpoint.isSendGuardCurrent(effect.guard)) {
				report(effect, ContentSendPhase.INVOKED, ContentSendPhase.COMPLETED)
			} else {
				report(effect, ContentSendPhase.DROPPED)
			}
		}
		return issued
	}

	/** Drive the one preference change the endpoint accepts as a writer boundary. */
	fun updatePolicy(next: ContentInputPolicy) = observe(endpoint.updateInputPolicy(next))

	fun isCurrent(effect: ContentSendEffect): Boolean = endpoint.isSendGuardCurrent(effect.guard)

	fun handshake(capabilities: List<String> = listOf(ContentProtocol.REQUIRED_CAPABILITY)): String {
		val subscriptionId = endpoint.subscriptionId
		deliver(ackFrame(capabilities))
		settleAllEffects()
		deliver(subscribedFrame(subscriptionId))
		return subscriptionId
	}

	/** Publish one complete viewport through the real frame shapes. */
	fun publish(
		frame: TerminalFrame = sampleFrame(),
		sequence: Long = nextSequence,
		transferId: String = "transfer-$sequence",
		inputSource: OptionalNativeIoSource = OptionalNativeIoSource.Absent,
		inputModes: TerminalInputModes = INPUT_MODES,
		chunkBytes: Int = ContentBounds.DEFAULT.maxChunkPayloadBytes,
		nativeSession: NativeSessionRef? = NativeSessionRef("native-session-1", 3),
	) {
		nextSequence = maxOf(nextSequence, sequence + 1)
		deliverAll(
			transferFrames(
				frame = frame,
				subscriptionId = endpoint.subscriptionId,
				transferId = transferId,
				sequence = sequence,
				inputSource = inputSource,
				inputModes = inputModes,
				chunkBytes = chunkBytes,
				nativeSession = nativeSession,
			),
		)
	}

	/** Publish one viewport that carries [source], then commit it as actually written. */
	fun commitWrittenFrame(
		source: NativeIoInputSource,
		sequence: Long = nextSequence,
		frame: TerminalFrame = sampleFrame(),
		policyGeneration: Long = observation.inputPolicy.generation,
	): ContentWrittenFrameOutcome {
		publish(frame = frame, sequence = sequence, inputSource = OptionalNativeIoSource.Stated(source))
		return endpoint.recordWrittenFrame(
			writtenProof(this, sequence, frame.geometry(), policyGeneration),
		)
	}

	private fun observe(step: ContentEndpointStep): ContentEndpointStep {
		effects += step.effects
		events += step.events
		armed = step.deadlines
		return step
	}
}

/** The canonical geometry one fixture frame was drawn from. */
internal fun TerminalFrame.geometry(): SessionGeometry = SessionGeometry(cols = cols, rows = rows, revision = 0)

/**
 * One written-frame proof matching the harness's current publication, with every
 * fence available for a test to deliberately break.
 */
internal fun writtenProof(
	harness: ContentEndpointHarness,
	sequence: Long = harness.nextSequence - 1,
	geometry: SessionGeometry = TARGET_GEOMETRY,
	policyGeneration: Long = harness.observation.inputPolicy.generation,
	selectionGeneration: Long = SELECTION_GENERATION,
): ContentWrittenFrameProof = ContentWrittenFrameProof(
	selectionGeneration = selectionGeneration,
	subscriptionId = harness.endpoint.subscriptionId,
	sequence = sequence,
	geometry = geometry,
	resizeEpoch = harness.observation.resizeEpoch,
	policyGeneration = policyGeneration,
	nativeContent = ContentPaneRect(column = 0, row = 0, cols = geometry.cols, rows = geometry.rows),
)

/** One startup-phase source of the sample publish. */
internal fun sampleStartupSource(): NativeIoStartupSource = startupSource(geometry = TARGET_GEOMETRY)

/** The acknowledgement that turns the full native IO extension on. */
internal val NATIVE_IO_ACK: List<String> = listOf(
	ContentProtocol.REQUIRED_CAPABILITY,
	ContentProtocol.NATIVE_IO_CAPABILITY,
	ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
)

/** A config with the native IO extension offered and the preference switched on. */
internal fun nativeIoConfig(
	startup: Boolean = true,
	policy: ContentInputPolicy = ContentInputPolicy(enabled = true, generation = 1L),
	viewport: ContentViewportRequest = ContentViewportRequest(cols = 80, rows = 24),
): ContentEndpointConfig = endpointConfig(
	viewport = viewport,
	nativeIo = nativeIoOptions(startup = startup),
	inputPolicy = policy,
)

/** One keyboard packet admitted against the current publication and its written receipt. */
internal fun keyboardRequest(
	text: String = "a",
	source: NativeIoInputSource = contentSource(geometry = TARGET_GEOMETRY),
	inputModes: TerminalInputModes = INPUT_MODES,
): ContentInputRequest = ContentInputRequest(
	source = source,
	inputModes = inputModes,
	kind = NativeIoInputKind.KEYBOARD,
	text = text,
)

/** One canonical content-space SGR mouse report. */
internal fun mouseRequest(
	text: String = "\u001b[<0;3;4M",
	source: NativeIoInputSource = contentSource(geometry = TARGET_GEOMETRY),
): ContentInputRequest = ContentInputRequest(
	source = source,
	inputModes = INPUT_MODES,
	kind = NativeIoInputKind.MOUSE,
	text = text,
)

/** One text paste of exactly [bytes] UTF-8 bytes. */
internal fun pasteRequest(
	bytes: Int,
	source: NativeIoInputSource = contentSource(geometry = TARGET_GEOMETRY),
): ContentInputRequest = ContentInputRequest(
	source = source,
	inputModes = INPUT_MODES,
	kind = NativeIoInputKind.PASTE,
	text = "x".repeat(bytes),
)

/** Bring a native IO endpoint up to a committed, writable publication. */
internal fun ContentEndpointHarness.commitNativePublication(
	source: NativeIoInputSource = contentSource(geometry = TARGET_GEOMETRY),
	sequence: Long = 1L,
): ContentWrittenFrameOutcome = commitWrittenFrame(source, sequence = sequence)
