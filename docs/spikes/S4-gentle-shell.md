# S4 — gentle-shell / gentle-pi

**Resultado: ✅ verificado con gentle-shell 4.1.0 real (home aislado) y las herramientas reales de gentle-pi.**

## Procedimiento reproducible
`test/gentle-shell-e2e.test.ts` crea un `HOME` temporal, un *shim* `pi` y ejecuta el lanzador real:
`gentle-shell install <ruta-del-plugin>` → lo declara en `~/.gentle-shell/agent/settings.json` (no en `~/.pi/agent`),
y se lanza `gentle-shell` en tmux con un modelo simulado. (Con el paquete publicado el comando es
`gentle-shell install npm:@j3pf/pi-rp`; la ruta local ejercita el mismo mecanismo de carga.)

## Comprobado
| Hecho | Resultado |
|---|---|
| G1/G3 `gentle-shell install` instala en el home aislado y el plugin se carga ahí | ✅ `agent.hello.launcher = "gentle-shell"`, `gentle.version = "4.1.0"` |
| P1/P2 confirmación de gentle-pi («Allow recognized data-loss command?») llega al móvil como **autorización** (`category:"permission"`, `danger:"high"`, `tool:{name:"bash"}`) y se responde desde fuera | ✅ |
| P3 `ask_user_question` (cuestionario de 2 preguntas con multi-selección) y `ask_user_choice` (con respuesta propia) mediante **adaptadores**: el `custom()` real de la TUI se cierra y el resultado llega al modelo con la forma exacta | ✅ (`tui-e2e`) |
| P5 `gentle:mode` («Permissions: NORMAL») llega como `agent.statuses` y el siguiente `hello` lo trae en `gentle.mode` | ✅ (se publica a partir del primer turno) |
| `/gentle:mode` enviado desde el móvil como comando (`asCommand`) → `sendUserMessage` | ✅ se ejecuta y muestra el modo |
| G4 `GENTLE_PI_AGENTS_CHILD=1` → el plugin no se registra | ✅ (se simula con la variable; no con un subagente real) |
| Con gentle-pi presente el gate propio queda desactivado (`auto-detect`) | ✅ |

## Pendiente (requiere configuración que aquí no existe)
- Modo *takeover* (`--package-root`) y `--link`.
- G5: pregunta de un **subagente real** de Gentle Agents respondida por el `ctx.ui` del padre.
- Modo **Auto** real de gentle-pi (necesita un modelo clasificador real). Lo que sí se comprobó: el código de gentle-pi
  (`lib/auto-permission-runtime.ts`) sólo acepta `event.source === "interactive"`, y la entrega interactiva produce
  exactamente ese `source` en Pi (ver S7).
