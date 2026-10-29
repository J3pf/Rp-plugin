export function herdrHello(loc) {
    return loc ? { ...loc } : null;
}
/**
 * Marks the herdr pane as blocked for a remote-opened prompt. gentle-pi already emits its own
 * `herdr:blocked` for its dialogs (COMPATIBILIDAD P7), so those are skipped via `alreadyReported`.
 */
export class HerdrBlocker {
    bus;
    enabled;
    active = new Map();
    constructor(bus, enabled) {
        this.bus = bus;
        this.enabled = enabled;
    }
    block(promptId, label, alreadyReported) {
        if (!this.enabled || !this.bus || alreadyReported)
            return;
        this.active.set(promptId, true);
        this.bus.emit("herdr:blocked", { active: true, label });
    }
    unblock(promptId) {
        if (!this.active.delete(promptId))
            return;
        if (this.active.size === 0)
            this.bus?.emit("herdr:blocked", { active: false });
    }
    releaseAll() {
        if (this.active.size === 0)
            return;
        this.active.clear();
        this.bus?.emit("herdr:blocked", { active: false });
    }
}
