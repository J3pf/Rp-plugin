import { createHash, createPrivateKey, createPublicKey, diffieHellman } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  b64url,
  b64urlDecode,
  generateMachineIdentity,
  keyIdForPubkey,
  loadOrCreateMachineIdentity,
  spkiFromPrivateKey,
} from "../src/shared/e2e/identity.ts";

const dirs: string[] = [];
function keyPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rpkey-"));
  dirs.push(d);
  return path.join(d, "machine.key");
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("machine identity", () => {
  it("creates a P-256 key once, with 0600 permissions, and reloads the same fingerprint", () => {
    const p = keyPath();
    const first = loadOrCreateMachineIdentity(p);
    expect(first.created).toBe(true);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(first.identity.pubkey.length).toBeGreaterThanOrEqual(65);

    const second = loadOrCreateMachineIdentity(p);
    expect(second.created).toBe(false);
    expect(second.identity.keyId).toBe(first.identity.keyId);
    expect(second.identity.pubkey).toBe(first.identity.pubkey);
    expect(second.identity.privateKeyPem).toBe(first.identity.privateKeyPem);
  });

  it("derives the fingerprint as the first 22 base64url chars of SHA-256(SPKI DER)", () => {
    const { identity } = loadOrCreateMachineIdentity(keyPath());
    const expected = b64url(createHash("sha256").update(b64urlDecode(identity.pubkey)).digest()).slice(0, 22);
    expect(identity.keyId).toBe(expected);
    expect(identity.keyId).toHaveLength(22);
    expect(identity.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(keyIdForPubkey(identity.pubkey)).toBe(identity.keyId);
  });

  it("publishes an SPKI DER key that a peer can import and use for ECDH", () => {
    const peer = generateMachineIdentity();
    const published = createPublicKey({ key: b64urlDecode(peer.pubkey), format: "der", type: "spki" });
    expect(published.asymmetricKeyType).toBe("ec");
    expect(published.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(spkiFromPrivateKey(peer.privateKeyPem)).toBe(peer.pubkey);

    const other = generateMachineIdentity();
    const mine = createPrivateKey(other.privateKeyPem);
    const theirs = createPublicKey({ key: b64urlDecode(peer.pubkey), format: "der", type: "spki" });
    const z1 = diffieHellman({ privateKey: createPrivateKey(peer.privateKeyPem), publicKey: createPublicKey({ key: b64urlDecode(other.pubkey), format: "der", type: "spki" }) });
    const z2 = diffieHellman({ privateKey: mine, publicKey: theirs });
    expect(z1).toEqual(z2);
    expect(z1).toHaveLength(32);
  });

  it("refuses to overwrite a malformed key file instead of silently regenerating it", () => {
    const p = keyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json at all", { mode: 0o600 });
    expect(() => loadOrCreateMachineIdentity(p)).toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(p, "utf8")).toBe("not json at all");

    fs.writeFileSync(p, JSON.stringify({ v: 1, created: "x", privateKeyPem: "nope" }), { mode: 0o600 });
    expect(() => loadOrCreateMachineIdentity(p)).toThrow(/refusing to overwrite/);
  });
});
