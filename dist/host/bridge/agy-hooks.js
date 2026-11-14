// Antigravity CLI (agy) PreToolUse hook entrypoint, authenticated gate IPC helpers, and hook config installer.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { compilePatterns, decide } from "../../extension/prompts/gate.js";
import { configDir } from "../../shared/platform.js";
import { atomicWriteFileSync, safeUser } from "../../shared/util.js";
import { parseAgyArgs } from "../agy-transcript.js";
export const AGY_GATE_SOCKET_TIMEOUT_MS = 300_000;
export const AGY_HOOK_CLIENT_TIMEOUT_MS = 280_000;
export const AGY_HOOK_CONFIG_TIMEOUT_SEC = 300;
export const GATE_MAX_LINE_BYTES = 256 * 1024;
export function sanitizeIdPart(raw) {
    return raw.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80);
}
export function gateSocketPath(env = process.env, platform = process.platform) {
    if (platform === "win32") {
        const user = sanitizeIdPart(safeUser());
        return `\\\\.\\pipe\\rp-agy-gate-${user}`;
    }
    return path.join(configDir(env, platform), "agy-gate.sock");
}
function deriveGateKey(token) {
    if (!token)
        return null;
    return createHmac("sha256", "rp-agy-gate-v1").update(token, "utf8").digest();
}
export function signGatePayload(token, parts) {
    const key = deriveGateKey(token ?? "");
    if (!key)
        return undefined;
    return createHmac("sha256", key).update(parts.join("\0"), "utf8").digest("hex");
}
export function verifyGateSignature(token, parts, sig) {
    const expected = signGatePayload(token, parts);
    if (!expected)
        return true;
    if (typeof sig !== "string" || sig.length !== expected.length)
        return false;
    try {
        return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
    }
    catch {
        return false;
    }
}
/** Check whether an existing Unix socket is actively held by a live daemon process. */
export function probeUnixSocketAlive(sockPath, timeoutMs = 150) {
    return new Promise((resolve) => {
        const probe = net.createConnection(sockPath);
        let settled = false;
        const done = (alive) => {
            if (settled)
                return;
            settled = true;
            try {
                probe.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(alive);
        };
        probe.setTimeout(timeoutMs, () => done(false));
        probe.on("connect", () => done(true));
        probe.on("error", () => done(false));
    });
}
/**
 * Executed by Antigravity CLI on `PreToolUse` (`rp-host agy-hook PreToolUse`).
 * MUST write exactly one JSON object to stdout and exit 0.
 */
export async function runAgyHook(cfg, stdinText, sockPath = gateSocketPath()) {
    if (!cfg.enabled)
        return { decision: "ask" };
    let payload;
    try {
        payload = JSON.parse(stdinText);
    }
    catch {
        return { decision: "ask", reason: "RP: entrada de hook inválida (JSON malformado)" };
    }
    const rawToolName = String(payload?.toolCall?.name ?? "");
    if (rawToolName !== "run_command")
        return { decision: "allow" };
    const args = parseAgyArgs(payload?.toolCall?.args ?? payload?.toolCall?.arguments);
    const command = String(args.CommandLine ?? args.command ?? args.commandLine ?? args.cmd ?? "").trim();
    if (!command)
        return { decision: "ask", reason: "RP: comando no identificado; confirmar en terminal" };
    const mode = cfg.gate.mode === "auto-detect" ? "dangerous" : cfg.gate.mode;
    if (mode === "off")
        return { decision: "ask" };
    const patterns = compilePatterns(cfg.gate.dangerousPatterns);
    const dec = decide(mode, cfg.gate, patterns, "bash", { command });
    if (!dec.ask)
        return { decision: "allow" };
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId : "";
    if (!conversationId)
        return { decision: "ask", reason: "RP: comando peligroso detectado" };
    const nonce = randomBytes(16).toString("hex");
    const paneId = process.env.HERDR_PANE_ID ?? "";
    const sig = signGatePayload(cfg.machineToken, ["req", conversationId, paneId, command, nonce]);
    return new Promise((resolve) => {
        const client = net.createConnection(sockPath);
        client.setEncoding("utf8");
        let settled = false;
        const finish = (res) => {
            if (settled)
                return;
            settled = true;
            try {
                client.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(res);
        };
        const timer = setTimeout(() => finish({ decision: "ask", reason: "RP: tiempo de espera agotado; confirmar en terminal" }), AGY_HOOK_CLIENT_TIMEOUT_MS);
        timer.unref?.();
        client.on("error", () => {
            clearTimeout(timer);
            finish({ decision: "ask", reason: "RP: comando peligroso detectado (rp-host inactivo)" });
        });
        client.on("connect", () => {
            const req = {
                conversationId,
                workspacePaths: payload?.workspacePaths,
                transcriptPath: payload?.transcriptPath,
                paneId,
                command,
                danger: dec.danger,
                allowKey: dec.key,
                nonce,
                ...(sig ? { sig } : {}),
            };
            client.write(JSON.stringify(req) + "\n");
        });
        let buf = "";
        client.on("data", (chunk) => {
            if (buf.length + chunk.length > GATE_MAX_LINE_BYTES) {
                clearTimeout(timer);
                finish({ decision: "ask", reason: "RP: respuesta de gate demasiado grande" });
                return;
            }
            buf += chunk;
            const nl = buf.indexOf("\n");
            if (nl < 0)
                return;
            clearTimeout(timer);
            try {
                const parsed = JSON.parse(buf.slice(0, nl).trim());
                const decision = parsed?.decision;
                const reason = typeof parsed?.reason === "string" ? parsed.reason : undefined;
                if (decision === "allow" || decision === "deny" || decision === "ask") {
                    if (!verifyGateSignature(cfg.machineToken, ["res", decision, reason ?? "", nonce], parsed?.sig)) {
                        finish({ decision: "ask", reason: "RP: respuesta de gate no autenticada" });
                        return;
                    }
                    finish(reason !== undefined ? { decision, reason } : { decision });
                    return;
                }
            }
            catch {
                /* fallthrough */
            }
            finish({ decision: "ask", reason: "RP: comando peligroso detectado" });
        });
        client.on("close", () => {
            clearTimeout(timer);
            finish({ decision: "ask", reason: "RP: comando peligroso detectado" });
        });
    });
}
/** Install or update the rp-gate PreToolUse hook inside ~/.gemini/config/hooks.json without touching other hooks. */
export function installAgyHooks(nodePath, scriptPath, home = os.homedir(), platform = process.platform) {
    const hooksFile = path.join(home, ".gemini", "config", "hooks.json");
    let current = {};
    try {
        current = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
        if (!current || typeof current !== "object" || Array.isArray(current))
            current = {};
    }
    catch {
        current = {};
    }
    const hookCommand = platform === "win32"
        ? `"${nodePath.replace(/"/g, '""')}" "${scriptPath.replace(/"/g, '""')}" agy-hook PreToolUse`
        : `'${nodePath.replace(/'/g, "'\\''")}' '${scriptPath.replace(/'/g, "'\\''")}' agy-hook PreToolUse`;
    current["rp-gate"] = {
        enabled: true,
        PreToolUse: [
            {
                matcher: "run_command",
                hooks: [
                    {
                        type: "command",
                        command: hookCommand,
                        timeout: AGY_HOOK_CONFIG_TIMEOUT_SEC,
                    },
                ],
            },
        ],
    };
    atomicWriteFileSync(hooksFile, JSON.stringify(current, null, 2) + "\n", 0o600);
    return hooksFile;
}
