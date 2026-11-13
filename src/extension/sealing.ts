import type { MachineIdentity } from "../shared/e2e/identity.ts";
import { type DeviceKey, parseDevices, sealTarget, sealedDevices } from "../shared/e2e/directory.ts";
import { CAP_ENC, type Sealed, deriveContentKey, sealJson, sealText, sealedAad } from "../shared/e2e/seal.ts";

export interface SealingContext {
  agentId: string;
  agentLabel: string;
  machineId: string;
  machineName: string;
  machineContext: string;
}

export interface Sealer {
  /** Advertised in `agent.hello`: sealed content is possible as soon as we know the devices. */
  caps: string[];
  updateDevices(raw: unknown): void;
  devices(): DeviceKey[];
  target(): DeviceKey | null;
  /** Seals the content fields of one outbound envelope body. Unknown types pass through untouched. */
  transform(t: string, d: unknown, opts?: { id?: string }): Promise<unknown>;
}

export interface SealerOptions {
  identity: MachineIdentity;
  ctx: () => SealingContext;
  onLog?: (line: string) => void;
}

/** Shapes of the push body, mirroring what the relay built for v1 so the phone renders the same thing. */
interface PushBody {
  promptId: string;
  agentId: string;
  agentLabel: string;
  machineId: string;
  machineName: string;
  machineContext: string;
  kind: string;
  category?: string;
  title: string;
  message: string | null;
  options: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
  danger?: string;
}

const encoder = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Content sealing for protocol v2 (PROTOCOLO-V2.md §4, §10).
 *
 * Everything that would leak the conversation is sealed here, at the single place where a body
 * becomes an envelope. Ids, types, kind, category, danger, sizes and times stay readable: the
 * relay needs them to route, store and page.
 */
export function createSealer(o: SealerOptions): Sealer {
  let devices: DeviceKey[] = [];
  let cache: { deviceId: string; key: Buffer } | null = null;

  const keyFor = (device: DeviceKey): Buffer => {
    if (cache && cache.deviceId === device.deviceId) return cache.key;
    const key = deriveContentKey(o.identity.privateKeyPem, device.pubkey, o.identity.keyId);
    cache = { deviceId: device.deviceId, key };
    return key;
  };

  const sealString = (value: unknown, device: DeviceKey, t: string, id?: string): unknown => {
    const text = encoder(value);
    if (text === null) return value;
    return sealText(keyFor(device), o.identity.keyId, text, sealedAad(o.identity.keyId, t, id));
  };

  const sealOptions = (options: unknown, device: DeviceKey, t: string, id?: string): unknown => {
    if (!Array.isArray(options)) return options;
    return options.map((option) => {
      if (!option || typeof option !== "object") return option;
      const label = sealString((option as { label?: unknown }).label, device, t, id);
      return { ...(option as Record<string, unknown>), label };
    });
  };

  const pushBodies = (body: Record<string, unknown>, promptId: string): Array<{ deviceId: string; body: Sealed }> => {
    const ctx = o.ctx();
    const push: PushBody = {
      promptId,
      agentId: ctx.agentId,
      agentLabel: ctx.agentLabel,
      machineId: ctx.machineId,
      machineName: ctx.machineName,
      machineContext: ctx.machineContext,
      kind: String(body.kind ?? "confirm"),
      category: encoder(body.category) ?? undefined,
      title: String(body.title ?? ""),
      message: encoder(body.message),
      options: Array.isArray(body.options)
        ? (body.options as Array<{ id?: unknown; label?: unknown }>).slice(0, 3).map((option) => ({ id: String(option.id ?? ""), label: String(option.label ?? "") }))
        : [],
      allowFreeText: body.allowFreeText === true,
      danger: encoder(body.danger) ?? undefined,
    };
    const aad = sealedAad(o.identity.keyId, "push", promptId);
    // Fan-out per device: N copies of one body, each readable only by its owner (§10).
    return sealedDevices(devices).map((device) => ({
      deviceId: device.deviceId,
      body: sealJson(keyFor(device), o.identity.keyId, push, aad),
    }));
  };

  const sealPromptOpen = (d: Record<string, unknown>): Record<string, unknown> => {
    const promptId = String(d.promptId ?? "");
    const target = sealTarget(devices);
    const out: Record<string, unknown> = { ...d };
    out.push = pushBodies(d, promptId);
    if (!target) return out;
    out.title = sealString(d.title, target, "prompt.open", promptId);
    if (d.message !== undefined && d.message !== null) out.message = sealString(d.message, target, "prompt.open", promptId);
    out.options = sealOptions(d.options, target, "prompt.open", promptId);
    if (Array.isArray(d.questions)) out.questions = sealOptions(d.questions, target, "prompt.open", promptId);
    return out;
  };

  return {
    get caps() {
      return o.identity ? [CAP_ENC] : [];
    },
    updateDevices(raw: unknown) {
      const next = parseDevices(raw);
      if (next.length !== devices.length || next.some((d, i) => d.deviceId !== devices[i]?.deviceId || d.pubkey !== devices[i]?.pubkey)) {
        o.onLog?.(`e2e: ${next.length} device key(s) known, ${sealedDevices(next).length} with ${CAP_ENC}`);
      }
      devices = next;
      cache = null;
    },
    devices: () => devices,
    target: () => sealTarget(devices),
    async transform(t: string, d: unknown, opts?: { id?: string }) {
      if (!d || typeof d !== "object") return d;
      const body = d as Record<string, unknown>;
      const target = sealTarget(devices);

      switch (t) {
        case "prompt.open":
          return sealPromptOpen(body);
        case "prompt.settled": {
          if (!target) return d;
          const promptId = String(body.promptId ?? opts?.id ?? "");
          return { ...body, preview: sealString(body.preview, target, "prompt.settled", promptId) };
        }
        case "agent.event": {
          if (!target) return d;
          return {
            ...body,
            text: sealString(body.text, target, "agent.event"),
            preview: sealString(body.preview, target, "agent.event"),
            detail: sealString(body.detail, target, "agent.event"),
          };
        }
        case "agent.snapshot": {
          if (!target) return d;
          const items = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : null;
          if (!items) return d;
          return {
            ...body,
            messages: items.map((item) => ({ ...item, lastPreview: sealString(item.lastPreview, target, "agent.snapshot", String(item.seq ?? "")) })),
          };
        }
        default:
          return d;
      }
    },
  };
}
