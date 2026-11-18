package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.client.roster.NativeCatalogScope
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.isNativeCliNewSessionTarget
import io.github.rfairburn.pireviewgate.core.protocol.native.isNewSessionTarget

/**
 * One exact provider choice in the create form.
 *
 * [Pi] is the existing rowless Pi create. [Native] names one target from the
 * selected owner's COMMITTED advertised catalog by the closed backend/id pair; it is
 * never a requester-side configured target and never a label lookup. The label is
 * display context carried with the same choice so a catalog label change invalidates
 * the old selection instead of quietly retargeting it. [Native.catalogScope] is the
 * exact catalog/advertisement lifetime: it stays equal across roster-only revisions
 * and changes on any add/remove/relabel/reorder/withdrawal/reconnect.
 */
public sealed interface CreateProviderChoice {
    public data object Pi : CreateProviderChoice

    public data class Native(
        public val backend: NativeCliBackend,
        public val targetId: String,
        public val label: String,
        /** The exact catalog observation this target was advertised in. */
        public val catalogScope: NativeCatalogScope,
    ) : CreateProviderChoice
}

/**
 * Host-scoped create-provider selection.
 *
 * Options come only from the selected owner's committed catalog, and only from its
 * NEW-session targets — a backend's default target, never a named external worker
 * profile (#493). A native choice is admissible only while that exact host, run,
 * backend, id, and label are still advertised. A changed catalog, a replaced owner
 * run, or a different host invalidates a native choice; it is never silently
 * replaced by Pi. Choosing Pi is always an explicit operator choice (or the
 * fresh-form default).
 */
public object CreateProviderSelection {

    /** Every provider that owner may be addressed with right now, in display order. */
    public fun options(owner: OwnerChoice?): List<CreateProviderChoice> = buildList {
        add(CreateProviderChoice.Pi)
        val scope = owner?.nativeCatalogScope
        if (owner?.nativeCreateEligible == true && scope != null) {
            // NEW-session targets only (#493): never a named external worker profile.
            owner.nativeTargets.filter { it.isNewSessionTarget }.forEach { add(choiceOf(it, scope)) }
        }
    }

    /**
     * A stable key for the written form proof: it changes when the provider, its
     * backend/id pair, target label, or catalog scope changes, so an old receipt
     * cannot address a different provider or a replaced/revived catalog entry.
     */
    public fun key(choice: CreateProviderChoice?): List<String> = when (choice) {
        null -> listOf("none")
        CreateProviderChoice.Pi -> listOf("pi")
        is CreateProviderChoice.Native -> listOf(
            "native", choice.backend.wireName, choice.targetId, choice.label,
            choice.catalogScope.hostRunId,
            choice.catalogScope.channelGeneration.toString(),
            choice.catalogScope.epoch.toString(),
        )
    }

    /** Freeze one advertised target as this form's provider choice. */
    public fun choiceOf(
        target: NativeCliTarget,
        catalogScope: NativeCatalogScope,
    ): CreateProviderChoice.Native =
        CreateProviderChoice.Native(target.backend, target.id, target.label, catalogScope)

    /** True only when [choice] is exactly admissible for [owner] now. */
    public fun admits(owner: OwnerChoice?, choice: CreateProviderChoice?): Boolean = when (choice) {
        null -> false
        CreateProviderChoice.Pi -> owner?.createEligible == true
        is CreateProviderChoice.Native ->
            // The controller's submit gate: a named external worker profile is refused
            // even if some caller froze it as a choice (#493); nothing falls back to Pi.
            isNativeCliNewSessionTarget(choice.backend, choice.targetId) &&
                owner?.nativeCreateEligible == true &&
                owner.nativeCatalogScope == choice.catalogScope &&
                owner.nativeTargets.any { target ->
                    target.backend == choice.backend &&
                        target.id == choice.targetId &&
                        target.label == choice.label
                }
    }

    /**
     * Reconcile one open form's native choice against the owner facts held now.
     *
     * Pi is unaffected by catalog churn. A native choice survives only while the
     * same host, same owner run, and the exact same advertised catalog still hold,
     * and that pair is still admissible. Anything else returns `null` ("choose a
     * provider again"); it is never converted to [CreateProviderChoice.Pi].
     */
    public fun reconcile(
        previousOwner: OwnerChoice?,
        owner: OwnerChoice?,
        choice: CreateProviderChoice?,
    ): CreateProviderChoice? {
        if (choice !is CreateProviderChoice.Native) return choice
        if (owner == null || previousOwner == null) return null
        if (previousOwner.hostId != owner.hostId) return null
        if (previousOwner.hostRunId != owner.hostRunId) return null
        if (previousOwner.nativeCatalogScope != owner.nativeCatalogScope) return null
        if (previousOwner.nativeTargets != owner.nativeTargets) return null
        return if (admits(owner, choice)) choice else null
    }

    /**
     * One explicit owner change.
     *
     * Reselecting the SAME owner preserves the exact provider choice (including a
     * native one). Changing to another destination after a native choice invalidates
     * the provider to `null`, requiring an explicit new choice; it never restores Pi.
     * Pi remains the fresh-form default and also survives an owner change when it was
     * already the chosen Pi provider.
     */
    public fun afterOwnerChange(previous: CreateProviderChoice?): CreateProviderChoice? = when (previous) {
        is CreateProviderChoice.Native -> null
        CreateProviderChoice.Pi -> CreateProviderChoice.Pi
        null -> null
    }
}
