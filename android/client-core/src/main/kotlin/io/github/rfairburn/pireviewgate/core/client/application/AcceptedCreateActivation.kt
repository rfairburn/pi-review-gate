package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEvent
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOperationKind
import io.github.rfairburn.pireviewgate.core.client.roster.RosterOwnerOutcome
import io.github.rfairburn.pireviewgate.core.client.roster.RosterPendingOperation
import io.github.rfairburn.pireviewgate.core.client.roster.RosterRequestResult
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget
import io.github.rfairburn.pireviewgate.core.client.ui.ClientRoute
import io.github.rfairburn.pireviewgate.core.client.ui.CreateSessionDialog
import io.github.rfairburn.pireviewgate.core.client.ui.UiActionProof
import io.github.rfairburn.pireviewgate.core.client.ui.UiProofScreen
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One deliberately submitted rowless create whose owner later names the row it
 * actually started.
 *
 * The create form is rowless, so this is not a row-selection proof and it is not a
 * retry, a row factory, or a second navigation store. It is the missing provenance
 * between an actual committed Create form and the owner's own `started` answer: the
 * form proof and frozen click are captured at the synchronous submit boundary, and
 * only the exact accepted request in the exact owner run may [started] it.
 *
 * The owner's `started` answer is never user consent by itself. [started] requires
 * the exact accepted request and the exact submitted form; [mayActivate] and [claim]
 * additionally require that form's committed receipt to have been still current at
 * `started`, and permit exactly one activation of the exact returned row after the
 * controller has observed that row in a CURRENT roster. A separate one-way focus
 * lifetime is not retired by the form's normal closure but is permanently retired by
 * a later focus or pause loss. No row is fabricated here, and cancellation is
 * permanent so a later metadata refresh cannot revive it.
 */
class AcceptedCreateActivation private constructor(
    val hostId: HostId,
    val connectionGeneration: Long,
    val hostRunId: String,
    val workspace: String,
    val formProof: UiActionProof,
    val originRoute: ClientRoute,
    private val click: FrozenAction,
) {
    private val live = AtomicBoolean(true)
    private var accepted: RosterPendingOperation? = null
    private var returned: StartedRow? = null
    private val claimed = AtomicBoolean(false)
    private val superseded = AtomicBoolean(false)
    private val focusLifetime = AtomicBoolean(true)
    @Volatile private var activationAuthorized = false

    /** The exact owner-returned row, after an actual correlated `started` answer. */
    data class StartedRow(val hostRunId: String, val rowId: String)

    /** The accepted returned row while this activation is still live and unclaimed. */
    val returnedRow: StartedRow?
        get() = returned?.takeIf { mayActivate }

    /** True only when the exact submitted form receipt was still current at `started`. */
    val mayActivate: Boolean
        get() = live.get() && !claimed.get() && !superseded.get() && focusLifetime.get() && activationAuthorized

    fun cancel() {
        live.set(false)
    }

    /**
     * A newer explicit user action retires delayed navigation but not the fact that
     * the owner may still name the row. The exact submitted form may still close, which
     * prevents a duplicate create; [mayActivate] stays false forever.
     */
    fun supersede() {
        superseded.set(true)
    }

    /**
     * Record a focus or pause loss after this continuation exists. The form's normal
     * closure must not call this; a later resume can never revive the activation.
     */
    fun focusLost() {
        focusLifetime.set(false)
    }

    /**
     * Accept only the exact pending-create metadata returned by this side's admitting
     * step. Later endpoint state is not evidence about this request.
     */
    fun admitted(pending: RosterPendingOperation?) {
        if (!live.get() || accepted != null || pending == null || pending.kind != RosterOperationKind.CREATE ||
            pending.requestId.isBlank() || pending.hostRunId != hostRunId || pending.sequence == null ||
            pending.rowId != null) {
            if (live.get()) cancel()
            return
        }
        accepted = pending
    }

    /**
     * Record the actual owner `started` answer for this exact accepted request.
     *
     * Returns the returned run/row only when the form receipt is the same submitted
     * form and its semantic owner/workspace are unchanged. The controller may then
     * close that exact form. Any other outcome or correlation cancels permanently; no
     * other result opens the form or mints a target. Whether navigation is authorized
     * is kept separate in [mayActivate], so a retired receipt is never recaptured.
     */
    fun started(event: RosterClientEvent.OperationSettled, form: CreateSessionDialog?): StartedRow? {
        if (!live.get() || returned != null || claimed.get()) return null
        val pending = accepted ?: run { cancel(); return null }
        if (event.kind != RosterOperationKind.CREATE || event.requestId != pending.requestId ||
            event.hostRunId != hostRunId || form == null || form.proof !== formProof ||
            form.selectedHostId != hostId || form.workspaceDraft != workspace ||
            click.target != formProof.target) {
            cancel()
            return null
        }
        val facts = ((event.result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.Create)?.facts
        if (facts !is OwnerCreateFacts.Started || facts.hostRunId != hostRunId || facts.rowId.isBlank()) {
            cancel()
            return null
        }
        val row = StartedRow(facts.hostRunId, facts.rowId)
        returned = row
        // The form is still the exact submitted form, so the controller may close it.
        // Navigation additionally needs the committed receipt to still be current at
        // this settlement; a retired proof is never recaptured or treated as consent.
        activationAuthorized = click.isStillCurrent()
        return row
    }

    /** True only for the exact returned row, on the exact connection attempt. */
    fun authorizes(target: TerminalTarget, connectionGeneration: Long): Boolean {
        val row = returned ?: return false
        return mayActivate && accepted != null &&
            connectionGeneration == this.connectionGeneration &&
            target.hostId == hostId && target.ownerRunId == row.hostRunId && target.rowId == row.rowId
    }

    /** Consume the one activation this accepted create can ever authorize. */
    fun claim(target: TerminalTarget, connectionGeneration: Long): Boolean {
        if (!authorizes(target, connectionGeneration)) return false
        if (!claimed.compareAndSet(false, true)) return false
        return true
    }

    companion object {
        /**
         * Capture the committed form receipt at the synchronous submit boundary.
         *
         * The form, selected owner, workspace, and live click must all name the same
         * create. `originRoute` records where the form was opened so the controller can
         * cancel a delayed activation after any later explicit navigation; it is never
         * used to restrict Create to the session list.
         */
        fun capture(
            hostId: HostId,
            connectionGeneration: Long,
            hostRunId: String,
            workspace: String,
            form: CreateSessionDialog,
            click: FrozenAction,
            originRoute: ClientRoute,
        ): AcceptedCreateActivation? {
            val token = form.proof.target
            if (!click.isStillCurrent() || click.target != token ||
                token.screen != UiProofScreen.SESSION_CREATE || token.hostId != hostId ||
                token.hostRunId != hostRunId || token.rowId != null ||
                form.selectedHostId != hostId || form.workspaceDraft != workspace) return null
            return AcceptedCreateActivation(hostId, connectionGeneration, hostRunId, workspace,
                form.proof, originRoute, click)
        }
    }
}
