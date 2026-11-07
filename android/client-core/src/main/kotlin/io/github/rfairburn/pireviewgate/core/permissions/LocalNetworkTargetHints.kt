package io.github.rfairburn.pireviewgate.core.permissions

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint

/**
 * Non-exhaustive syntactic hints that a target may need local-network access.
 *
 * This is deliberately a hint helper, not a LAN detector. It recognizes only
 * explicit private IPv4 ranges, IPv4 link-local, IPv6 unique-local, IPv6
 * link-local, and `.local` names. A `false` result never proves that a target is
 * not local: public addresses can still sit on the local segment, other mDNS or
 * split-horizon names can resolve locally, and local routes or VPNs can reach
 * private or public addresses. A `true` result is only a reason for the caller to
 * consider requiring the permission; the caller decides whether this connection
 * actually needs local-network access.
 *
 * No name or address is resolved, scanned, or opened. No socket, DNS lookup,
 * Android network API, or system service is used.
 */
public object LocalNetworkTargetHints {
    /**
     * True only for the narrow explicit forms described in the type documentation.
     *
     * The check is case-insensitive for `.local` names. Bracketed IPv6 literals and
     * an IPv6 zone id are accepted for their address part.
     */
    public fun isExplicitLocalHint(host: String): Boolean {
        val candidate = host.trim()
        if (candidate.isEmpty()) return false

        val withoutRootDot = candidate.removeSuffix(".")
        if (withoutRootDot.endsWith(".local", ignoreCase = true)) return true

        val address = withoutRootDot
            .removePrefix("[")
            .removeSuffix("]")
            .substringBefore('%')
        return if (address.contains(':')) {
            isUniqueLocalOrLinkLocalIpv6(address)
        } else {
            isPrivateOrLinkLocalIpv4(address)
        }
    }

    /** Convenience form of [isExplicitLocalHint] for one configured endpoint. */
    public fun endpointHasExplicitLocalHint(endpoint: Endpoint): Boolean =
        isExplicitLocalHint(endpoint.host)

    private fun isPrivateOrLinkLocalIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = IntArray(4)
        for ((index, part) in parts.withIndex()) {
            if (part.isEmpty() || part.length > 3) return false
            // Leading zeroes are ambiguous legacy notation; treat them as no hint.
            if (part.length > 1 && part[0] == '0') return false
            if (!part.all { it in '0'..'9' }) return false
            val value = part.toIntOrNull() ?: return false
            if (value !in 0..255) return false
            octets[index] = value
        }
        return when {
            octets[0] == 10 -> true
            octets[0] == 172 && octets[1] in 16..31 -> true
            octets[0] == 192 && octets[1] == 168 -> true
            octets[0] == 169 && octets[1] == 254 -> true
            else -> false
        }
    }

    private fun isUniqueLocalOrLinkLocalIpv6(address: String): Boolean {
        val first = firstHextetOrNull(address) ?: return false
        // fc00::/7 unique-local and fe80::/10 link-local.
        return (first and 0xFE00) == 0xFC00 || (first and 0xFFC0) == 0xFE80
    }

    /**
     * Validate the literal enough to read its first 16-bit group. Returns `null`
     * for malformed input; an omitted compressed prefix yields a first group of 0.
     */
    private fun firstHextetOrNull(value: String): Int? {
        if (value.isEmpty() || value.count { it == ':' } < 2) return null
        if (value.contains(":::")) return null

        val compression = value.indexOf("::")
        if (compression >= 0 && value.indexOf("::", compression + 2) >= 0) return null

        val headText = if (compression >= 0) value.substring(0, compression) else value
        val tailText = if (compression >= 0) value.substring(compression + 2) else ""
        val head = parseHextets(headText) ?: return null
        val tail = if (compression >= 0) parseHextets(tailText) ?: return null else emptyList()
        val total = head.size + tail.size

        if (compression >= 0) {
            if (total >= 8) return null
        } else if (total != 8) {
            return null
        }
        return head.firstOrNull() ?: 0
    }

    private fun parseHextets(text: String): List<Int>? {
        if (text.isEmpty()) return emptyList()
        val parts = text.split(':')
        if (parts.any { it.isEmpty() || it.length > 4 }) return null
        val values = ArrayList<Int>(parts.size)
        for (part in parts) {
            if (!part.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
            values += part.toInt(16)
        }
        return values
    }
}
