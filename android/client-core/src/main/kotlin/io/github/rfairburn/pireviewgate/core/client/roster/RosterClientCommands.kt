package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend

/** Default local patience for a Saved LIST/SEARCH first reply: sixty seconds. */
public const val DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS: Long = 60_000L

/**
 * The caller-supplied inputs to one roster client endpoint, and the per-message
 * dynamic proof each submitted effect carries.
 *
 * The endpoint owns no UI, no transport, and no storage, so it cannot observe
 * whether a form, a drawn row, or a picker is still the one the request was built
 * from. [RosterUiProof] is that observation, furnished by the committed Android UI
 * bridge. The endpoint never manufactures one from a token, a decoded frame, or its
 * own state: a request whose proof is absent is refused as never submitted, and a
 * proof that answers "no longer current" is refused rather than retargeted.
 *
 * Every proof is checked twice: once by this endpoint before the effect is emitted,
 * and again by the future transport adapter immediately before the write is invoked,
 * because a queued effect can outlive the thing it was built from.
 */

/**
 * One cheap, thread-safe, idempotent dynamic check furnished by the committed UI.
 *
 * `true` only while the exact destination, run, row, form, or picker this request
 * was built from is still the one on screen and still belongs to this request. A
 * throw is no decision at all and is treated as `false`.
 */
public fun interface RosterUiProof {
    public fun isStillCurrent(): Boolean
}

/**
 * The per-message proof attached to every outbound effect.
 *
 * The [channelGeneration] makes a stale effect recognizable after a new channel
 * attempt. Control traffic carries no row, form, or picker epoch: an unrelated
 * control message never inherits one, and a row-scoped proof is never satisfied by
 * a control-scoped one.
 */
public sealed interface RosterSendProof {
    /** The channel attempt this effect belongs to. */
    public val channelGeneration: Long

    /** Handshake, subscribe, unsubscribe, and error notices: no UI binding at all. */
    public data class Control(override val channelGeneration: Long) : RosterSendProof

    /** One row-scoped action, proven against the exact drawn row. */
    public data class RowAction(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val rowId: String,
        /** The native conversation tuple the action was authorized against, when it has one. */
        public val expectedSessionId: String? = null,
        public val expectedSessionEpoch: Long? = null,
        public val ui: RosterUiProof,
        /**
         * The fresh user receipt behind a confirmed close, carried so the adapter
         * re-checks it too. A confirmed close whose receipt lapsed while the write
         * was queued is never invoked.
         */
        public val confirmation: RosterUiProof? = null,
    ) : RosterSendProof

    /** One Pi create, proven against the exact written New form. */
    public data class Form(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val workspace: String,
        public val ui: RosterUiProof,
    ) : RosterSendProof

    /**
     * One NATIVE create, proven against the exact written New form, the exact
     * owner-advertised backend/target id pair that form chose, and the exact catalog
     * observation lifetime it chose from. It is deliberately a distinct proof: a Pi
     * create proof can never satisfy a native request, and a native proof carries no
     * arbitrary command or requester-side target.
     */
    public data class NativeForm(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val workspace: String,
        public val backend: NativeCliBackend,
        public val targetId: String,
        /** The catalog observation to which the chosen target belonged. */
        public val catalogScope: NativeCatalogScope,
        public val ui: RosterUiProof,
    ) : RosterSendProof

    /**
     * One native HOST ROW NAME, proven against the exact drawn row AND the backend
     * this side observed on it. No Pi conversation tuple is expressible here.
     */
    public data class NativeRowAction(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val rowId: String,
        public val backend: NativeCliBackend,
        public val ui: RosterUiProof,
    ) : RosterSendProof

    /** One Saved read intent, proven against the exact live picker and its query revision. */
    public data class PickerRead(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val catalogId: String? = null,
        public val resultId: String? = null,
        public val queryRevision: Long,
        public val ui: RosterUiProof,
    ) : RosterSendProof

    /** One Saved resume or delete, proven against the exact frozen picker entry. */
    public data class PickerEntry(
        override val channelGeneration: Long,
        public val hostRunId: String,
        public val catalogId: String,
        public val resultId: String,
        public val entryId: String,
        public val pickerRevision: Long,
        public val ui: RosterUiProof,
        /** The fresh written confirmation behind a confirmed delete, carried for re-check. */
        public val confirmation: RosterUiProof? = null,
    ) : RosterSendProof
}

/** Ask this owner to close exactly one row of one run. */
public data class RosterCloseCommand(
    public val hostRunId: String,
    public val rowId: String,
    /**
     * True only for a deliberate confirmation of a busy or unknown row. It
     * authorizes the owner's existing bounded stop ladder and nothing more.
     */
    public val confirmed: Boolean,
    /** Drawn-row proof. Absent means this endpoint refuses the request as never submitted. */
    public val proof: RosterSendProof.RowAction? = null,
    /**
     * Fresh, specific user receipt required for a confirmed close. It must name
     * this exact run and row and must still hold at submission; it is never reused
     * implicitly and a confirmed close without one is never submitted.
     */
    public val confirmation: RosterUiProof? = null,
)

/** Ask this owner to create one blank child in one run. Rowless: no row, selection, or tuple. */
public data class RosterCreateCommand(
    public val hostRunId: String,
    /** Canonical workspace text exactly as the form held it. Never trimmed, resolved, or rewritten. */
    public val workspace: String,
    public val proof: RosterSendProof.Form? = null,
)

/**
 * Ask this owner to create one native CLI child in one run.
 *
 * Rowless like the Pi create, and additionally names the exact owner-advertised
 * backend/target pair the operator selected. No arbitrary command, model, auth,
 * permission, executable, environment, or requester-side target is expressible.
 */
public data class RosterNativeCreateCommand(
    public val hostRunId: String,
    /** Canonical workspace text exactly as the form held it. Never trimmed or resolved. */
    public val workspace: String,
    public val backend: NativeCliBackend,
    /** Exact owner-advertised target id; the owner matches it with [backend]. */
    public val targetId: String,
    public val proof: RosterSendProof.NativeForm? = null,
)

/** Ask this owner to rename exactly one row, fenced to that row's native conversation tuple. */
public data class RosterRenameCommand(
    public val hostRunId: String,
    public val rowId: String,
    public val expectedSessionId: String,
    public val expectedSessionEpoch: Long,
    /** Exact requested name, forwarded verbatim. */
    public val name: String,
    public val proof: RosterSendProof.RowAction? = null,
)

/**
 * Ask this owner to caption exactly one of its native rows.
 *
 * The request names the exact run, row, and backend this side observed. It carries
 * NO Pi conversation tuple and never falls back to a Pi conversation rename.
 */
public data class RosterNativeRenameCommand(
    public val hostRunId: String,
    public val rowId: String,
    /** Native backend last observed on that row; a fence, never a guess. */
    public val backend: NativeCliBackend,
    /** Exact replacement caption, forwarded verbatim. */
    public val name: String,
    public val proof: RosterSendProof.NativeRowAction? = null,
)

/** Fresh Saved catalog listing. */
public data class RosterSavedListCommand(
    public val hostRunId: String,
    /** Exact query text; empty means unfiltered. Never trimmed or normalized. */
    public val query: String,
    public val offset: Long,
    public val count: Long,
    public val proof: RosterSendProof.PickerRead? = null,
    /** Optional accepted post-delete continuation lifetime, also checked during transfer. */
    public val resultLifetime: RosterUiProof? = null,
    /**
     * Local-only first-reply patience. This never appears on the wire: it is the
     * deadline this side gives the owner's first answer before reporting unknown.
     */
    public val firstReplyTimeoutMs: Long = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS,
)

/** Search within one exact owner catalog. */
public data class RosterSavedSearchCommand(
    public val hostRunId: String,
    public val catalogId: String,
    public val query: String,
    public val offset: Long,
    public val count: Long,
    public val proof: RosterSendProof.PickerRead? = null,
    /** Local-only first-reply patience; never encoded into the owner request. */
    public val firstReplyTimeoutMs: Long = DEFAULT_SAVED_FIRST_REPLY_TIMEOUT_MS,
)

/** Another bounded window of one exact owner result. Never relists and never remints ids. */
public data class RosterSavedWindowCommand(
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val offset: Long,
    public val count: Long,
    public val proof: RosterSendProof.PickerRead? = null,
)

/** Resume one entry of one exact owner result through the owner's native path. */
public data class RosterSavedResumeCommand(
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val entryId: String,
    public val proof: RosterSendProof.PickerEntry? = null,
)

/** Prepare (`confirmed = false`) or delete (`confirmed = true`) one exact Saved entry. */
public data class RosterSavedDeleteCommand(
    public val hostRunId: String,
    public val catalogId: String,
    public val resultId: String,
    public val entryId: String,
    public val proof: RosterSendProof.PickerEntry? = null,
)
