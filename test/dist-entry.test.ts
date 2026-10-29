import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

// Pi installs git packages with `--omit=dev`, so nothing compiles them: dist/ ships in git.
describe("committed dist (git install has no build step)", () => {
  it("rp-host launcher target exists", () => {
    const launcher = fs.readFileSync(path.join(root, "bin/rp-host.mjs"), "utf8");
    const rel = /from "(\.\.\/dist\/[^"]+)"/.exec(launcher)?.[1];
    expect(rel).toBeTruthy();
    expect(fs.existsSync(path.resolve(root, "bin", rel!))).toBe(true);
  });

  it("every src module has a compiled counterpart (run `npm run build`)", () => {
    const missing = sources(path.join(root, "src"))
      .map((f) => path.join(root, "dist", path.relative(path.join(root, "src"), f).replace(/\.ts$/, ".js")))
      .filter((f) => !fs.existsSync(f));
    expect(missing).toEqual([]);
  });
});
