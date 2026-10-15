# Feature: TODOs, Subagentes y Comandos Slash en rp-plugin
Implementación de T2 coordinada con Rp-app y Rp-relay bajo ODD.
Branch: `feat/todos-subagents-slash-commands` | Status: completed

## Specs
- S1: Esquemas en `src/shared/protocol.ts`
  - `TodoTask`: `{ id: number; title: string; status: "pending" | "in_progress" | "blocked" | "done" | "dropped"; note?: string }`.
  - `TodoUpdateEvent`: `{ type: "todo_update"; tasks: TodoTask[] }`.
  - `SubagentToolCall`: `{ toolCallId: string; name: string; status: string; durationMs?: number }`.
  - `SubagentUpdateEvent`: `{ type: "subagent_update"; taskId: string; agent: string; label: string; status: string; model?: string; thinking?: string; startedAt?: number; endedAt?: number; durationMs?: number; turns?: number; toolCalls?: number; tokens?: number; cost?: number; error?: string; result?: string; tools?: SubagentToolCall[] }`.
  - Extender `AgentHelloBody` para incluir opcionalmente `todos?: { tasks: TodoTask[] }` y `subagents?: SubagentUpdateEvent[]`.
- S2: Autodetección y ejecución de comandos slash
  - En `src/extension/delivery/index.ts`, si `msg.text.trim().startsWith("/")` o `msg.asCommand === true`, fijar `asCommand = true`.
  - En `methodChain`, si `asCommand` es true, la cadena es siempre `["api"]`.
  - En `src/extension/delivery/api.ts`, asegurar que `expandPromptTemplates: true` se envíe SIEMPRE cuando `asCommand` sea true (tanto idle como ocupado con `deliverAs`).
  - Retornar ack con `disposition: "command"`.
- S3: Detección y emisión de TODOs
  - En `session_start` / `agent.hello`, reconstruir el estado inicial de TODOs desde `ctx.sessionManager.getBranch()` para poblar `agent.hello`.
  - En `forwarder.ts` / `runtime.ts`, interceptar `tool_execution_end` para `toolName === "todo"`, extraer `details.gentleTodo` (o resultado estructurado), actualizar el estado y emitir `todo_update` dentro de `agent.event`.
- S4: Telemetría de subagentes en `agent.event`
  - En el proceso padre, capturar la actividad de subagentes (`subagent_run` en `tool_execution_start/end`, y suscripción a eventos de `pi.events` como `gentle-pi:notification:source` si gentle-agents está activo).
  - Emitir evento `subagent_update` dentro de `agent.event` con los metadatos acordados.
- S5: Pruebas unitarias, suite completa y verificación de tipos
  - Pruebas para autodetección de slash commands en `test/delivery.test.ts`.
  - Pruebas para eventos `todo_update` y `subagent_update` en `test/todos.test.ts` y `test/subagents.test.ts`.
  - Verificación de tipos (`npm run build`) y paso de la suite completa (`npm test`).

## Tasks
- T1 (S1) [inline] Definir esquemas de `todo_update` y `subagent_update` en `src/shared/protocol.ts`: done
- T2 (S2) [inline] Implementar autodetección de comandos slash y `expandPromptTemplates` en `src/extension/delivery/index.ts` y `api.ts`: done
- T3 (S3) [inline] Implementar extracción de TODOs en `session_start` y emisión de `todo_update` en `tool_execution_end`: done
- T4 (S4) [inline] Implementar captura y emisión de `subagent_update` en `forwarder.ts` / `runtime.ts`: done
- T5 (S5) [inline] Escribir tests para cada componente, ejecutar suite completa de pruebas y verificar tipos: done

## Log
- L1: "[T2 - Ejecución en Rp-plugin] Adelante Rp-plugin con la implementación de T2 usando ODD y tus subagentes: 1. Esquemas en protocol.ts (todo_update, subagent_update). 2. Emisión de TODOs en session_start/hello y en tool_execution_end de 'todo'. 3. Telemetría de subagentes en agent.event (subagent_update). 4. Forzar expandPromptTemplates: true y autodetectar '/' en deliverer. 5. Ejecutar la suite de tests y reportar la evidencia y commits correspondientes."
- L2: Contrato acordado y alineado con Rp-app y Rp-relay.
- L3: Implementado y verificado con suites de test dedicadas (test/todos.test.ts, test/subagents.test.ts, test/delivery.test.ts) y build tsc limpio.
