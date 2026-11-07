package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkRequestToken
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationIdentity
import io.github.rfairburn.pireviewgate.core.presentation.RemotePresentationMovePosition

/**
 * One text draft the UI owns and reports upward.
 *
 * Drafts are the only text the UI is authoritative about. Nothing here is an owner
 * fact: a workspace string is never completed or resolved locally, and a rename
 * draft changes no row until the owner confirms it.
 */
public sealed interface ClientDraft {
    /** Add-host form drafts. */
    public data class HostForm(
        public val label: String,
        public val host: String,
        public val port: String,
    ) : ClientDraft

    /** Address-only draft for the exact dialog target; never edits a port or identity. */
    public data class HostAddressForm(
        public val target: EditHostAddressTarget,
        public val value: String,
        public val proof: UiActionProof,
    ) : ClientDraft

    /** Create-session workspace draft, sent verbatim when submitted. */
    public data class Workspace(public val value: String) : ClientDraft

    /** Rename draft for one frozen target. */
    public data class Rename(public val target: RenameTarget, public val value: String) : ClientDraft

    /** Saved search draft. Typing changes nothing until it is submitted. */
    public data class SavedSearch(public val value: String) : ClientDraft
}

/**
 * Everything a native control can ask the future controller to do.
 *
 * The contract is one-directional and non-authoritative: an intent is a request
 * carrying the exact frozen target the drawn control addressed. It never asserts
 * that anything happened, never carries an owner fact the UI invented, and never
 * implies a retry. Destructive and submitting intents additionally carry the
 * [UiActionProof] of the control that produced them, so the controller can refuse
 * an intent whose control is no longer current, whose frame was never committed, or
 * whose critical identity text was not readable.
 *
 * A controller receiving one of these still has to revalidate the owner facts behind
 * the target with its own authority before acting.
 */
public sealed interface ClientIntent {

    // ---- navigation -------------------------------------------------------

    /** Show one of the three top-level destinations. */
    public data class ShowDestination(public val destination: NavigationDestination) : ClientIntent

    /** Open the fullscreen terminal for one frozen row target. */
    public data class EnterTerminal(
        public val target: SessionActionTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Switch the fullscreen terminal to another host's or session's target. */
    public data class SwitchTerminalTarget(
        public val target: SessionActionTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /**
     * Leave the terminal.
     *
     * This detaches this view only. It never closes, stops, or signals the owner's
     * session, and it never implies that the owner noticed.
     */
    public data object LeaveTerminal : ClientIntent

    /** Open the cross-host quick switcher sheet. */
    public data object ShowQuickSwitcher : ClientIntent

    /** Retire the quick switcher sheet without selecting anything. */
    public data object DismissQuickSwitcher : ClientIntent

    /**
     * Report what the UI is actually drawing over the terminal.
     *
     * Any suspending coverage must retire in-flight terminal proofs and stop
     * terminal input until the covering control is gone.
     */
    public data class UiCoverageChanged(public val coverage: UiCoverage) : ClientIntent

    /** Report a text draft the UI owns. */
    public data class UpdateDraft(public val draft: ClientDraft) : ClientIntent

    /** Dismiss one open dialog without acting on it. */
    public data class DismissDialog(public val kind: ClientDialogKind) : ClientIntent

    // ---- hosts ------------------------------------------------------------

    /**
     * Connect one saved host.
     *
     * [requestToken] is the caller-issued explicit-intent token the local-network
     * permission flow is bound to, or `null` when the caller knows the platform
     * permission is not required. Presenting this intent is a user action; the UI
     * never prompts on composition or resume, and public-internet traffic is never
     * blocked on the permission.
     */
    public data class ConnectHost(
        public val hostId: HostId,
        public val requestToken: LocalNetworkRequestToken? = null,
    ) : ClientIntent

    /** Explicit Disconnect for one saved host. Local intent only. */
    public data class DisconnectHost(public val hostId: HostId) : ClientIntent

    /**
     * Arm the forget confirmation for one drawn host row.
     *
     * The controller answers by putting a [RemoveHostDialog] carrying a live proof
     * into [ClientUiState.dialogs]; the confirmation itself is a second, separately
     * committed control.
     */
    public data class RequestRemoveHost(public val target: RemoveHostTarget) : ClientIntent

    /** Open an address-only form for the saved endpoint actually drawn. */
    public data class RequestEditHostAddress(public val target: EditHostAddressTarget) : ClientIntent

    /** One committed combined gesture: save this draft, then explicitly Connect this new target. */
    public data class SaveHostAddressAndReconnect(
        public val target: EditHostAddressTarget,
        public val address: String,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Forget one saved association. Never stops or touches anything remote. */
    public data class RemoveHost(
        public val target: RemoveHostTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Save one new host from the form. */
    public data class SubmitNewHost(
        public val label: String,
        public val host: String,
        public val port: String,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Arm the add-host form. */
    public data object RequestAddHost : ClientIntent

    /**
     * Ask the platform for local-network permission again, for one explicit host.
     *
     * Emitted only from the operator's own tap on a denial panel. The UI never
     * requests permission on composition or resume.
     */
    public data class RequestLocalNetworkPermissionRetry(public val hostId: HostId) : ClientIntent

    /** Open the system settings screen for this app, from the denial panel. */
    public data class OpenLocalNetworkPermissionSettings(public val hostId: HostId) : ClientIntent

    // ---- first-contact server key consent ---------------------------------

    /** Approve the exact key the consent dialog is showing. */
    public data class ApproveFirstContactServerKey(
        public val target: FirstContactConsentTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Decline the exact key the consent dialog is showing. */
    public data class DeclineFirstContactServerKey(
        public val target: FirstContactConsentTarget,
    ) : ClientIntent

    // ---- sessions ---------------------------------------------------------

    /** Arm the close confirmation for one drawn row. Removes nothing. */
    public data class RequestSessionClose(public val target: SessionActionTarget) : ClientIntent

    /** Deliberate close confirmation for the target the dialog is showing. */
    public data class ConfirmSessionClose(
        public val target: SessionActionTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Arm the create form. */
    public data object RequestSessionCreate : ClientIntent

    /** Choose the owner the create form is addressed to. */
    public data class SelectCreateOwner(public val hostId: HostId) : ClientIntent

    /** Create one session on one explicitly chosen owner, workspace verbatim. */
    public data class SubmitSessionCreate(
        public val hostId: HostId,
        public val workspace: String,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Arm the rename form for one row that reports a native conversation. */
    public data class RequestSessionRename(public val target: RenameTarget) : ClientIntent

    /**
     * Move one row's presentation identity relative to another.
     *
     * Reordering is addressed by the owner-qualified presentation identities only —
     * never by a label, a list index, or a row id alone — and it changes nothing
     * about the rows themselves. The controller applies it through the existing
     * presentation-order owner and the next snapshot it renders reflects it.
     */
    public data class MoveSessionRow(
        public val identity: RemotePresentationIdentity,
        public val position: RemotePresentationMovePosition,
        public val relativeTo: RemotePresentationIdentity,
    ) : ClientIntent

    /** Submit a rename fenced to the frozen native tuple. */
    public data class SubmitSessionRename(
        public val target: RenameTarget,
        public val name: String,
        public val proof: UiActionProof,
    ) : ClientIntent

    // ---- Saved ------------------------------------------------------------

    /** Open one owner's Saved browser. */
    public data class ShowSaved(public val hostId: HostId) : ClientIntent

    /** Choose the owner a Saved request is addressed to. */
    public data class SelectSavedOwner(public val hostId: HostId) : ClientIntent

    /**
     * Ask the addressed owner run for a fresh Saved listing.
     *
     * [target] is frozen from the drawn screen, so changing the selection before this
     * intent is handled cannot retarget it at another owner run.
     */
    public data class RequestSavedList(
        public val target: SavedOwnerTarget,
        public val query: String,
        public val proof: UiActionProof,
    ) : ClientIntent

    /**
     * Ask for another bounded window of one exact owner result. Never relists.
     *
     * [target] carries every handle the drawn window belonged to, including the
     * request id and sequence the owner answered. A result that was replaced in the
     * meantime is refused rather than silently followed.
     */
    public data class RequestSavedWindow(
        public val target: SavedResultTarget,
        public val offset: Long,
        public val count: Long,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Resume one entry by its owner handle. */
    public data class ResumeSavedEntry(
        public val target: SavedEntryTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Ask the owner whether a delete of one entry would need confirmation. */
    public data class PrepareSavedDelete(
        public val target: SavedEntryTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    /** Deliberate delete confirmation for one frozen entry. */
    public data class ConfirmSavedDelete(
        public val target: SavedEntryTarget,
        public val proof: UiActionProof,
    ) : ClientIntent

    // ---- settings ---------------------------------------------------------

    /** Change the remembered automatic-reconnect preference. */
    public data class SetAutoReconnectEnabled(public val enabled: Boolean) : ClientIntent

    /** Change this viewer's remote native input/copy preference. */
    public data class SetViewerRemoteInputEnabled(public val enabled: Boolean) : ClientIntent

    /**
     * Save the remembered Saved LIST/SEARCH first-reply timeout.
     *
     * The value is already parsed from whole seconds by the drawn form; the
     * controller validates it again before any durable write. Typing in the field
     * is a local draft only and never emits this intent.
     */
    public data class SetSavedFirstReplyTimeoutSeconds(public val seconds: Int) : ClientIntent

    // ---- terminal transient affordances -----------------------------------

    /** Show or hide the soft keyboard. */
    public data class SetTerminalKeyboardVisible(public val visible: Boolean) : ClientIntent

    /**
     * Show or hide the optional extra-keys row.
     *
     * Showing it resizes the terminal viewport; the controller reports the viewport
     * ready again only after a fresh commit receipt, and the toolbar keeps key
     * buttons closed until then. It is a layout resize, never an overlay that
     * bypasses one.
     */
    public data class SetTerminalExtraKeysVisible(public val visible: Boolean) : ClientIntent

    /** Toggle one sticky toolbar modifier. Cleared across targets and coverage. */
    public data class ToggleTerminalModifier(public val modifier: TerminalModifier) : ClientIntent
}

/** Stable association plus the exact old locator, frozen from the drawn host row. */
public data class EditHostAddressTarget(
    public val hostId: HostId,
    public val expectedOldEndpoint: Endpoint,
)

/**
 * One frozen host-removal target.
 *
 * [label] and [endpointDisplayText] are what the drawn row said, so the
 * confirmation cannot be retargeted at another association by a later catalog edit.
 */
public data class RemoveHostTarget(
    public val hostId: HostId,
    public val label: String,
    public val endpointDisplayText: String,
)

/**
 * One frozen first-contact consent target.
 *
 * [serverFingerprint] and [endpointDisplayText] are the full values the operator
 * compared, carried so the controller can refuse an approval whose live consent no
 * longer shows the same identity.
 */
public data class FirstContactConsentTarget(
    public val hostId: HostId,
    public val latchedLabel: String,
    public val endpointDisplayText: String,
    public val serverFingerprint: String,
)
