// Authenticated Unix-socket / Windows named-pipe PreToolUse gate IPC server for agy.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SAFE_CONV_ID_RE, errMsg } from "../../shared/util.ts";
import { validatePaneId } from "../validate.ts";
import {
  AGY_GATE_SOCKET_TIMEOUT_MS,
  GATE_MAX_LINE_BYTES,
  probeUnixSocketAlive,
  signGatePayload,
  verifyGateSignature,
  type GateHookDecision,
} from "./agy-hooks.ts";

export interface GateSocketRequest {
  conversationId: string;
  paneId: string;
  command: string;
  danger?: unknown;
  workspacePaths?: unknown;
  transcriptPath?: unknown;
  nonce: string;
}

export interface AgyGateServerOptions {
  sockPath: string;
  token: string;
  onRequest: (req: GateSocketRequest, signal: AbortSignal) => Promise<GateHookDecision>;
  onLog?: (msg: string) => void;
}

const GATE_MAX_CONNECTIONS = 64;

export class AgyGateServer {
  private _server: net.Server | null = null;
  private _ownsSocket = false;
  private socketIno: number | null = null;
  private clientSockets = new Set<net.Socket>();
  private stopped = false;

  constructor(private readonly opts: AgyGateServerOptions) {}

  get server(): net.Server | null {
    return this._server;
  }

  get ownsSocket(): boolean {
    return this._ownsSocket;
  }

  start(): void {
    try {
      if (process.platform !== "win32") {
        const sockDir = path.dirname(this.opts.sockPath);
        fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
        try {
          fs.chmodSync(sockDir, 0o700);
        } catch {
          /* ignore */
        }
        if (fs.existsSync(this.opts.sockPath)) {
          void probeUnixSocketAlive(this.opts.sockPath).then((alive) => {
            if (this.stopped) return;
            if (alive) {
              this.opts.onLog?.(`gate socket already held by another live process: ${this.opts.sockPath}`);
              return;
            }
            try {
              fs.rmSync(this.opts.sockPath, { force: true });
            } catch {
              /* ignore */
            }
            this.bind();
          });
          return;
        }
      }
      this.bind();
    } catch (e) {
      this.opts.onLog?.(`failed to start gate socket: ${errMsg(e)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this._server) {
      try {
        this._server.close();
      } catch {
        /* ignore */
      }
      this._server = null;
    }
    for (const socket of this.clientSockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clientSockets.clear();
    const shouldUnlink = this._ownsSocket && this.socketIno !== null;
    const expectedIno = this.socketIno;
    this._ownsSocket = false;
    this.socketIno = null;
    if (process.platform !== "win32" && shouldUnlink) {
      try {
        const st = fs.lstatSync(this.opts.sockPath);
        if (st.ino === expectedIno) {
          fs.unlinkSync(this.opts.sockPath);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private bind(): void {
    if (this.stopped) return;
    const server = net.createServer((socket) => {
      this.clientSockets.add(socket);
      socket.setEncoding("utf8");
      const ac = new AbortController();
      socket.setTimeout(AGY_GATE_SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.on("close", () => {
        this.clientSockets.delete(socket);
        ac.abort();
      });
      socket.on("error", () => {
        this.clientSockets.delete(socket);
        ac.abort();
      });

      let buf = "";
      let handled = false;
      const sendResponse = (resp: GateHookDecision & { sig?: string }) => {
        if (socket.destroyed || socket.writableEnded) return;
        try {
          socket.end(JSON.stringify(resp) + "\n");
        } catch {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
      };
      socket.on("data", (chunk: string) => {
        if (handled) return;
        if (buf.length + chunk.length > GATE_MAX_LINE_BYTES) {
          handled = true;
          socket.destroy();
          return;
        }
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        handled = true;
        const line = buf.slice(0, nl).trim();
        buf = "";
        void this.handleRawLine(line, ac.signal)
          .then((resp) => sendResponse(resp))
          .catch((e) => {
            this.opts.onLog?.(`gate request error: ${errMsg(e)}`);
            sendResponse({ decision: "ask", reason: "RP: error interno en gate; confirmar en terminal" });
          });
      });
    });
    server.maxConnections = GATE_MAX_CONNECTIONS;
    server.on("error", (e) => this.opts.onLog?.(`gate socket error: ${errMsg(e)}`));
    server.listen(this.opts.sockPath, () => {
      if (this.stopped) {
        try {
          server.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this._ownsSocket = true;
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(this.opts.sockPath, 0o600);
        } catch {
          /* ignore */
        }
        try {
          this.socketIno = fs.lstatSync(this.opts.sockPath).ino;
        } catch {
          this.socketIno = null;
        }
      }
    });
    server.unref?.();
    this._server = server;
  }

  private signResponse(
    resp: GateHookDecision,
    nonce: string,
  ): GateHookDecision & { sig?: string } {
    const sig = signGatePayload(this.opts.token, ["res", resp.decision, resp.reason ?? "", nonce]);
    return sig ? { ...resp, sig } : resp;
  }

  private async handleRawLine(
    rawLine: string,
    signal: AbortSignal,
  ): Promise<GateHookDecision & { sig?: string }> {
    let req: any;
    try {
      req = JSON.parse(rawLine);
    } catch {
      return { decision: "ask", reason: "RP: solicitud de autorización inválida (JSON malformado)" };
    }
    const nonce = typeof req?.nonce === "string" ? req.nonce : "";
    const conversationId = typeof req?.conversationId === "string" ? req.conversationId : "";
    const command = typeof req?.command === "string" ? req.command : "";
    const rawPaneId = typeof req?.paneId === "string" ? req.paneId : "";
    if (!verifyGateSignature(this.opts.token, ["req", conversationId, rawPaneId, command, nonce], req?.sig)) {
      return { decision: "ask", reason: "RP: solicitud de gate no autenticada; confirmar en terminal" };
    }
    let paneId = "";
    if (rawPaneId) {
      try {
        paneId = validatePaneId(rawPaneId);
      } catch {
        paneId = "";
      }
    }
    if (!conversationId || !SAFE_CONV_ID_RE.test(conversationId) || !command) {
      return this.signResponse({ decision: "ask", reason: "RP: solicitud de autorización incompleta" }, nonce);
    }

    try {
      const decision = await this.opts.onRequest(
        {
          conversationId,
          paneId,
          command,
          danger: req.danger,
          workspacePaths: req.workspacePaths,
          transcriptPath: req.transcriptPath,
          nonce,
        },
        signal,
      );
      return this.signResponse(decision, nonce);
    } catch (e) {
      return this.signResponse(
        { decision: "ask", reason: `RP: error procesando autorización (${errMsg(e)}); confirmar en terminal` },
        nonce,
      );
    }
  }
}
