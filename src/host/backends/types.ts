import type { Runner } from "../runner.ts";
import type { BackendName } from "../config.ts";

export type HerdrTarget = { type: "workspace" } | { type: "tab"; workspaceId: string } | { type: "split"; paneId: string; direction: "right" | "down" };

export interface SpawnRequest {
  cwd: string;
  name: string;
  launcherCommand: string;
  spawnId: string;
  herdrTarget?: HerdrTarget;
  sessionId?: string;
}

export interface SpawnRecord {
  spawnId: string;
  backend: BackendName;
  herdr: { workspaceId: string | null; tabId?: string | null; paneId: string; ownsWorkspace?: boolean } | null;
  tmuxSession: string | null;
  createdAt: number;
  name?: string;
}

export interface Backend {
  readonly name: BackendName;
  /** Version string / true when available on this machine, null otherwise. */
  detect(): Promise<string | boolean | null>;
  spawn(req: SpawnRequest): Promise<SpawnRecord>;
  kill(rec: SpawnRecord): Promise<void>;
}

export interface BackendDeps {
  run: Runner;
  platform: NodeJS.Platform;
  herdrSession: string | null;
}
