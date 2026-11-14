import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DeliveryError } from "../../shared/protocol.ts";

export interface HerdrDraftUi {
  getText: () => string;
  setText: (text: string) => void;
}

/** `herdr agent prompt <pane> <text>`: types into the pane and presses Enter (COMPATIBILIDAD H3). No shell involved. */
export async function deliverHerdr(
  pi: ExtensionAPI,
  paneId: string | null,
  text: string,
  draftUi?: HerdrDraftUi,
): Promise<{ ok: true } | { ok: false; error: Exclude<DeliveryError, null> }> {
  if (!paneId || paneId.startsWith("-")) return { ok: false, error: "herdr_unavailable" };
  let savedDraft = "";
  if (draftUi) {
    try {
      savedDraft = draftUi.getText();
      if (savedDraft) draftUi.setText("");
    } catch {
      savedDraft = "";
    }
  }
  const textArgs = text.startsWith("-") ? ["--", text] : [text];
  try {
    const r = await pi.exec("herdr", ["agent", "prompt", paneId, ...textArgs], { timeout: 10_000 });
    if (r.code === 0) return { ok: true };
    if (/agent_blocked/i.test(r.stderr + r.stdout)) return { ok: false, error: "agent_blocked" };
    return { ok: false, error: "herdr_unavailable" };
  } catch {
    return { ok: false, error: "herdr_unavailable" };
  } finally {
    if (savedDraft) {
      try {
        draftUi?.setText(savedDraft);
      } catch {
        /* editor restore is best-effort */
      }
    }
  }
}
