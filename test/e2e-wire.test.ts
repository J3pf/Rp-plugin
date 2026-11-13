import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Connection } from "../src/extension/connection.ts";
import { createSealer } from "../src/extension/sealing.ts";
import { generateMachineIdentity, loadOrCreateMachineIdentity } from "../src/shared/e2e/identity.ts";
import { CAP_ENC, deriveContentKey, openText, sealedAad, type Sealed } from "../src/shared/e2e/seal.ts";
import { FakeRelay } from "./helpers.ts";

const phone = generateMachineIdentity();
let relay: FakeRelay | undefined;
afterEach(async () => {
  await relay?.stop();
  relay = undefined;
});

function openForPhone(machinePubkey: string, machineKeyId: string) {
  const key = deriveContentKey(createPrivateKey(phone.privateKeyPem), machinePubkey, phone.keyId);
  return (value: unknown, t: string, id?: string) => openText(key, value as never, sealedAad(machineKeyId, t, id));
}

/** Waits until the relay has received an envelope of the given type. */
async function received(r: FakeRelay, t: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = r.all.filter((e) => e.t === t);
    if (found.length) return found;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`no ${t} envelope reached the relay`);
}

describe("sealed content on the wire", () => {
  it("seals prompt content in order and advertises enc1 in agent.hello", async () => {
    relay = await new FakeRelay().start();
    const machine = loadOrCreateMachineIdentity(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rpwire-")), "machine.key")).identity;
    relay.welcomeBody = { serverTime: Date.now(), lastSeq: null, pendingAnswers: [], devices: [{ deviceId: "dev-1", pubkey: phone.pubkey, caps: [CAP_ENC] }] };

    const sealer = createSealer({
      identity: machine,
      ctx: () => ({ agentId: "a1", agentLabel: "pi@pc", machineId: "m1", machineName: "PC", machineContext: "personal" }),
    });
    const conn = new Connection({
      relayUrl: relay.url,
      token: "tok",
      agentId: "a1",
      instance: "i1",
      sealer,
      makeHello: () => ({ agentId: "a1", kind: "pi", instance: "i1", epoch: "e1", caps: sealer.caps }),
      onWelcome: (w) => sealer.updateDevices((w as { devices?: unknown }).devices),
      onMessage: () => {},
      onState: () => {},
    });
    conn.start();

    await received(relay, "agent.hello");
    await new Promise((r) => setTimeout(r, 50));
    const hello = (await received(relay, "agent.hello"))[0]!.d as Record<string, unknown>;
    expect(hello.caps).toEqual([CAP_ENC]);

    conn.send("prompt.open", { promptId: "P1", kind: "confirm", category: "permission", title: "¿Permitir?", message: "detalle", options: [{ id: "yes", label: "Sí" }] });
    conn.send("prompt.settled", { promptId: "P1", preview: "Sí" });

    const opens = await received(relay, "prompt.open");
    const settled = await received(relay, "prompt.settled");
    const open = openForPhone(machine.pubkey, machine.keyId);
    const openBody = opens[0]!.d as Record<string, unknown>;
    expect(open(openBody.title, "prompt.open", "P1")).toBe("¿Permitir?");
    expect((openBody.push as Array<{ deviceId: string; body: Sealed }>)[0]!.deviceId).toBe("dev-1");
    expect(open((settled[0]!.d as Record<string, unknown>).preview, "prompt.settled", "P1")).toBe("Sí");
    // Order is preserved across two sealed sends.
    expect(relay.all.findIndex((e) => e.t === "prompt.open")).toBeLessThan(relay.all.findIndex((e) => e.t === "prompt.settled"));
    conn.stop();
  });
});
