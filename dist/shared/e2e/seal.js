import { createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes } from "node:crypto";
import { b64url, b64urlDecode, keyIdForPubkey } from "./identity.js";
/**
 * Sealed content for protocol v2 (PROTOCOLO-V2.md §2-§3), byte-compatible with
 * `@j3pf/rp-protocol`'s `e2e.ts` and with the Kotlin port in the app.
 *
 * The plugin keeps its own copy on purpose: it must not depend on the relay package.
 * Node's crypto is used instead of WebCrypto because the identity on disk is a PEM key.
 */
/** Capability that turns sealed content on for a pair. */
export const CAP_ENC = "enc1";
/** `info` of the derivation; changing it invalidates every existing key. */
const HKDF_INFO = "rp-e2e-v1";
export function isSealed(value) {
    return (typeof value === "object" &&
        value !== null &&
        value.s === 1 &&
        typeof value.k === "string" &&
        typeof value.n === "string" &&
        typeof value.c === "string");
}
/** `true` if any field of the body travels sealed. The relay only checks this opaquely. */
export function hasSealed(value) {
    if (isSealed(value))
        return true;
    if (Array.isArray(value))
        return value.some(hasSealed);
    if (typeof value === "object" && value !== null)
        return Object.values(value).some(hasSealed);
    return false;
}
/**
 * AAD of the contract: `keyIdEmisor || 0x00 || t || 0x00 || (id ?? "")`.
 * It stops a ciphertext from being replayed in another message, another type, or backwards.
 */
export function sealedAad(from, t, id) {
    return Buffer.concat([Buffer.from(`${from}\u0000${t}\u0000`, "utf8"), Buffer.from(id ?? "", "utf8")]);
}
/**
 * `K = HKDF-SHA256(ikm = ECDH(priv, peerPub), salt = SHA-256(keyIdA || keyIdB sorted), info = "rp-e2e-v1", 32)`.
 * One key per (device, machine) pair; the AAD, not extra keys, provides direction binding.
 */
export function deriveContentKey(privateKey, peerPubkey, ownKeyId) {
    const peer = createPublicKey({ key: b64urlDecode(peerPubkey), format: "der", type: "spki" });
    const own = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
    const shared = diffieHellman({ privateKey: own, publicKey: peer });
    const peerKeyId = keyIdForPubkey(peerPubkey);
    const salt = createHash("sha256").update(`${[ownKeyId, peerKeyId].sort().join("")}`, "utf8").digest();
    return Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(HKDF_INFO, "utf8"), 32));
}
/** Same pair key, derived from the wire form of both sides (no private key at hand). */
export function contentKeyIdAad(keyId, t, id) {
    return sealedAad(keyId, t, id);
}
import { createCipheriv, createDecipheriv } from "node:crypto";
/** Seals a text with the pair key. `nonce` is only passed by tests that pin a vector. */
export function sealText(key, keyId, plain, aad, nonce) {
    const iv = nonce ?? randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final(), cipher.getAuthTag()]);
    return { s: 1, k: keyId, n: b64url(iv), c: b64url(ciphertext) };
}
/**
 * Opens a field that may arrive in clear (v1) or sealed (v2).
 * Returns `null` when authentication fails: the caller must discard the message, never show empty text.
 */
export function openText(key, value, aad) {
    if (typeof value === "string")
        return value;
    if (!isSealed(value))
        return null;
    try {
        const raw = b64urlDecode(value.c);
        if (raw.length < 17)
            return null;
        const decipher = createDecipheriv("aes-256-gcm", key, b64urlDecode(value.n));
        decipher.setAAD(aad);
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
    }
    catch {
        return null;
    }
}
/** Seals any serializable value (options, attachment metadata) as one ciphertext. */
export function sealJson(key, keyId, value, aad, nonce) {
    return sealText(key, keyId, JSON.stringify(value), aad, nonce);
}
export function openJson(key, value, aad) {
    const plain = openText(key, value, aad);
    if (plain === null)
        return null;
    try {
        return JSON.parse(plain);
    }
    catch {
        return null;
    }
}
