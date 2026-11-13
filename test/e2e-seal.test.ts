import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyIdForPubkey } from "../src/shared/e2e/identity.ts";
import { deriveContentKey, openJson, openText, sealJson, sealText, sealedAad } from "../src/shared/e2e/seal.ts";

/**
 * Interop vector produced by `@j3pf/rp-protocol` (`packages/protocol/src/e2e.ts`) in Rp-relay:
 * fixed P-256 identities, the sealed prompt that implementation emitted for the AAD
 * (machineKeyId, "prompt.open", "PROMPT1"), and the plaintext it decrypts to.
 * The plugin must reproduce these bytes exactly; the app's Kotlin port is checked against them too.
 */
const VECTOR = {
  machinePem: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUNBd3k0PJBxdRLnP
lwRCjz6pxHKQV/uQMRTEXUveWLOhRANCAAQGk2DNIgpa9hGay/rjdo4+O9rv6c6h
aMd6d8uwdSuqk5qzpCFMphz3BxQIubPHK8g/5wgQrJXmdK49aI0tz60z
-----END PRIVATE KEY-----
`,
  devicePem: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNXa3S2krWhTIE6fr
bmLjqwpp9n+Djl9CPpQfxpg9542hRANCAAR1KK6in3OVDvkqSAskZr0HEmD7VxBk
1bMOAYFL5yBbmo6QBdPpJirRpCWIz1g342hu+pQSTNAT8p+PR8pbFEzH
-----END PRIVATE KEY-----
`,
  machinePubkey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBpNgzSIKWvYRmsv643aOPjva7-nOoWjHenfLsHUrqpOas6QhTKYc9wcUCLmzxyvIP-cIEKyV5nSuPWiNLc-tMw",
  machineKeyId: "qLNV4haRjb3tLsm-JOmlOP",
  devicePubkey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdSiuop9zlQ75KkgLJGa9BxJg-1cQZNWzDgGBS-cgW5qOkAXT6SYq0aQliM9YN-NobvqUEkzQE_Kfj0fKWxRMxw",
  deviceKeyId: "2nFPGhCFHJBUbpKjPh-31K",
  sealed: { s: 1 as const, k: "qLNV4haRjb3tLsm-JOmlOP", n: "c69doD8UT9YLwPid", c: "TXbsXcn2ZbJ_g03e_pjYxrShu_52QJts2a1cFi-qP13USGGIOCw" },
  promptId: "PROMPT1",
  plain: "Hola desde la máquina",
};

const machineKey = createPrivateKey(VECTOR.machinePem);
const deviceKey = createPrivateKey(VECTOR.devicePem);

describe("sealed content (protocol v2 §2-§3)", () => {
  it("uses the same key ids as the reference implementation", () => {
    expect(keyIdForPubkey(VECTOR.machinePubkey)).toBe(VECTOR.machineKeyId);
    expect(keyIdForPubkey(VECTOR.devicePubkey)).toBe(VECTOR.deviceKeyId);
  });

  it("derives the same content key from both sides of the pair", () => {
    const fromMachine = deriveContentKey(machineKey, VECTOR.devicePubkey, VECTOR.machineKeyId);
    const fromDevice = deriveContentKey(deviceKey, VECTOR.machinePubkey, VECTOR.deviceKeyId);
    expect(fromMachine.equals(fromDevice)).toBe(true);
    expect(fromMachine).toHaveLength(32);
  });

  it("opens a payload sealed by the reference implementation", () => {
    const key = deriveContentKey(deviceKey, VECTOR.machinePubkey, VECTOR.deviceKeyId);
    const aad = sealedAad(VECTOR.machineKeyId, "prompt.open", VECTOR.promptId);
    expect(openText(key, VECTOR.sealed, aad)).toBe(VECTOR.plain);
  });

  it("re-seals to byte-identical ciphertext with the reference nonce", () => {
    const key = deriveContentKey(machineKey, VECTOR.devicePubkey, VECTOR.machineKeyId);
    const aad = sealedAad(VECTOR.machineKeyId, "prompt.open", VECTOR.promptId);
    const nonce = Buffer.from(VECTOR.sealed.n.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const resealed = sealText(key, VECTOR.machineKeyId, VECTOR.plain, aad, nonce);
    expect(resealed).toEqual(VECTOR.sealed);
  });

  it("binds the ciphertext to its type and id, so it cannot be reflected", () => {
    const key = deriveContentKey(deviceKey, VECTOR.machinePubkey, VECTOR.deviceKeyId);
    expect(openText(key, VECTOR.sealed, sealedAad(VECTOR.machineKeyId, "user.message", VECTOR.promptId))).toBeNull();
    expect(openText(key, VECTOR.sealed, sealedAad(VECTOR.machineKeyId, "prompt.open", "OTHER"))).toBeNull();
    expect(openText(key, VECTOR.sealed, sealedAad(VECTOR.deviceKeyId, "prompt.open", VECTOR.promptId))).toBeNull();
  });

  it("passes plain v1 text through and refuses malformed sealed values instead of throwing", () => {
    const key = deriveContentKey(deviceKey, VECTOR.machinePubkey, VECTOR.deviceKeyId);
    const aad = sealedAad(VECTOR.machineKeyId, "prompt.open", VECTOR.promptId);
    expect(openText(key, "texto en claro", aad)).toBe("texto en claro");
    expect(openText(key, { s: 1, k: VECTOR.machineKeyId, n: "AAAA", c: "AAAA" } as never, aad)).toBeNull();
  });

  it("seals and opens JSON values such as prompt options", () => {
    const key = deriveContentKey(machineKey, VECTOR.devicePubkey, VECTOR.machineKeyId);
    const aad = sealedAad(VECTOR.machineKeyId, "prompt.open", "OPTIONS");
    const options = [{ id: "a", label: "Sí" }, { id: "b", label: "No" }];
    const sealed = sealJson(key, VECTOR.machineKeyId, options, aad);
    expect(openJson(key, sealed, aad)).toEqual(options);
    expect(openJson(key, sealed, sealedAad(VECTOR.machineKeyId, "prompt.settled", "OPTIONS"))).toBeNull();
  });
});
