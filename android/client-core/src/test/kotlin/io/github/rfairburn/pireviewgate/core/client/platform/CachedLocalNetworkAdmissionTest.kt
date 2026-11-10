package io.github.rfairburn.pireviewgate.core.client.platform

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CachedLocalNetworkAdmissionTest {
    private val local = listOf("192.168.1.3", "10.0.0.2", "172.16.0.8", "169.254.1.2", "fd00::1", "fe80::1", "peer.local")
    private val unknownOrPublic = listOf("example.test", "split-horizon-name", "8.8.8.8", "2001:4860:4860::8888")
    private fun endpoint(host: String) = Endpoint(host, 443)

    @Test
    fun `API37 starts refusing only explicit LAN hints until grant and revokes on refresh`() {
        val admission = CachedLocalNetworkAdmission(37)
        for (host in local) {
            assertTrue(admission.requiresLocalNetworkGrant(endpoint(host)))
            assertFalse(admission.allows(endpoint(host)))
        }
        for (host in unknownOrPublic) assertTrue(admission.allows(endpoint(host)))
        admission.refresh { LocalNetworkPermissionStatus.GRANTED }
        for (host in local) assertTrue(admission.allows(endpoint(host)))
        admission.refresh { LocalNetworkPermissionStatus.NOT_GRANTED }
        for (host in local) assertFalse(admission.allows(endpoint(host)))
        for (host in unknownOrPublic) assertTrue(admission.allows(endpoint(host)))
    }

    @Test
    fun `platform read refusal and invalid NOT_REQUIRED answer on API37 fail closed only for known LAN`() {
        val admission = CachedLocalNetworkAdmission(37)
        admission.refresh { LocalNetworkPermissionStatus.GRANTED }
        admission.refresh { error("platform refused permission read") }
        assertEquals(LocalNetworkPermissionStatus.NOT_GRANTED, admission.permissionStatus)
        assertFalse(admission.allows(endpoint("peer.local")))
        for (host in unknownOrPublic) assertTrue(admission.allows(endpoint(host)))
        admission.refresh { LocalNetworkPermissionStatus.NOT_REQUIRED }
        assertFalse(admission.allows(endpoint("10.0.0.1")))
    }

    @Test
    fun `below API37 not required and does not even read nonexistent permission`() {
        for (sdk in 33..36) {
            val admission = CachedLocalNetworkAdmission(sdk)
            admission.refresh { error("must not read or request nonexistent permission") }
            assertEquals(LocalNetworkPermissionStatus.NOT_REQUIRED, admission.permissionStatus)
            for (host in local + unknownOrPublic) {
                assertFalse(admission.requiresLocalNetworkGrant(endpoint(host)))
                assertTrue(admission.allows(endpoint(host)))
            }
        }
    }

    @Test
    fun `admission reads only cache not the platform probe on every writer call`() {
        val admission = CachedLocalNetworkAdmission(37)
        var reads = 0
        admission.refresh {
            reads++
            LocalNetworkPermissionStatus.GRANTED
        }
        repeat(100) {
            for (host in local + unknownOrPublic) {
                admission.requiresLocalNetworkGrant(endpoint(host))
                assertTrue(admission.allows(endpoint(host)))
            }
        }
        assertEquals(1, reads)
        // The admission API has no launcher, resolver, socket, or Activity dependency.
    }
}
