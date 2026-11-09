package io.github.rfairburn.pireviewgate.core.input

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.CoroutineContext

/**
 * Admits inputs one at a time, in the order they were handed over.
 *
 * Each input used to start its own coroutine and hop to a worker pool on its own. Two
 * packets of one keystroke, like the backspace and the text of a correction, could then
 * reach the admission queue in whichever order their workers ran. This helper keeps one
 * consumer. Every [submit] is queued synchronously in call order, and the consumer runs
 * [admit] for one input before the next. Only admission is serialized. [admit] returns
 * once the input is admitted, and nothing waits for it to be sent or settled before the
 * next input is admitted.
 *
 * The queue holds no more than its callers admit. The caller keeps its own bound and
 * accounting, and it observes each result through the returned [Deferred], exactly as
 * it would have observed a per-input coroutine. A failure in one admission fails only that
 * input's result. Nothing is retried or replayed.
 *
 * Every result terminates. Once the owning scope is cancelled, whether before the consumer
 * ever ran or while it was waiting, the queue is closed. Every input still queued is
 * cancelled without being admitted, and so is every later [submit].
 *
 * [submit] must be called from one thread, which is the caller's UI thread.
 */
class OrderedInputAdmission<T, R>(
	private val scope: CoroutineScope,
	private val context: CoroutineContext,
	private val admit: suspend (T) -> R,
) {
	private class Pending<T, R>(val item: T, val reply: CompletableDeferred<R>)

	private val queue = Channel<Pending<T, R>>(Channel.UNLIMITED)
	private var consumer: Job? = null

	/** Queue [item] behind every earlier one. The result completes once it is admitted. */
	fun submit(item: T): Deferred<R> {
		val reply = CompletableDeferred<R>()
		if (!scope.isActive) {
			reply.cancel(closed())
			return reply
		}
		if (consumer == null) {
			// Completion, not the body, closes the queue: a consumer cancelled before it
			// ever started still reconciles whatever was queued for it.
			consumer = scope.launch(context) { drain() }.also { job -> job.invokeOnCompletion { closeQueue() } }
		}
		if (!queue.trySend(Pending(item, reply)).isSuccess) reply.cancel(closed())
		return reply
	}

	private suspend fun drain() {
		for (pending in queue) {
			if (pending.reply.isCompleted) continue
			try {
				pending.reply.complete(admit(pending.item))
			} catch (cancellation: CancellationException) {
				pending.reply.completeExceptionally(cancellation)
				// Only this input's admission was cancelled unless the consumer itself was.
				currentCoroutineContext().ensureActive()
			} catch (failure: Throwable) {
				pending.reply.completeExceptionally(failure)
			}
		}
	}

	/** Close the queue and cancel everything still in it. Safe from any thread. */
	private fun closeQueue() {
		queue.close()
		while (true) {
			val left = queue.tryReceive().getOrNull() ?: break
			left.reply.cancel(closed())
		}
	}

	private companion object {
		fun closed() = CancellationException("Input admission is closed")
	}
}
