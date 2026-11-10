package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.grantsAction
import java.util.concurrent.atomic.AtomicReference

/** Capture at the synchronous click boundary, never inside a launched coroutine. */
class FrozenAction private constructor(private val proof: UiActionProof, private val epoch: Long) : RosterUiProof {
    val target = proof.target
    override fun isStillCurrent(): Boolean = proof.target == target && proof.epoch == epoch && proof.grantsAction() && proof.epoch == epoch

    companion object {
        fun capture(proof: UiActionProof): FrozenAction? {
            val epoch = proof.epoch
            return FrozenAction(proof, epoch).takeIf { it.isStillCurrent() }
        }
    }
}

/** Navigation admission is NOT an owner-operation or renderer/input proof. */
class AcceptedNavigation {
    data class Wanted(val epoch: Long, val target: TerminalTarget, val connectionGeneration: Long)
    private val current = AtomicReference<Wanted?>()
    private var nextEpoch = 0L

    /** Called only while handling the positively committed click, before route disposal. */
    @Synchronized
    fun accept(target: TerminalTarget, connectionGeneration: Long, click: FrozenAction): Wanted? {
        if (!click.isStillCurrent() || click.target.hostId != target.hostId ||
            click.target.hostRunId != target.ownerRunId || click.target.rowId != target.rowId) return null
        return Wanted(++nextEpoch, target, connectionGeneration).also { current.set(it) }
    }

    /**
     * Admit the one target an accepted create's owner actually returned.
     *
     * This is deliberately not another click-proof entry point: [created] is the
     * preserved committed form receipt and accepted operation provenance, and its own
     * [AcceptedCreateActivation.claim] admits exactly one exact run/row on the exact
     * connection attempt. The caller has already observed that row in a CURRENT
     * roster; navigation measurement remains the existing flow's responsibility.
     */
    @Synchronized
    fun acceptReturnedRow(target: TerminalTarget, connectionGeneration: Long,
                          created: AcceptedCreateActivation): Wanted? {
        if (!created.claim(target, connectionGeneration)) return null
        return Wanted(++nextEpoch, target, connectionGeneration).also { current.set(it) }
    }

    fun wanted(): Wanted? = current.get()
    fun cancel() { current.set(null) }
    fun isCurrent(wanted: Wanted): Boolean = current.get() === wanted
}
