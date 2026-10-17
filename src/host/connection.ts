// rp-host ⇄ relay: wss://<relay>/ws/host (PROTOCOLO §9).
import os from "node:os";
import WebSocket from "ws";
import { MAX_FRAME_BYTES, CLOSE, envelope, parseEnvelope, type Envelope, type HostHelloBody, type HostQuotasBody } from "../shared/protocol.ts";
import { getProxyAgent, toWsUrl } from "../shared/http.ts";
import { backoffDelay, errMsg } from "../shared/util.ts";
import type { HostConfig } from "./config.ts";
import type { HostManager } from "./manager.ts";
import { HostError, listDirs } from "./validate.ts";

export interface HostConnectionOptions {
  relayUrl: string;
  machineId: string;
  token: string;
  cfg: HostConfig;
  manager: HostManager;
  onLog?: (m: string) => void;
  backoff?: (attempt: number) => number;
}

export class HostConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private quotaTimer: NodeJS.Timeout | null = null;

  constructor(private o: HostConnectionOptions) {}

  private log(m: string) {
    this.o.onLog?.(m);
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearWatchdog();
    this.stopQuotaTimer();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.ws?.close(1000);
    } catch {
      /* ignore */
    }
  }

  /** The relay pings every 25 s; silence beyond 70 s means a dead socket. */
  private arm(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => this.ws?.terminate(), 70_000);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private scheduleReconnect(code?: number): void {
    if (this.stopped) return;
    if (code === CLOSE.INVALID_TOKEN || code === CLOSE.INCOMPATIBLE) {
      this.log(`relay closed the connection with ${code}; not reconnecting`);
      this.stopped = true;
      return;
    }
    const delay = code === CLOSE.SERVICE_RESTART ? 0 : (this.o.backoff ?? backoffDelay)(this.attempt++);
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
      });
    } catch (e) {
      this.log(`ws connect failed: ${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      this.arm();
      this.startQuotaTimer();
      void this.hello();
    });
    ws.on("ping", () => this.arm());
    ws.on("message", (data) => {
      this.arm();
      const env = parseEnvelope(data.toString("utf8"));
      if (env) void this.handle(env);
    });
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.log(`relay rejected auth with http ${res.statusCode}; not reconnecting`);
        this.stopped = true;
      }
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    });
    ws.on("close", (code) => {
      this.clearWatchdog();
      this.stopQuotaTimer();
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect(code);
    });
  }

  private sendEnv(e: Envelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(e));
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
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      const quotas = await this.o.manager.collectQuotas();
      if (quotas && this.ws?.readyState === WebSocket.OPEN) {
        const body: HostQuotasBody = { quotas };
        this.sendEnv(envelope("host.quotas", body));
      }
    } catch (e) {
      this.log(`error polling quotas: ${(e as Error).message}`);
    }
  }

  async hello(): Promise<void> {
    const rep = await this.o.manager.detect(true);
    const def = await this.o.manager.defaultBackend();
    const quotas = await this.o.manager.collectQuotas();
    const body: HostHelloBody = {
      machineId: this.o.machineId,
      hostname: os.hostname(),
      roots: this.o.cfg.roots,
      backends: { herdr: rep.herdr, tmux: rep.tmux, wt: rep.wt, console: rep.console },
      defaultBackend: def,
      launchers: Object.keys(this.o.cfg.launchers),
      defaultLauncher: this.o.cfg.defaultLauncher,
    };
    if (quotas && quotas.length > 0) {
      body.quotas = quotas;
    }
    this.sendEnv(envelope("host.hello", body));
  }

  /** Handle one relay request; always answers with `re` = request id. */
  async handle(env: Envelope): Promise<void> {
    const d: any = env.d ?? {};
    const reply = (t: string, body: unknown) => this.sendEnv(envelope(t, body, { re: env.id }));
    try {
      if (d.machineId && d.machineId !== this.o.machineId) throw new HostError("bad_request", "machineId mismatch");
      switch (env.t) {
        case "host.list_dirs":
          return reply("host.dirs", listDirs(this.o.cfg, String(d.path ?? "")));
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
            herdr: rec.herdr ? { workspaceId: rec.herdr.workspaceId, paneId: rec.herdr.paneId } : null,
            tmuxSession: rec.tmuxSession,
          });
        }
        case "host.kill":
          await this.o.manager.kill(d.spawnId);
          return reply("ack", {});
        case "error":
          this.log(`relay error: ${d.code} ${d.message}`);
          return;
        default:
          return;
      }
    } catch (e) {
      const code = e instanceof HostError ? e.code : "internal";
      this.log(`${env.t} failed: ${errMsg(e)}`);
      reply("error", { code, message: errMsg(e) });
    }
  }
}

export function parseTarget(t: any) {
  if (!t || typeof t !== "object") return undefined;
  if (t.type === "workspace") return { type: "workspace" as const };
  if (t.type === "tab" && typeof t.workspaceId === "string" && t.workspaceId) return { type: "tab" as const, workspaceId: t.workspaceId };
  if (t.type === "split" && typeof t.paneId === "string" && t.paneId) {
    return { type: "split" as const, paneId: t.paneId, direction: t.direction === "down" ? ("down" as const) : ("right" as const) };
  }
  throw new HostError("bad_request", "invalid herdrTarget");
}
