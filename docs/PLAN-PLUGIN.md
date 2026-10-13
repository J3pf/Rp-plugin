# Plan — Plugin para Pi (`rp-plugin`)

Contexto: [ARQUITECTURA.md](ARQUITECTURA.md). Contrato de red: `rp-relay/docs/PROTOCOLO.md`.
Versión de Pi de referencia: **1.2.0** (`@earendil-works/pi-coding-agent`). Las rutas `src/...` citadas abajo son
del repo `earendil-works/pi`, `packages/coding-agent/`.

## 1. Qué es

Un **Pi package** que contiene:

1. **La extensión** `rp` (se carga en cada proceso `pi`): conecta el agente al relay, transmite su actividad,
   recibe mensajes/adjuntos/abort, y lleva preguntas y autorizaciones al móvil.
2. **`rp-host`** (fase 3): pequeño daemon opcional por máquina que permite **crear agentes nuevos desde el móvil**
   (los lanza en `tmux` con Pi + esta extensión).

Instalación del usuario:
```bash
pi install git:github.com/j3pf/rp-plugin@v0.1.0     # o: pi install npm:@j3pf/pi-rp@0.1.0
# dentro de pi:
/rp pair https://relay.midominio.com ABCD2345         # código de `rp-relay pair machine` o de la app
```
Desde ahí, **toda** sesión de Pi en esa máquina aparece en el móvil automáticamente.

## 2. Estructura del paquete

```
rp-plugin/
├── package.json             # "keywords":["pi-package"], "pi":{"extensions":["./src/extension/index.ts"]}
├── src/
│   ├── extension/
│   │   ├── index.ts         # factory: SÓLO registra handlers/commands/tools/flags (nada de sockets aquí)
│   │   ├── runtime.ts       # estado por sesión: se crea en session_start, se destruye en session_shutdown
│   │   ├── config.ts        # ~/.pi/agent/rp/config.json (respeta PI_CODING_AGENT_DIR)
│   │   ├── connection.ts    # WS con reconexión, cola de salida acotada, hello/welcome
│   │   ├── forwarder.ts     # eventos Pi → agent.event (coalescido de deltas, truncados)
│   │   ├── snapshot.ts      # getBranch() → agent.snapshot normalizado
│   │   ├── inbound.ts       # user.message / abort / prompt.answer
│   │   ├── attachments.ts   # descarga de blobs, imagen→ImageContent, archivos→inbox
│   │   ├── prompts/
│   │   │   ├── broker.ts    # registro de prompts abiertos, carrera terminal vs. móvil
│   │   │   ├── mirror.ts    # parche de ctx.ui.select/confirm/input (espejo de diálogos de cualquier extensión)
│   │   │   ├── gate.ts      # autorizaciones de herramientas (tool_call)
│   │   │   └── askUser.ts   # herramienta ask_user para el modelo
│   │   ├── status.ts        # derivación idle/working/waiting_input/compacting
│   │   ├── commands.ts      # /rp pair|status|on|off|gate|test
│   │   └── compat.ts        # TODO acceso "no público" a Pi pasa por aquí (detección de capacidades)
│   ├── host/                # rp-host (fase 3)
│   └── shared/              # cliente HTTP, logger a archivo
├── test/
└── docs/
```
`package.json`:
- `peerDependencies`: `@earendil-works/pi-coding-agent: "*"`, `@earendil-works/pi-ai: "*"`, `typebox: "*"`
  (provistos por Pi; **no** ponerlos en `dependencies`, ver `docs/packages.md`).
- `dependencies`: `ws`, `@j3pf/rp-protocol`, `ulid`.
- `bin`: `rp-host` → `src/host/cli.ts` (compilado a `dist/` para el bin; la extensión se carga con jiti).

## 3. Configuración

`~/.pi/agent/rp/config.json` (permisos 600):
```jsonc
{
  "relayUrl": "https://relay.midominio.com",
  "machineId": "01JA…", "machineToken": "…",          // obtenidos en /rp pair
  "enabled": true,
  "gate": {
    "mode": "dangerous",            // off | dangerous | writes | all
    "dangerousPatterns": ["\\brm\\s+-[a-z]*r", "\\bsudo\\b", "\\bgit\\s+push\\b.*--force", "\\bchmod\\b.*777", "\\bdd\\b", "\\bmkfs"],
    "alwaysAllowTools": ["read", "grep", "find", "ls"],
    "useAnnotations": true          // usar annotations MCP (destructiveHint/readOnlyHint) para tools de terceros
  },
  "mirrorDialogs": true,
  "notifyOnSettled": true,
  "inboxDir": null                  // por defecto ~/.pi/agent/rp/inbox
}
```
Overrides: env `RP_RELAY_URL`, `RP_DISABLED=1`; flag de Pi `--rp-off` (registrado con `pi.registerFlag`).

## 4. Ciclo de vida (respetando las reglas de Pi)

Reglas de `docs/extensions.md`: *no* abrir sockets/timers en la factory; abrir en `session_start`; cerrar en
`session_shutdown` de forma idempotente; tras reload el runtime anterior queda inválido.

```ts
export default function rp(pi: ExtensionAPI) {
  const cfg = loadConfig();                     // sync, sólo lectura de archivo
  registerCommands(pi); registerFlags(pi);
  registerAskUserTool(pi);                      // siempre registrada; si no hay relay funciona sólo local
  let rt: Runtime | undefined;

  pi.on("session_start", async (ev, ctx) => {
    if (!cfg.enabled || pi.getFlag("rp-off")) return;
    rt = new Runtime(pi, ctx, cfg, ev.reason);  // crea agentId/epoch, instala mirror, conecta WS (no bloquea)
  });
  pi.on("session_shutdown", async () => { await rt?.dispose(); rt = undefined; });

  // Todos los demás handlers delegan en rt si existe:
  for (const e of FORWARDED_EVENTS) pi.on(e, (ev, ctx) => rt?.forward(ev, ctx));
  pi.on("tool_call", (ev, ctx) => rt?.gate(ev, ctx) ?? localGate(ev, ctx, cfg));
  pi.on("ui_prompt_start", (ev) => rt?.terminalWait(ev, true));
  pi.on("ui_prompt_end",   (ev) => rt?.terminalWait(ev, false));
}
```
- `agentId = ctx.sessionManager.getSessionId() + "~" + randomHex(3)`; `epoch = ulid()` por cada `session_start`.
- Cambios de sesión (`/new`, `/resume`, `/fork`): Pi emite `session_shutdown` + `session_start` → nuevo `epoch` y
  posiblemente nuevo `agentId`; el relay ve un agente nuevo y el anterior offline (correcto: es otra conversación).
- El WS se abre en segundo plano: **nunca** se bloquea el arranque de Pi esperando al relay.
- `dispose()`: resuelve como "cancelled" sus prompts abiertos (enviando `prompt.resolved{by:"cancelled"}`),
  restaura `ctx.ui` original, cierra WS con 1000.

## 5. Conexión (`connection.ts`)

- `new WebSocket(relayWsUrl, { headers: { Authorization: "Bearer " + token } })`.
- Reconexión: backoff 1→30 s con jitter; al reconectar: `agent.hello` (incluye `openPrompts`) → `agent.welcome`
  → `agent.snapshot` → vaciar cola.
- Cola de salida mientras está desconectado: máx. **500** mensajes o 2 MB; si se desborda se descartan los
  `agent.event` más viejos y se marca `needsSnapshot` (el snapshot reconstruye el estado). `prompt.*` nunca se descartan.
- Cierre `4001`/`4002`: no reconectar; `ctx.ui.notify("RP: token revocado / versión incompatible", "error")` y
  `ctx.ui.setStatus("rp", "RP ✗")`.
- Indicador en el footer: `ctx.ui.setStatus("rp", "📱 RP")` conectado / `"RP …"` reconectando.

## 6. Reenvío de eventos (`forwarder.ts`)

Eventos de Pi suscritos (`pi.on`): `agent_start`, `agent_settled`, `turn_start`, `turn_end`, `message_start`,
`message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
`session_info_changed`, `model_select`, `thinking_level_select`, `session_compact`.

Reglas (las del PROTOCOLO §4):
- `message_update`: se acumulan los `assistantMessageEvent` `text_delta`/`thinking_delta`/`toolcall_delta` por
  `contentIndex` y se emite un `message_delta` cada 100 ms (o al recibir `message_end`).
- `tool_execution_update`: máx. 1 cada 500 ms por `toolCallId`, `partialResult` truncado a 8 KiB.
- `tool_execution_end`: contenido de texto truncado a 32 KiB; imágenes de resultados → `image_ref` (no se mandan bytes).
- Herramientas anidadas (`parentToolCallId`) se reenvían con ese campo; la app las agrupa.
- Handlers **no** hacen `await` de red (sólo encolan) → no ralentizan el stream de Pi (los handlers se esperan en orden).
- Estado derivado (`status.ts`): `agent_start`→`working`; `ui_prompt_start` o prompt abierto→`waiting_input`;
  compactación→`compacting`; `agent_settled`→`idle`; error del proveedor→`error`.
- `agent_settled` además envía `lastMessagePreview` (primeros 140 caracteres del último texto del asistente) para la
  notificación "terminó".

## 7. Entrada desde el móvil (`inbound.ts`, `attachments.ts`)

### `user.message`
```ts
const content = await buildContent(msg);          // string | (TextContent|ImageContent)[]
if (ctx.isIdle()) pi.sendUserMessage(content);                      // dispara turno
else pi.sendUserMessage(content, { deliverAs: msg.delivery === "steer" ? "steer" : "followUp" });
send("user.message.ack", { clientMsgId, disposition });
```
- `delivery:"auto"` = `followUp` si está ocupado.
- **No** se usa `expandPromptTemplates` salvo que el texto empiece con `/` y el usuario lo active en la app
  (permite usar plantillas y comandos de skills desde el móvil; fase 4).
- Se marca el origen: el plugin guarda `pi.appendEntry("rp.origin", { clientMsgId, deviceId })` para que el historial
  pueda mostrar "enviado desde el móvil" (no entra en el contexto del modelo).

### Adjuntos
- Descarga `GET /v1/blobs/{id}` (token de máquina), verifica `sha256`.
- `image/png|jpeg|webp|gif` ≤ 10 MB → `{ type:"image", data: base64, mimeType }`. Pi ya redimensiona imágenes
  (worker `image-resize-worker`) antes de mandarlas al proveedor.
- Otros → `<inboxDir>/<sessionId>/<YYYYMMDD-HHmmss>-<nombre-saneado>`; se añade al texto:
  `\n\n[Archivo adjunto desde el móvil: <ruta absoluta> (<mime>, <tamaño>)]`.
  Nombre saneado: sólo `[A-Za-z0-9._-]`, máx. 100 chars, sin rutas.
- Modelo sin visión + imagen → también se guarda en inbox y se referencia por ruta.

### `agent.abort` → `ctx.abort()`.

## 8. Preguntas y autorizaciones

Tres fuentes, un único **broker**:

```
                ┌──────── gate.ts (tool_call) ─────────┐
                │                                      │
 ask_user tool ─┼──► ctx.ui.select/confirm/input ──► mirror.ts ──► broker.race(terminal, móvil)
                │                                      ▲
 otras extensiones (permission-gate, plan-mode, …) ────┘  (mismo objeto ctx.ui compartido)
```

### 8.1 `mirror.ts` — espejo de diálogos (núcleo)

Hecho verificado: `ctx.ui` devuelve `runner.uiContext`, un objeto plano creado por `wrapUIPromptContext` y
compartido por todas las extensiones del runner (`src/core/extensions/runner.ts:572-591, 889-891`). Reemplazar sus
métodos afecta a todos los diálogos posteriores de cualquier extensión.

```ts
function installMirror(ctx: ExtensionContext, broker: Broker): () => void {
  if (!ctx.hasUI) return () => {};                 // print/json: noOpUIContext es un singleton del módulo → NO tocar
  const ui = ctx.ui as any;
  if (ui.__rpMirrored) return () => {};
  const orig = { select: ui.select, confirm: ui.confirm, input: ui.input };
  ui.select = (title, options, opts) => broker.race({ kind:"select", title, options, opts },
                  (signal) => orig.select.call(ui, title, options, { ...opts, signal: anySignal(opts?.signal, signal) }));
  ui.confirm = (title, message, opts) => broker.race({ kind:"confirm", title, message, opts },
                  (signal) => orig.confirm.call(ui, title, message, { ...opts, signal: anySignal(opts?.signal, signal) }));
  ui.input  = (title, placeholder, opts) => broker.race({ kind:"input", title, placeholder, opts },
                  (signal) => orig.input.call(ui, title, placeholder, { ...opts, signal: anySignal(opts?.signal, signal) }));
  ui.__rpMirrored = true;
  return () => { Object.assign(ui, orig); delete ui.__rpMirrored; };
}
```
`compat.ts` verifica tras instalar que `ctx.ui.select === nuestro wrapper` (si Pi en el futuro devuelve objetos
nuevos o congelados, se detecta, se registra la característica `mirror_ui` como **no** disponible y se notifica una vez).
Se reinstala en cada `session_start` (el runner puede recrear `uiContext` con `setUIContext`).

### 8.2 `broker.race` — "primera respuesta gana"

```ts
async race(req, runLocal: (signal) => Promise<T>): Promise<T> {
  const p = this.open(req);                       // promptId, guarda en mapa, envía prompt.open (si conectado)
  const localAbort = new AbortController();
  const remote = p.remoteAnswer;                  // Promise que resuelve al llegar prompt.answer
  const local  = ctx.hasUI ? runLocal(localAbort.signal).then(v => ({ src:"local", v }))
                           : new Promise(() => {}); // sin UI local: sólo móvil
  const winner = await Promise.race([local, remote.then(a => ({ src:"remote", v: toLocalValue(req, a) }))]);
  if (winner.src === "remote") { localAbort.abort(); send("prompt.ack", { promptId, accepted:true }); }
  else { send("prompt.resolved", { promptId, by: localResolution(req, winner.v), answer: fromLocal(req, winner.v) }); }
  this.close(p); return winner.v;
}
```
Detalles:
- Si llega `prompt.answer` de un prompt ya cerrado → `prompt.ack{accepted:false}`.
- `opts.timeout` del llamador: se respeta (Pi auto‑resuelve el diálogo local con el valor por defecto) → se envía
  `prompt.resolved{by:"timeout"}`.
- `opts.signal` del llamador abortado → `prompt.resolved{by:"cancelled"}`.
- Sin conexión al relay: el prompt se encola y se envía al reconectar (en `hello.openPrompts`), el diálogo local
  funciona igual.
- Conversión de respuestas: `select` → `options[i]` (texto exacto de la opción, porque Pi devuelve el string);
  `confirm` → boolean; `input` → string. `cancelled` → `undefined`/`false`.
- Prompts concurrentes (herramientas en paralelo) se manejan independientemente; cada uno tiene su `promptId`.
- Diálogos con `kind:"custom"` o `editor()` **no** se espejan (no hay forma pública de cancelarlos/responderlos);
  `ui_prompt_start/end` → `terminal_wait` para que el móvil notifique "esperando en la terminal".

### 8.3 `gate.ts` — autorizaciones

`pi.on("tool_call", …)`: decide si la llamada necesita aprobación:

| `gate.mode` | Pide aprobación para |
|---|---|
| `off` | nada |
| `dangerous` (defecto) | `bash` cuyo comando coincide con `dangerousPatterns`; herramientas con `annotations.destructiveHint===true` |
| `writes` | lo anterior + `write`, `edit`, cualquier `bash`, tools sin `readOnlyHint` |
| `all` | todo excepto `alwaysAllowTools` |

Diálogo: `ctx.ui.select("⚠ <tool>: <resumen>", ["Permitir", "Permitir siempre en esta sesión", "Denegar", "Denegar con motivo…"])`
(pasa por el espejo → llega al móvil con `category:"permission"`, `tool`, `danger`). "Denegar con motivo…" →
`ctx.ui.input("Motivo")`. Resultado: `{ block:true, reason:"Denegado por el usuario: <motivo>" }` (el modelo lo ve).
"Permitir siempre" guarda la regla (tool + patrón de comando) en memoria de la sesión y en
`pi.appendEntry("rp.allow", …)` para reconstruirla en `session_start` desde `getBranch()`.
Sin UI local y sin relay conectado → bloquear con razón "sin forma de aprobar" (fail‑safe, como el ejemplo oficial).
El gate se cambia desde Pi (`/rp gate writes`) y desde la app (mensaje `agent.config` — fase 4).

Para que el broker sepa que es `category:"permission"` y adjunte `tool`, el gate llama `broker.withContext({category, tool, danger}, () => ctx.ui.select(...))` (AsyncLocalStorage); el espejo lee ese contexto. Diálogos de otras extensiones van como `category:"dialog"`.

### 8.4 `askUser.ts` — herramienta para que el modelo pregunte

```ts
pi.registerTool({
  name: "ask_user", label: "Preguntar al usuario", executionMode: "sequential",
  description: "Ask the user a question when you need a decision or missing information. The user may answer from their phone. Prefer 2-5 concise options; set allowFreeText when an open answer is acceptable.",
  parameters: Type.Object({
    question: Type.String(),
    options: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
    allowFreeText: Type.Optional(Type.Boolean({ default: true })),
  }),
  async execute(id, p, signal, _u, ctx) { /* withContext({category:"question"}) → select (+ "Otra respuesta…" → input) o input */ }
});
```
Devuelve `content:[{type:"text", text:"User answered: …"}]`, `details:{question, answer, source:"local"|"remote"}`.
Si el usuario ya tiene `@eko24ive/pi-ask` (su propio `ask_user`), detectar con `pi.getAllTools()` y **no** registrar el
nuestro con el mismo nombre (registrar `rp_ask_user`); el puente de eventos `@eko24ive/pi-ask:*` queda para fase 4.

### 8.5 Notificaciones sin pregunta
- `agent_settled` → evento normal; el relay decide si hace push "terminó" (no hace falta lógica en el plugin).
- Error de proveedor sin reintento (`agent_settled` tras `message_end` con `stopReason:"error"`) → `agent.status{status:"error"}`.

## 9. `rp-host` (fase 3): crear agentes desde el móvil

- Proceso por máquina (`systemctl --user enable --now rp-host`), usa el mismo `machineToken`.
- Conecta a `wss://relay/ws/host`; anuncia `{ machineId, hostname, roots:["~/proyectos"], tmux:true }`.
- Recibe `host.spawn { cwd, name?, model?, initialPrompt? }` → valida que `cwd` esté bajo un `root` permitido →
  `tmux new-session -d -s rp-<short> -c <cwd> -e RP_SPAWN_ID=<ulid> "pi --name '<name>'"`; Pi arranca con el plugin (instalado global) y
  aparece solo en la app. El plugin envía `spawnId` (de `RP_SPAWN_ID`) en `agent.hello`; el relay entrega
  `initialPrompt` como `user.message` a ese agente (lo retiene 60 s). `tmux new-session -e` requiere tmux ≥ 3.2.
- `host.list_dirs { path }` para que la app navegue carpetas dentro de `roots` (sólo nombres de directorios).
- `host.kill { agentId }` → `tmux kill-session` (sólo sesiones creadas por rp-host).
- Requisito: `tmux` ≥ 3.2 con la config de `docs/tmux.md` de Pi. El usuario puede `tmux attach -t rp-<short>` para
  seguir en la terminal.
- Protocolo `host.*` se añade a `PROTOCOLO.md` §9 en la fase 3 (campos arriba).

## 10. Comandos `/rp`

| Comando | Acción |
|---|---|
| `/rp pair <url> <código>` | `POST /v1/pair/machine` → guarda config → conecta |
| `/rp status` | relay, conexión, agentId, features, prompts abiertos |
| `/rp on` / `/rp off` | habilita/deshabilita para esta sesión (y `--persist` en config) |
| `/rp gate <off|dangerous|writes|all>` | cambia el modo del gate |
| `/rp test` | crea un prompt de prueba (confirm) para verificar notificación de punta a punta |
| `/rp unpair` | borra credenciales locales |

## 11. Compatibilidad y modos de Pi

| `ctx.mode` | Espejo | Gate / ask_user | Comentario |
|---|---|---|---|
| `tui` | sí | terminal + móvil | caso principal |
| `rpc` | sí (el UI RPC acepta `signal`, verificado en `rpc-mode.ts:90-115`) | cliente RPC + móvil | p. ej. IDEs |
| `json` / `print` | no (`hasUI=false`) | **sólo móvil** (el broker corre sin rama local) | agentes headless/CI quedan controlables desde el móvil |

Versión mínima soportada: Pi 1.2.0 (requiere `ui_prompt_start`, `agent_settled`, `before_agent_start` unificado).
`compat.ts` comprueba al cargar `typeof pi.on`, existencia de eventos y versión (`VERSION` exportado por el paquete) y
degrada características en vez de fallar.

## 12. Tests

| Nivel | Cómo |
|---|---|
| Unit | broker (carrera local/remoto, timeout, cancel, ack tardío), coalescedor de deltas, truncados, gate (patrones, annotations), saneado de nombres |
| Contrato | todos los mensajes generados validan contra `@j3pf/rp-protocol`; fixtures compartidos |
| Integración con Pi real | `createAgentSession` del SDK de Pi (`docs/sdk.md`) con un proveedor falso (`pi.registerProvider` con stream sintético) + relay real en memoria: (1) el modelo llama `bash rm -rf x` → prompt llega al "móvil" falso → respuesta → la herramienta se bloquea/permite; (2) `pi --mode rpc` como subproceso + `RpcClient` para verificar el espejo cuando hay UI (respuesta remota cancela el `extension_ui_request` local) |
| Manual | checklist en `docs/QA.md`: TUI real en tmux, reload, `/new`, dos `pi` en la misma carpeta, red caída 2 min |

CI: matriz Pi `1.2.0` y `latest` (instalando `@earendil-works/pi-coding-agent` como devDependency).

## 13. Tareas

| # | Tarea | Fase | Est. |
|---|---|---|---|
| P0 | **Spike S1**: extensión mínima que parchea `ctx.ui.select`, responde desde un timer y verifica que el selector TUI se cierra; probar con `permission-gate.ts` oficial cargado a la vez | 0 | 1 d |
| P1 | Esqueleto del paquete, config, `/rp pair`, `/rp status`, compat | 1 | 1 d |
| P2 | Conexión WS + hello/welcome + snapshot + reconexión + cola | 1 | 2 d |
| P3 | Forwarder (coalescido, truncados, estado) | 1 | 1,5 d |
| P4 | Inbound: user.message, abort, ack | 1 | 1 d |
| P5 | Broker + mirror | 2 | 2 d |
| P6 | Gate + reglas persistidas | 2 | 1,5 d |
| P7 | ask_user | 2 | 1 d |
| P8 | Adjuntos | 3 | 1 d |
| P9 | rp-host | 3 | 2 d |
| P10 | Tests de integración con SDK/RPC, publicación (git tag + npm) | 1–3 | 2 d |
