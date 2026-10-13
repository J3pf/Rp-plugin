#!/usr/bin/env node
// rp-host entry point: runs the compiled host (dist/host/main.js).
import { main } from "../dist/host/main.js";
main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
