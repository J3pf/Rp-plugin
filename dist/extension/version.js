import { fileURLToPath } from "node:url";
import { findPackageJson } from "./compat.js";
let cached;
export function pluginVersion() {
    if (cached)
        return cached;
    try {
        const pkg = findPackageJson(fileURLToPath(import.meta.url), "@j3pf/pi-rp");
        cached = typeof pkg?.json?.version === "string" ? pkg.json.version : "0.0.0";
    }
    catch {
        cached = "0.0.0";
    }
    return cached;
}
