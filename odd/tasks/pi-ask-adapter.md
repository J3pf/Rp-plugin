# Feature: pi-ask ask_user adapter in rp-plugin
Custom dialog adapter for `@eko24ive/pi-ask`'s `ask_user` tool in `Rp-plugin`, routing questionnaire dialogs to mobile `Rp-app` through the broker.
Branch: `feat/pi-ask-adapter` | Status: completed

## Specs
- S1: Implement `piAskUser` adapter (`src/extension/prompts/adapters/pi-ask-user.ts`). Implement `CustomDialogAdapter` with `tool: "ask_user"` and `extension: "@eko24ive/pi-ask"`.
  - `accepts(args)` validates that `args.questions` is an array of 1 to 4 questions, each having a string `prompt` and an array of `options` with valid `label`s.
  - `toPrompt(args)` produces an `AdapterPromptSpec` with `kind: "questionnaire"`, `category: "question"`, `danger: "low"`, `source: { extension: "@eko24ive/pi-ask", tool: "ask_user", subagent: false }`. Title maps to `args.title ?? (args.questions.length === 1 ? args.questions[0].prompt : \`${args.questions.length} preguntas\`)`. Questions map `question` (`q.prompt`), `header` (`q.label ?? q.id`), `multiSelect` (`q.type === "multi"`), `allowFreeText: true`, and `options` with `id: String(index)`, `label`, `description`, `preview`.
  - `toResult(args, answer)` transforms remote `Answer` (`answers: [{ questionIndex, optionIds, text }]`) into `AskResult` (`cancelled: false, mode: "submit", title, questions, answers: { [q.id]: { values, labels, indices, customText } }`). If `answer.cancelled` or partial answers, returns `{ cancelled: true, mode: "submit", questions: [...], answers: {} }`.
  - `fromResult(args, result)` transforms local TUI `AskResult` into `Answer` (`{ answers: [{ questionIndex, optionIds, text }] }`) for `prompt.resolved`.
- S2: Register `piAskUser` in `AdapterRegistry` (`src/extension/prompts/adapters/index.ts`). Export `piAskUser` and add it to `BUILTIN_ADAPTERS`.
- S3: Unit tests and regression suite. Add test coverage in `test/prompts.test.ts` for `accepts`, `toPrompt`, `toResult`, `fromResult`, and `AdapterRegistry.race` with `ask_user`. Verify typecheck and full test suite passes.

## Tasks
- T1 (S3) [inline] Escribir pruebas unitarias RED para el adaptador `ask_user` en `test/prompts.test.ts`: done (1368fd7)
- T2 (S1, S2) [inline] Implementar `piAskUser` en `src/extension/prompts/adapters/pi-ask-user.ts` y registrarlo en `BUILTIN_ADAPTERS` (GREEN): done (1368fd7)
- T3 (S3) [inline] Ejecución de suite completa de pruebas, verificación de tipos y cierre con commit convencional: done (1368fd7)

## Log
- L1: "Al ejecutar la herramienta `ask_user` (de `@eko24ive/pi-ask`), la pregunta NO llega a la app móvil `Rp-app`. El plugin emite un evento `terminal_wait`, el móvil muestra el banner/notificación 'Esperando en la terminal (diálogo no remoto)' y la terminal de la PC queda bloqueada esperando input en el diálogo `ctx.ui.custom()` de `@eko24ive/pi-ask`."
- L2: Causa raíz identificada: `Rp-plugin` tiene un `AdapterRegistry` para interceptar diálogos `custom()`, pero solo contiene adaptadores para `ask_user_choice` y `ask_user_question` (de `gentle-pi`). Al no existir adaptador para `ask_user`, el diálogo TUI cae en `terminalWait(ev, true)`.
- L3: Especificación recibida del peer `subagent-chat-01a140b1-abad-7441` (/home/drift/Workspace/Rp-app) solicitando implementación de `piAskUser` bajo ODD.
- L4: TDD implementado: tests unitarios RED en `test/prompts.test.ts` (6 tests fallando como esperado), implementación de `piAskUser` en `src/extension/prompts/adapters/pi-ask-user.ts` y registro en `BUILTIN_ADAPTERS` (`src/extension/prompts/adapters/index.ts`), pasando a GREEN (49 tests unitarios aprobados, typecheck y build limpios).
