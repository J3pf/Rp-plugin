import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateMachineIdentity } from "../src/shared/e2e/identity.ts";
import { deriveContentKey, openJson, openText, sealedAad, type Sealed } from "../src/shared/e2e/seal.ts";
import { parseDevices } from "../src/shared/e2e/directory.ts";
import { createSealer } from "../src/extension/sealing.ts";

const machine = generateMachineIdentity();
const phone = generateMachineIdentity();
const tablet = generateMachineIdentity();

function device(identity: ReturnType<typeof generateMachineIdentity>, id: string) {
  return { deviceId: id, pubkey: identity.pubkey, caps: ["enc1"] };
}

/** Opens a field the way the phone would: derive the pair key from its own private key. */
function opener(identity: ReturnType<typeof generateMachineIdentity>, machinePubkey: string, ownKeyId: string) {
  const key = deriveContentKey(createPrivateKey(identity.privateKeyPem), machinePubkey, ownKeyId);
  return (value: unknown, t: string, id?: string) => openText(key, value as never, sealedAad(machine.keyId, t, id));
}

function makeSealer(devices: unknown) {
  const logs: string[] = [];
  const sealer = createSealer({
    identity: machine,
    ctx: () => ({ agentId: "agent-1", agentLabel: "pi@pc", machineId: "m1", machineName: "PC", machineContext: "personal" }),
    onLog: (m) => logs.push(m),
  });
  sealer.updateDevices(parseDevices(devices));
  return { sealer, logs };
}

const OPEN_PROMPT = {
  promptId: "P1",
  agentId: "agent-1",
  kind: "confirm",
  category: "permission",
  title: "¿Permitir rm -rf build?",
  message: "El agente quiere borrar la carpeta",
  options: [{ id: "yes", label: "Permitir" }, { id: "no", label: "Denegar" }],
  allowFreeText: false,
  danger: "high",
  expiresAt: "2026-01-01T00:10:00.000Z",
};

describe("sealing outbound content", () => {
  it("announces enc1 and seals prompt content for the paired phone", async () => {
    const { sealer } = makeSealer({ devices: [device(phone, "dev-1")] });
    expect(sealer.caps).toEqual(["enc1"]);

    const sealed = (await sealer.transform("prompt.open", OPEN_PROMPT)) as Record<string, any>;
    const open = opener(phone, machine.pubkey, phone.keyId);
    expect(open(sealed.title, "prompt.open", "P1")).toBe(OPEN_PROMPT.title);
    expect(open(sealed.message, "prompt.open", "P1")).toBe(OPEN_PROMPT.message);
    expect(open(sealed.options[0].label, "prompt.open", "P1")).toBe("Permitir");
    // Routing metadata stays readable so the relay can still route and the app can still render.
    expect(sealed.kind).toBe("confirm");
    expect(sealed.category).toBe("permission");
    expect(sealed.danger).toBe("high");
    expect(sealed.options[0].id).toBe("yes");
  });

  it("adds one sealed push body per device, each readable only by its own device", async () => {
    const { sealer } = makeSealer({ devices: [device(phone, "dev-1"), device(tablet, "dev-2")] });
    const sealed = (await sealer.transform("prompt.open", OPEN_PROMPT)) as Record<string, any>;

    expect(sealed.push).toHaveLength(2);
    expect(sealed.push.map((p: any) => p.deviceId).sort()).toEqual(["dev-1", "dev-2"]);

    const forPhone = sealed.push.find((p: any) => p.deviceId === "dev-1")!.body as Sealed;
    const forTablet = sealed.push.find((p: any) => p.deviceId === "dev-2")!.body as Sealed;
    const phoneKey = deriveContentKey(createPrivateKey(phone.privateKeyPem), machine.pubkey, phone.keyId);
    const tabletKey = deriveContentKey(createPrivateKey(tablet.privateKeyPem), machine.pubkey, tablet.keyId);

    const body = openJson<Record<string, any>>(phoneKey, forPhone, sealedAad(machine.keyId, "push"));
    expect(body).toMatchObject({ promptId: "P1", title: OPEN_PROMPT.title, agentLabel: "pi@pc", machineName: "PC", kind: "confirm" });
    expect(body?.options).toEqual(OPEN_PROMPT.options);
    // One device's push body must never open with another device's key.
    expect(openJson(tabletKey, forPhone, sealedAad(machine.keyId, "push"))).toBeNull();
  });

  it("leaves content in clear when no device can receive sealed text", async () => {
    // enc1 is a capability of this machine, not a promise about the current peer: until a device
    // key shows up in agent.welcome.devices there is nothing to seal for.
    const none = makeSealer({ devices: [] }).sealer;
    expect(none.caps).toEqual(["enc1"]);
    const clear = (await none.transform("prompt.open", OPEN_PROMPT)) as Record<string, unknown>;
    expect(clear.title).toBe(OPEN_PROMPT.title);
    expect(clear.push).toEqual([]);

    const v1Device = makeSealer({ devices: [{ deviceId: "old", pubkey: phone.pubkey, caps: [] }] }).sealer;
    const body = (await v1Device.transform("prompt.open", OPEN_PROMPT)) as Record<string, unknown>;
    expect(body.push).toEqual([]);
    expect(body.title).toBe(OPEN_PROMPT.title);
  });

  it("seals previews and streaming text, and never seals ids or types", async () => {
    const { sealer } = makeSealer({ devices: [device(phone, "dev-1")] });
    const open = opener(phone, machine.pubkey, phone.keyId);

    const event = (await sealer.transform("agent.event", { seq: 3, kind: "text", text: "hola", preview: "hol", detail: "detalle" })) as Record<string, any>;
    expect(event.seq).toBe(3);
    expect(event.kind).toBe("text");
    expect(open(event.text, "agent.event", undefined)).toBe("hola");
    expect(open(event.preview, "agent.event", undefined)).toBe("hol");
    expect(open(event.detail, "agent.event", undefined)).toBe("detalle");

    const settled = (await sealer.transform("prompt.settled", { promptId: "P1", preview: "Permitir" })) as Record<string, any>;
    expect(settled.promptId).toBe("P1");
    expect(open(settled.preview, "prompt.settled", "P1")).toBe("Permitir");
  });

  it("seals snapshot previews one item at a time", async () => {
    const { sealer } = makeSealer({ devices: [device(phone, "dev-1")] });
    const snapshot = (await sealer.transform("agent.snapshot", {
      messages: [{ seq: 1, lastPreview: "uno" }, { seq: 2, lastPreview: "dos" }],
    })) as Record<string, any>;
    const open = opener(phone, machine.pubkey, phone.keyId);
    expect(snapshot.messages[0].seq).toBe(1);
    // The preview is bound to the message seq, so a preview cannot be moved to another message.
    expect(open(snapshot.messages[1].lastPreview, "agent.snapshot", "1")).toBeNull();
    expect(open(snapshot.messages[1].lastPreview, "agent.snapshot", "2")).toBe("dos");
  });

  it("does not touch message types that carry no content", async () => {
    const { sealer } = makeSealer({ devices: [device(phone, "dev-1")] });
    const body = { agentId: "a", state: "ready", n: 2 };
    expect(await sealer.transform("agents.update", body)).toEqual(body);
  });
});

describe("device directory", () => {
  it("keeps only devices that publish a usable public key", () => {
    const devices = parseDevices({ devices: [
      { deviceId: "a", pubkey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBpNgzSIKWvYRmsv643aOPjva7-nOoWjHenfLsHUrqpOas6QhTKYc9wcUCLmzxyvIP-cIEKyV5nSuPWiNLc-tMw" },
      { deviceId: "b" },
      { deviceId: "c", pubkey: "" },
      { pubkey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBpNgzSIKWvYRmsv643aOPjva7-nOoWjHenfLsHUrqpOas6QhTKYc9wcUCLmzxyvIP-cIEKyV5nSuPWiNLc-tMw" },
      "junk",
      null,
    ] });
    expect(devices.map((d) => d.deviceId)).toEqual(["a"]);
    expect(parseDevices(undefined)).toEqual([]);
  });
});
