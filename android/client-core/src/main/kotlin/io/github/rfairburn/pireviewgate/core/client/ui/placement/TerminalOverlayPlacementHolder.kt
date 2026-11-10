package io.github.rfairburn.pireviewgate.core.client.ui.placement

import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** What the terminal overlay layer currently draws and what it must warn about. */
public data class TerminalOverlayPlacementUiState(
    public val placement: TerminalOverlayPlacement = TerminalOverlayPlacement.DEFAULT,
    public val warning: TerminalOverlayPlacementWarning? = null,
    /** True only after the initial load completed with saved positions or warned defaults. */
    public val ready: Boolean = false,
)

/**
 * Application-scoped owner of the cosmetic terminal overlay placement.
 *
 * The holder opens the private placement document on an IO dispatcher, publishes one
 * immutable [uiState], and accepts completed-drag snapshots from the UI thread without
 * blocking it. A new snapshot replaces the in-memory placement immediately so the
 * current frame is stable; only a completed drag is ever submitted.
 *
 * One IO coroutine owns the store and all publications. Commands pass through a
 * conflated channel: writes never interleave, and the last complete six-slot state
 * wins. [uiState] reports an explicit completed-load state: the terminal overlay
 * layer does not compose and drag-end commits are ignored until the load has
 * published either saved positions or warned defaults. A load failure uses default
 * positions, reports a warning, and does not block the client graph; a later
 * completed drag can normally replace the malformed UI-only document. A genuine
 * write refusal warns rather than claiming persistence, and the failed handle is
 * discarded so a later drag can try a fresh normal handle.
 *
 * [commit] is the Main-thread drag-end command and is ignored until the completed
 * load publishes ready state. [start] and [commit] are idempotent with respect to
 * closing.
 */
public class TerminalOverlayPlacementHolder(
    private val openStore: () -> TerminalOverlayPlacementStore,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : AutoCloseable {
    private data class Command(
        val sequence: Long,
        val placement: TerminalOverlayPlacement,
    )

    private val stateLock = Any()
    private val state = MutableStateFlow(TerminalOverlayPlacementUiState())
    private val commands = Channel<Command>(Channel.CONFLATED)
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val started = AtomicBoolean(false)
    private var sequence = 0L
    private var closed = false

    /** Store handles are touched only by the single IO writer, except for close. */
    @Volatile
    private var store: TerminalOverlayPlacementStore? = null

    /** The immutable placement state the terminal screen renders. */
    public val uiState: StateFlow<TerminalOverlayPlacementUiState> = state.asStateFlow()

    /** Begin the IO load and the single writer. Safe to call once; later calls do nothing. */
    public fun start() {
        if (!started.compareAndSet(false, true)) return
        if (isClosed()) return
        scope.launch {
            load()
            for (command in commands) write(command)
        }
    }

    /**
     * Submit one completed drag's complete six-slot state.
     *
     * This is called on Main at the end of a recognized drag. It updates the visible
     * state synchronously and never waits for IO. A long-press that never became a
     * drag, a cancelled drag, and a rotation do not call this method.
     */
    public fun commit(placement: TerminalOverlayPlacement) {
        synchronized(stateLock) {
            if (closed || !state.value.ready) return
            sequence += 1
            state.value = state.value.copy(placement = placement)
            commands.trySend(Command(sequence, placement))
        }
    }

    override fun close() {
        var active: TerminalOverlayPlacementStore? = null
        synchronized(stateLock) {
            if (closed) return
            closed = true
            active = store
            store = null
        }
        commands.close()
        scope.cancel()
        try {
            active?.close()
        } catch (_: Exception) {
            // Closing a handle cannot make a previously reported result less true.
        }
    }

    private fun isClosed(): Boolean = synchronized(stateLock) { closed }

    private fun load() {
        val opened = try {
            openStore()
        } catch (_: Exception) {
            markLoadDefaulted()
            return
        }
        val observed = try {
            opened.read()
        } catch (_: Exception) {
            try {
                opened.close()
            } catch (_: Exception) {
                // A refused open owns nothing that must be cleaned up.
            }
            markLoadDefaulted()
            return
        }
        store = opened
        synchronized(stateLock) {
            when (observed) {
                TerminalOverlayPlacementRead.Fresh -> if (sequence == 0L) {
                    state.value = state.value.copy(
                        placement = TerminalOverlayPlacement.DEFAULT,
                        warning = null,
                        ready = true,
                    )
                } else {
                    state.value = state.value.copy(ready = true)
                }
                is TerminalOverlayPlacementRead.Saved -> if (sequence == 0L) {
                    state.value = state.value.copy(
                        placement = observed.placement,
                        warning = null,
                        ready = true,
                    )
                } else {
                    state.value = state.value.copy(ready = true)
                }
                is TerminalOverlayPlacementRead.Defaulted ->
                    state.value = state.value.copy(
                        warning = TerminalOverlayPlacementWarning.LOADED_DEFAULTS,
                        ready = true,
                    )
            }
        }
    }

    private fun write(command: Command) {
        val active = store ?: openForWrite()
        if (active == null) {
            markSaveFailed()
            return
        }
        store = active
        val outcome = try {
            active.write(command.placement)
        } catch (_: StorageException) {
            TerminalOverlayPlacementWriteResult.Refused(StorageFailureReason.UNAVAILABLE)
        } catch (_: Exception) {
            TerminalOverlayPlacementWriteResult.Refused(StorageFailureReason.WRITE_FAILED)
        }
        when (outcome) {
            TerminalOverlayPlacementWriteResult.Published -> markPublished(command.sequence)
            is TerminalOverlayPlacementWriteResult.Refused -> {
                // A stale, changed, unsafe, or uncertain handle is not reused: a later
                // drag reopens normally instead of inheriting a permanent failure.
                discardStore(active)
                markSaveFailed()
            }
        }
    }

    private fun openForWrite(): TerminalOverlayPlacementStore? {
        val opened = try {
            openStore()
        } catch (_: Exception) {
            return null
        }
        return try {
            // Establish this handle's normal observation fence. Its loaded placement
            // is deliberately ignored: the in-memory completed drag is newer.
            opened.read()
            opened
        } catch (_: Exception) {
            try {
                opened.close()
            } catch (_: Exception) {
                // Nothing was published through this failed handle.
            }
            null
        }
    }

    private fun markPublished(commandSequence: Long) {
        synchronized(stateLock) {
            if (commandSequence == sequence) {
                state.value = state.value.copy(warning = null)
            }
        }
    }

    private fun markLoadDefaulted() {
        synchronized(stateLock) {
            state.value = state.value.copy(
                warning = TerminalOverlayPlacementWarning.LOADED_DEFAULTS,
                ready = true,
            )
        }
    }

    private fun markSaveFailed() {
        synchronized(stateLock) {
            state.value = state.value.copy(warning = TerminalOverlayPlacementWarning.SAVE_FAILED)
        }
    }

    private fun discardStore(active: TerminalOverlayPlacementStore) {
        if (store === active) store = null
        try {
            active.close()
        } catch (_: Exception) {
            // The handle is already being treated as unusable.
        }
    }
}
