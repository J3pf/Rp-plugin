/** pi.sendUserMessage: source "extension" in Pi, so it does not authorize actions in gentle-pi AUTO (COMPATIBILIDAD P4). */
export function deliverApi(pi, input) {
    const content = input.images.length > 0 ? [{ type: "text", text: input.text }, ...input.images] : input.text;
    const isSlash = input.text.trim().startsWith("/");
    const asCommand = input.asCommand || isSlash;
    if (asCommand) {
        if (input.idle) {
            pi.sendUserMessage(content, { expandPromptTemplates: true });
        }
        else {
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
