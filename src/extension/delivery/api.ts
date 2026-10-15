import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Disposition } from "../../shared/protocol.ts";

export interface ApiDeliveryInput {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  delivery: "auto" | "steer" | "followUp";
  asCommand: boolean;
  idle: boolean;
}

/** pi.sendUserMessage: source "extension" in Pi, so it does not authorize actions in gentle-pi AUTO (COMPATIBILIDAD P4). */
export function deliverApi(pi: ExtensionAPI, input: ApiDeliveryInput): { disposition: Disposition } {
  const content =
    input.images.length > 0 ? [{ type: "text" as const, text: input.text }, ...input.images] : input.text;
  const isSlash = input.text.trim().startsWith("/");
  const asCommand = input.asCommand || isSlash;
  if (asCommand) {
    if (input.idle) {
      pi.sendUserMessage(content, { expandPromptTemplates: true });
    } else {
      const deliverAs = input.delivery === "steer" ? "steer" : "followUp";
      pi.sendUserMessage(content, { deliverAs, expandPromptTemplates: true });
    }
    return { disposition: "command" };
  }
  if (input.idle) {
    pi.sendUserMessage(content);
    return { disposition: "sent" };
  }
  const as = input.delivery === "steer" ? "steer" : "followUp";
  pi.sendUserMessage(content, { deliverAs: as });
  return { disposition: as === "steer" ? "queued_steer" : "queued_followup" };
}
