import { parseDevices, sealTarget, sealedDevices } from "../shared/e2e/directory.js";
import { CAP_ENC, deriveContentKey, sealJson, sealText, sealedAad } from "../shared/e2e/seal.js";
const encoder = (v) => (typeof v === "string" ? v : null);
/**
 * Content sealing for protocol v2 (PROTOCOLO-V2.md §4, §10).
 *
 * Everything that would leak the conversation is sealed here, at the single place where a body
 * becomes an envelope. Ids, types, kind, category, danger, sizes and times stay readable: the
 * relay needs them to route, store and page.
 */
export function createSealer(o) {
    let devices = [];
    let cache = null;
    const keyFor = (device) => {
        if (cache && cache.deviceId === device.deviceId)
            return cache.key;
        const key = deriveContentKey(o.identity.privateKeyPem, device.pubkey, o.identity.keyId);
        cache = { deviceId: device.deviceId, key };
        return key;
    };
    const sealString = (value, device, t, id) => {
        const text = encoder(value);
        if (text === null)
            return value;
        return sealText(keyFor(device), o.identity.keyId, text, sealedAad(o.identity.keyId, t, id));
    };
    const sealOptions = (options, device, t, id) => {
        if (!Array.isArray(options))
            return options;
        return options.map((option) => {
            if (!option || typeof option !== "object")
                return option;
            const label = sealString(option.label, device, t, id);
            return { ...option, label };
        });
    };
    const pushBodies = (body, promptId) => {
        const ctx = o.ctx();
        const push = {
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
                ? body.options.slice(0, 3).map((option) => ({ id: String(option.id ?? ""), label: String(option.label ?? "") }))
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
    const sealPromptOpen = (d) => {
        const promptId = String(d.promptId ?? "");
        const target = sealTarget(devices);
        const out = { ...d };
        out.push = pushBodies(d, promptId);
        if (!target)
            return out;
        out.title = sealString(d.title, target, "prompt.open", promptId);
        if (d.message !== undefined && d.message !== null)
            out.message = sealString(d.message, target, "prompt.open", promptId);
        out.options = sealOptions(d.options, target, "prompt.open", promptId);
        if (Array.isArray(d.questions))
            out.questions = sealOptions(d.questions, target, "prompt.open", promptId);
        return out;
    };
    return {
        get caps() {
            return o.identity ? [CAP_ENC] : [];
        },
        updateDevices(raw) {
            const next = parseDevices(raw);
            if (next.length !== devices.length || next.some((d, i) => d.deviceId !== devices[i]?.deviceId || d.pubkey !== devices[i]?.pubkey)) {
                o.onLog?.(`e2e: ${next.length} device key(s) known, ${sealedDevices(next).length} with ${CAP_ENC}`);
            }
            devices = next;
            cache = null;
        },
        devices: () => devices,
        target: () => sealTarget(devices),
        async transform(t, d, opts) {
            if (!d || typeof d !== "object")
                return d;
            const body = d;
            const target = sealTarget(devices);
            switch (t) {
                case "prompt.open":
                    return sealPromptOpen(body);
                case "prompt.settled": {
                    if (!target)
                        return d;
                    const promptId = String(body.promptId ?? opts?.id ?? "");
                    return { ...body, preview: sealString(body.preview, target, "prompt.settled", promptId) };
                }
                case "agent.event": {
                    if (!target)
                        return d;
                    return {
                        ...body,
                        text: sealString(body.text, target, "agent.event"),
                        preview: sealString(body.preview, target, "agent.event"),
                        detail: sealString(body.detail, target, "agent.event"),
                    };
                }
                case "agent.snapshot": {
                    if (!target)
                        return d;
                    const items = Array.isArray(body.messages) ? body.messages : null;
                    if (!items)
                        return d;
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
