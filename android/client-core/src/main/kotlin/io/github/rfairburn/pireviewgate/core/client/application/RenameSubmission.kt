package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterRenameCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSendProof
import io.github.rfairburn.pireviewgate.core.client.ui.ClientDialogs
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.RenameSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * One deliberate Rename, from the committed click to the settlement that may close it.
 *
 * This is the whole production rename submission: it re-admits the drawn form against the
 * owner facts held at the moment of the click, captures the committed click receipt, and
 * builds the one command the caller hands to the runtime unchanged. Nothing here queues,
 * retries, replays, or renames anything locally; the owner's answer stays the only fact
 * that can close the form, and the endpoint still re-checks the native tuple and this same
 * receipt at the last instant before the transport is entered.
 *
 * The receipt is captured synchronously, at the click boundary, and is genuinely
 * load-bearing: a proof that was never committed, or that is invalidated while the write
 * is still queued, makes the request unsubmittable or undispatchable rather than merely
 * unreported.
 */
class RenameSubmission private constructor(
    /** The host this rename was addressed to. */
    val host: HostId,
    /** The connection attempt the caller's send proof belongs to. */
    val generation: Long,
    /** The exact command to hand to the runtime, once. */
    val command: RosterRenameCommand,
    /** The drawn form's own proof object, kept for the correlated settlement. */
    val proof: UiActionProof,
    private val form: RenameSessionDialog,
) {

    /**
     * Apply one settled rename to the dialog state.
     *
     * Only this submission's own form closes, and only on the owner's positive `renamed`.
     * The returned state is the same object for every other outcome — a replacement form,
     * another host or owner run, a refusal, a busy or stale-session answer, an
     * unobservable outcome, or a never-sent request.
     */
    fun closeIfConfirmed(current: ClientDialogs, eventHostRunId: String, result: RosterRequestResult): ClientDialogs {
        // The controller's refresh copies the pending form on every renewDialogProofs(),
        // retaining its proof while the operation is busy, so identity of the captured
        // instance is not this form's marker. Replacement is still refused: the fence
        // below demands the identical submitted proof object.
        if (current.renameSession != form) return current
        if (!RenameResultFence.closesOn(current.renameSession, proof, host, eventHostRunId, result)) return current
        return current.copy(renameSession = null)
    }

    companion object {
        /**
         * Begin the one rename the drawn form asks for, or `null` when its own facts no
         * longer admit it: a different proof object, an inadmissible row, or a click
         * receipt that is not currently committed and readable.
         */
        fun begin(
            host: HostUiState?,
            generation: Long,
            form: RenameSessionDialog,
            proof: UiActionProof,
        ): RenameSubmission? {
            if (form.proof !== proof) return null
            val target = form.target
            val row = RenameRowFence.row(host, target) ?: return null
            val frozen = FrozenAction.capture(proof) ?: return null
            val command = RosterRenameCommand(
                hostRunId = target.base.hostRunId,
                rowId = target.base.rowId,
                expectedSessionId = target.expectedSessionId,
                expectedSessionEpoch = target.expectedSessionEpoch,
                // Exactly the name the form holds, forwarded verbatim.
                name = form.nameDraft,
                proof = RosterSendProof.RowAction(
                    channelGeneration = generation,
                    hostRunId = target.base.hostRunId,
                    rowId = target.base.rowId,
                    expectedSessionId = target.expectedSessionId,
                    expectedSessionEpoch = target.expectedSessionEpoch,
                    ui = frozen,
                ),
            )
            return RenameSubmission(target.base.hostId, generation, command, proof, form)
        }
    }
}
