package io.github.rfairburn.pireviewgate.core.input

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * One proof together with the publication that made it current.
 *
 * [publicationEpoch] increases with every publication, so a holder can tell two
 * publications of equal-valued proofs apart. It is a marker, not authority: the
 * only decision made here is whether something is the current proof.
 */
data class PublishedInputProof<T>(val proof: T, val publicationEpoch: Long)

/**
 * The thread-safe statement of which input proof is current right now.
 *
 * A surface like the phone's terminal decides input eligibility on its UI thread,
 * where the view, its layout, and its lifecycle live. The party that needs the
 * answer is often somewhere else — an IO writer deciding whether a queued write may
 * still be attributed to the frame it was prepared against — and reading those UI
 * structures from there is not safe. This type is what crosses that boundary: the
 * UI thread publishes one immutable proof or retires it, and any thread can ask,
 * from a single atomic read, whether the proof it is holding is the current one.
 *
 * The rules are deliberately few:
 *  - publication and retirement are the writer's job, and a writer stays on the
 *    thread that owns the underlying state;
 *  - [isCurrent] and [current] are safe from any thread and read nothing but the
 *    published snapshot;
 *  - retirement is what a state change does first, so a proof stops being current
 *    before anything else about the change is handled;
 *  - nothing here holds a lock across a callback, and nothing here decides whether
 *    a proof *should* exist — that stays with the surface that publishes it.
 *
 * A proof is whatever the publisher says it is. The value is compared by equality,
 * so a proof type that carries its own identity and epochs (a frame commit receipt,
 * say) is current only while that exact value is what was published.
 */
class InputProofPublication<T> {
	private val published = AtomicReference<PublishedInputProof<T>?>(null)
	private val epochs = AtomicLong(0)

	/**
	 * Make [proof] the current proof and return it with its publication epoch.
	 *
	 * Any earlier proof stops being current at this point.
	 */
	fun publish(proof: T): PublishedInputProof<T> {
		val next = PublishedInputProof(proof, epochs.incrementAndGet())
		published.set(next)
		return next
	}

	/**
	 * Stop standing behind the current proof.
	 *
	 * Returns what was retired, or null when nothing was published. Idempotent: a
	 * second retirement reports nothing, so a caller can retire defensively from
	 * every path without producing a phantom change.
	 */
	fun retire(): PublishedInputProof<T>? = published.getAndSet(null)

	/** The current publication, or null. Safe from any thread. */
	fun current(): PublishedInputProof<T>? = published.get()

	/**
	 * True when [candidate] is exactly the current proof. Safe from any thread.
	 *
	 * Null is never current, and neither is a proof that was superseded or retired —
	 * including one that is equal in every visible field to a proof published later,
	 * which can only happen if the publisher published the same value twice, in which
	 * case it is current again by definition.
	 */
	fun isCurrent(candidate: T?): Boolean {
		val snapshot = published.get() ?: return false
		return candidate != null && candidate == snapshot.proof
	}
}
