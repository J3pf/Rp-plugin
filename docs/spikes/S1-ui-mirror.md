# S1 — Espejo de `ctx.ui` y cierre de diálogos con `AbortSignal`

**Resultado: ✅ funciona en Pi 1.2.0 (TUI real).**

## Qué se hizo
`installMirror()` (`src/extension/prompts/mirror.ts`) sustituye **en el sitio** `select/confirm/input/custom/setStatus` del
objeto `ctx.ui` compartido. Cada diálogo se registra en el `Broker` y compite con el teléfono; el diálogo local recibe una
señal que se une (`AbortSignal.any`) a la del llamador.

## Pruebas (Pi real dentro de tmux, modelo simulado)
- El diálogo del *gate* (`⚠ bash: rm -rf …`) se ve en la TUI; al responder desde el teléfono **el diálogo desaparece** de la
  pantalla y el turno continúa (`S1: a gate dialog … is closed when the phone answers first`).
- Responder primero en la terminal (Enter) → `prompt.resolved{by:"local", answer:{optionIds:["0"]}}`; una respuesta tardía
  del teléfono recibe `prompt.ack{accepted:false}`.
- Denegar desde el teléfono bloquea la llamada y el modelo recibe «Denegado por el usuario».
- Dentro de `AgentSession` del SDK (sin UI, `hasUI=false`) el espejo no toca el `ctx.ui` *no-op* (singleton del módulo) y el
  gate funciona sólo con el teléfono (`test/pi-integration.test.ts`).

## Hallazgos que cambiaron el código
- Tras `session.dispose()` (SDK) Pi **no** emite `session_shutdown` (lo emite `AgentSessionRuntime.dispose()`); el socket
  del plugin se marca `unref()` para no retener el proceso.
- Leer `ctx.ui` en un `ctx` obsoleto (tras reload/dispose) **lanza**; el runtime copia los datos estáticos del `ctx` y
  protege todos los accesos tardíos.
- `ctx.ui.setStatus` sólo se observa desde que se instala el espejo: gentle-pi publica `gentle:mode` en el primer turno, por lo
  que el modo llega por `agent.statuses` y no necesariamente en el primer `agent.hello`.

## Pendiente
Windows (misma API, no se espera diferencia) y Pi `latest` (CI).
