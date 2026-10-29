// Keep scraping independent of the user's terminal width; the component wraps at this width.
export const REVIEW_CONSENT_RENDER_WIDTH = 80;
const MAX_MESSAGE_CHARS = 32_000;
const ACTIONS_FOOTER = "↑↓ choose · Enter confirm · Esc cancel · D details";
const DETAILS_FOOTER = "PgUp/PgDn · D return · Esc";
// review-consent-component.ts routes this terminal PageDown sequence to matchesKey(..., "pageDown").
const PAGE_DOWN_KEY = "\u001b[6~";
const MAX_DETAILS_PAGES = 512;
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g;
function renderedLines(component) {
    const value = component.render(REVIEW_CONSENT_RENDER_WIDTH);
    if (!Array.isArray(value) || !value.every((line) => typeof line === "string"))
        return null;
    return value.map((line) => line.replace(ANSI, ""));
}
function sameLines(a, b) {
    return a.length === b.length && a.every((line, i) => line === b[i]);
}
// gentle-pi/lib/review-consent-component.ts:70-72 exposes these three numbered label/effect strings.
function optionsFrom(component) {
    const options = component.getActionOptions();
    if (!Array.isArray(options) || options.length !== 3)
        return null;
    const parsed = options.map((value, i) => {
        if (typeof value !== "string")
            return null;
        const match = value.match(new RegExp(`^${i + 1}\\. ([^\\n]+)\\n(Effect: [\\s\\S]+)$`));
        return match ? { id: String(i), label: match[1], description: match[2] } : null;
    });
    return parsed.every((option) => option !== null) ? parsed : null;
}
function detailBody(lines) {
    return lines.filter((line) => line.trim() !== DETAILS_FOOTER && !line.trim().startsWith("Details (read-only)"));
}
function appendPage(body, page, maxOverlap) {
    for (let overlap = Math.min(maxOverlap, body.length, page.length); overlap > 0; overlap--) {
        if (body.slice(-overlap).every((line, i) => line === page[i])) {
            body.push(...page.slice(overlap));
            return true;
        }
    }
    if (maxOverlap > 0)
        return false;
    body.push(...page);
    return true;
}
function scrapeDetails(component) {
    const first = renderedLines(component);
    if (!first || !first.some((line) => line.trim().startsWith("Details (read-only)")))
        return null;
    const body = detailBody(first);
    // The mounted component paginates when its body exceeds terminal rows; its public PageDown
    // handler advances by one less than the viewport height, so consecutive pages overlap one line.
    const maxOverlap = Math.max(0, body.length - 1);
    for (let pageNumber = 0; pageNumber < MAX_DETAILS_PAGES; pageNumber++) {
        component.handleInput(PAGE_DOWN_KEY);
        const next = renderedLines(component);
        if (!next || !next.some((line) => line.trim().startsWith("Details (read-only)")))
            return null;
        const nextBody = detailBody(next);
        if (sameLines(first, next))
            return body;
        if (!appendPage(body, nextBody, maxOverlap))
            return null;
        if (nextBody.length === 0)
            return null;
        // The current page is now the previous page for the next iteration.
        first.splice(0, first.length, ...next);
    }
    return null;
}
function promptSpec(options, actions, details) {
    const actionLines = actions.filter((line) => line.trim() !== ACTIONS_FOOTER);
    const detailLines = details ?? [];
    const message = [...actionLines, ...detailLines].join("\n").slice(0, MAX_MESSAGE_CHARS);
    return {
        kind: "select",
        category: "permission",
        danger: "high",
        title: "Review consent",
        message,
        options,
        source: { extension: "gentle-pi", tool: "gentle_review", subagent: false },
    };
}
function fromComponent(componentValue) {
    if (!componentValue || typeof componentValue !== "object")
        return null;
    const component = componentValue;
    if (typeof component.getActionOptions !== "function" || typeof component.render !== "function" || typeof component.handleInput !== "function")
        return null;
    try {
        const options = optionsFrom(component);
        if (!options)
            return null;
        const actions = renderedLines(component);
        if (!actions || !actions.some((line) => line.trim() === "Review consent"))
            return null;
        // review-consent-component.ts toggles actions/details on D; probe that public path without
        // rendering details first, then scrape only after D→D proves byte-identical action restoration.
        component.handleInput("d");
        component.handleInput("d");
        const probe = renderedLines(component);
        if (!probe)
            return null;
        if (!sameLines(actions, probe)) {
            if (!probe.some((line) => line.trim() === "Review consent"))
                return null;
            return promptSpec(options, actions, ["Value, risk and evidence are visible on the terminal."]);
        }
        // renderDetailsScreen() is viewport-sized in gentle-pi/lib/review-consent-component.ts, so
        // collect its public PageDown pages rather than silently omitting off-screen evidence.
        let details = null;
        let restored = null;
        let toggled = false;
        try {
            component.handleInput("d");
            toggled = true;
            details = scrapeDetails(component);
        }
        finally {
            if (toggled) {
                try {
                    component.handleInput("d");
                    restored = renderedLines(component);
                }
                catch {
                    restored = null;
                }
            }
        }
        if (!details || !restored || !sameLines(actions, restored))
            return null;
        return promptSpec(options, actions, details);
    }
    catch {
        return null;
    }
}
export const reviewConsent = {
    tool: "gentle_review",
    extension: "gentle-pi",
    accepts(args) {
        return !!args && typeof args === "object" && args.operation === "start";
    },
    // gentle_review's args contain only operation data; its consent is available solely on the returned component.
    toPrompt() {
        throw new Error("gentle_review prompts must be built from the custom component");
    },
    fromComponent,
    // Matches gentle-pi/lib/review-consent-ui.ts:84-87: answers must pass through the component's done callback.
    toResult(_args, answer) {
        const value = answer;
        if ("cancelled" in value && value.cancelled)
            return undefined;
        const index = "optionIds" in value ? Number(value.optionIds[0]) : -1;
        if (index === 0)
            return { kind: "provider", answer: "granted" };
        if (index === 1)
            return { kind: "provider", answer: "declined" };
        if (index === 2)
            return { kind: "host-session" };
        return undefined;
    },
    fromResult(_args, result) {
        if (result && typeof result === "object") {
            const value = result;
            if (value.kind === "provider" && value.answer === "granted")
                return { optionIds: ["0"] };
            if (value.kind === "provider" && value.answer === "declined")
                return { optionIds: ["1"] };
            if (value.kind === "host-session")
                return { optionIds: ["2"] };
        }
        return { cancelled: true };
    },
};
