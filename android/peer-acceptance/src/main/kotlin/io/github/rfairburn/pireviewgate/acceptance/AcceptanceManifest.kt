package io.github.rfairburn.pireviewgate.acceptance

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.identity.PeerKey
import java.security.KeyFactory
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID
import kotlinx.serialization.json.*

const val FIXTURE_LABEL = "Pi Review Gate"
const val FIXTURE_PACKAGE = "io.github.rfairburn.pireviewgate.acceptance"

fun checkedNonce(value: String): String = value.also {
    require(Regex("[0-9a-f]{16}").matches(it)) { "invalid nonce" }
}

data class AcceptanceHost(
    val hostId: HostId,
    val hostRunId: String,
    val key: PeerKey,
    val port: Int,
) {
    // The only address translation permitted by this fixture.
    val endpoint: Endpoint get() = Endpoint.parseOrNull("10.0.2.2", port)!!
}

data class AcceptanceManifest(val nonce: String, val clientKey: PeerKey, val hosts: List<AcceptanceHost>) {
    companion object {
        const val MAX_BYTES = 64 * 1024
        fun parse(manifestB64: String): AcceptanceManifest {
            require(manifestB64.length <= ((MAX_BYTES + 2) / 3) * 4)
            val bytes = Base64.getDecoder().decode(manifestB64)
            require(bytes.size in 1..MAX_BYTES)
            require(Base64.getEncoder().encodeToString(bytes) == manifestB64)
            val text = bytes.decodeToString(throwOnInvalidSequence = true)
            // JsonObject alone would silently collapse duplicate keys.
            UniqueJsonKeys(text).check()
            val root = Json.parseToJsonElement(text).closedObject(
                "event", "version", "nonce", "clientKeyId", "clientLabel", "listenHost", "hosts",
            )
            require(root.string("event") == "ready" && root.integer("version") == 1)
            require(root.string("clientLabel") == FIXTURE_LABEL)
            require(root.string("listenHost") == "127.0.0.1")
            val nonce = checkedNonce(root.string("nonce"))
            val client = canonicalPublicKey(root.string("clientKeyId"))
            val rows = root["hosts"] as? JsonArray ?: error("hosts must be array")
            require(rows.size == 64)
            val hosts = rows.map { row ->
                val host = row.closedObject("hostId", "hostRunId", "hostKeyId", "hostLabel", "port")
                require(host.string("hostLabel") == FIXTURE_LABEL)
                val id = canonicalUuid(host.string("hostId"))
                val run = canonicalUuid(host.string("hostRunId"))
                val port = host.integer("port")
                require(port in 1..65535)
                AcceptanceHost(HostId.parse(id), run, canonicalPublicKey(host.string("hostKeyId")), port)
            }
            require(hosts.flatMap { listOf(it.hostId.value, it.hostRunId) }.toSet().size == 128)
            require(hosts.map { it.key.keyId }.toSet().size == 64)
            require(hosts.none { it.key.keyId == client.keyId })
            require(hosts.map { it.port }.toSet().size == 64)
            return AcceptanceManifest(nonce, client, hosts)
        }
    }
}

internal fun JsonElement.closedObject(vararg keys: String): JsonObject =
    (this as? JsonObject ?: error("object required")).also { require(it.keys == keys.toSet()) }

internal fun JsonObject.string(key: String): String =
    (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: error("string required")

private fun JsonObject.integer(key: String): Int {
    val value = get(key) as? JsonPrimitive ?: error("integer required")
    require(!value.isString && Regex("0|[1-9][0-9]*").matches(value.content))
    return value.content.toInt()
}

private fun canonicalUuid(value: String): String = value.also {
    require(UUID.fromString(it).toString() == it)
    require(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}").matches(it))
}

internal fun canonicalPublicKey(value: String): PeerKey {
    require(value.length <= PeerKey.MAX_KEY_ID_CHARS)
    val der = Base64.getDecoder().decode(value)
    require(Base64.getEncoder().encodeToString(der) == value)
    // These peers use actual P-256 SPKI, not arbitrary base64 or a digest.
    val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
    require(publicKey.encoded.contentEquals(der))
    val ec = publicKey as java.security.interfaces.ECPublicKey
    val parameters = java.security.AlgorithmParameters.getInstance("EC").apply {
        init(java.security.spec.ECGenParameterSpec("secp256r1"))
    }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
    require(ec.params.curve == parameters.curve && ec.params.generator == parameters.generator &&
        ec.params.order == parameters.order && ec.params.cofactor == parameters.cofactor)
    return PeerKey.fromSpki(der).also { require(it.keyId == value) }
}

/** Bounded lexical walk; the JSON decoder subsequently checks the full grammar. */
private class UniqueJsonKeys(private val text: String) {
    private var at = 0
    fun check() { value(0); whitespace(); require(at == text.length) }
    private fun whitespace() { while (at < text.length && text[at] in " \r\n\t") at++ }
    private fun take(c: Char) { whitespace(); require(at < text.length && text[at++] == c) }
    private fun string(): String {
        whitespace()
        val start = at
        take('"')
        while (at < text.length) {
            when (text[at++]) {
                '\\' -> { require(at < text.length); at++ }
                '"' -> return (Json.parseToJsonElement(text.substring(start, at)) as JsonPrimitive).content
            }
        }
        error("unterminated string")
    }
    private fun value(depth: Int) {
        require(depth <= 8)
        whitespace(); require(at < text.length)
        when (text[at]) {
            '{' -> {
                at++; whitespace()
                if (at < text.length && text[at] == '}') { at++; return }
                val keys = HashSet<String>()
                while (true) {
                    require(keys.add(string())) { "duplicate key" }
                    take(':'); value(depth + 1); whitespace()
                    require(at < text.length)
                    if (text[at] == '}') { at++; return }
                    take(',')
                }
            }
            '[' -> {
                at++; whitespace()
                if (at < text.length && text[at] == ']') { at++; return }
                while (true) {
                    value(depth + 1); whitespace(); require(at < text.length)
                    if (text[at] == ']') { at++; return }
                    take(',')
                }
            }
            '"' -> { string() }
            else -> {
                val start = at
                while (at < text.length && text[at] !in ",]} \r\n\t") at++
                require(at > start)
            }
        }
    }
}
