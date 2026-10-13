# Spikes de la fase 0 — resultados

Cada spike tiene una prueba automatizada que se puede repetir (`npm run test:e2e`) y, donde no se pudo ejecutar en este
entorno, el procedimiento manual exacto. Entorno de las pruebas: Linux, Node 22.22, Pi 1.2.0, gentle-pi 4.1.0 (npm),
gentle-ai `main` (`f0b6e47`, compilado con Go), tmux 3.4.

| Spike | Qué se comprobó | Estado | Evidencia |
|---|---|---|---|
| [S1](S1-ui-mirror.md) | Parchear `ctx.ui` y cerrar un diálogo real de la TUI con `AbortSignal` | ✅ verificado (Linux) | `test/tui-e2e.test.ts` (3 pruebas S1) |
| [S4](S4-gentle-shell.md) | gentle-shell (home aislado) carga el plugin; confirmaciones, `ask_user_*`, estado y comandos de gentle-pi | ✅ verificado casi todo; faltan *takeover* y subagente real | `test/gentle-shell-e2e.test.ts`, `test/tui-e2e.test.ts` |
| [S5](S5-herdr.md) | `herdr agent prompt`, `workspace create` + `pane run`, reanudación | ⚠️ **no verificado con herdr real** (no se pudo compilar aquí); verificado con un CLI de sustitución | `test/tui-e2e.test.ts` (S5), `test/host.test.ts` |
| [S6](S6-windows-empresa.md) | Conectividad desde la PC Windows de la empresa (proxy/WS/TLS) | ⏳ pendiente: requiere esa máquina | `/rp doctor` + procedimiento |
| [S7](S7-entrega-interactiva.md) | Entrega interactiva por `process.stdin` | ✅ verificado en Linux con Pi real; ⏳ Windows, modo Vim y clasificador Auto real | `test/tui-e2e.test.ts` (3 pruebas S7) |
| A1 | `gentle-ai sync` conserva `npm:@j3pf/pi-rp` | ✅ verificado con gentle-ai real | `test/gentle-ai-sync.test.ts` |
