import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
/** base64url without padding: the encoding used on the wire for every key and nonce. */
export function b64url(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(text) {
    return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
const KEY_ID_LENGTH = 22;
export function keyIdForPubkey(pubkeyB64) {
    return b64url(createHash("sha256").update(b64urlDecode(pubkeyB64)).digest()).slice(0, KEY_ID_LENGTH);
}
export function spkiFromPrivateKey(privateKeyPem) {
    const publicKey = createPublicKey(privateKeyPem);
    return b64url(publicKey.export({ type: "spki", format: "der" }));
}
/** Generates a fresh P-256 machine identity. There are only two primitives in this protocol: ECDH + AEAD. */
export function generateMachineIdentity() {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pubkey = spkiFromPrivateKey(privateKeyPem);
    return { pubkey, keyId: keyIdForPubkey(pubkey), privateKeyPem };
}
/**
 * Loads the machine key, creating it on first use with mode 0600.
 * A corrupt or unreadable file is an error, never a silent regeneration: a new key
 * would invalidate every device pin and every sealed message.
 */
export function loadOrCreateMachineIdentity(keyPath) {
    if (fs.existsSync(keyPath)) {
        const raw = fs.readFileSync(keyPath, "utf8");
        let stored;
        try {
            stored = JSON.parse(raw);
        }
        catch {
            throw new Error(`machine key at ${keyPath} is not valid JSON; refusing to overwrite it (restore it or delete it deliberately)`);
        }
        if (stored.v !== 1 || typeof stored.privateKeyPem !== "string" || !stored.privateKeyPem.includes("PRIVATE KEY")) {
            throw new Error(`machine key at ${keyPath} is malformed; refusing to overwrite it (restore it or delete it deliberately)`);
        }
        const pubkey = spkiFromPrivateKey(stored.privateKeyPem);
        return { identity: { pubkey, keyId: keyIdForPubkey(pubkey), privateKeyPem: stored.privateKeyPem }, created: false };
    }
    const identity = generateMachineIdentity();
    const stored = { v: 1, created: new Date().toISOString(), privateKeyPem: identity.privateKeyPem };
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const tmp = `${keyPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    }
    catch {
        /* Windows: ACLs inherit from the user profile */
    }
    fs.renameSync(tmp, keyPath);
    return { identity, created: true };
}
