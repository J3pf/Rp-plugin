import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeliveryError } from "../../shared/protocol.ts";

/** `herdr agent prompt <pane> <text>`: types into the pane and presses Enter (COMPATIBILIDAD H3). No shell involved. */
export async function deliverHerdr(
  pi: ExtensionAPI,
  paneId: string | null,
  text: string,
): Promise<{ ok: true } | { ok: false; error: Exclude<DeliveryError, null> }> {
  if (!paneId) return { ok: false, error: "herdr_unavailable" };
  try {
    const r = await pi.exec("herdr", ["agent", "prompt", paneId, text], { timeout: 10_000 });
    if (r.code === 0) return { ok: true };
    if (/agent_blocked/i.test(r.stderr + r.stdout)) return { ok: false, error: "agent_blocked" };
    return { ok: false, error: "herdr_unavailable" };
  } catch {
    return { ok: false, error: "herdr_unavailable" };
  }
}
