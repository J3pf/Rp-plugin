# Feature: Soporte de comandos /model y /thinking desde Rp-app
Implementación de la ejecución de los comandos slash /model y /thinking en Rp-plugin bajo ODD.
Branch: `main` | Status: completed

## Specs
- S1: Intercepción de comandos slash `/model` y `/thinking` en `Deliverer.process` antes de enviarlos a `deliverApi`. Registrar la entrada (`this.record(msg, "api")`) y retornar de inmediato un ack con `{ clientMsgId: id, disposition: "command", method: "api", error: null }`.
- S2: Comando `/model`:
  - Con argumentos (`/model <provider/modelId>` o `/model <modelId>`):
    - Buscar el modelo usando `ctx.modelRegistry.find(provider, modelId)` o buscando en `ctx.modelRegistry.getAll()` donde coincida `id` o `${provider}/${id}`.
    - Si se encuentra: ejecutar `const ok = await this.d.pi.setModel(model)`. Si no es exitoso (o no tiene API key), emitir `ctx.ui.notify` advirtiendo del error. Si es exitoso, emitir `ctx.ui.notify` confirmando el cambio.
    - Si no se encuentra: emitir `ctx.ui.notify` advirtiendo que el modelo no existe en el catálogo/configuración.
  - Sin argumentos (`/model`):
    - Obtener los modelos disponibles (`await ctx.modelRegistry.getAvailable()` o `getAll()`).
    - Presentar las opciones vía `ctx.ui.select("Seleccionar modelo", opciones)` (esto se refleja automáticamente al móvil a través del broker de prompts).
    - Si el usuario selecciona un modelo, aplicar `await this.d.pi.setModel(selectedModel)`.
- S3: Comando `/thinking`:
  - Con argumentos (`/thinking <nivel>`):
    - Normalizar y validar el nivel contra los soportados por Pi: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
    - Si es válido: ejecutar `this.d.pi.setThinkingLevel(nivel)`. Emitir `ctx.ui.notify` confirmando.
    - Si es inválido: emitir `ctx.ui.notify` indicando los niveles válidos.
  - Sin argumentos (`/thinking`):
    - Presentar las opciones vía `ctx.ui.select("Nivel de thinking", ["off", "minimal", "low", "medium", "high", "xhigh", "max"])` (reflejado al móvil por el broker).
    - Al seleccionar, invocar `this.d.pi.setThinkingLevel(seleccion)`.
- S4: Calidad y pruebas:
  - Pruebas unitarias exhaustivas en `test/delivery.test.ts` cubriendo `/model provider/id` exitoso, inexistente, interactivo con `ctx.ui.select`, y `/thinking level` exitoso, inválido, e interactivo con `ctx.ui.select`.
- S5: Entrega:
  - Ejecución de typecheck, build y suite de pruebas (`npm run build && npm test`).
  - Conventional Commits en `main`.
  - Bump de versión a 0.2.6 en `package.json` y `package-lock.json`, actualización de documentación y tag `v0.2.6`.

## Tasks
- T1 (S1, S2, S3) [inline] Implementar interceptación y ejecución de /model y /thinking en Deliverer: done
- T2 (S4) [inline] Escribir pruebas unitarias exhaustivas en test/delivery.test.ts: done
- T3 (S5) [inline] Quality gates, bump de versión a 0.2.6, docs y tag v0.2.6: done

## Log
- L1: "[Instrucción de Orquestación - T1: Soporte de /model y /thinking en Rp-plugin] Como orquestador de RP, te asigno la implementación de la ejecución de los comandos slash `/model` y `/thinking` en Rp-plugin.\n### Contexto y Problema\nActualmente, los comandos slash recibidos desde el móvil se envían vía `pi.sendUserMessage` con `expandPromptTemplates: true`. Esto trata a `/model` y `/thinking` como prompts conversacionales dirigidos al LLM en lugar de ejecutar el cambio de modelo/thinking en la sesión de Pi.\n### Requerimientos de Implementación\n1. **Detección e interceptación en `Deliverer.process` (o módulo de comandos):**\n   - Interceptar comandos que comiencen con `/model` o `/thinking` antes de enviarlos a `deliverApi`.\n   - Registrar la entrada (`this.record(msg, "api")`) y retornar un ack con `{ clientMsgId: id, disposition: "command", method: "api", error: null }`.\n2. **Comando `/model`:**\n   - **Con argumentos (`/model <provider/modelId>` o `/model <modelId>`):**\n     - Buscar el modelo usando `ctx.modelRegistry.find(provider, modelId)` o buscando en `ctx.modelRegistry.getAll()` donde coincida `id` o `${provider}/${id}`.\n     - Si se encuentra: ejecutar `const ok = await this.d.pi.setModel(model)`. Si no es exitoso (o no tiene API key), emitir `ctx.ui.notify` advirtiendo del error. Si es exitoso, emitir `ctx.ui.notify` confirmando el cambio.\n     - Si no se encuentra: emitir `ctx.ui.notify` advirtiendo que el modelo no existe en el catálogo/configuración.\n   - **Sin argumentos (`/model`):**\n     - Obtener los modelos disponibles (`await ctx.modelRegistry.getAvailable()` o `getAll()`).\n     - Presentar las opciones vía `ctx.ui.select(\"Seleccionar modelo\", opciones)` (esto se refleja automáticamente al móvil a través del broker de prompts).\n     - Si el usuario selecciona un modelo, aplicar `await this.d.pi.setModel(selectedModel)`.\n3. **Comando `/thinking`:**\n   - **Con argumentos (`/thinking <nivel>`):**\n     - Normalizar y validar el nivel contra los soportados por Pi: `\"off\" | \"minimal\" | \"low\" | \"medium\" | \"high\" | \"xhigh\" | \"max\"`.\n     - Si es válido: ejecutar `this.d.pi.setThinkingLevel(nivel)`. Emitir `ctx.ui.notify` confirmando.\n     - Si es inválido: emitir `ctx.ui.notify` indicando los niveles válidos.\n   - **Sin argumentos (`/thinking`):**\n     - Presentar las opciones vía `ctx.ui.select(\"Nivel de thinking\", [\"off\", \"minimal\", \"low\", \"medium\", \"high\", \"xhigh\", \"max\"])` (reflejado al móvil por el broker).\n     - Al seleccionar, invocar `this.d.pi.setThinkingLevel(seleccion)`.\n4. **Calidad y Entrega:**\n   - Agregar pruebas unitarias exhaustivas en `test/delivery.test.ts` (o suite dedicada) cubriendo:\n     - `/model provider/id` exitoso y modelo inexistente.\n     - `/model` interactivo con `ctx.ui.select`.\n     - `/thinking level` exitoso y nivel inválido.\n     - `/thinking` interactivo con `ctx.ui.select`.\n   - Ejecutar suite de pruebas completa y typecheck (`npm run build && npm test`).\n   - Mantener todo en la rama `main` con Conventional Commits.\n   - Bump de versión (0.2.6), actualización de documentación y release publicado con tag en git (`v0.2.6`)."
- L2: Implementación y verificación completadas:
  - Módulo `src/extension/delivery/slash-commands.ts` creado con `handleModelCommand` y `handleThinkingCommand`.
  - Integrado en `Deliverer.process` (`src/extension/delivery/index.ts`) interceptando `/model` y `/thinking`, emitiendo ack `disposition: "command"` y registrando origen.
  - Pruebas unitarias exhaustivas en `test/delivery.test.ts` pasando 44/44.
  - Suite completa de 367 pruebas (unitarias, contrato, RPC y TUI/gentle-shell E2E) pasando 100%.
  - Bump a v0.2.6 en `package.json` y `package-lock.json`, documentación actualizada en `README.md` y `docs/INSTALACION.md`.
