// Regression A1: `gentle-ai sync` must keep `npm:@j3pf/pi-rp` in ~/.pi/agent/settings.json (it only drops its own retired packages).
// Needs the real gentle-ai binary: set GENTLE_AI_BIN (CI builds it from Gentleman-Programming/gentle-ai).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bin = process.env.GENTLE_AI_BIN;

describe.skipIf(!bin || !fs.existsSync(bin))("gentle-ai sync keeps the RP plugin", () => {
  it("preserves npm:@j3pf/pi-rp and foreign packages, removes only retired ones", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rp-ga-"));
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(path.join(home, "bin"));
    // a `pi` shim so the adapter sees an installed Pi
    fs.writeFileSync(path.join(home, "bin", "pi"), `#!/bin/sh\nexec node ${path.resolve(import.meta.dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js")} "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:@j3pf/pi-rp", "npm:@juicesharp/rpiv-ask-user-question", "npm:some-other-pkg"], theme: "dark" }),
    );
    const r = spawnSync(bin!, ["sync", "--agent", "pi", "--scope", "global"], {
      env: { ...process.env, HOME: home, PATH: `${path.join(home, "bin")}:${process.env.PATH}`, GENTLE_AI_NO_TELEMETRY: "1" },
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    expect(settings.packages).toContain("npm:@j3pf/pi-rp");
    expect(settings.packages).toContain("npm:some-other-pkg");
    expect(settings.packages).not.toContain("npm:@juicesharp/rpiv-ask-user-question"); // retired by gentle-ai itself
    expect(settings.theme).toBe("dark");
  }, 300_000);
});
