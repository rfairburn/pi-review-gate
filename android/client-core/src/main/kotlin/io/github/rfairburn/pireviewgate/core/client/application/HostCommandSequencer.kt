package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean

/** Registry command order is reserved synchronously at intake, not by IO scheduling. */
class HostCommandSequencer {
    private val tails = mutableMapOf<HostId, CompletableDeferred<Unit>>()

    @Synchronized
    fun enqueue(host: HostId): Ticket {
        val completion = CompletableDeferred<Unit>()
        val previous = tails.put(host, completion)
        return Ticket(host, previous, completion)
    }

    sealed interface Dispatch<out T> {
        data class Executed<T>(val value: T) : Dispatch<T>
        data object Retired : Dispatch<Nothing>
    }

    inner class Ticket internal constructor(
        private val host: HostId,
        private val previous: CompletableDeferred<Unit>?,
        private val completion: CompletableDeferred<Unit>,
    ) {
        private val spent = AtomicBoolean()

        /** The caller uses IO. The boundary covers BOTH authority check and registry call. */
        suspend fun <T> dispatch(proof: RosterUiProof, command: suspend () -> T): Dispatch<T> {
            check(spent.compareAndSet(false, true)) { "host command ticket was already spent" }
            try {
                previous?.await()
                return if (proof.isStillCurrent()) Dispatch.Executed(command()) else Dispatch.Retired
            } finally {
                // Cancellation while waiting must not let a successor overtake the still
                // executing predecessor. No cancelled command is dispatched or replayed.
                withContext(NonCancellable) {
                    previous?.await()
                    completion.complete(Unit)
                    synchronized(this@HostCommandSequencer) {
                        if (tails[host] === completion) tails.remove(host)
                    }
                }
            }
        }
    }
}
