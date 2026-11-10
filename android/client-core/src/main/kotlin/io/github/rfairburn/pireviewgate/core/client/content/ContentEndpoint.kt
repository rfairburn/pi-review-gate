package io.github.rfairburn.pireviewgate.core.client.content

import io.github.rfairburn.pireviewgate.core.protocol.content.ContentAckDecision
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyBeginFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.CopyFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentEndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentErrorCode
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocolException
import io.github.rfairburn.pireviewgate.core.protocol.content.EndFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.ErrorFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.HelloAckFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.HelloFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.InputChunkFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoInputSource
import io.github.rfairburn.pireviewgate.core.protocol.content.NativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.OptionalNativeIoSource
import io.github.rfairburn.pireviewgate.core.protocol.content.ResizeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribedFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.SubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.TerminalInputModes
import io.github.rfairburn.pireviewgate.core.protocol.content.UnsubscribeFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.UnsubscribedFrame
import io.github.rfairburn.pireviewgate.core.protocol.content.isNativeIoStartupSource
import io.github.rfairburn.pireviewgate.core.protocol.content.nativeIoSourceEquals
import java.util.UUID

/**
 * How the caller supplies this endpoint's one subscription id and its per-input
 * ids. A deterministic supplier makes the whole endpoint reproducible; the default
 * is one fresh UUID per call.
 */
fun interface ContentIdSupplier {
	fun nextId(): String
}

/**
 * Everything one content endpoint is created with.
 *
 * The target, the initially requested viewport, the wire bounds, the finite
 * deadlines, and the explicit native IO opt-in. Omitting [nativeIo] keeps the
 * exact legacy display-only behavior, hello bytes included: no optional capability
 * is offered, so none can be acknowledged, and the endpoint stays a truthful
 * display-only stream rather than claiming an input permission it never negotiated.
 */
data class ContentEndpointConfig(
	val target: ContentEndpointTarget,
	val viewport: ContentViewportRequest,
	val nativeIo: ContentNativeIoOptions? = null,
	val bounds: ContentBounds = ContentBounds.DEFAULT,
	val deadlines: ContentDeadlineSettings = ContentDeadlineSettings.DEFAULT,
	val inputPolicy: ContentInputPolicy = ContentInputPolicy(enabled = false, generation = 0L),
	val ids: ContentIdSupplier = ContentIdSupplier { UUID.randomUUID().toString() },
) {
	init {
		require(isValidContentIdentifier(ContentProtocol.REQUIRED_CAPABILITY, bounds.maxCapabilityIdBytes)) {
			"content required capability is invalid"
		}
	}
}

/**
 * The viewer-side state machine of ONE selected native viewport.
 *
 * This class is transport-free and Android-free. It never opens a socket, never
 * reads a setting, never starts a timer of its own, and never invokes a caller
 * callback: every entrypoint is synchronous, consumes typed facts (one decoded
 * [ContentFrame], a channel loss, a resize, a clock deadline, or a user input),
 * and returns the outbound frame effects plus the publication, copy, and outcome
 * events the caller must act on. A later adapter serializes those effects over the
 * real transport and reports each write's phase back, which is what keeps every
 * outcome honest.
 *
 * **One target, one subscription, one in-flight transfer.** The target is immutable
 * for the endpoint's lifetime: a frame from another owner run or owner row is a
 * protocol violation, never a retarget, and a lost channel never reopens,
 * resubscribes, retries, or replays anything.
 *
 * **Deadlines belong to the caller.** [nextDeadline] reports what is armed and when
 * it is due; [onDeadline] delivers the expiry. The armed set returned with every
 * step is complete, so a timer can never outlive the step that disarmed it. There
 * is no idle expiry of a published viewport: an unchanged current frame stays
 * current indefinitely.
 *
 * **Thread safety.** Every entrypoint is `@Synchronized`, and no caller code,
 * socket, or UI work runs while the monitor is held: proofs arrive as values and
 * everything the caller must do leaves as a returned effect or event.
 */
class ContentEndpoint(private val config: ContentEndpointConfig) {
	/** The one target this endpoint may ever serve. */
	val target: ContentEndpointTarget = config.target

	/** The one subscription identifier this endpoint ever uses. */
	val subscriptionId: String = config.ids.nextId().also {
		require(isValidContentIdentifier(it, config.bounds.maxIdentifierBytes)) { "content subscription id is invalid" }
	}

	private val bounds: ContentBounds = config.bounds
	private val deadlines: ContentDeadlineSettings = config.deadlines
	private val offeredCapabilities: List<String> = buildList {
		add(ContentProtocol.REQUIRED_CAPABILITY)
		config.nativeIo?.offeredCapabilities?.forEach { if (!contains(it)) add(it) }
	}

	private val transferAssembly = ContentTransferAssembly(bounds)
	private val copyAssembly = ContentCopyAssembly(bounds)

	private var phase: ContentEndpointPhase = ContentEndpointPhase.NONE
	private var status: ContentViewStatus = ContentViewStatus.NONE
	private var reason: ContentUnavailableReason? = null
	private var snapshot: ContentSnapshot? = null
	private var acknowledgedCapabilities: List<String> = emptyList()
	private var nativeIoNegotiated = false
	private var startupInputNegotiated = false

	/** Positive monotonic publish fence; jumps are allowed, duplicates and regressions are not. */
	private var lastSequence = 0L

	private var requestedViewport = config.viewport
	/**
	 * The dimensions the owner was actually told, carried by the last write that was
	 * INVOKED. An emitted-but-dropped effect never moves it, so a superseded resize
	 * can never suppress the newest request.
	 */
	private var invokedViewport: ContentViewportRequest? = null
	private var resizeInFlight = false
	private var resizeEpoch = 0L

	/** Whether the subscribe bytes were actually handed to the caller as an effect. */
	private var subscribeEmitted = false
	private var stopRequested = false
	private var retired = false

	private var inputGeneration = 0L
	/**
	 * The publish sequence at which the current [inputGeneration] began. Every
	 * publication from here up to the current one shares one semantic input context,
	 * so a commit of any of them is a commit of that context; nothing older is.
	 */
	private var contextStartSequence = 0L
	private var policy: ContentInputPolicy = config.inputPolicy
	private var writtenReceipt: WrittenRemoteContent? = null

	private val pendingInputs = LinkedHashMap<String, PendingInput>()
	private var nextInputOrdinal = 1L

	private var copyHeaderId: String? = null
	private var copyHeaderSource: NativeIoInputSource? = null
	/** The policy generation the in-flight copy header was admitted under. */
	private var copyHeaderPolicyGeneration: Long? = null
	private var copyDiscardId: String? = null

	private var nextEffectId = 1L
	private val issuedEffects = LinkedHashMap<Long, IssuedEffect>()
	private val armedDeadlines = LinkedHashMap<ContentDeadlineKind, Long>()

	/**
	 * effectId → absolute due mark of one write that was INVOKED and has not returned.
	 * A held write is bounded by the finite transfer-idle bound, exactly as the source
	 * per-send deadline does; published content itself is never timed.
	 */
	private val sendDue = LinkedHashMap<Long, Long>()

	/** One admitted-but-unsettled logical input operation. */
	private inner class PendingInput(
		val inputId: String,
		val ordinal: Long,
		val source: NativeIoInputSource,
		val inputModes: TerminalInputModes,
		/** The semantic input generation admitted under; a newer one ends this lifetime. */
		val generation: Long,
		val effectIds: List<Long>,
	) {
		var invoked = false
		var settled = false
		var completed = 0
		var invalidated = false
		var staleReason: ContentNotSentReason = ContentNotSentReason.STALE_SOURCE

		fun settle(outcome: ContentSendOutcome, events: MutableList<ContentEndpointEvent>) {
			if (settled) return
			settled = true
			events += ContentEndpointEvent.InputSettled(inputId, ordinal, outcome)
			pendingInputs.remove(inputId)
			effectIds.forEach {
				issuedEffects.remove(it)
				sendDue.remove(it)
			}
		}

		/** Truthful on retirement: bytes never invoked are not sent; bytes that may be on the wire are unknown. */
		fun abort(events: MutableList<ContentEndpointEvent>) {
			settle(
				if (invoked) ContentSendOutcome.Unknown else ContentSendOutcome.NotSent(ContentNotSentReason.STOPPED),
				events,
			)
		}
	}

	/** What one issued effect belongs to, so a reported phase can be routed truthfully. */
	private class IssuedEffect(
		val guard: ContentSendGuard,
		val inputId: String?,
		/** The dimensions a resize effect carried, so an INVOKED write can be recorded. */
		val viewport: ContentViewportRequest? = null,
	)

	/* --------------------------------------------------------------------- *
	 * Reads
	 * --------------------------------------------------------------------- */

	/** The immutable, thread-safe view of this endpoint right now. */
	@Synchronized
	fun observe(): ContentEndpointObservation = observation()

	/** The armed deadline set a coordinator must mirror, as absolute monotonic marks. */
	@Synchronized
	fun nextDeadline(): List<ContentDeadline> = deadlinesNow()

	private fun deadlinesNow(): List<ContentDeadline> {
		val all = armedDeadlines.entries.map { (kind, due) -> ContentDeadline(kind, due) }.toMutableList()
		val earliestSend = sendDue.values.minOrNull()
		if (earliestSend != null) all += ContentDeadline(ContentDeadlineKind.SEND, earliestSend)
		return all.sortedWith(compareBy({ it.dueAtNanos }, { it.kind.ordinal }))
	}

	/**
	 * The exact native input target of the currently published stream, or `null`
	 * while the extension is unoffered, unacknowledged, not streaming, retired, or
	 * that snapshot carries no source. Descriptive facts only: the source is never
	 * authority to write, and it is never inferred from a newer target.
	 */
	@Synchronized
	fun readNativeInputTarget(): ContentNativeInputTarget? {
		if (!nativeIoNegotiated || retired || stopRequested) return null
		if (phase != ContentEndpointPhase.STREAMING) return null
		return currentTarget(snapshot ?: return null)
	}

	/**
	 * Whether one already-issued guard is still current. This is the cheap atomic
	 * check the actual transport must consume before it queues AND immediately
	 * before it dispatches. Each guard answers only for its own lifetime: an ended
	 * input never invalidates a hello, subscribe, resize, or unsubscribe notice.
	 */
	@Synchronized
	fun isSendGuardCurrent(guard: ContentSendGuard): Boolean {
		if (guard.connectionGeneration != target.connectionGeneration) return false
		// The single terminal refusal is the one effect still worth attempting after
		// retirement, which is what makes a failure observable to the owner. It is
		// narrowly scoped to this connection generation and is minted only once.
		if (guard is ContentSendGuard.ProtocolError) return true
		if (retired) return false
		return when (guard) {
			is ContentSendGuard.Hello -> phase == ContentEndpointPhase.AWAITING_ACK
			is ContentSendGuard.Subscribe ->
				phase == ContentEndpointPhase.SUBSCRIBING && guard.subscriptionId == subscriptionId

			is ContentSendGuard.Resize ->
				phase == ContentEndpointPhase.STREAMING &&
					guard.subscriptionId == subscriptionId &&
					guard.resizeEpoch == resizeEpoch

			is ContentSendGuard.Unsubscribe -> guard.subscriptionId == subscriptionId
			is ContentSendGuard.ProtocolError -> true
			is ContentSendGuard.Input -> {
				if (guard.subscriptionId != subscriptionId) return false
				val pending = pendingInputs[guard.inputId] ?: return false
				!pending.invalidated && !pending.settled && pending.generation == guard.inputGeneration
			}
		}
	}

	/* --------------------------------------------------------------------- *
	 * Startup and shutdown
	 * --------------------------------------------------------------------- */

	/**
	 * Begin the handshake: one hello carrying exactly the capabilities this endpoint
	 * was configured to offer, and one armed handshake deadline. Calling it twice
	 * returns an empty step — there is no second hello, no retry, and no heartbeat.
	 */
	@Synchronized
	fun start(nowNanos: Long): ContentEndpointStep {
		if (phase != ContentEndpointPhase.NONE) return step(emptyList(), emptyList())
		phase = ContentEndpointPhase.AWAITING_ACK
		status = ContentViewStatus.CONNECTING
		reason = null
		arm(ContentDeadlineKind.HANDSHAKE, nowNanos, deadlines.handshakeMs)
		return step(
			listOf(
				effect(
					HelloFrame(
						service = ContentProtocol.SERVICE,
						major = ContentProtocol.MAJOR,
						minor = ContentProtocol.MINOR,
						capabilities = offeredCapabilities,
					),
					ContentSendGuard.Hello(target.connectionGeneration),
				),
			),
			emptyList(),
		)
	}

	/**
	 * Idempotent local retirement: clear the published view, invalidate every
	 * written receipt and pending authority, and emit at most one `unsubscribe` —
	 * and only when the subscribe was actually handed to the caller. Nothing here
	 * stops a remote process, and nothing after this can make the view current.
	 */
	@Synchronized
	fun stop(nowNanos: Long): ContentEndpointStep {
		if (retired || phase == ContentEndpointPhase.STOPPING) return step(emptyList(), emptyList())
		val announce = subscribeEmitted
		// Recorded synchronously, so nothing already in flight can start or continue
		// a subscription after this call.
		stopRequested = true
		phase = ContentEndpointPhase.STOPPING
		val events = ArrayList<ContentEndpointEvent>()
		clearSnapshot(ContentUnavailableReason.STOPPED, events)
		transferAssembly.reset()
		copyAssembly.reset()
		copyHeaderId = null
		copyHeaderSource = null
		copyHeaderPolicyGeneration = null
		copyDiscardId = null
		disarmAllButStopAck()
		sendDue.clear()
		abortPendingInputs(events)
		writtenReceipt = null
		resizeInFlight = false
		if (!announce) {
			return retire(ContentUnavailableReason.STOPPED, events)
		}
		arm(ContentDeadlineKind.STOP_ACK, nowNanos, deadlines.stopAckMs)
		val effects = listOf(
			effect(
				UnsubscribeFrame(subscriptionId),
				ContentSendGuard.Unsubscribe(target.connectionGeneration, subscriptionId),
			),
		)
		return step(effects, events)
	}

	/**
	 * The caller's channel went away. The target is preserved, the published view
	 * and every written receipt and pending authority are invalidated, unsent
	 * effects stop being current, and nothing is reopened, resubscribed, or replayed.
	 */
	@Synchronized
	fun onChannelLost(nowNanos: Long): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		val events = ArrayList<ContentEndpointEvent>()
		clearSnapshot(ContentUnavailableReason.CONNECTION_LOST, events)
		transferAssembly.reset()
		copyAssembly.reset()
		abortPendingInputs(events)
		writtenReceipt = null
		return retire(ContentUnavailableReason.CONNECTION_LOST, events)
	}

	/* --------------------------------------------------------------------- *
	 * Inbound frames
	 * --------------------------------------------------------------------- */

	/** Consume one already-decoded inbound frame. */
	@Synchronized
	fun onFrame(frame: ContentFrame, nowNanos: Long): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		return try {
			if (phase == ContentEndpointPhase.STOPPING) onRetirementFrame(frame, nowNanos) else handle(frame, nowNanos)
		} catch (failure: ContentProtocolFailure) {
			protocolFailure()
		}
	}

	/**
	 * Consume one raw inbound channel message. A message that is not one complete
	 * frame of this lane is a protocol failure, never a partially applied frame.
	 */
	@Synchronized
	fun onBytes(bytes: ByteArray, nowNanos: Long): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		val frame = try {
			ContentProtocol.decode(bytes, bounds)
		} catch (error: ContentProtocolException) {
			return protocolFailure()
		}
		return onFrame(frame, nowNanos)
	}

	private fun handle(frame: ContentFrame, nowNanos: Long): ContentEndpointStep = when (frame) {
		is HelloAckFrame -> onHelloAck(frame, nowNanos)
		is SubscribedFrame -> onSubscribed(frame, nowNanos)
		is ContentBeginFrame -> onContentBegin(frame, nowNanos)
		is ContentChunkFrame -> onContentChunk(frame, nowNanos)
		is ContentEndFrame -> onContentEnd(frame, nowNanos)
		is CopyFrame -> onCopy(frame, nowNanos)
		is CopyBeginFrame -> onCopyBegin(frame, nowNanos)
		is CopyChunkFrame -> onCopyChunk(frame, nowNanos)
		is CopyEndFrame -> onCopyEnd(frame, nowNanos)
		is UnsubscribedFrame -> ownerEnded(frame.subscriptionId, ContentUnavailableReason.CONTENT_LOST)

		is EndFrame -> ownerEnded(frame.subscriptionId, ContentUnavailableReason.CONTENT_LOST)
		is ErrorFrame -> ownerEnded(frame.subscriptionId, ContentUnavailableReason.OWNER_REFUSED)
		else -> protocolFailure()
	}

	/**
	 * Retirement is the one window in which frames for this endpoint's own, already
	 * retired subscription are expected: the owner admitted them before its
	 * unsubscribe arrived. They are dropped without reactivating anything. An
	 * identifier that is not this endpoint's own is never treated as noise.
	 */
	private fun onRetirementFrame(frame: ContentFrame, nowNanos: Long): ContentEndpointStep {
		val named = subscriptionIdOf(frame)
		if (named == subscriptionId) {
			return when (frame) {
				is UnsubscribedFrame, is EndFrame, is ErrorFrame -> settleStopAck()
				else -> step(emptyList(), emptyList())
			}
		}
		if (named == null && frame is ErrorFrame) return settleStopAck()
		return protocolFailure()
	}

	private fun protocolFailure(): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		// One fixed refusal, issued before retirement, so the failure stays observable
		// even if the caller cannot deliver it.
		val refusal = effect(
			ErrorFrame(ContentErrorCode.BAD_FRAME),
			ContentSendGuard.ProtocolError(target.connectionGeneration),
		)
		return retire(ContentUnavailableReason.PROTOCOL_VIOLATION, ArrayList(), listOf(refusal))
	}

	private fun onHelloAck(frame: HelloAckFrame, nowNanos: Long): ContentEndpointStep {
		if (phase != ContentEndpointPhase.AWAITING_ACK) throw ContentProtocolFailure
		disarm(ContentDeadlineKind.HANDSHAKE)
		val decision = ContentProtocol.reviewHelloAck(frame, offeredCapabilities)
		if (decision !is ContentAckDecision.Accepted) {
			return retire(ContentUnavailableReason.OWNER_REFUSED)
		}
		acknowledgedCapabilities = decision.capabilities
		// Only an explicitly offered capability the owner actually acknowledged turns
		// the extension on; a plain acknowledgement leaves this endpoint display-only.
		if (config.nativeIo != null && decision.capabilities.contains(ContentProtocol.NATIVE_IO_CAPABILITY)) {
			nativeIoNegotiated = true
			if (decision.capabilities.contains(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY)) {
				startupInputNegotiated = true
			}
		}
		phase = ContentEndpointPhase.SUBSCRIBING
		val dims = requestedViewport
		arm(ContentDeadlineKind.FIRST_TRANSFER, nowNanos, deadlines.firstTransferMs)
		return step(
			listOf(
				effect(
					SubscribeFrame(
						subscriptionId = subscriptionId,
						hostRunId = target.ownerRunId,
						sessionId = target.rowId,
						cols = dims.cols,
						rows = dims.rows,
					),
					ContentSendGuard.Subscribe(target.connectionGeneration, subscriptionId),
					viewport = dims,
				),
			),
			listOf(ContentEndpointEvent.HelloAccepted(decision.capabilities)),
		)
	}

	private fun onSubscribed(frame: SubscribedFrame, nowNanos: Long): ContentEndpointStep {
		if (phase != ContentEndpointPhase.SUBSCRIBING) throw ContentProtocolFailure
		if (frame.subscriptionId != subscriptionId ||
			frame.hostRunId != target.ownerRunId ||
			frame.sessionId != target.rowId
		) {
			// An acknowledgement for another subscription, run, or row cannot make this
			// endpoint ready.
			throw ContentProtocolFailure
		}
		phase = ContentEndpointPhase.STREAMING
		status = ContentViewStatus.CONNECTING
		reason = null
		// Ready is the exact acknowledgement, not a frame, so the first-transfer window
		// restarts here: an owner that acknowledges and then never publishes is bounded
		// by a full window from the acknowledgement, never by whatever remained of the
		// window armed at the hello acknowledgement.
		arm(ContentDeadlineKind.FIRST_TRANSFER, nowNanos, deadlines.firstTransferMs)
		val effects = ArrayList<ContentSendEffect>()
		flushResize(effects)
		return step(effects, listOf(ContentEndpointEvent.Subscribed))
	}

	private fun onContentBegin(frame: ContentBeginFrame, nowNanos: Long): ContentEndpointStep {
		requireStreamingFor(frame.subscriptionId)
		if (frame.hostRunId != target.ownerRunId || frame.sessionId != target.rowId) {
			// Wrong run or wrong owner row: never published, never retargeted.
			throw ContentProtocolFailure
		}
		val stated = frame.inputSource
		if (stated !is OptionalNativeIoSource.Absent && !nativeIoNegotiated) {
			// A source this side never offered and the owner never acknowledged is not
			// silently dropped: the extension was not negotiated on this channel.
			throw ContentProtocolFailure
		}
		if (stated is OptionalNativeIoSource.Stated &&
			isNativeIoStartupSource(stated.source) &&
			!startupInputNegotiated
		) {
			throw ContentProtocolFailure
		}
		if (frame.sequence <= lastSequence) {
			// Duplicate or regressed publish sequence; jumps forward are allowed.
			throw ContentProtocolFailure
		}
		lastSequence = frame.sequence
		if (!transferAssembly.begin(frame)) throw ContentProtocolFailure
		disarm(ContentDeadlineKind.FIRST_TRANSFER)
		arm(ContentDeadlineKind.TRANSFER_IDLE, nowNanos, deadlines.transferIdleMs)
		return step(emptyList(), emptyList())
	}

	private fun onContentChunk(frame: ContentChunkFrame, nowNanos: Long): ContentEndpointStep {
		requireStreamingFor(frame.subscriptionId)
		if (!transferAssembly.chunk(frame)) throw ContentProtocolFailure
		arm(ContentDeadlineKind.TRANSFER_IDLE, nowNanos, deadlines.transferIdleMs)
		return step(emptyList(), emptyList())
	}

	private fun onContentEnd(frame: ContentEndFrame, nowNanos: Long): ContentEndpointStep {
		requireStreamingFor(frame.subscriptionId)
		val assembled = transferAssembly.end(frame)
		disarm(ContentDeadlineKind.TRANSFER_IDLE)
		if (assembled !is Assembled.Completed) {
			// A `content_end` either completes a transfer or refuses; there is nothing
			// to publish from a control frame and nothing partial survives.
			throw ContentProtocolFailure
		}
		val snapshot = assembled.snapshot
		if (snapshot.meta.subscriptionId != subscriptionId ||
			snapshot.meta.hostRunId != target.ownerRunId ||
			snapshot.meta.rowId != target.rowId ||
			snapshot.meta.sequence != lastSequence
		) {
			throw ContentProtocolFailure
		}
		return publish(snapshot)
	}

	private fun ownerEnded(subscriptionId: String?, unavailable: ContentUnavailableReason): ContentEndpointStep {
		if (subscriptionId != null && subscriptionId != this.subscriptionId) {
			// A frame about another subscription is not this endpoint's business.
			throw ContentProtocolFailure
		}
		return retire(unavailable)
	}

	/* --------------------------------------------------------------------- *
	 * Publishing
	 * --------------------------------------------------------------------- */

	private fun publish(snapshot: ContentSnapshot): ContentEndpointStep {
		val events = ArrayList<ContentEndpointEvent>()
		// Semantic generation first: it is the only proof that survives an exact
		// A → B → A transition, where present equality looks unchanged. Ordinary
		// output — new text, a new snapshot object, a new publish sequence — under an
		// unchanged source, modes, and geometry does not advance it.
		val previous = this.snapshot
		if (previous == null || !samePublicationIdentity(previous, snapshot)) {
			inputGeneration += 1
			contextStartSequence = snapshot.meta.sequence
		}
		this.snapshot = snapshot
		status = ContentViewStatus.CURRENT
		reason = null
		// A semantic change is a new source lifetime: pending input admitted against a
		// different context can never finish as `submitted`, and a copy whose header
		// belonged to a different source is withheld for good. Ordinary output in the
		// same context ends neither.
		invalidatePendingInputsFor(snapshot, events)
		withholdActiveCopy(snapshot, events)
		// A written receipt proves the caller committed this semantic context. It stays
		// standing across same-context output and is retired by any semantic change.
		if (!receiptMatchesPublication(writtenReceipt, snapshot)) writtenReceipt = null
		events += ContentEndpointEvent.SnapshotPublished(snapshot)
		return step(emptyList(), events)
	}

	private fun samePublicationIdentity(left: ContentSnapshot, right: ContentSnapshot): Boolean {
		val a = left.meta.inputSource
		val b = right.meta.inputSource
		val sourceChanged = if (a is OptionalNativeIoSource.Stated && b is OptionalNativeIoSource.Stated) {
			!nativeIoSourceEquals(a.source, b.source)
		} else {
			a != b
		}
		// Geometry and frame extents are part of the input context: what was typed
		// against one grid is never attributed to a reflowed one.
		return !sourceChanged && sameInputModes(left.meta.inputModes, right.meta.inputModes) &&
			left.meta.geometry == right.meta.geometry &&
			left.frame.cols == right.frame.cols && left.frame.rows == right.frame.rows
	}

	private fun clearSnapshot(why: ContentUnavailableReason, events: MutableList<ContentEndpointEvent>) {
		if (snapshot == null) return
		snapshot = null
		status = ContentViewStatus.UNAVAILABLE
		reason = why
		events += ContentEndpointEvent.ViewCleared(why)
	}

	/* --------------------------------------------------------------------- *
	 * Resize
	 * --------------------------------------------------------------------- */

	/**
	 * Request new viewport dimensions. At most one newest request is retained, one
	 * resize write is in flight at a time, and the published geometry only changes
	 * when the owner reports a frame. Each accepted request advances the resize
	 * epoch, so a written receipt captured under an older epoch stops describing
	 * what the caller sees, and pending input admitted under it is dropped.
	 */
	@Synchronized
	fun resize(cols: Int, rows: Int, nowNanos: Long): ContentEndpointStep {
		require(cols in 1..bounds.maxCols) { "content resize columns are invalid" }
		require(rows in 1..bounds.maxRows) { "content resize rows are invalid" }
		// After stop or retirement a resize is inert: nothing may restart delivery.
		if (retired || stopRequested) return step(emptyList(), emptyList())
		val next = ContentViewportRequest(cols, rows)
		if (next == requestedViewport) return step(emptyList(), emptyList())
		requestedViewport = next
		// A geometry change is its own epoch: an A → B → A return never revives a
		// receipt or an admitted input captured under the original A.
		resizeEpoch += 1
		val events = ArrayList<ContentEndpointEvent>()
		// A geometry change drops admitted input lifetimes: what was typed against the
		// previous geometry is never written into a reflowed one.
		invalidatePendingInputs(ContentNotSentReason.STALE_RESIZE, events)
		val effects = ArrayList<ContentSendEffect>()
		flushResize(effects)
		return step(effects, events)
	}

	/**
	 * Emit at most one newest resize.
	 *
	 * The comparison is against the dimensions the owner was ACTUALLY told (the last
	 * write that was invoked), never against dimensions an effect merely carried: an
	 * effect whose guard went stale before dispatch is dropped, releases the in-flight
	 * slot, and the newest request is written instead.
	 */
	private fun flushResize(effects: MutableList<ContentSendEffect>) {
		if (retired || stopRequested) return
		if (resizeInFlight || phase != ContentEndpointPhase.STREAMING) return
		val wanted = requestedViewport
		val invoked = invokedViewport
		if (invoked != null && invoked == wanted) {
			// The owner was already told exactly this; there is nothing new to send.
			return
		}
		resizeInFlight = true
		effects += effect(
			ResizeFrame(subscriptionId, wanted.cols, wanted.rows),
			ContentSendGuard.Resize(target.connectionGeneration, subscriptionId, resizeEpoch),
			viewport = wanted,
		)
	}

	/* --------------------------------------------------------------------- *
	 * Deadlines
	 * --------------------------------------------------------------------- */

	/**
	 * Deliver one expiry the coordinator armed. An expiry the endpoint no longer
	 * holds is ignored, so a timer armed from a stale step can never retire anything.
	 */
	@Synchronized
	fun onDeadline(kind: ContentDeadlineKind, nowNanos: Long): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		// An invoked write is bounded per effect rather than as one armed kind, because
		// several writes can be outstanding at once; its expiry is the earliest bound.
		val due = if (kind == ContentDeadlineKind.SEND) sendDue.values.minOrNull() else armedDeadlines[kind]
		if (due == null || due > nowNanos) return step(emptyList(), emptyList())
		if (kind != ContentDeadlineKind.SEND) disarm(kind)
		return when (kind) {
			ContentDeadlineKind.HANDSHAKE, ContentDeadlineKind.FIRST_TRANSFER ->
				retire(ContentUnavailableReason.SUBSCRIPTION_TIMEOUT)

			ContentDeadlineKind.TRANSFER_IDLE -> {
				// The staged payload is discarded whole and never published.
				transferAssembly.reset()
				retire(ContentUnavailableReason.TRANSFER_FAILED)
			}

			ContentDeadlineKind.COPY_IDLE -> {
				copyAssembly.reset()
				copyHeaderId = null
				copyHeaderSource = null
				copyDiscardId = null
				retire(ContentUnavailableReason.TRANSFER_FAILED)
			}

			ContentDeadlineKind.STOP_ACK -> finishStop()

			ContentDeadlineKind.SEND -> sendDeadlineElapsed(nowNanos)
		}
	}

	/**
	 * One invoked write never returned. Its finite bound is the transfer-idle bound,
	 * exactly as the source per-send deadline reuses it: a control write fails the
	 * endpoint, an input page can only be `unknown`, and nothing is retried.
	 */
	private fun sendDeadlineElapsed(nowNanos: Long): ContentEndpointStep {
		val events = ArrayList<ContentEndpointEvent>()
		val expired = sendDue.filterValues { it <= nowNanos }.keys.toList()
		if (expired.isEmpty()) return step(emptyList(), events)
		var failure: ContentUnavailableReason? = null
		for (effectId in expired) {
			sendDue.remove(effectId)
			val issued = issuedEffects[effectId] ?: continue
			when (issued.guard) {
				is ContentSendGuard.Input -> {
					val pending = pendingInputs[issued.inputId] ?: continue
					// The write was invoked, so its full return will never be known.
					pending.invoked = true
					pending.settle(ContentSendOutcome.Unknown, events)
				}

				is ContentSendGuard.Unsubscribe -> {
					// The retirement notice never landed; stop is still bounded.
					return settleStopAck(events)
				}

				is ContentSendGuard.ProtocolError -> Unit

				else -> failure = ContentUnavailableReason.SEND_FAILED
			}
		}
		if (failure != null) return retire(failure, events)
		return step(emptyList(), events)
	}

	private fun arm(kind: ContentDeadlineKind, nowNanos: Long, millis: Long) {
		armedDeadlines[kind] = nowNanos + millis * 1_000_000L
	}

	private fun disarm(kind: ContentDeadlineKind) {
		armedDeadlines.remove(kind)
	}

	private fun disarmAllButStopAck() {
		armedDeadlines.keys.retainAll(setOf(ContentDeadlineKind.STOP_ACK))
	}

	/* --------------------------------------------------------------------- *
	 * Written-frame receipt
	 * --------------------------------------------------------------------- */

	/**
	 * Register the caller's commit of one exact published frame.
	 *
	 * This is the ONLY way a written receipt comes to exist: the endpoint never
	 * invents one, and a queued, held, or superseded candidate never becomes one.
	 * The proof must match the current published binding, geometry and revision, the
	 * caller's own pending resize epoch and policy generation, and the current
	 * semantic input context: its generation must be the live one and its sequence
	 * must name a publication of that context — never a future sequence and never one
	 * published before the context began. A commit of an earlier publication of the
	 * same context (drawn just before newer output arrived) is therefore a genuine
	 * commit of that context; one from any other context never is.
	 */
	@Synchronized
	fun recordWrittenFrame(proof: ContentWrittenFrameProof): ContentWrittenFrameOutcome {
		if (retired || stopRequested) return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.STOPPED)
		val current = snapshot ?: return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.NO_VIEW)
		if (proof.selectionGeneration != target.selectionGeneration ||
			proof.subscriptionId != subscriptionId ||
			current.meta.hostRunId != target.ownerRunId ||
			current.meta.rowId != target.rowId
		) {
			return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.BINDING_MISMATCH)
		}
		if (proof.inputGeneration != inputGeneration ||
			proof.sequence > current.meta.sequence ||
			proof.sequence < contextStartSequence
		) {
			return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.SEQUENCE_MISMATCH)
		}
		if (proof.geometry != current.meta.geometry) {
			return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.GEOMETRY_MISMATCH)
		}
		if (proof.policyGeneration != policy.generation) {
			return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.POLICY_STALE)
		}
		if (proof.resizeEpoch != resizeEpoch) {
			return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.RESIZE_EPOCH_STALE)
		}
		val source = (current.meta.inputSource as? OptionalNativeIoSource.Stated)?.source
			?: return ContentWrittenFrameOutcome.Rejected(ContentWrittenFrameRejectReason.NO_SOURCE)
		val receipt = WrittenRemoteContent(
			hostId = target.hostId,
			hostRunId = current.meta.hostRunId,
			rowId = current.meta.rowId,
			selectionGeneration = target.selectionGeneration,
			subscriptionId = subscriptionId,
			sequence = proof.sequence,
			source = source,
			inputModes = current.meta.inputModes,
			geometry = current.meta.geometry,
			nativeContent = proof.nativeContent,
			resizeEpoch = proof.resizeEpoch,
			policyGeneration = proof.policyGeneration,
			inputGeneration = inputGeneration,
		)
		writtenReceipt = receipt
		return ContentWrittenFrameOutcome.Registered(receipt)
	}

	/**
	 * Replace the live remote input/copy preference. Every actual effective change
	 * must arrive with a higher generation, including an Off → On return, so a
	 * receipt or admitted input captured under an older generation can never be
	 * revived by a value that merely reads the same again.
	 */
	@Synchronized
	fun updateInputPolicy(next: ContentInputPolicy): ContentEndpointStep {
		if (next.generation == policy.generation) {
			policy = next
			return step(emptyList(), emptyList())
		}
		policy = next
		val events = ArrayList<ContentEndpointEvent>()
		// A preference change is a writer boundary even when the pixels are identical.
		writtenReceipt = null
		invalidatePendingInputs(ContentNotSentReason.POLICY_DISABLED, events)
		// An in-flight copy header admitted under the previous generation is withheld for
		// good: its pages stay consumed and validated, but nothing is routed.
		val copyId = copyHeaderId
		if (copyId != null && copyDiscardId == null) {
			copyDiscardId = copyId
			events += ContentEndpointEvent.CopyWithheld(copyId)
		}
		return step(emptyList(), events)
	}

	/* --------------------------------------------------------------------- *
	 * Native input
	 * --------------------------------------------------------------------- */

	/**
	 * Submit one typed, caller-normalized native input against the exact source and
	 * modes of the current published snapshot.
	 *
	 * [authorized] is the caller's own dynamic written-source/focus/coverage proof,
	 * evaluated synchronously by the caller immediately before this call: only
	 * `true` admits the operation, and passing it as a value keeps caller code out of
	 * this endpoint's monitor. Admission still requires this endpoint's own fences —
	 * negotiation, a current publication, the exact source and modes, a written
	 * receipt of that same semantic input context, the live policy generation, and
	 * the current resize epoch.
	 *
	 * The returned effects are this operation's frames in wire order and must be
	 * serialized by the caller one operation at a time, so a paste's pages never
	 * interleave another input's pages. Immediately before each page the caller must
	 * re-consume [isSendGuardCurrent] and re-run its own proof. Nothing is retried,
	 * replayed, or reconnected, and the final outcome arrives as
	 * [ContentEndpointEvent.InputSettled].
	 */
	@Synchronized
	fun submitInput(request: ContentInputRequest, authorized: Boolean, nowNanos: Long): ContentInputAdmission {
		val admitted = inputGate(request)
		if (admitted is Gate.Blocked) return ContentInputAdmission.Refused(admitted.reason)
		if (!authorized) return ContentInputAdmission.Refused(ContentNotSentReason.UNAUTHORIZED)
		if (pendingInputs.size >= MAX_PENDING_INPUT_OPERATIONS) {
			// The bound counts logical input operations, not characters or pages: one
			// paste never consumes several slots. Overflow is refused without replay or
			// relaxed input fences.
			return ContentInputAdmission.Refused(ContentNotSentReason.BUSY)
		}
		val open = admitted as Gate.Open
		val inputId = config.ids.nextId()
		if (!isValidContentIdentifier(inputId, bounds.maxIdentifierBytes)) {
			return ContentInputAdmission.Refused(ContentNotSentReason.INVALID_INPUT)
		}
		val ordinal = nextInputOrdinal
		val packed = ContentInputPacking.pack(
			subscriptionId = subscriptionId,
			inputId = inputId,
			ordinal = ordinal,
			source = open.source,
			inputModes = open.inputModes,
			kind = request.kind,
			text = request.text,
			bounds = bounds,
		)
		if (packed is PackedInput.Refused) return ContentInputAdmission.Refused(packed.reason)
		nextInputOrdinal = ordinal + 1
		val effects = (packed as PackedInput.Ready).frames.map { frame ->
			effect(frame, ContentSendGuard.Input(target.connectionGeneration, subscriptionId, inputId, inputGeneration))
		}
		val generation = inputGeneration
		val pending = PendingInput(
			inputId = inputId,
			ordinal = ordinal,
			source = open.source,
			inputModes = open.inputModes,
			generation = generation,
			effectIds = effects.map { it.effectId },
		)
		pendingInputs[inputId] = pending
		return ContentInputAdmission.Accepted(inputId, ordinal, effects)
	}

	/**
	 * Report what actually happened to one issued effect, at the moment it happened.
	 *
	 * This is what keeps an outcome truthful: `not-sent` can only be produced while
	 * no write of that operation was ever invoked, `submitted` only once every local
	 * write returned, and everything else becomes `unknown`.
	 */
	@Synchronized
	fun reportSend(effectId: Long, phase: ContentSendPhase, nowNanos: Long): ContentEndpointStep {
		if (retired) return step(emptyList(), emptyList())
		val issued = issuedEffects[effectId] ?: return step(emptyList(), emptyList())
		val events = ArrayList<ContentEndpointEvent>()
		when (phase) {
			// An invoked write is bounded by the finite transfer-idle bound, so a write
			// that never returns cannot pin a resize slot or a pending input forever.
			ContentSendPhase.INVOKED -> sendDue[effectId] = nowNanos + deadlines.transferIdleMs * 1_000_000L
			else -> sendDue.remove(effectId)
		}
		if (issued.inputId == null && phase != ContentSendPhase.INVOKED) issuedEffects.remove(effectId)
		return when (issued.guard) {
			is ContentSendGuard.Hello ->
				if (phase == ContentSendPhase.FAILED) retire(ContentUnavailableReason.SEND_FAILED, events)
				else step(emptyList(), events)

			is ContentSendGuard.Subscribe -> {
				if (phase != ContentSendPhase.DROPPED) {
					// Only bytes actually handed to the transport owe an unsubscribe.
					subscribeEmitted = true
					invokedViewport = issued.viewport ?: invokedViewport
				}
				if (phase == ContentSendPhase.FAILED) retire(ContentUnavailableReason.SEND_FAILED, events)
				else step(emptyList(), events)
			}

			is ContentSendGuard.Resize -> {
				if (phase == ContentSendPhase.INVOKED) {
					issued.viewport?.let { invokedViewport = it }
					step(emptyList(), events)
				} else if (phase == ContentSendPhase.FAILED) {
					retire(ContentUnavailableReason.SEND_FAILED, events)
				} else {
					// A completed or dropped resize frees the slot; a dropped one never reached
					// the wire, so the newest requested dimensions are written instead.
					resizeInFlight = false
					val effects = ArrayList<ContentSendEffect>()
					flushResize(effects)
					step(effects, events)
				}
			}

			is ContentSendGuard.Unsubscribe -> {
				// Local completion is NOT the owner's acknowledgement: the bounded stop
				// window stays armed until the matching owner frame, a send failure, the
				// notice never being dispatched, channel loss, or the deadline.
				if (phase == ContentSendPhase.FAILED || phase == ContentSendPhase.DROPPED) settleStopAck(events)
				else step(emptyList(), events)
			}

			is ContentSendGuard.ProtocolError -> step(emptyList(), events)

			is ContentSendGuard.Input -> {
				val pending = pendingInputs[issued.inputId]
					?: return step(emptyList(), events)
				if (pending.settled) return step(emptyList(), events)
				when (phase) {
					ContentSendPhase.INVOKED -> pending.invoked = true

					ContentSendPhase.COMPLETED -> {
						pending.completed += 1
						if (pending.completed >= pending.effectIds.size) {
							pending.settle(ContentSendOutcome.Submitted, events)
						}
					}

					ContentSendPhase.FAILED -> pending.settle(ContentSendOutcome.Unknown, events)

					ContentSendPhase.DROPPED -> pending.settle(
						if (pending.invoked) {
							ContentSendOutcome.Unknown
						} else {
							ContentSendOutcome.NotSent(
								if (pending.invalidated) pending.staleReason else ContentNotSentReason.STOPPED,
							)
						},
						events,
					)
				}
				step(emptyList(), events)
			}
		}
	}

	private fun abortPendingInputs(events: MutableList<ContentEndpointEvent>) {
		pendingInputs.values.toList().forEach { it.abort(events) }
	}

	/**
	 * Invalidate pending input operations whose admitted semantic context no longer
	 * matches the snapshot that just became current. The flag is permanent for that
	 * operation: a later return to the same source does not restore its lifetime, and
	 * the invalidation survives the completion of a write already in flight.
	 *
	 * Ordinary output under the same source, modes, and geometry keeps the generation
	 * and leaves an admitted operation alone; the documented contract is that a new
	 * snapshot or publish sequence alone never stalls input.
	 */
	private fun invalidatePendingInputsFor(snapshot: ContentSnapshot, events: MutableList<ContentEndpointEvent>) {
		if (pendingInputs.isEmpty()) return
		val current = (snapshot.meta.inputSource as? OptionalNativeIoSource.Stated)?.source
		for (pending in pendingInputs.values.toList()) {
			if (pending.settled) continue
			// An admitted operation is bound to the semantic generation it was admitted
			// under. Any advance — even A → B → A — ends that lifetime for good.
			if (pending.generation != inputGeneration ||
				current == null ||
				!nativeIoSourceEquals(pending.source, current) ||
				!sameInputModes(pending.inputModes, snapshot.meta.inputModes)
			) {
				invalidate(pending, ContentNotSentReason.STALE_SOURCE, events)
			}
		}
	}

	private fun invalidatePendingInputs(why: ContentNotSentReason, events: MutableList<ContentEndpointEvent>) {
		for (pending in pendingInputs.values.toList()) {
			if (pending.settled) continue
			invalidate(pending, why, events)
		}
	}

	/**
	 * End one admitted operation for good.
	 *
	 * The flag is permanent: a later return to the same source, geometry, or policy
	 * generation never restores the lifetime. The operation is settled here rather than
	 * left waiting for pages that must never dispatch — a compliant transport stops at
	 * the stale guard, so waiting would pin the slot forever. Bytes never invoked are
	 * `not-sent`; bytes that may already be on the wire are `unknown`.
	 */
	private fun invalidate(pending: PendingInput, why: ContentNotSentReason, events: MutableList<ContentEndpointEvent>) {
		if (pending.invalidated || pending.settled) return
		pending.invalidated = true
		pending.staleReason = why
		pending.settle(
			if (pending.invoked) ContentSendOutcome.Unknown else ContentSendOutcome.NotSent(why),
			events,
		)
	}

	/* --------------------------------------------------------------------- *
	 * Native copies
	 * --------------------------------------------------------------------- */

	private fun onCopy(frame: CopyFrame, nowNanos: Long): ContentEndpointStep {
		requireNativeIoFor(frame.subscriptionId)
		val events = ArrayList<ContentEndpointEvent>()
		noteCopyHeader(frame.copyId, frame.source, events)
		val completed = copyAssembly.inline(frame) ?: throw ContentProtocolFailure
		return deliverCopy(completed, events)
	}

	private fun onCopyBegin(frame: CopyBeginFrame, nowNanos: Long): ContentEndpointStep {
		requireNativeIoFor(frame.subscriptionId)
		val events = ArrayList<ContentEndpointEvent>()
		noteCopyHeader(frame.copyId, frame.source, events)
		if (!copyAssembly.begin(frame)) throw ContentProtocolFailure
		arm(ContentDeadlineKind.COPY_IDLE, nowNanos, deadlines.transferIdleMs)
		return step(emptyList(), events)
	}

	private fun onCopyChunk(frame: CopyChunkFrame, nowNanos: Long): ContentEndpointStep {
		requireNativeIoFor(frame.subscriptionId)
		if (!copyAssembly.chunk(frame)) throw ContentProtocolFailure
		arm(ContentDeadlineKind.COPY_IDLE, nowNanos, deadlines.transferIdleMs)
		return step(emptyList(), emptyList())
	}

	private fun onCopyEnd(frame: CopyEndFrame, nowNanos: Long): ContentEndpointStep {
		requireNativeIoFor(frame.subscriptionId)
		val events = ArrayList<ContentEndpointEvent>()
		val completed = copyAssembly.end(frame)
		disarm(ContentDeadlineKind.COPY_IDLE)
		if (completed == null) throw ContentProtocolFailure
		return deliverCopy(completed, events)
	}

	private fun noteCopyHeader(copyId: String, source: NativeIoSource, events: MutableList<ContentEndpointEvent>) {
		if (source.hostRunId != target.ownerRunId || source.sessionId != target.rowId) {
			// Another run or another owner row is never this endpoint's copy.
			throw ContentProtocolFailure
		}
		// The header's exact source decides routability for this one assembly, so the
		// header identity is the single discard slot's lifetime marker.
		copyHeaderId = copyId
		copyHeaderSource = source
		copyHeaderPolicyGeneration = policy.generation
		if (!copyRoutable(source)) {
			copyDiscardId = copyId
			events += ContentEndpointEvent.CopyWithheld(copyId)
		}
	}

	private fun deliverCopy(completed: AssembledCopy, events: MutableList<ContentEndpointEvent>): ContentEndpointStep {
		val withheld = copyDiscardId != null
		copyDiscardId = null
		copyHeaderId = null
		copyHeaderSource = null
		copyHeaderPolicyGeneration = null
		if (withheld) {
			// The one withheld assembly just ended, so its slot is released without ever
			// routing its data.
			return step(emptyList(), events)
		}
		// Completed data is re-checked, not just the header: a source change while the
		// pages arrived must never hand the copy to a newer view.
		if (!copyRoutable(completed.source)) {
			events += ContentEndpointEvent.CopyWithheld(completed.copyId)
			return step(emptyList(), events)
		}
		events += ContentEndpointEvent.CopyDelivered(
			ContentCopyReceipt(
				hostId = target.hostId,
				selectionGeneration = target.selectionGeneration,
				subscriptionId = subscriptionId,
				copyId = completed.copyId,
				sequence = completed.sequence,
				source = completed.source,
				dispatchId = completed.dispatchId,
				event = completed.event,
			),
		)
		return step(emptyList(), events)
	}

	/**
	 * Whether a copy's exact source is this endpoint's own current published source
	 * AND the live remote input/copy preference permits delivery.
	 *
	 * A copy is delivered only to the current initiating viewer: with the preference
	 * Off, or under a policy generation other than the one the header was admitted
	 * under, nothing is routed.
	 */
	private fun copyRoutable(source: NativeIoSource): Boolean {
		if (!nativeIoNegotiated || retired || stopRequested) return false
		if (!policy.enabled) return false
		if (phase != ContentEndpointPhase.STREAMING) return false
		// A header admitted under an older preference generation is withheld for good.
		val headerGeneration = copyHeaderPolicyGeneration
		if (headerGeneration != null && headerGeneration != policy.generation) return false
		val snapshot = snapshot ?: return false
		if (snapshot.meta.subscriptionId != subscriptionId ||
			snapshot.meta.hostRunId != target.ownerRunId ||
			snapshot.meta.rowId != target.rowId
		) {
			return false
		}
		val current = snapshot.meta.inputSource as? OptionalNativeIoSource.Stated ?: return false
		// Exact equality, so an A → B → A change never routes the old A data. A copy is
		// conversation-only, so a startup publication is never routable either.
		return nativeIoSourceEquals(source, current.source)
	}

	/** Withhold the in-flight copy when a publication leaves that copy's header source. */
	private fun withholdActiveCopy(snapshot: ContentSnapshot, events: MutableList<ContentEndpointEvent>) {
		val copyId = copyHeaderId ?: return
		val source = copyHeaderSource ?: return
		if (copyDiscardId != null) return
		val current = snapshot.meta.inputSource as? OptionalNativeIoSource.Stated
		if (current == null || !nativeIoSourceEquals(source, current.source)) {
			copyDiscardId = copyId
			events += ContentEndpointEvent.CopyWithheld(copyId)
		}
	}

	/* --------------------------------------------------------------------- *
	 * Retirement
	 * --------------------------------------------------------------------- */

	private fun settleStopAck(events: MutableList<ContentEndpointEvent> = ArrayList()): ContentEndpointStep {
		if (phase != ContentEndpointPhase.STOPPING) return step(emptyList(), events)
		disarm(ContentDeadlineKind.STOP_ACK)
		return finishStop(events)
	}

	private fun finishStop(events: MutableList<ContentEndpointEvent> = ArrayList()): ContentEndpointStep =
		retire(ContentUnavailableReason.STOPPED, events)

	private fun retire(
		why: ContentUnavailableReason,
		events: MutableList<ContentEndpointEvent> = ArrayList(),
		extraEffects: List<ContentSendEffect> = emptyList(),
	): ContentEndpointStep {
		if (retired) return ContentEndpointStep(observation(), extraEffects, events, nextDeadline())
		retired = true
		phase = ContentEndpointPhase.RETIRED
		val cleared = ArrayList(events)
		clearSnapshot(why, cleared)
		if (status != ContentViewStatus.CURRENT) {
			status = ContentViewStatus.UNAVAILABLE
			reason = why
		}
		transferAssembly.reset()
		copyAssembly.reset()
		copyHeaderId = null
		copyHeaderSource = null
		copyHeaderPolicyGeneration = null
		copyDiscardId = null
		armedDeadlines.clear()
		sendDue.clear()
		// Every pending logical input ends now with its truthful invocation status, and
		// every unsent effect stops being current for the transport.
		abortPendingInputs(cleared)
		pendingInputs.clear()
		issuedEffects.clear()
		writtenReceipt = null
		resizeInFlight = false
		cleared += ContentEndpointEvent.Retired(why)
		return ContentEndpointStep(observation(), extraEffects, cleared, emptyList())
	}

	/* --------------------------------------------------------------------- *
	 * Gates and helpers
	 * --------------------------------------------------------------------- */

	private sealed interface Gate {
		/** The endpoint's own immutable current source and modes, used for the wire. */
		class Open(
			val source: NativeIoInputSource,
			val inputModes: TerminalInputModes,
		) : Gate

		/** One fixed reason nothing was staged. */
		class Blocked(val reason: ContentNotSentReason) : Gate
	}

	private fun inputGate(request: ContentInputRequest): Gate {
		fun refuse(why: ContentNotSentReason): Gate = Gate.Blocked(why)
		if (retired || stopRequested) return refuse(ContentNotSentReason.STOPPED)
		if (!nativeIoNegotiated) return refuse(ContentNotSentReason.NOT_NEGOTIATED)
		if (!policy.enabled) return refuse(ContentNotSentReason.POLICY_DISABLED)
		if (phase != ContentEndpointPhase.STREAMING) return refuse(ContentNotSentReason.NOT_READY)
		val snapshot = snapshot ?: return refuse(ContentNotSentReason.NOT_READY)
		if (snapshot.meta.subscriptionId != subscriptionId ||
			snapshot.meta.hostRunId != target.ownerRunId ||
			snapshot.meta.rowId != target.rowId
		) {
			return refuse(ContentNotSentReason.STALE_SOURCE)
		}
		val stated = snapshot.meta.inputSource as? OptionalNativeIoSource.Stated ?: return refuse(ContentNotSentReason.STALE_SOURCE)
		// A startup source is usable only on a channel that negotiated startup input.
		if (isNativeIoStartupSource(stated.source) && !startupInputNegotiated) {
			return refuse(ContentNotSentReason.STALE_SOURCE)
		}
		// Exact expected source against this endpoint's own current published facts:
		// token, run, row, native tuple and epoch, geometry revision, viewer revision.
		if (!nativeIoSourceEquals(request.source, stated.source)) return refuse(ContentNotSentReason.STALE_SOURCE)
		if (!sameInputModes(request.inputModes, snapshot.meta.inputModes)) {
			return refuse(ContentNotSentReason.STALE_MODES)
		}
		// Admission is onto the frame the caller ACTUALLY committed, not merely onto a
		// publish that exists.
		val receipt = writtenReceipt ?: return refuse(ContentNotSentReason.NO_WRITTEN_FRAME)
		if (!receiptMatchesPublication(receipt, snapshot)) return refuse(ContentNotSentReason.NO_WRITTEN_FRAME)
		if (receipt.policyGeneration != policy.generation) return refuse(ContentNotSentReason.POLICY_STALE)
		if (receipt.resizeEpoch != resizeEpoch) return refuse(ContentNotSentReason.STALE_RESIZE)
		// Only this endpoint's own immutable facts are ever used for the wire, never the
		// caller's mutable objects that merely had to compare equal to them.
		return Gate.Open(stated.source, snapshot.meta.inputModes)
	}

	private fun receiptMatchesPublication(receipt: WrittenRemoteContent?, snapshot: ContentSnapshot): Boolean {
		receipt ?: return false
		if (receipt.selectionGeneration != target.selectionGeneration) return false
		if (receipt.subscriptionId != subscriptionId) return false
		if (receipt.hostRunId != target.ownerRunId || receipt.rowId != target.rowId) return false
		// The receipt is proof of the current semantic context, not of one publish: it
		// must belong to the live generation and name a publication of it.
		if (receipt.inputGeneration != inputGeneration) return false
		if (receipt.sequence > snapshot.meta.sequence || receipt.sequence < contextStartSequence) return false
		if (receipt.geometry != snapshot.meta.geometry) return false
		if (!sameInputModes(receipt.inputModes, snapshot.meta.inputModes)) return false
		val stated = snapshot.meta.inputSource as? OptionalNativeIoSource.Stated ?: return false
		return nativeIoSourceEquals(receipt.source, stated.source)
	}

	private fun currentTarget(snapshot: ContentSnapshot): ContentNativeInputTarget? {
		val stated = snapshot.meta.inputSource as? OptionalNativeIoSource.Stated ?: return null
		return ContentNativeInputTarget(
			hostId = target.hostId,
			selectionGeneration = target.selectionGeneration,
			subscriptionId = subscriptionId,
			source = stated.source,
			inputModes = snapshot.meta.inputModes,
		)
	}

	private fun requireStreamingFor(subscriptionId: String) {
		if (phase != ContentEndpointPhase.STREAMING || subscriptionId != this.subscriptionId) {
			// No frame may be published or staged before the exact acknowledgement.
			throw ContentProtocolFailure
		}
	}

	private fun requireNativeIoFor(subscriptionId: String) {
		if (!nativeIoNegotiated) {
			// Nothing offered this frame type: an unnegotiated extension is a violation.
			throw ContentProtocolFailure
		}
		requireStreamingFor(subscriptionId)
	}

	private fun effect(
		frame: ContentFrame,
		guard: ContentSendGuard,
		viewport: ContentViewportRequest? = null,
	): ContentSendEffect {
		val id = nextEffectId
		nextEffectId += 1
		issuedEffects[id] = IssuedEffect(guard, (guard as? ContentSendGuard.Input)?.inputId, viewport)
		return ContentSendEffect(id, frame, guard)
	}

	private fun observation(): ContentEndpointObservation = ContentEndpointObservation(
		target = target,
		subscriptionId = subscriptionId,
		phase = phase,
		status = status,
		view = snapshot,
		reason = if (status == ContentViewStatus.CURRENT) null else reason,
		acknowledgedCapabilities = acknowledgedCapabilities,
		nativeIoNegotiated = nativeIoNegotiated,
		startupInputNegotiated = startupInputNegotiated,
		requestedViewport = requestedViewport,
		publishedGeometry = snapshot?.meta?.geometry,
		writtenReceipt = writtenReceipt,
		inputPolicy = policy,
		pendingInputCount = pendingInputs.size,
		inputGeneration = inputGeneration,
		resizeEpoch = resizeEpoch,
	)

	private fun step(
		effects: List<ContentSendEffect>,
		events: List<ContentEndpointEvent>,
	): ContentEndpointStep = ContentEndpointStep(observation(), effects, events, nextDeadline())

	companion object {
		/**
		 * Bound on admitted-but-unsettled logical input operations. Slots release as
		 * operations settle; a synchronous burst can fill the bound before any write runs.
		 */
		const val MAX_PENDING_INPUT_OPERATIONS: Int = 128
	}
}

/** Signals a frame this endpoint must treat as a protocol failure. */
private object ContentProtocolFailure : RuntimeException("session content protocol violation") {
	private const val serialVersionUID: Long = 1L
}

/** Exact structural equality of one observed mode set. */
internal fun sameInputModes(left: TerminalInputModes, right: TerminalInputModes): Boolean =
	left == right

/** The subscription a frame names, when its shape names one. */
private fun subscriptionIdOf(frame: ContentFrame): String? = when (frame) {
	is SubscribeFrame -> frame.subscriptionId
	is SubscribedFrame -> frame.subscriptionId
	is ResizeFrame -> frame.subscriptionId
	is UnsubscribeFrame -> frame.subscriptionId
	is UnsubscribedFrame -> frame.subscriptionId
	is EndFrame -> frame.subscriptionId
	is ErrorFrame -> frame.subscriptionId
	is ContentBeginFrame -> frame.subscriptionId
	is ContentChunkFrame -> frame.subscriptionId
	is ContentEndFrame -> frame.subscriptionId
	is InputChunkFrame -> frame.subscriptionId
	is CopyFrame -> frame.subscriptionId
	is CopyBeginFrame -> frame.subscriptionId
	is CopyChunkFrame -> frame.subscriptionId
	is CopyEndFrame -> frame.subscriptionId
	else -> null
}
