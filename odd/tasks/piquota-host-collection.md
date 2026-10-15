# Feature: piQuota collection in rp-host
Periodic quota collection in `rp-host` via `piquota --json`, mapped to `MachineQuota[]` and transmitted to `rp-relay`.
Branch: `feat/piquota-host-collection` | Status: in_progress

## Specs
- S1: Protocol definitions. Define `QuotaWindow` (`id`, `label`, `usedPercent`, `remainingPercent`, `resetsAt`, `resetsInSec`, `note`) and `MachineQuota` (`family`, `label`, `plan`, `ok`, `notConfigured`, `error`, `primaryWindowId`, `windows`, `updatedAt`) in `src/shared/protocol.ts`. Update `HostHelloBody` to include optional `quotas?: MachineQuota[]`. Add `HostQuotasBody` (`{ quotas: MachineQuota[] }`) for message type `"host.quotas"`.
- S2: Collector module `src/host/quota.ts`. Execute `piquota --json` asynchronously with bounded timeout (default 15s). Parse output and map `providers` to `MachineQuota[]`. If `piquota` is missing, fails, or produces invalid output, fail gracefully: return null/cached without throwing or interrupting `rp-host`. Support memory caching.
- S3: Host configuration. In `src/host/config.ts`, add `quotaEnabled` (boolean, default true), `quotaCommand` (string, default "piquota --json"), and `quotaIntervalSec` (number, default 300 seconds; <= 0 disables periodic collection).
- S4: Host connection & manager integration. In `src/host/connection.ts` and `src/host/manager.ts`: collect quotas on startup and attach to `host.hello`. Schedule periodic polling if `quotaIntervalSec > 0` and emit `host.quotas` envelopes when updated. Stop and clear timers on connection shutdown.
- S5: Contract & unit tests. Unit tests in `test/host-quota.test.ts` covering success, invalid JSON, binary missing, timeouts, and field mapping. Integration test in `test/host.test.ts` for `host.hello` quotas and `host.quotas` envelope. Validate contract shapes in `test/contract.ts`.
- S6: Build, documentation, and release readiness. Run `npm run typecheck`, `npm run build`, and `npm run test:unit`. Update docs and bump version in `package.json` to 0.1.4.

## Tasks
- T1 (S1, S3) [inline] Protocol types in protocol.ts and config options in config.ts: done (1571707)
- T2 (S2) [inline] Quota collector implementation in src/host/quota.ts and unit tests in test/host-quota.test.ts: done (8c1efb8)
- T3 (S4) [inline] Connect quota collector to HostManager and HostConnection (host.hello + host.quotas): in_progress
- T4 (S5) [inline] Wire contract validation and integration tests in test/host.test.ts and test/contract.test.ts: pending
- T4 (S5) [inline] Wire contract validation and integration tests in test/host.test.ts and test/contract.test.ts: pending
- T5 (S6) [inline] Documentation, build, package version bump to 0.1.4 and verification: pending

## Log
- L1: "En Rp-app ya completamos y liberamos (v0.1.9) la visualización y persistencia de las cuotas. Para completar el flujo end-to-end hacia el usuario, es momento de que implementes en `rp-host` la recolección periódica de `piquota --json`, mapees la salida al array `MachineQuota[]` acordado y la envíes a `rp-relay` en el `host.hello` y/o mensaje de actualización. Por favor procede con la implementación en tu repositorio, ejecuta sus pruebas y genera su release correspondiente cuando esté listo."
- L2: "Cuando implementes la recolección en `rp-host`, puedes mapear directamente la salida de `piquota --json` a `MachineQuota[]` (con family, label, plan, ok, notConfigured, error, primaryWindowId, windows: [{ id, label, usedPercent, remainingPercent, resetsAt, resetsInSec, note }], updatedAt). Rp-relay lo propagará en MachineSummary.quotas y Rp-app lo consumirá de forma opcional y tolerante a fallos."
- L3: User confirmed: "Proceder con la implementación en rp-host".
