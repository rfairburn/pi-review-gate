package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/** Which dialog a dismiss intent refers to. Fixed kinds only. */
public enum class ClientDialogKind {
    ADD_HOST,
    EDIT_HOST_ADDRESS,
    REMOVE_HOST,
    FIRST_CONTACT_CONSENT,
    CREATE_SESSION,
    RENAME_SESSION,
    NATIVE_RENAME_SESSION,
    CLOSE_SESSION,
    SAVED_DELETE,
}

/**
 * First-contact server key consent.
 *
 * Everything identity-bearing here is the full, unshortened value the operator has
 * to compare: [serverFingerprint] and [endpointDisplayText] are shown in full and
 * the native dialog must not ellipsize them. [latchedLabel] is the label the
 * consent was latched for — the exact text that was on screen when the handshake
 * asked — so a later rename cannot change what the operator is being asked to
 * approve.
 *
 * [deadlineAtMonotonicMillis] is a controller-issued absolute deadline on the same
 * monotonic clock the controller uses. The dialog shows the remaining time and stops
 * offering Approve once it has passed; only the controller retires the consent.
 */
public data class FirstContactConsentDialog(
    public val hostId: HostId,
    public val latchedLabel: String,
    public val endpointDisplayText: String,
    public val serverFingerprint: String,
    public val deadlineAtMonotonicMillis: Long? = null,
    public val proof: UiActionProof,
)

/** Add-host form. The three fields are operator drafts, owned by the UI. */
public data class AddHostDialog(
    public val labelDraft: String = "",
    public val hostDraft: String = "",
    public val portDraft: String = "",
    public val proof: UiActionProof,
)

/** The old endpoint and label never follow catalog changes while this form is open. */
public data class EditHostAddressDialog(
    public val target: EditHostAddressTarget,
    public val label: String,
    public val addressDraft: String = target.expectedOldEndpoint.host,
    public val proof: UiActionProof,
)

/**
 * Forget one saved host association.
 *
 * [endpointDisplayText] and [label] are frozen from the row that was drawn, so the
 * confirmation names the association being forgotten. The operation is local only:
 * it never stops, signals, or otherwise touches a remote process, and the native
 * confirmation says so in fixed text.
 */
public data class RemoveHostDialog(
    public val hostId: HostId,
    public val label: String,
    public val endpointDisplayText: String,
    public val proof: UiActionProof,
)

/**
 * Create one session on one explicitly chosen owner.
 *
 * [owners] is every configured host, connected or not: the operator chooses an owner
 * by name, and a chosen disconnected owner stays chosen with its real connection
 * state shown rather than being replaced by another host. [workspaceDraft] is the
 * operator's own text, sent verbatim; this client performs no local filesystem
 * completion, validation, or path resolution of it.
 *
 * [createWorkspace] is the request-specific "Create missing workspace directory"
 * choice. A fresh form starts unchecked and nothing about it is persisted. When
 * checked it is honoured only by the destination owner; this client never creates a
 * directory itself, and a checked form addressed to an owner that does not support
 * the flag keeps the choice visible and refuses to submit rather than dropping it.
 */
public data class CreateSessionDialog(
    public val owners: List<OwnerChoice>,
    public val selectedHostId: HostId? = null,
    public val workspaceDraft: String = "",
    public val proof: UiActionProof,
    /**
     * The exact provider this form chose. [CreateProviderChoice.Pi] is the fresh-form
     * default; `null` means a previously chosen native provider is no longer
     * advertised and the operator must choose again. It is never converted back to
     * Pi on the operator's behalf.
     */
    public val provider: CreateProviderChoice? = CreateProviderChoice.Pi,
    /** Ask the chosen owner to create the missing workspace directory. Fresh forms: false. */
    public val createWorkspace: Boolean = false,
) {
    /** The explicitly chosen owner, or `null` when nothing is chosen yet. */
    public val selectedOwner: OwnerChoice?
        get() = selectedHostId?.let { id -> owners.firstOrNull { it.hostId == id } }

    /** Providers this owner may be addressed with right now, in Host -> Provider order. */
    public val providerOptions: List<CreateProviderChoice>
        get() = CreateProviderSelection.options(selectedOwner)

    /**
     * The provider the form draws as chosen: [provider], except that a Pi default the
     * selected owner cannot create is drawn as no choice (see [CreateProviderSelection.shown]).
     */
    public val shownProvider: CreateProviderChoice?
        get() = CreateProviderSelection.shown(selectedOwner, provider)

    /**
     * True when the create-workspace checkbox is drawn: the selected owner supports
     * the flag, or the form already holds a checked choice that must stay visible and
     * clearable (for example after switching to an owner that does not support it).
     */
    public val showsCreateWorkspace: Boolean
        get() = createWorkspace || selectedOwner?.createWorkspaceEligible == true

    /**
     * True when the checked choice cannot be honoured by the selected owner. Submit is
     * refused until the operator unchecks it or chooses a supporting owner; the choice
     * is never cleared on the operator's behalf and never sent to that owner.
     */
    public val createWorkspaceBlocked: Boolean
        get() = createWorkspace && selectedOwner?.createWorkspaceEligible != true
}

/** Rename one row, fenced to the native conversation tuple frozen in [target]. */
public data class RenameSessionDialog(
    public val target: RenameTarget,
    public val nameDraft: String = "",
    public val proof: UiActionProof,
)

/**
 * Caption one native CLI row.
 *
 * This is the native HOST ROW NAME form, not the Pi conversation rename: the
 * target carries no conversation tuple, the backend is the one the owner reported,
 * and the replacement caption is never sent to the provider or typed into its
 * child. It is gated by the SEPARATE native-name capability.
 */
public data class NativeRenameSessionDialog(
    public val target: NativeRenameTarget,
    public val nameDraft: String = "",
    public val proof: UiActionProof,
)

/**
 * Close one row.
 *
 * The dialog is armed by a deliberate Close request on the exact drawn row. It never
 * claims that a close already accepted by the owner can be cancelled from here, and
 * it never retries an unknown outcome.
 *
 * [connectionGeneration] is the connection attempt that opened this form. Both the
 * first and second stage must still be on that exact attempt before submitting; a
 * disconnect or reconnect permanently retires the form's authority rather than
 * letting old consent ride a new channel.
 *
 * [confirmationRequestId] is set only after the owner actually answered
 * `confirmation-required` for this exact form's request. It marks the explicit second
 * in-app confirmation stage: the UI must show a distinct confirmation control, and
 * only another deliberate tap may submit `confirmed = true`. It is never optimistically
 * armed by the client.
 */
public data class CloseSessionDialog(
    public val target: SessionActionTarget,
    public val proof: UiActionProof,
    public val connectionGeneration: Long? = null,
    public val confirmationRequestId: String? = null,
)

/** Delete one Saved entry, after the owner's prepare asked for confirmation. */
public data class SavedDeleteDialog(
    public val target: SavedEntryTarget,
    public val proof: UiActionProof,
)

/** The dialogs a screen can currently be showing, at most one of each kind. */
public data class ClientDialogs(
    public val addHost: AddHostDialog? = null,
    public val editHostAddress: EditHostAddressDialog? = null,
    public val removeHost: RemoveHostDialog? = null,
    public val firstContactConsent: FirstContactConsentDialog? = null,
    public val createSession: CreateSessionDialog? = null,
    public val renameSession: RenameSessionDialog? = null,
    public val nativeRenameSession: NativeRenameSessionDialog? = null,
    public val closeSession: CloseSessionDialog? = null,
    public val savedDelete: SavedDeleteDialog? = null,
) {
    /** True when any modal dialog covers the screen. */
    public val hasModal: Boolean
        get() = addHost != null || editHostAddress != null || removeHost != null || firstContactConsent != null ||
            createSession != null || renameSession != null || nativeRenameSession != null ||
            closeSession != null || savedDelete != null

    /**
     * The open dialogs in the order their layers are composed, bottom first.
     *
     * Only a dialog that appears later in this list covers an earlier one. A dialog
     * is itself the modal over the terminal, so it never covers itself: that is what
     * keeps an open dialog able to commit and act while the terminal underneath is
     * suspended.
     */
    public val openKinds: List<ClientDialogKind>
        get() = buildList {
            if (addHost != null) add(ClientDialogKind.ADD_HOST)
            if (editHostAddress != null) add(ClientDialogKind.EDIT_HOST_ADDRESS)
            if (removeHost != null) add(ClientDialogKind.REMOVE_HOST)
            if (firstContactConsent != null) add(ClientDialogKind.FIRST_CONTACT_CONSENT)
            if (createSession != null) add(ClientDialogKind.CREATE_SESSION)
            if (renameSession != null) add(ClientDialogKind.RENAME_SESSION)
            if (nativeRenameSession != null) add(ClientDialogKind.NATIVE_RENAME_SESSION)
            if (closeSession != null) add(ClientDialogKind.CLOSE_SESSION)
            if (savedDelete != null) add(ClientDialogKind.SAVED_DELETE)
        }

    /**
     * True when another open dialog is composed above this one.
     *
     * A dialog is never covered by the terminal underneath it — that is what lets an
     * open dialog commit and act while terminal input is suspended.
     */
    public fun isCovered(kind: ClientDialogKind): Boolean {
        val kinds = openKinds
        val index = kinds.indexOf(kind)
        return index >= 0 && index < kinds.lastIndex
    }

    /** Drop one dialog kind; everything else is untouched. */
    public fun dismissing(kind: ClientDialogKind): ClientDialogs = when (kind) {
        ClientDialogKind.ADD_HOST -> copy(addHost = null)
        ClientDialogKind.EDIT_HOST_ADDRESS -> copy(editHostAddress = null)
        ClientDialogKind.REMOVE_HOST -> copy(removeHost = null)
        ClientDialogKind.FIRST_CONTACT_CONSENT -> copy(firstContactConsent = null)
        ClientDialogKind.CREATE_SESSION -> copy(createSession = null)
        ClientDialogKind.RENAME_SESSION -> copy(renameSession = null)
        ClientDialogKind.NATIVE_RENAME_SESSION -> copy(nativeRenameSession = null)
        ClientDialogKind.CLOSE_SESSION -> copy(closeSession = null)
        ClientDialogKind.SAVED_DELETE -> copy(savedDelete = null)
    }

    public companion object {
        /** No dialog is open. */
        public val NONE: ClientDialogs = ClientDialogs()
    }
}
