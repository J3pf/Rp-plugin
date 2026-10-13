// Test-only: logs every `input` event (source + text) so tests can prove what Pi saw.
import fs from "node:fs";
export default function probe(pi: any) {
  pi.on("input", (ev: any) => {
    if (process.env.INPUT_LOG) fs.appendFileSync(process.env.INPUT_LOG, JSON.stringify({ source: ev.source, text: ev.text }) + "\n");
  });
}
