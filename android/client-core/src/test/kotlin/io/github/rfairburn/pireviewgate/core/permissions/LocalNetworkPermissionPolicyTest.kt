package io.github.rfairburn.pireviewgate.core.permissions

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Focused policy checks for the Android 17 local-network permission abstraction.
 *
 * These tests are platform-neutral: no Android class, device, DNS, socket, or system
 * prompt is involved. Actual system-dialog behavior remains unverified here.
 */
class LocalNetworkPermissionPolicyTest {
    private class FakeProbe(
        var status: LocalNetworkPermissionStatus,
        var shouldShowRationale: Boolean = false,
    ) : LocalNetworkPermissionProbe {
        var observations: Int = 0
            private set

        override fun observe(): LocalNetworkPermissionPlatformFacts {
            observations += 1
            return LocalNetworkPermissionPlatformFacts(
                status = status,
                shouldShowRationale = shouldShowRationale,
            )
        }
    }

    private fun token(
        hostId: String = "host-a",
        host: String = "192.168.1.10",
        port: Int = 8443,
        generation: Long = 1L,
    ): LocalNetworkRequestToken = LocalNetworkRequestToken(
        hostId = HostId.parse(hostId),
        endpoint = Endpoint(host, port),
        intentGeneration = generation,
    )

    private fun accepted(start: LocalNetworkRequestStart): LocalNetworkPendingRequest =
        assertIs<LocalNetworkRequestStart.Accepted>(start).request

    private fun assertRejected(
        start: LocalNetworkRequestStart,
        reason: LocalNetworkRequestRejectionReason,
    ) {
        assertEquals(reason, assertIs<LocalNetworkRequestStart.Rejected>(start).reason)
    }

    @Test
    fun `local network permission applies only from API 37`() {
        assertEquals(
            LocalNetworkPermissionStatus.NOT_REQUIRED,
            LocalNetworkPermission.statusFor(sdkInt = 33, granted = false),
        )
        assertEquals(
            LocalNetworkPermissionStatus.NOT_REQUIRED,
            LocalNetworkPermission.statusFor(sdkInt = 36, granted = true),
        )
        assertEquals(
            LocalNetworkPermissionStatus.NOT_GRANTED,
            LocalNetworkPermission.statusFor(sdkInt = 37, granted = false),
        )
        assertEquals(
            LocalNetworkPermissionStatus.GRANTED,
            LocalNetworkPermission.statusFor(sdkInt = 37, granted = true),
        )
        assertEquals(
            LocalNetworkPermissionStatus.NOT_GRANTED,
            LocalNetworkPermission.statusFor(sdkInt = 38, granted = false),
        )
        assertEquals(
            "android.permission.ACCESS_LOCAL_NETWORK",
            LocalNetworkPermission.PERMISSION_NAME,
        )
    }

    @Test
    fun `no rationale before the first request is not a permanent denial claim`() {
        val initial = LocalNetworkPermissionObservation(
            status = LocalNetworkPermissionStatus.NOT_GRANTED,
            shouldShowRationale = false,
            lastExplicitRequestDenied = false,
        )
        assertTrue(initial.needsPermission)
        assertFalse(initial.rationaleShouldBeShown)
        assertFalse(initial.settingsAffordanceSuggested)

        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        assertEquals(initial, gate.enterForeground())
        assertNull(gate.pendingRequest())
        // The initial state still admits an explicit request; no "permanently denied"
        // inference blocks the user from asking.
        assertEquals(token(), accepted(gate.prepareRequest(token())).token)
    }

    @Test
    fun `rationale and settings affordances follow observed facts only`() {
        val rationaleAfterDenial = LocalNetworkPermissionObservation(
            status = LocalNetworkPermissionStatus.NOT_GRANTED,
            shouldShowRationale = true,
            lastExplicitRequestDenied = true,
        )
        assertTrue(rationaleAfterDenial.rationaleShouldBeShown)
        assertFalse(rationaleAfterDenial.settingsAffordanceSuggested)

        val noRationaleAfterDenial = LocalNetworkPermissionObservation(
            status = LocalNetworkPermissionStatus.NOT_GRANTED,
            shouldShowRationale = false,
            lastExplicitRequestDenied = true,
        )
        assertFalse(noRationaleAfterDenial.rationaleShouldBeShown)
        assertTrue(noRationaleAfterDenial.settingsAffordanceSuggested)

        assertFalse(
            LocalNetworkPermissionObservation(
                status = LocalNetworkPermissionStatus.GRANTED,
            ).needsPermission,
        )
        assertFailsWith<IllegalArgumentException> {
            LocalNetworkPermissionObservation(
                status = LocalNetworkPermissionStatus.GRANTED,
                shouldShowRationale = true,
            )
        }
        assertFailsWith<IllegalArgumentException> {
            LocalNetworkPermissionObservation(
                status = LocalNetworkPermissionStatus.NOT_REQUIRED,
                lastExplicitRequestDenied = true,
            )
        }
    }

    @Test
    fun `foreground refresh adopts a grant without preparing or replaying a request`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        assertTrue(gate.enterForeground().needsPermission)
        assertNull(gate.pendingRequest())

        probe.status = LocalNetworkPermissionStatus.GRANTED
        val observedBefore = probe.observations
        assertEquals(LocalNetworkPermissionStatus.GRANTED, gate.refresh().status)
        assertEquals(observedBefore + 1, probe.observations)
        assertNull(gate.pendingRequest())
        assertRejected(
            gate.prepareRequest(token()),
            LocalNetworkRequestRejectionReason.PERMISSION_ALREADY_GRANTED,
        )

        // A new foreground epoch reads the grant and still never prompts.
        assertEquals(LocalNetworkPermissionStatus.GRANTED, gate.enterForeground().status)
        assertNull(gate.pendingRequest())
    }

    @Test
    fun `revocation is reported separately and never starts a prompt`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        assertEquals(LocalNetworkPermissionStatus.GRANTED, gate.enterForeground().status)
        assertNull(gate.pendingRequest())

        probe.status = LocalNetworkPermissionStatus.NOT_GRANTED
        val revoked = gate.refresh()
        assertEquals(LocalNetworkPermissionStatus.NOT_GRANTED, revoked.status)
        assertFalse(revoked.lastExplicitRequestDenied)
        assertFalse(revoked.settingsAffordanceSuggested)
        assertNull(gate.pendingRequest())
    }

    @Test
    fun `late grant after background is stale and starts nothing`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()
        val intent = token()
        val request = accepted(gate.prepareRequest(intent))
        assertEquals(intent, gate.pendingRequest()?.token)

        val retired = gate.leaveForeground()
        assertEquals(intent, retired)
        probe.status = LocalNetworkPermissionStatus.GRANTED

        val stale = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(request.requestId, granted = true, currentIntent = intent),
        )
        assertEquals(LocalNetworkRequestStaleReason.FOREGROUND_UI_CHANGED, stale.reason)
        assertNull(gate.pendingRequest())

        // The truthful foreground status may be granted, but the old request is not
        // resurrected and no connection is replayed from it.
        assertEquals(LocalNetworkPermissionStatus.GRANTED, gate.enterForeground().status)
        assertNull(gate.pendingRequest())
    }

    @Test
    fun `a new foreground epoch retires the previous prompt`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()
        val intent = token()
        val request = accepted(gate.prepareRequest(intent))

        val nextEpoch = gate.enterForeground()
        assertTrue(nextEpoch.needsPermission)
        assertNull(gate.pendingRequest())
        val stale = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(request.requestId, granted = true, currentIntent = intent),
        )
        assertEquals(LocalNetworkRequestStaleReason.NO_MATCHING_REQUEST, stale.reason)
    }

    @Test
    fun `late denial after background is stale and records no current denial`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()
        val intent = token()
        val request = accepted(gate.prepareRequest(intent))
        gate.leaveForeground()

        val stale = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(request.requestId, granted = false, currentIntent = intent),
        )
        assertEquals(LocalNetworkRequestStaleReason.FOREGROUND_UI_CHANGED, stale.reason)
        val observation = gate.refresh()
        assertEquals(LocalNetworkPermissionStatus.NOT_GRANTED, observation.status)
        assertFalse(observation.lastExplicitRequestDenied)
        assertFalse(observation.settingsAffordanceSuggested)
        assertNull(gate.pendingRequest())
    }

    @Test
    fun `late grant after navigation or source change is stale`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()

        val oldIntent = token(generation = 1)
        val retiredRequest = accepted(gate.prepareRequest(oldIntent))
        gate.retirePending()
        val staleAfterRetire = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(retiredRequest.requestId, granted = true, currentIntent = oldIntent),
        )
        assertEquals(LocalNetworkRequestStaleReason.NO_MATCHING_REQUEST, staleAfterRetire.reason)

        // Even without an explicit retire, a changed generation is not the current
        // explicit intent and cannot receive the old result.
        val pendingRequest = accepted(gate.prepareRequest(token(generation = 2)))
        val staleAfterSourceChange = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(
                pendingRequest.requestId,
                granted = true,
                currentIntent = token(generation = 3),
            ),
        )
        assertEquals(
            LocalNetworkRequestStaleReason.TARGET_NOT_CURRENT,
            staleAfterSourceChange.reason,
        )
        assertNull(gate.pendingRequest())
    }

    @Test
    fun `removing a host retires only that host's pending request`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()

        val hostA = token(hostId = "host-a")
        val request = accepted(gate.prepareRequest(hostA))
        assertNull(gate.retireForHost(HostId.parse("host-b")))
        assertEquals(hostA, gate.pendingRequest()?.token)

        assertEquals(hostA, gate.retireForHost(HostId.parse("host-a")))
        assertNull(gate.pendingRequest())
        val stale = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(request.requestId, granted = true, currentIntent = hostA),
        )
        assertEquals(LocalNetworkRequestStaleReason.NO_MATCHING_REQUEST, stale.reason)
    }

    @Test
    fun `one native prompt is tracked across concurrently configured hosts`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()

        val hostA = token(hostId = "host-a")
        val hostB = token(hostId = "host-b")
        val requestA = accepted(gate.prepareRequest(hostA))
        assertRejected(
            gate.prepareRequest(hostB),
            LocalNetworkRequestRejectionReason.REQUEST_ALREADY_PENDING,
        )

        gate.retirePending()
        val requestB = accepted(gate.prepareRequest(hostB))
        val staleA = assertIs<LocalNetworkRequestResolution.Stale>(
            gate.resolve(requestA.requestId, granted = true, currentIntent = hostB),
        )
        assertEquals(LocalNetworkRequestStaleReason.NO_MATCHING_REQUEST, staleA.reason)

        val grantedB = assertIs<LocalNetworkRequestResolution.Granted>(
            gate.resolve(requestB.requestId, granted = true, currentIntent = hostB),
        )
        assertEquals(hostB, grantedB.token)
    }

    @Test
    fun `denial grant and later revocation move the observed state truthfully`() {
        val probe = FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED)
        val gate = LocalNetworkPermissionGate(probe)
        gate.enterForeground()

        val firstIntent = token(generation = 1)
        val firstRequest = accepted(gate.prepareRequest(firstIntent))
        val denied = assertIs<LocalNetworkRequestResolution.Denied>(
            gate.resolve(firstRequest.requestId, granted = false, currentIntent = firstIntent),
        )
        assertEquals(firstIntent, denied.token)

        probe.shouldShowRationale = false
        var observation = gate.refresh()
        assertTrue(observation.lastExplicitRequestDenied)
        assertTrue(observation.settingsAffordanceSuggested)

        val secondIntent = token(generation = 2)
        val secondRequest = accepted(gate.prepareRequest(secondIntent))
        val granted = assertIs<LocalNetworkRequestResolution.Granted>(
            gate.resolve(secondRequest.requestId, granted = true, currentIntent = secondIntent),
        )
        assertEquals(secondIntent, granted.token)

        probe.status = LocalNetworkPermissionStatus.GRANTED
        observation = gate.refresh()
        assertEquals(LocalNetworkPermissionStatus.GRANTED, observation.status)
        assertFalse(observation.lastExplicitRequestDenied)
        assertFalse(observation.settingsAffordanceSuggested)

        probe.status = LocalNetworkPermissionStatus.NOT_GRANTED
        observation = gate.refresh()
        assertEquals(LocalNetworkPermissionStatus.NOT_GRANTED, observation.status)
        assertFalse(observation.lastExplicitRequestDenied)
        assertFalse(observation.settingsAffordanceSuggested)
    }

    @Test
    fun `requests are rejected without a foreground epoch current intent or need`() {
        val gate = LocalNetworkPermissionGate(FakeProbe(LocalNetworkPermissionStatus.NOT_GRANTED))
        assertRejected(
            gate.prepareRequest(token()),
            LocalNetworkRequestRejectionReason.NOT_IN_FOREGROUND_UI,
        )

        gate.enterForeground()
        assertRejected(
            gate.prepareRequest(null),
            LocalNetworkRequestRejectionReason.NO_CURRENT_EXPLICIT_INTENT,
        )
        accepted(gate.prepareRequest(token()))
        gate.retirePending()

        val grantedGate = LocalNetworkPermissionGate(FakeProbe(LocalNetworkPermissionStatus.GRANTED))
        grantedGate.enterForeground()
        assertRejected(
            grantedGate.prepareRequest(token()),
            LocalNetworkRequestRejectionReason.PERMISSION_ALREADY_GRANTED,
        )

        val notRequiredGate = LocalNetworkPermissionGate(
            FakeProbe(LocalNetworkPermissionStatus.NOT_REQUIRED),
        )
        notRequiredGate.enterForeground()
        assertRejected(
            notRequiredGate.prepareRequest(token()),
            LocalNetworkRequestRejectionReason.PERMISSION_NOT_REQUIRED,
        )
    }

    @Test
    fun `request tokens bind host endpoint and explicit intent generation`() {
        val base = token()
        assertEquals(base, token())
        assertNotEquals(base, token(hostId = "host-b"))
        assertNotEquals(base, token(host = "192.168.1.11"))
        assertNotEquals(base, token(port = 8444))
        assertNotEquals(base, token(generation = 2))
        assertFailsWith<IllegalArgumentException> { base.copy(intentGeneration = 0L) }
        assertFailsWith<IllegalArgumentException> { base.copy(intentGeneration = -1L) }
    }

    @Test
    fun `LAN hints are explicit syntactic hints and not an exhaustive detector`() {
        listOf(
            "10.0.0.1",
            "10.255.255.255",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.10",
            "169.254.10.20",
        ).forEach { host ->
            assertTrue(LocalNetworkTargetHints.isExplicitLocalHint(host), host)
        }
        listOf(
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "[fe80::1]",
            "fe80::1%wlan0",
        ).forEach { host ->
            assertTrue(LocalNetworkTargetHints.isExplicitLocalHint(host), host)
        }
        listOf(
            "host.local",
            "HOST.LOCAL",
            "host.local.",
            "printer.local",
        ).forEach { host ->
            assertTrue(LocalNetworkTargetHints.isExplicitLocalHint(host), host)
        }

        listOf(
            "8.8.8.8",
            "172.15.0.1",
            "172.32.0.1",
            "192.169.0.1",
            "10.0.0.256",
            "010.0.0.1",
            "192.168.1",
            "2001:db8::1",
            "::1",
            "::",
            "fec0::1",
            "fe80::gg",
            "1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7:8:9",
            "example.com",
            "notlocal",
            "",
        ).forEach { host ->
            assertFalse(LocalNetworkTargetHints.isExplicitLocalHint(host), host)
        }

        assertTrue(
            LocalNetworkTargetHints.endpointHasExplicitLocalHint(
                Endpoint(host = "192.168.1.10", port = 8443),
            ),
        )
        assertFalse(
            LocalNetworkTargetHints.endpointHasExplicitLocalHint(
                Endpoint(host = "review.example", port = 8443),
            ),
        )
    }
}
