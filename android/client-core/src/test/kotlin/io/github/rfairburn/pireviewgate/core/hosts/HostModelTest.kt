package io.github.rfairburn.pireviewgate.core.hosts

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/** Bounds and association rules for the host model and the multi-host catalog. */
class HostModelTest {

    private fun host(
        id: String,
        label: String = "Host $id",
        endpointHost: String = "192.168.1.10",
        port: Int = 8443,
        previouslyConnected: Boolean = false,
        reconnectSuppressed: Boolean = false,
    ): ConfiguredHost = ConfiguredHost(
        id = HostId.parse(id),
        label = HostLabel.parse(label),
        endpoint = Endpoint(endpointHost, port),
        previouslyConnected = previouslyConnected,
        reconnectSuppressed = reconnectSuppressed,
    )

    @Test
    fun `host ids are bounded opaque local values`() {
        assertTrue(HostId.isValid("a"))
        assertTrue(HostId.isValid("6f1c8f2e-0000-4000-8000-000000000000"))
        assertTrue(HostId.isValid("x".repeat(HostId.MAX_ID_CHARS)))
        assertFalse(HostId.isValid(""))
        assertFalse(HostId.isValid("x".repeat(HostId.MAX_ID_CHARS + 1)))
        assertFalse(HostId.isValid("has\nnewline"))
        assertFalse(HostId.isValid("tab\there"))
        assertFalse(HostId.isValid("nul\u0000inside"))
        assertFalse(HostId.isValid("del\u007Finside"))
        assertNull(HostId.parseOrNull(""))
        // An opaque id is data only: names with no language-level meaning are ordinary.
        assertNotNull(HostId.parseOrNull("__proto__"))
        assertNotNull(HostId.parseOrNull("constructor"))
    }

    @Test
    fun `labels are bounded line-safe display values`() {
        assertTrue(HostLabel.isValid("Pixel in the kitchen"))
        assertTrue(HostLabel.isValid("work-host (desk) @1"))
        assertTrue(HostLabel.isValid("x".repeat(HostLabel.MAX_LABEL_BYTES)))
        assertFalse(HostLabel.isValid(""))
        assertFalse(HostLabel.isValid("x".repeat(HostLabel.MAX_LABEL_BYTES + 1)))
        assertFalse(HostLabel.isValid("emoji 😀"))
        assertFalse(HostLabel.isValid("line\nbreak"))
        assertFalse(HostLabel.isValid("quote\"inside"))
        assertFalse(HostLabel.isValid("slash/inside"))
    }

    @Test
    fun `endpoints carry no path or URL punctuation and dialable ports only`() {
        assertTrue(Endpoint.isValidHost("192.168.1.10"))
        assertTrue(Endpoint.isValidHost("fe80::1"))
        assertTrue(Endpoint.isValidHost("host.example"))
        assertFalse(Endpoint.isValidHost(""))
        assertFalse(Endpoint.isValidHost("bad host"))
        assertFalse(Endpoint.isValidHost("bad/host"))
        assertFalse(Endpoint.isValidHost("bad\\host"))
        assertFalse(Endpoint.isValidHost("bad?host"))
        assertFalse(Endpoint.isValidHost("bad#host"))
        assertFalse(Endpoint.isValidHost("bad@host"))
        assertFalse(Endpoint.isValidHost("h".repeat(Endpoint.MAX_HOST_CHARS + 1)))

        assertTrue(Endpoint.isValidPort(1))
        assertTrue(Endpoint.isValidPort(65_535))
        assertFalse(Endpoint.isValidPort(0))
        assertFalse(Endpoint.isValidPort(-1))
        assertFalse(Endpoint.isValidPort(65_536))

        assertEquals(8443, Endpoint.parsePortOrNull(" 8443 "))
        assertNull(Endpoint.parsePortOrNull("0"))
        assertEquals(0, Endpoint.parsePortOrNull("0", allowZero = true))
        assertNull(Endpoint.parsePortOrNull("65536"))
        assertNull(Endpoint.parsePortOrNull("8443a"))
        assertNull(Endpoint.parsePortOrNull(""))
    }

    @Test
    fun `an ipv6 endpoint displays bracketed`() {
        assertEquals("[fe80::1]:8443", Endpoint("fe80::1", 8443).displayText())
        assertEquals("192.168.1.10:8443", Endpoint("192.168.1.10", 8443).displayText())
    }

    @Test
    fun `the catalog holds many hosts with stable ids and no current-host slot`() {
        val first = host("a")
        val second = host("b")
        val third = host("c")

        val added = HostCatalog.EMPTY.added(first).mustCatalog()
            .added(second).mustCatalog()
            .added(third).mustCatalog()

        assertEquals(3, added.size)
        assertEquals(listOf(HostId.parse("a"), HostId.parse("b"), HostId.parse("c")), added.ids)
        assertEquals(second, added.find(HostId.parse("b")))
        assertNull(added.find(HostId.parse("zz")))

        // Removing one entry never renumbers or retargets the others.
        val afterRemove = added.removed(HostId.parse("b")).mustCatalog()
        assertEquals(listOf(HostId.parse("a"), HostId.parse("c")), afterRemove.ids)
        assertEquals(third, afterRemove.find(HostId.parse("c")))

        // Renaming preserves id, endpoint, and both lifecycle facts.
        val renamed = afterRemove
            .updated(HostId.parse("c")) { it.withLabel(HostLabel.parse("Renamed couch")) }
            .mustCatalog()
        val renamedC = renamed.find(HostId.parse("c"))!!
        assertEquals(HostId.parse("c"), renamedC.id)
        assertEquals(third.endpoint, renamedC.endpoint)
        assertEquals(HostLabel.parse("Renamed couch"), renamedC.label)
    }

    @Test
    fun `two hosts may name the same endpoint and stay distinct`() {
        val shared = Endpoint("10.0.0.5", 9000)
        val catalog = HostCatalog.EMPTY
            .added(host("one", endpointHost = shared.host, port = shared.port)).mustCatalog()
            .added(host("two", endpointHost = shared.host, port = shared.port)).mustCatalog()

        assertEquals(2, catalog.size)
        assertEquals(2, catalog.findByEndpoint(shared).size)
        assertNotSameLoosely(catalog.find(HostId.parse("one"))!!, catalog.find(HostId.parse("two"))!!)
    }

    @Test
    fun `duplicate ids and the count bound refuse without changing the catalog`() {
        val first = host("a")
        val catalog = HostCatalog.EMPTY.added(first).mustCatalog()

        val duplicate = assertIs<HostCatalogMutation.Failed>(catalog.added(first))
        assertEquals(CatalogFailureReason.DUPLICATE_HOST_ID, duplicate.reason)
        assertEquals(1, catalog.size)

        val unknown = assertIs<HostCatalogMutation.Failed>(catalog.removed(HostId.parse("nope")))
        assertEquals(CatalogFailureReason.UNKNOWN_HOST_ID, unknown.reason)

        var filled = catalog
        while (filled.size < HostCatalog.MAX_HOSTS) {
            val index = filled.size
            filled = filled.added(host("id-$index")).mustCatalog()
        }
        assertEquals(HostCatalog.MAX_HOSTS, filled.size)
        val overflow = assertIs<HostCatalogMutation.Failed>(filled.added(host("one-too-many")))
        assertEquals(CatalogFailureReason.TOO_MANY_HOSTS, overflow.reason)
        assertEquals(HostCatalog.MAX_HOSTS, filled.size)
    }

    @Test
    fun `per-host facts change exactly one entry`() {
        val catalog = HostCatalog.EMPTY
            .added(host("a", previouslyConnected = true)).mustCatalog()
            .added(host("b")).mustCatalog()

        val suppressed = catalog
            .updated(HostId.parse("a")) { it.withReconnectSuppressed(true) }
            .mustCatalog()

        assertTrue(suppressed.find(HostId.parse("a"))!!.reconnectSuppressed)
        assertFalse(suppressed.find(HostId.parse("b"))!!.reconnectSuppressed)
        assertTrue(suppressed.find(HostId.parse("a"))!!.previouslyConnected)

        val connected = suppressed
            .updated(HostId.parse("b")) { it.withPreviouslyConnected(true) }
            .mustCatalog()
        assertTrue(connected.find(HostId.parse("b"))!!.previouslyConnected)
        assertTrue(connected.find(HostId.parse("a"))!!.reconnectSuppressed)
    }

    @Test
    fun `settings defaults are remembered off for reconnect and on for viewer input`() {
        val defaults = NetworkSettings.DEFAULTS
        assertFalse(defaults.autoReconnect)
        assertTrue(defaults.viewerRemoteInputEnabled)
        assertTrue(defaults.hosts.isEmpty)

        val settings = defaults.withAutoReconnect(true)
        assertTrue(settings.autoReconnect)
        assertTrue(settings.viewerRemoteInputEnabled)

        val viewerOff = defaults.withViewerRemoteInputEnabled(false)
        assertFalse(viewerOff.viewerRemoteInputEnabled)
        assertFalse(viewerOff.autoReconnect)
    }

    @Test
    fun `automatic reconnect needs the preference, history, and no suppression`() {
        val connected = host("a", previouslyConnected = true)
        val suppressed = connected.withReconnectSuppressed(true)
        val fresh = host("b")

        val on = NetworkSettings(autoReconnect = true)
        val off = NetworkSettings(autoReconnect = false)

        assertTrue(on.autoReconnectEligible(connected))
        assertFalse(off.autoReconnectEligible(connected))
        assertFalse(on.autoReconnectEligible(suppressed))
        assertFalse(on.autoReconnectEligible(fresh))
    }

    @Test
    fun `a per-host update that changes the id is refused`() {
        val catalog = HostCatalog.EMPTY
            .added(host("a", previouslyConnected = true)).mustCatalog()
            .added(host("b")).mustCatalog()

        val swap = assertIs<HostCatalogMutation.Failed>(
            catalog.updated(HostId.parse("a")) { it.copy(id = HostId.parse("b")) },
        )
        assertEquals(CatalogFailureReason.INVALID_UPDATE, swap.reason)

        // Nothing moved: both associations keep their own ids and facts.
        assertEquals(HostId.parse("a"), catalog.find(HostId.parse("a"))!!.id)
        assertTrue(catalog.find(HostId.parse("a"))!!.previouslyConnected)
        assertFalse(catalog.find(HostId.parse("b"))!!.previouslyConnected)
    }

    private fun HostCatalogMutation.mustCatalog(): HostCatalog = when (this) {
        is HostCatalogMutation.Ok -> catalog
        is HostCatalogMutation.Failed -> fail("catalog mutation refused: ${reason.name}")
    }

    private fun assertNotSameLoosely(left: ConfiguredHost, right: ConfiguredHost) {
        assertFalse(left.id == right.id, "distinct saved hosts must keep distinct ids")
    }
}
