// rp-host ⇄ relay: wss://<relay>/ws/host (PROTOCOLO §9).
import os from "node:os";
import WebSocket from "ws";
import { MAX_FRAME_BYTES, CLOSE, envelope, parseEnvelope, type Envelope, type HostHelloBody, type HostQuotasBody } from "../shared/protocol.ts";
import { WsKeepalive, getProxyAgent, toWsUrl } from "../shared/http.ts";
import { backoffDelay, errMsg } from "../shared/util.ts";
import type { HostConfig } from "./config.ts";
import type { HostManager } from "./manager.ts";
import { HostError, listDirs, validateSessionId } from "./validate.ts";
import { gitDiff, gitDiscard } from "./git.ts";

const MAX_CONCURRENT_RPCS = 4;
const MAX_QUEUED_RPCS = 32;
const STABILITY_WINDOW_MS = 5_000;

export interface HostConnectionOptions {
  relayUrl: string;
  machineId: string;
  token: string;
  cfg: HostConfig;
  manager: HostManager;
  redactContent?: boolean;
  onLog?: (m: string) => void;
  backoff?: (attempt: number) => number;
  random?: () => number;
  maxConcurrentRpcs?: number;
  maxQueuedRpcs?: number;
}

export class HostConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private restartAttempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  /** The relay pings every 25 s, client pings every 20 s; silence beyond 70 s means a dead socket. */
  private keepalive = new WsKeepalive(70_000, 20_000);
  private quotaTimer: NodeJS.Timeout | null = null;
  private quotaPolling = false;
  private inFlightRpcs = 0;
  private rpcQueue: Array<() => void> = [];

  constructor(private o: HostConnectionOptions) {}

  private log(m: string) {
    this.o.onLog?.(m);
  }

  start(): void {
    void this.connect();
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
  }

  private armStabilityTimer(): void {
    this.clearStabilityTimer();
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null;
      this.attempt = 0;
      this.restartAttempt = 0;
    }, STABILITY_WINDOW_MS);
    this.stabilityTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.keepalive.stop();
    this.stopQuotaTimer();
    this.clearStabilityTimer();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* ignore */
    }
  }

  private computeRestartDelay(): number {
    const rnd = this.o.random ?? Math.random;
    const baseJitter = 250 + rnd() * 1250; // 250–1500ms
    const factor = 2 ** Math.min(this.restartAttempt++, 5);
    return Math.min(30_000, Math.round(baseJitter * factor));
  }

  private scheduleReconnect(code?: number): void {
    if (this.stopped) return;
    if (code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE || code === CLOSE.REPLACED) {
      this.log(`relay closed the connection with ${code}; not reconnecting`);
      this.stopped = true;
      return;
    }
    let delay: number;
    if (code === CLOSE.SERVICE_RESTART) {
      delay = this.computeRestartDelay();
    } else {
      this.restartAttempt = 0;
      delay = (this.o.backoff ?? backoffDelay)(this.attempt++);
    }
    this.log(`reconnecting in ${delay}ms (close=${code ?? "none"})`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
    this.timer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const agent = await getProxyAgent();
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWsUrl(this.o.relayUrl, "/ws/host"), {
        headers: { Authorization: `Bearer ${this.o.token}` },
        agent,
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: 10_000,
        perMessageDeflate: {
          threshold: 1024,
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
        },
      });
    } catch (e) {
      this.log(`ws connect failed: ${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let lastWsError: string | null = null;
    ws.on("open", () => {
      if (this.stopped || this.ws !== ws) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      lastWsError = null;
      this.armStabilityTimer();
      this.keepalive.start(ws, WebSocket.OPEN);
      this.startQuotaTimer();
      void this.hello(ws).catch((e) => this.log(`hello failed: ${errMsg(e)}`));
    });
    ws.on("ping", () => this.keepalive.arm(ws));
    ws.on("pong", () => this.keepalive.arm(ws));
    ws.on("message", (data) => {
      if (this.stopped || this.ws !== ws) return;
      this.keepalive.arm(ws);
      const env = parseEnvelope(data.toString("utf8"));
      if (env) void this.handle(env);
    });
    ws.on("error", (err) => {
      lastWsError = errMsg(err);
      if (!this.stopped && this.ws === ws) {
        this.log(`ws error: ${lastWsError}`);
      }
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.log(`relay rejected auth with http ${res.statusCode}; not reconnecting`);
        this.stopped = true;
      } else {
        this.log(`relay rejected upgrade with http ${res.statusCode ?? "unknown"}`);
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    });
    ws.on("close", (code, reasonBuf) => {
      this.keepalive.stop();
      this.stopQuotaTimer();
      this.clearStabilityTimer();
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString("utf8").trim() : String(reasonBuf ?? "").trim();
      const details = [reason ? `reason=${reason}` : "", lastWsError ? `error=${lastWsError}` : ""].filter(Boolean).join(", ");
      this.log(`ws closed (code=${code}${details ? `, ${details}` : ""})`);
      this.scheduleReconnect(code);
    });
  }

  private sendEnv(e: Envelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(e));
    } catch {
      /* ignore transient send error */
    }
  }

  private startQuotaTimer(): void {
    this.stopQuotaTimer();
    const sec = this.o.cfg.quotaIntervalSec;
    if (!this.o.cfg.quotaEnabled || !sec || sec <= 0) return;
    this.quotaTimer = setInterval(() => void this.pollQuotas(), sec * 1000);
    this.quotaTimer.unref?.();
  }

  private stopQuotaTimer(): void {
    if (this.quotaTimer) {
      clearInterval(this.quotaTimer);
      this.quotaTimer = null;
    }
  }

  async pollQuotas(): Promise<void> {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.quotaPolling) return;
    const ws = this.ws;
    this.quotaPolling = true;
    try {
      const quotas = await this.o.manager.collectQuotas();
      if (!this.stopped && this.ws === ws && ws.readyState === WebSocket.OPEN && quotas) {
        const body: HostQuotasBody = { quotas };
        this.sendEnv(envelope("host.quotas", body));
      }
    } catch (e) {
      this.log(`error polling quotas: ${(e as Error).message}`);
    } finally {
      this.quotaPolling = false;
    }
  }

  async hello(ws?: WebSocket): Promise<void> {
    const rep = await this.o.manager.detect(true);
    const def = await this.o.manager.defaultBackend();
    if (this.stopped || (ws && this.ws !== ws)) return;
    const body: HostHelloBody = {
      machineId: this.o.machineId,
      hostname: os.hostname(),
      roots: this.o.cfg.roots,
      backends: { herdr: rep.herdr, tmux: rep.tmux, wt: rep.wt, console: rep.console },
      ...(def ? { defaultBackend: def } : {}),
      launchers: Object.keys(this.o.cfg.launchers),
      defaultLauncher: this.o.cfg.defaultLauncher,
    };
    const quotas = this.o.manager.getLastQuotas?.() ?? null;
    if (quotas && quotas.length > 0) {
      body.quotas = quotas;
    }
    this.sendEnv(envelope("host.hello", body));
    void this.pollQuotas();
  }

  private async acquireRpcSlot(): Promise<boolean> {
    const maxConcurrent = Math.max(1, this.o.maxConcurrentRpcs ?? MAX_CONCURRENT_RPCS);
    const maxQueued = Math.max(0, this.o.maxQueuedRpcs ?? MAX_QUEUED_RPCS);
    if (this.inFlightRpcs < maxConcurrent) {
      this.inFlightRpcs++;
      return true;
    }
    if (this.rpcQueue.length >= maxQueued) {
      return false;
    }
    await new Promise<void>((resolve) => {
      this.rpcQueue.push(resolve);
    });
    // Slot ownership is transferred synchronously by releaseRpcSlot().
    return true;
  }

  private releaseRpcSlot(): void {
    const next = this.rpcQueue.shift();
    if (next) {
      next();
      return;
    }
    this.inFlightRpcs = Math.max(0, this.inFlightRpcs - 1);
  }

  /** Handle one relay request; always answers with `re` = request id. */
  async handle(env: Envelope): Promise<void> {
    const d: any = env.d ?? {};
    const reply = (t: string, body: unknown) => this.sendEnv(envelope(t, body, { re: env.id }));
    if (env.t === "error") {
      this.log(`relay error: ${d.code} ${d.message}`);
      return;
    }
    const acquired = await this.acquireRpcSlot();
    if (!acquired) {
      this.log(`${env.t} rejected: too many concurrent host requests`);
      reply("error", { code: "internal", message: "too many concurrent host requests" });
      return;
    }
    try {
      if (d.machineId && d.machineId !== this.o.machineId) throw new HostError("bad_request", "machineId mismatch");
      switch (env.t) {
        case "host.list_dirs":
          return reply("host.dirs", listDirs(this.o.cfg, String(d.path ?? "")));
        case "host.git_diff": {
          const res = await gitDiff(
            this.o.cfg,
            String(d.cwd ?? ""),
            typeof d.path === "string" ? d.path : undefined,
            { redactContent: !!this.o.redactContent },
          );
          return reply("host.git_diff.result", res);
        }
        case "host.git_discard": {
          const res = await gitDiscard(this.o.cfg, String(d.cwd ?? ""), String(d.path ?? ""));
          return reply("host.git_discard.result", res);
        }
        case "host.herdr_layout":
          return reply("host.herdr_layout.result", await this.o.manager.herdrLayout());
        case "host.spawn": {
          const rec = await this.o.manager.spawn({
            cwd: String(d.cwd ?? ""),
            name: typeof d.name === "string" ? d.name : undefined,
            launcher: typeof d.launcher === "string" ? d.launcher : undefined,
            backend: ["herdr", "tmux", "wt", "console"].includes(d.backend) ? d.backend : undefined,
            herdrTarget: parseTarget(d.herdrTarget),
            sessionId: typeof d.sessionId === "string" && d.sessionId.trim() ? d.sessionId.trim() : undefined,
          });
          return reply("host.spawned", {
            spawnId: rec.spawnId,
            backend: rec.backend,
            herdr: rec.herdr?.paneId ? { workspaceId: rec.herdr.workspaceId ?? "", paneId: rec.herdr.paneId } : null,
            tmuxSession: rec.tmuxSession,
          });
        }
        case "host.kill":
          await this.o.manager.kill(d.spawnId);
          return reply("ack", {});
        case "host.herdr_close":
          return reply("host.herdr_closed", await this.o.manager.herdrClose(d.paneId));
        default:
          return;
      }
    } catch (e) {
      const code = e instanceof HostError ? e.code : "internal";
      this.log(`${env.t} failed: ${errMsg(e)}`);
      reply("error", { code, message: errMsg(e) });
    } finally {
      this.releaseRpcSlot();
    }
  }
}

export function parseTarget(t: any) {
  if (!t || typeof t !== "object") return undefined;
  if (t.type === "workspace") return { type: "workspace" as const };
  if (t.type === "tab" && typeof t.workspaceId === "string" && t.workspaceId) {
    return { type: "tab" as const, workspaceId: validateSessionId(t.workspaceId) };
  }
  if (t.type === "split" && typeof t.paneId === "string" && t.paneId) {
    return {
      type: "split" as const,
      paneId: validateSessionId(t.paneId),
      direction: t.direction === "down" ? ("down" as const) : ("right" as const),
    };
  }
  throw new HostError("bad_request", "invalid herdrTarget");
}
