# S7 — Entrega interactiva (teclear en la TUI del propio proceso)

**Resultado: ✅ verificado en Linux con la TUI real de Pi 1.2.0.** ⏳ Pendiente: Windows, modo Vim de gentle-shell y el
clasificador Auto real.

## Mecanismo
`process.stdin.emit("data", "\x1b[200~" + texto + "\x1b[201~")` y luego `"\r"` (`src/extension/delivery/interactive.ts`).
La TUI de Pi lee `process.stdin` en el mismo proceso y trata el pegado entre corchetes como texto del editor.

## Comprobado (tmux + Pi real, `test/tui-e2e.test.ts`)
- Pi emite `input` con `source:"interactive"` y el texto exacto (incluye saltos de línea) → `ack{typed, method:"interactive"}`.
- El borrador del editor local se guarda, se limpia y se **restaura** después (y no se envía junto con el mensaje).
- Con un diálogo abierto el mensaje espera; al cerrarse se teclea y el ack es `typed_after_dialog`.
- Si Pi no confirma el `input` en 3 s: se revierte el editor, se avisa y se cae a `api` (probado con `stdin.emit` simulado).
- `delivery: "followUp"` espera a `agent_settled`; `steer` teclea de inmediato.
- Sólo se usa en `ctx.mode === "tui"`.

## Sobre el modo Auto de gentle-pi
`lib/auto-permission-runtime.ts` (gentle-pi 4.1.0): `input()` ignora todo lo que no sea `event.source === "interactive"`.
Eso es exactamente lo que genera esta entrega. No se ejecutó el clasificador Auto con un modelo real.
Hasta que gentle-pi publica su modo (primer turno) se asume que **podría** ser Auto y se teclea (es correcto en cualquier modo).

## Pendiente
1. **Windows** (Windows Terminal y herdr beta): ejecutar los mismos casos; la API es la misma (`process.stdin` con entrada VT).
2. **Modo Vim** de gentle-shell: hoy el plugin sólo no teclea si detecta un estado de pie de página con «vim» que no diga
   «insert». Hay que comprobar cómo lo publica gentle-shell y ajustar `editorAcceptsText`.
3. **Auto real**: con un modelo clasificador, comprobar que una acción pedida por un mensaje tecleado desde el móvil es autorizada.
