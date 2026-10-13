# S5 — herdr

**Resultado: ⚠️ no verificado contra herdr real.** herdr 0.9.3 se compila con Zig 0.16 y descarga dependencias de
`deps.files.ghostty.org`, host bloqueado en el entorno donde se desarrolló el plugin. No hay binario precompilado accesible.

## Qué sí se probó
- **Entrega `herdr`**: `test/tui-e2e.test.ts` («S5 stand-in») usa un CLI `herdr` de sustitución con el contrato documentado
  (`herdr agent prompt <pane> <texto>` teclea y pulsa Enter). Con él se verifica en una TUI real de Pi que el plugin
  ejecuta el binario **sin shell** (los metacaracteres `; $() \`` llegan literales), que `HERDR_*` se reporta en
  `agent.hello.herdr`, y que Pi ve el mensaje con `source:"interactive"`.
- **rp-host/herdr**: `test/host.test.ts` cubre `workspace create`, `tab create`, `pane split` (con `--env RP_SPAWN_ID` y
  `--no-focus`), `pane run`, `kill`, arranque del servidor sin interfaz y `host.herdr_layout`, con un ejecutor simulado.
- `agent_blocked` se informa (`ack{rejected, error:"agent_blocked"}`) en lugar de caer silenciosamente a `api`.

## Supuestos a confirmar con herdr real
1. Forma exacta del JSON de `workspace create` / `tab create` / `pane split` (se leen varias rutas posibles en
   `src/host/backends/herdr.ts: PANE_PATHS / WORKSPACE_PATHS / TAB_PATHS`).
2. Que `workspace list` / `tab list` devuelvan JSON por defecto (si necesitan un flag, ajustar `HerdrBackend.layout`).
3. `herdr workspace close <id>` y `herdr pane close <pane>` para `host.kill`.
4. Que la variable `HERDR_SESSION` seleccione la sesión (`herdrSession` en `host.json`).
5. Reanudación tras reiniciar el servidor: `agentId = machineId:sessionId` ya es estable por diseño; falta observarlo.

## Procedimiento
```bash
herdr workspace create --cwd ~/proyectos/x --label x --env RP_SPAWN_ID=TEST --no-focus   # anotar el JSON
herdr pane run <pane_id> gentle-shell
rp-host status        # backends.herdr debe mostrar la versión
```
Pegar el JSON real en un test de `test/host.test.ts` y ajustar las rutas si difieren.
