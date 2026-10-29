import { withSignal } from "./broker.js";
import { getSharedUi, mirrorTookEffect, warnOnce } from "../compat.js";
export function installMirror(ctx, broker, custom, statuses, opts) {
    if (!ctx.hasUI)
        return { uninstall: () => { }, installed: false, dialogs: false }; // print/json: noOpUIContext is a module singleton → never touch it
    const ui = getSharedUi(ctx);
    if (!ui || ui.__rp)
        return { uninstall: () => { }, installed: false, dialogs: false };
    const orig = {
        select: ui.select,
        confirm: ui.confirm,
        input: ui.input,
        custom: ui.custom,
        setStatus: ui.setStatus,
    };
    if (opts.dialogs) {
        ui.select = (title, options, o) => broker.race({ kind: "select", title, options, opts: o }, (s) => orig.select.call(ui, title, options, withSignal(o, s)));
        ui.confirm = (title, message, o) => broker.race({ kind: "confirm", title, message, opts: o }, (s) => orig.confirm.call(ui, title, message, withSignal(o, s)));
        ui.input = (title, placeholder, o) => broker.race({ kind: "input", title, placeholder, opts: o }, (s) => orig.input.call(ui, title, placeholder, withSignal(o, s)));
        if (custom) {
            ui.custom = (factory, o) => custom.active()
                ? custom.customMirror
                    ? custom.customMirror(factory, o, (f) => orig.custom.call(ui, f, o))
                    : custom.race(factory, o, (f) => orig.custom.call(ui, f, o))
                : orig.custom.call(ui, factory, o);
        }
    }
    ui.setStatus = (k, v) => {
        statuses.observe(k, v);
        return orig.setStatus.call(ui, k, v);
    };
    ui.__rp = true;
    const wrapper = ui.setStatus;
    const uninstall = () => {
        if (!ui.__rp)
            return;
        // only restore what is still ours (another extension may have wrapped on top of us)
        if (opts.dialogs) {
            ui.select = orig.select;
            ui.confirm = orig.confirm;
            ui.input = orig.input;
            ui.custom = orig.custom;
        }
        if (ui.setStatus === wrapper)
            ui.setStatus = orig.setStatus;
        delete ui.__rp;
    };
    // compat check (R1): the wrapper must be what callers see
    if (opts.dialogs &&
        (!mirrorTookEffect(ctx, ui.select) ||
            ctx.ui?.confirm !== ui.confirm ||
            ctx.ui?.input !== ui.input)) {
        uninstall();
        warnOnce(ctx, "mirror", "RP: no se pudo interceptar los diálogos de Pi (versión incompatible); se desactiva el espejo.");
        return { uninstall: () => { }, installed: false, dialogs: false };
    }
    return { uninstall, installed: true, dialogs: opts.dialogs };
}
