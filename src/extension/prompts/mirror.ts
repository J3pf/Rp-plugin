// Patches the shared ctx.ui in place so every extension's select/confirm/input goes through the broker (PLAN §8.1).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Broker } from "./broker.ts";
import { withSignal } from "./broker.ts";
import type { StatusTracker } from "../status.ts";
import { getSharedUi, mirrorTookEffect, warnOnce } from "../compat.ts";

export interface CustomInterceptor {
  active(): boolean;
  race<T>(factory: (...a: any[]) => any, options: any, runOrig: (factory: (...a: any[]) => any) => Promise<T>): Promise<T>;
}

export interface MirrorResult {
  uninstall: () => void;
  /** The shared ui was patched (setStatus is observed). */
  installed: boolean;
  /** select/confirm/input/custom are routed through the broker. */
  dialogs: boolean;
}

export function installMirror(
  ctx: ExtensionContext,
  broker: Broker,
  custom: CustomInterceptor | null,
  statuses: StatusTracker,
  opts: { dialogs: boolean },
): MirrorResult {
  if (!ctx.hasUI) return { uninstall: () => {}, installed: false, dialogs: false }; // print/json: noOpUIContext is a module singleton → never touch it
  const ui = getSharedUi(ctx);
  if (!ui || ui.__rp) return { uninstall: () => {}, installed: false, dialogs: false };

  const orig = {
    select: ui.select,
    confirm: ui.confirm,
    input: ui.input,
    custom: ui.custom,
    setStatus: ui.setStatus,
  };

  if (opts.dialogs) {
    ui.select = (title: string, options: string[], o?: any) =>
      broker.race({ kind: "select", title, options, opts: o }, (s) => orig.select.call(ui, title, options, withSignal(o, s)));
    ui.confirm = (title: string, message: string, o?: any) =>
      broker.race({ kind: "confirm", title, message, opts: o }, (s) => orig.confirm.call(ui, title, message, withSignal(o, s)));
    ui.input = (title: string, placeholder?: string, o?: any) =>
      broker.race({ kind: "input", title, placeholder, opts: o }, (s) => orig.input.call(ui, title, placeholder, withSignal(o, s)));
    if (custom) {
      ui.custom = (factory: any, o?: any) =>
        custom.active() ? custom.race(factory, o, (f) => orig.custom.call(ui, f, o)) : orig.custom.call(ui, factory, o);
    }
  }
  ui.setStatus = (k: string, v: string | undefined) => {
    statuses.observe(k, v);
    return orig.setStatus.call(ui, k, v);
  };
  ui.__rp = true;

  const wrapper = ui.setStatus;
  const uninstall = () => {
    if (!ui.__rp) return;
    // only restore what is still ours (another extension may have wrapped on top of us)
    if (opts.dialogs) {
      ui.select = orig.select;
      ui.confirm = orig.confirm;
      ui.input = orig.input;
      ui.custom = orig.custom;
    }
    if (ui.setStatus === wrapper) ui.setStatus = orig.setStatus;
    delete ui.__rp;
  };

  // compat check (R1): the wrapper must be what callers see
  if (opts.dialogs && !mirrorTookEffect(ctx, ui.select)) {
    uninstall();
    warnOnce(ctx, "mirror", "RP: no se pudo interceptar los diálogos de Pi (versión incompatible); se desactiva el espejo.");
    return { uninstall: () => {}, installed: false, dialogs: false };
  }
  return { uninstall, installed: true, dialogs: opts.dialogs };
}
