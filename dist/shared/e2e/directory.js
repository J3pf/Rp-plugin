import { CAP_ENC } from "./seal.js";
const MIN_PUBKEY_LENGTH = 60;
function isDeviceKey(value) {
    if (!value || typeof value !== "object")
        return false;
    const d = value;
    return typeof d.deviceId === "string" && d.deviceId.length > 0 && typeof d.pubkey === "string" && d.pubkey.length >= MIN_PUBKEY_LENGTH;
}
/** Reads the device directory out of a welcome body, dropping anything without a usable public key. */
export function parseDevices(raw) {
    const list = Array.isArray(raw) ? raw : raw?.devices;
    if (!Array.isArray(list))
        return [];
    const out = [];
    for (const entry of list) {
        if (!isDeviceKey(entry))
            continue;
        const caps = Array.isArray(entry.caps) ? entry.caps.filter((c) => typeof c === "string") : [];
        if (out.some((d) => d.deviceId === entry.deviceId))
            continue;
        out.push({ deviceId: entry.deviceId, pubkey: entry.pubkey, caps });
    }
    return out;
}
/** Devices that advertised the sealed-content capability. */
export function sealedDevices(devices) {
    return devices.filter((d) => d.caps.includes(CAP_ENC));
}
/**
 * The single device we may seal conversational content for.
 *
 * `prompt.open` carries one title, one message and one option list, so it can only be sealed for
 * one recipient. With several `enc1` devices the fan-out is only defined for the per-device push
 * body (PROTOCOLO-V2.md §10), so conversational content stays in clear rather than becoming
 * unreadable for everyone but one phone. Multi-device conversational fan-out is tracked in
 * odd/tasks/multi-endpoint.md.
 */
export function sealTarget(devices) {
    const candidates = sealedDevices(devices);
    return candidates.length === 1 ? candidates[0] : null;
}
