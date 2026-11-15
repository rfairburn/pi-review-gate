package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.protocol.native.SessionBackend
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

/**
 * The complete card invariant for one hosted provider row and one Pi row.
 *
 * A hosted provider row can be positively at rest in the FOREGROUND — `busy == false`
 * with input positively `none` — while its provider harness still owns background
 * subtasks or background shell jobs, and while the host's own ownership counts are
 * unknown. The card therefore composes the agent and input values from the foreground
 * and activity-intent facts ONLY: the observed ownership pair
 * (`backgroundTasks`/`backgroundShells`) is a different fact, it never blocks or
 * enables rest, it is never read as zero, and it is never displayed as a zero the
 * owner did not report.
 *
 * Rest is a DISPLAYED value and nothing more. No Android path consumes it as stop,
 * close, or remove authority: [AgentActivity] reaches the drawn chips
 * ([sessionCardStatusRoles], `agentChipText`, `inputChipText`) and nowhere else, and
 * the conservative complete-idle gate stays on the owner, where the delivered
 * ownership pair remains its unchanged input.
 *
 * A busy, waiting, or unknown foreground is never promoted to rest, and a Pi row
 * answers the same matrix exactly as it did before hosted provider rows existed: the
 * backend identity selects nothing here.
 */
class NativeCardReadyCompositionTest {

    private data class Case(
        val busy: Boolean?,
        val pendingInput: Boolean?,
        val activeTasks: Long?,
        val activeShells: Long?,
        val expected: AgentActivity,
        val expectedInput: InputObservation,
    )

    private fun row(
        backend: SessionBackend?,
        case: Case,
        backgroundTasks: Long?,
        backgroundShells: Long?,
    ): SessionUiState {
        val drawn = ClientUiFixtures.row(
            HOST,
            busy = case.busy,
            pendingInput = case.pendingInput,
            activeTasks = case.activeTasks,
            activeShells = case.activeShells,
            backgroundTasks = backgroundTasks,
            backgroundShells = backgroundShells,
        )
        // A hosted provider row reports no Pi conversation at all.
        return drawn.copy(metadata = drawn.metadata.copy(backend = backend, nativeSession = null))
    }

    @Test
    fun aPositivelyObservedTurnEndStaysReadyWhateverTheOwnershipCountsSay() {
        val rest = Case(false, false, 0L, 0L, AgentActivity.IDLE, InputObservation.NONE)
        for (backend in listOf(SessionBackend.CLAUDE, SessionBackend.CODEX)) {
            for (pair in OWNERSHIP_PAIRS) {
                val drawn = row(backend, rest, pair.first, pair.second)
                assertEquals(
                    AgentActivity.IDLE,
                    drawn.agentActivity,
                    "$backend with ownership $pair must stay ready, not be erased by it",
                )
                assertEquals(InputObservation.NONE, drawn.inputObservation)
                val roles = sessionCardStatusRoles(drawn)
                assertEquals(SessionStatusRole.IDLE, roles.agent)
                assertEquals(SessionStatusRole.IDLE, roles.input)
                // The count band keeps the reported intent zeros and never borrows the pair.
                assertEquals(SessionCardBackground.Counts(0L, 0L), sessionCardBackground(drawn.metadata))
            }
        }
    }

    @Test
    fun anUnreportedIntentCountIsNeverRescuedByAnOwnershipZero() {
        val drawn = row(SessionBackend.CLAUDE, Case(false, false, null, null, AgentActivity.UNKNOWN, InputObservation.NONE), 0L, 0L)
        assertEquals(
            AgentActivity.UNKNOWN,
            drawn.agentActivity,
            "an unobserved count is unknown, never the zero the ownership pair might suggest",
        )
        assertEquals(SessionStatusRole.UNKNOWN, sessionCardStatusRoles(drawn).agent)
        assertEquals(
            SessionCardBackground.Unknown,
            sessionCardBackground(drawn.metadata),
            "the card draws no count the owner did not report",
        )
    }

    @Test
    fun aBusyWaitingOrUnknownForegroundIsNeverPaintedReady() {
        for (backend in listOf(SessionBackend.CLAUDE, SessionBackend.CODEX)) {
            for (case in CASES.filterNot { it.expected == AgentActivity.IDLE }) {
                val drawn = row(backend, case, 0L, 0L)
                assertEquals(case.expected, drawn.agentActivity, "$backend $case")
                assertNotEquals(
                    SessionStatusRole.IDLE,
                    sessionCardStatusRoles(drawn).agent,
                    "$backend $case must never paint rest",
                )
            }
        }
    }

    @Test
    fun everyBackendAnswersTheSameForegroundMatrix() {
        for (backend in BACKENDS) {
            for (case in CASES) {
                val drawn = row(backend, case, 0L, 0L)
                assertEquals(case.expected, drawn.agentActivity, "$backend $case")
                assertEquals(case.expectedInput, drawn.inputObservation, "$backend $case")
            }
        }
    }

    @Test
    fun theOwnershipPairNeverChangesAnyCardAnswerForAnyBackend() {
        for (backend in BACKENDS) {
            for (case in CASES) {
                val answers = OWNERSHIP_PAIRS.map { (tasks, shells) ->
                    val drawn = row(backend, case, tasks, shells)
                    Triple(drawn.agentActivity, drawn.inputObservation, sessionCardBackground(drawn.metadata))
                }
                assertEquals(
                    1,
                    answers.distinct().size,
                    "the ownership pair moved the card for $backend $case: $answers",
                )
            }
        }
    }

    @Test
    fun theOwnershipPairStaysExactlyAsDeliveredForTheOwnerOwnGate() {
        for (pair in OWNERSHIP_PAIRS) {
            val drawn = row(SessionBackend.CLAUDE, CASES.first(), pair.first, pair.second)
            assertEquals(pair.first, drawn.metadata.backgroundTasks)
            assertEquals(pair.second, drawn.metadata.backgroundShells)
        }
    }

    private companion object {
        const val HOST = "host-a"

        /** A reported zero, a reported positive count, and an unreported count. */
        val OWNERSHIP_PAIRS: List<Pair<Long?, Long?>> = listOf(
            0L to 0L,
            1L to 1L,
            9L to 7L,
            null to null,
            3L to null,
        )

        val BACKENDS: List<SessionBackend?> = listOf(null, SessionBackend.PI, SessionBackend.CLAUDE, SessionBackend.CODEX)

        val CASES: List<Case> = listOf(
            Case(false, false, 0L, 0L, AgentActivity.IDLE, InputObservation.NONE),
            Case(true, false, 0L, 0L, AgentActivity.RUNNING, InputObservation.NONE),
            Case(false, false, 2L, 0L, AgentActivity.RUNNING, InputObservation.NONE),
            Case(false, false, 0L, 1L, AgentActivity.RUNNING, InputObservation.NONE),
            Case(false, true, 0L, 0L, AgentActivity.WAITING, InputObservation.PENDING),
            Case(false, false, null, 0L, AgentActivity.UNKNOWN, InputObservation.NONE),
            Case(false, false, 0L, null, AgentActivity.UNKNOWN, InputObservation.NONE),
            Case(null, false, 0L, 0L, AgentActivity.UNKNOWN, InputObservation.NONE),
            Case(false, null, 0L, 0L, AgentActivity.UNKNOWN, InputObservation.UNKNOWN),
        )
    }
}
