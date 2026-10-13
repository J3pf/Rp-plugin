// herdr integration: location of the pane, and "blocked" markers for dialogs nobody else reported.
import type { HerdrLocation } from "./environment.ts";

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export function herdrHello(loc: HerdrLocation | null): { paneId: string; tabId: string | null; workspaceId: string | null; session: string | null } | null {
  return loc ? { ...loc } : null;
}

/**
 * Marks the herdr pane as blocked for a remote-opened prompt. gentle-pi already emits its own
 * `herdr:blocked` for its dialogs (COMPATIBILIDAD P7), so those are skipped via `alreadyReported`.
 */
export class HerdrBlocker {
  private active = new Map<string, boolean>();
  constructor(private bus: EventBusLike | null, private enabled: boolean) {}

  block(promptId: string, label: string, alreadyReported: boolean): void {
    if (!this.enabled || !this.bus || alreadyReported) return;
    this.active.set(promptId, true);
    this.bus.emit("herdr:blocked", { active: true, label });
  }

  unblock(promptId: string): void {
    if (!this.active.delete(promptId)) return;
    if (this.active.size === 0) this.bus?.emit("herdr:blocked", { active: false });
  }

  releaseAll(): void {
    if (this.active.size === 0) return;
    this.active.clear();
    this.bus?.emit("herdr:blocked", { active: false });
  }
}
