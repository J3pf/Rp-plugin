# Plan — Plugin para Pi (`rp-plugin`)

Contexto: [ARQUITECTURA.md](ARQUITECTURA.md) · Resiliencia e independencia: [RESILIENCIA.md](RESILIENCIA.md) · Compatibilidad con herdr / gentle-ai / gentle-shell y separación por PC:
[COMPATIBILIDAD.md](COMPATIBILIDAD.md) · Contrato de red: `rp-relay/docs/PROTOCOLO.md`.
Versiones de referencia: Pi **1.2.0**, gentle-pi **4.1.0**, herdr **0.9.3**. Las rutas `src/...` son de
`earendil-works/pi/packages/coding-agent/`; las de gentle-pi y herdr se indican con su prefijo.

## 1. Qué es

Un **Pi package** publicado en **npm** como `@j3pf/pi-rp` que contiene:

1. **La extensión `rp`** (se carga en cada proceso `pi`, también cuando lo lanza `gentle-shell` o herdr): conecta el
   agente al relay, transmite su actividad, recibe mensajes/adjuntos/abort y lleva preguntas y autorizaciones al móvil.
2. **`rp-host`** (fase 3): daemon opcional por PC para **crear agentes nuevos desde el móvil** dentro de herdr
   (preferido) o tmux, lanzando `gentle-shell` o `pi`.

### Instalación (por cada PC)
```bash
# 1. Pi "normal" (~/.pi/agent). Sobrevive a `gentle-ai sync` (COMPATIBILIDAD A1).
pi install npm:@j3pf/pi-rp
# 2. gentle-shell usa por defecto su propio home ~/.gentle-shell/agent (COMPATIBILIDAD G1) → instalar también ahí.
#    (no hace falta si siempre lanzas `gentle-shell --link`)
gentle-shell install npm:@j3pf/pi-rp
# 3. Emparejar la PC una sola vez (la credencial se comparte entre ambos homes, vive en ~/.config/rp/)
pi            # o gentle-shell
/rp pair https://relay.midominio.com ABCD2345 --name "PC Empresa" --context work
```
**Nunca** `pi install git:…`: el *takeover* de gentle-shell descarta paquetes git (COMPATIBILIDAD G2).
`rp doctor` (comando `/rp doctor`) verifica que el plugin esté declarado en **ambos** homes y avisa si falta.

## 2. Estructura del paquete

```
rp-plugin/
├── package.json             # name @j3pf/pi-rp, "keywords":["pi-package"], "pi":{"extensions":["./src/extension/index.ts"]}
├── src/
│   ├── extension/
│   │   ├── index.ts         # factory: SÓLO registra handlers/commands/flags (nada de sockets aquí)
│   │   ├── runtime.ts       # estado por sesión: se crea en session_start, se destruye en session_shutdown
│   │   ├── environment.ts   # detecta launcher (pi/gentle-shell), herdr, subagente, modo
│   │   ├── config.ts        # ~/.config/rp/config.json (Windows: %APPDATA%\rp\config.json)
│   │   ├── connection.ts    # WS (con proxy) + respaldo long-poll, reconexión, cola acotada
│   │   ├── forwarder.ts     # eventos Pi → agent.event (coalescido, truncado, redacción)
│   │   ├── snapshot.ts      # getBranch() → agent.snapshot
│   │   ├── inbound.ts       # user.message / abort / prompt.answer
│   │   ├── delivery/{api.ts, interactive.ts, herdr.ts}   # sendUserMessage · tecleado en el proceso · vía herdr
│   │   ├── attachments.ts
│   │   ├── prompts/
│   │   │   ├── broker.ts    # prompts abiertos, carrera terminal vs. móvil
│   │   │   ├── mirror.ts    # parche de ctx.ui: select/confirm/input (+custom vía adaptadores, +setStatus observado)
│   │   │   ├── adapters/{gentle-ask-user-choice.ts, gentle-ask-user-question.ts, index.ts}
│   │   │   ├── classify.ts  # categoría permission/question/dialog (usa eventos de gentle-pi)
│   │   │   ├── gate.ts      # autorizaciones propias (desactivado si gentle-pi ya las hace)
│   │   │   └── askUser.ts   # herramienta rp_ask_user (sólo si no hay otra de preguntas)
│   │   ├── herdr.ts         # herdr:blocked, ubicación del panel
│   │   ├── status.ts
│   │   ├── comm.ts           # Agent Mesh: telemetría de intercom y orchestrator (CommEvent)
│   │   ├── commands.ts      # /rp pair|status|on|off|gate|test|doctor|unpair
│   │   └── compat.ts        # TODO acceso no público (Pi interno, formas de gentle-pi) pasa por aquí
│   ├── host/                # rp-host (fase 3)
│   └── shared/
├── test/
└── docs/
```
`package.json`: `peerDependencies` `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox` = `"*"`
(provistos por Pi; no en `dependencies`). `dependencies`: `ws`, `proxy-agent`, `@j3pf/rp-protocol`, `ulid`.
`bin`: `rp-host`. `engines.node >= 22.19` (igual que gentle-pi).

## 3. Configuración

`~/.config/rp/config.json` (respeta `XDG_CONFIG_HOME`; permisos 600). **Independiente** de `PI_CODING_AGENT_DIR` para
que `pi` y `gentle-shell` (homes distintos) compartan el emparejamiento de la PC.
```jsonc
{
  "relayUrl": "https://relay.midominio.com",
  "machineId": "01JA…", "machineToken": "…",
  "machine": { "name": "PC Empresa", "context": "work" },   // se envía al relay al emparejar; editable desde la app
  "enabled": true,
  "redactContent": false,          // true = sólo estados/preguntas/respuestas, sin transcript (política de empresa)
  "gate": {
    "mode": "auto-detect",         // auto-detect | off | dangerous | writes | all  (auto-detect = off si hay gentle-pi, dangerous si no)
    "dangerousPatterns": ["\\brm\\s+-[a-z]*r", "\\bsudo\\b", "\\bgit\\s+push\\b.*--force", "\\bchmod\\b.*777", "\\bdd\\b", "\\bmkfs"],
    "alwaysAllowTools": ["read", "grep", "find", "ls"],
    "useAnnotations": true
  },
  "mirrorDialogs": true,
  "delivery": { "method": "auto", "interactive": true },  // auto | api | interactive | herdr  (auto: gentle AUTO → interactive → herdr → api; si no, api)
  "subagents": "skip",               // skip (defecto) | connect
  "inboxDir": null                   // por defecto ~/.config/rp/inbox
}
```
Overrides: `RP_RELAY_URL`, `RP_DISABLED=1`, `RP_CONFIG`; flag `--rp-off`.

## 4. Entorno (`environment.ts`)

| Detección | Cómo | Uso |
|---|---|---|
| Subagente de gentle-pi | `process.env.GENTLE_PI_AGENTS_CHILD === "1"` | `subagents:"skip"` → el plugin no conecta (sus preguntas ya llegan por el padre, COMPATIBILIDAD G5) |
| Lanzado por gentle-shell | `GENTLE_SHELL_USER_PI_HOME` definido o `PI_CODING_AGENT_DIR` termina en `.gentle-shell/agent` | `launcher:"gentle-shell"` en `agent.hello` |
| gentle-pi cargado | `pi.getAllTools()` contiene `ask_user_choice`/`ask_user_question`, o se observa `setStatus("gentle:mode", …)` | gate `auto-detect` → off; adaptadores activos |
| Modo de permisos gentle | último `setStatus("gentle:mode", "Permissions: X")` | `agent.hello.gentle.mode` + `agent.statuses` → la app avisa en AUTO |
| Dentro de herdr | `HERDR_ENV==="1"` y `HERDR_PANE_ID` | `herdr:{paneId,tabId,workspaceId,session}`; habilita entrega `herdr` (opcional) |
| Sistema operativo | `process.platform` (`linux` en la PC personal, `win32` en la de la empresa) | rutas de config/inbox, backend de rp-host |
| Modo Pi | `ctx.mode` (`tui`/`rpc`/`json`/`print`) | ver §12 |
| Lanzado por rp-host | `RP_SPAWN_ID` o flag `--rp-spawn-id` | `spawnId` en `agent.hello` |

## 5. Ciclo de vida

Reglas de Pi (`docs/extensions.md`): nada de sockets/timers en la factory; abrir en `session_start`; cerrar en
`session_shutdown` idempotente; tras reload el runtime anterior queda inválido.

```ts
export default function rp(pi: ExtensionAPI) {
  const env = detectStaticEnv(process.env);            // child, herdr, launcher, spawnId
  const cfg = loadConfig();                            // sync, sólo lectura
  registerCommands(pi, cfg); pi.registerFlag("rp-off", { type: "boolean", description: "Disable RP for this run" });
  pi.registerFlag("rp-spawn-id", { type: "string", description: "Internal: id assigned by rp-host" });
  if (env.isGentleChild && cfg.subagents === "skip") return;       // nada más en subagentes
  let rt: Runtime | undefined;
  pi.on("session_start", async (ev, ctx) => {
    if (!cfg.enabled || !cfg.machineToken || pi.getFlag("rp-off")) return;
    rt = new Runtime(pi, ctx, cfg, env, ev.reason);    // identidad, mirror, rp_ask_user condicional, WS en 2º plano
  });
  pi.on("session_shutdown", async () => { await rt?.dispose(); rt = undefined; });
  for (const e of FORWARDED_EVENTS) pi.on(e, (ev, ctx) => rt?.forward(ev, ctx));
  pi.on("tool_call", (ev, ctx) => rt?.onToolCall(ev, ctx));          // gate + seguimiento de herramientas adaptadas
  pi.on("tool_execution_start", (ev) => rt?.adapters.onStart(ev));
  pi.on("tool_execution_end",   (ev) => rt?.adapters.onEnd(ev));
  pi.on("ui_prompt_start", (ev) => rt?.terminalWait(ev, true));
  pi.on("ui_prompt_end",   (ev) => rt?.terminalWait(ev, false));
  pi.events.on("pi-permission-system:permission-request", (d) => rt?.classify.onPermissionRequest(d)); // gentle-pi P1
}
```

### Identidad (estable a través de reanudaciones de herdr, COMPATIBILIDAD H5)
- `agentId = "<machineId>:<piSessionId>"` (`ctx.sessionManager.getSessionId()`).
- `instance = ulid()` por proceso; si dos procesos abren la misma sesión, el relay conserva el más reciente y marca el
  otro con cierre `4003`.
- `epoch = ulid()` por cada `session_start` (cambia con `/new`, `/resume`, `/fork`, reload).

## 6. Conexión (`connection.ts`)

- `new WebSocket(url, { headers:{Authorization:"Bearer …"}, agent: new ProxyAgent() })` → respeta `HTTPS_PROXY`,
  `NO_PROXY`; Node respeta `NODE_EXTRA_CA_CERTS` para CA corporativas.
- Reconexión 1→30 s con jitter. Tras 3 fallos consecutivos de *upgrade* WS (p. ej. proxy que bloquea WebSocket) →
  **transporte long-poll** (`POST /v1/agent/send`, `POST /v1/agent/poll` con espera 25 s) con los mismos mensajes; se
  reintenta WS cada 10 min.
- Al conectar: `agent.hello` (con `openPrompts`) → `agent.welcome` → `agent.snapshot` → vaciar cola.
- Cola: máx. 500 mensajes / 2 MB; si desborda se descartan `agent.event` viejos y se marca `needsSnapshot`;
  `prompt.*` nunca se descartan.
- Cierres `4001`/`4002` → no reconectar; `ctx.ui.notify` + `setStatus("rp","RP ✗")`. Conectado: `setStatus("rp","📱")`.
- El arranque de Pi nunca espera al relay.

## 7. Reenvío de eventos (`forwarder.ts`)

Eventos: `agent_start`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`,
`tool_execution_start/update/end`, `session_info_changed`, `model_select`, `thinking_level_select`, `session_compact`.
- `message_update` coalescido cada 100 ms en `message_delta`; `tool_execution_update` ≤ 1/500 ms, 8 KiB;
  `tool_execution_end` texto ≤ 32 KiB; imágenes → `image_ref`.
- Llamadas anidadas (`parentToolCallId`, p. ej. codemode) se reenvían con ese campo.
- Herramientas de gentle-pi (`subagent_run`, `subagent_status`…) se reenvían como cualquier otra; la app las muestra
  como tarjetas (fase 4: vista dedicada de subagentes).
- `agent.statuses`: cada `setStatus(key, text)` de cualquier extensión (observado por el espejo, §8.1) se reenvía
  coalescido (≤1/s): así la app ve `gentle:mode`, `gentle:yolo`, `herdr`, etc.
- `redactContent:true` → no se envían `message_*` ni resultados de herramientas; sólo estado, nombre de herramienta,
  prompts y respuestas.
- Los handlers sólo encolan (no `await` de red) → no ralentizan a Pi.

## 8. Preguntas y autorizaciones

```
 gentle-pi confirm (P1,P2) ─┐
 subagentes gentle (G5) ────┤
 otras extensiones ─────────┼─► ctx.ui.select/confirm/input ─► mirror ─┐
 gate propio (si no gentle) ┤                                          ├─► broker.race(terminal, móvil)
 rp_ask_user ───────────────┘                                          │
 gentle ask_user_choice / ask_user_question ─► ctx.ui.custom ─► adaptador ┘
 otros custom() / editor() ─► ui_prompt_start ─► "esperando en la terminal" (sólo notificación)
```

### 8.1 `mirror.ts`
`ctx.ui` es **un único objeto compartido** por todas las extensiones del runner (`runner.ts:572-591, 889-891`), y los
llamadores invocan `ui.select(...)` como método → parchearlo **en el sitio** (no reemplazar el objeto) afecta a todos,
incluidos los que guardaron la referencia a `ctx.ui` antes (como `answerThroughUi` de gentle-agents).

```ts
function installMirror(ctx, broker, adapters, statuses): () => void {
  if (!ctx.hasUI) return () => {};                 // print/json: noOpUIContext es singleton del módulo → NO tocar
  const ui = ctx.ui as any; if (ui.__rp) return () => {};
  const orig = { select: ui.select, confirm: ui.confirm, input: ui.input, custom: ui.custom, setStatus: ui.setStatus };
  ui.select  = (t, o, opts)  => broker.race({kind:"select", title:t, options:o, opts}, s => orig.select.call(ui, t, o, withSignal(opts, s)));
  ui.confirm = (t, m, opts)  => broker.race({kind:"confirm", title:t, message:m, opts}, s => orig.confirm.call(ui, t, m, withSignal(opts, s)));
  ui.input   = (t, p, opts)  => broker.race({kind:"input", title:t, placeholder:p, opts}, s => orig.input.call(ui, t, p, withSignal(opts, s)));
  ui.custom  = (factory, o)  => adapters.active()
      ? adapters.race(factory, o, (f) => orig.custom.call(ui, f, o))     // §8.5
      : orig.custom.call(ui, factory, o);
  ui.setStatus = (k, v) => { statuses.observe(k, v); return orig.setStatus.call(ui, k, v); };
  ui.__rp = true;
  return () => { Object.assign(ui, orig); delete ui.__rp; };
}
```
`compat.ts` verifica tras instalar que `ctx.ui.select` es el wrapper; si no, desactiva `mirror_ui` y avisa una vez.
Se reinstala en cada `session_start`.

### 8.2 `broker.race` — "primera respuesta gana"
```ts
async race(req, runLocal: (signal) => Promise<T>): Promise<T> {
  const p = this.open(req);                                  // promptId; clasifica (§8.3); prompt.open; herdr:blocked si aplica
  const ac = new AbortController();
  const local  = ctx.hasUI ? runLocal(ac.signal).then(v => ({src:"local", v})) : never();
  const remote = p.remoteAnswer.then(a => ({src:"remote", v: toLocalValue(req, a)}));
  const w = await Promise.race([local, remote]);
  if (w.src === "remote") { ac.abort(); send("prompt.ack", {promptId: p.id, accepted:true}); }
  else send("prompt.resolved", {promptId: p.id, by: localBy(req, w.v), answer: fromLocal(req, w.v)});
  this.close(p); return w.v;
}
```
- `prompt.answer` de un prompt ya cerrado → `prompt.ack{accepted:false}`.
- `opts.timeout` del llamador → `by:"timeout"`; `opts.signal` abortado → `by:"cancelled"`.
- Sin conexión: el prompt viaja en `hello.openPrompts` al reconectar; el diálogo local funciona igual.
- `select` devuelve el **texto exacto** de la opción (Pi y gentle-pi comparan por etiqueta); `confirm` boolean; `input` string.
- Prompts concurrentes: independientes (cada uno su `promptId`).
- Respuesta remota a un diálogo de gentle-pi pasa por su propio `ctx.ui` → gentle-pi la registra como **respuesta
  humana** (cuenta como autorización también en modo Auto, COMPATIBILIDAD P4).

### 8.3 Clasificación (`classify.ts`)
| Origen | Señal | `category` | `danger` |
|---|---|---|---|
| Gate propio | contexto AsyncLocalStorage del gate | `permission` | según patrón |
| gentle-pi confirmación de comando | evento `pi-permission-system:permission-request` `state:"waiting"` justo antes del `confirm` (mismo tick) | `permission` (+`tool:{name:"bash"}`, comando = `message` del confirm) | `high` si el título contiene "data-loss", si no `medium` |
| Subagente gentle | título empieza con `❀ ` (`AGENTS_GLYPH`, gentle-pi `lib/agents-widget.ts:11`) | `question` (+ `subagent:true`) | `low` |
| `rp_ask_user`, adaptadores | — | `question` | `low` |
| Resto | — | `dialog` | `low` |

### 8.4 `gate.ts` — autorizaciones propias
Sólo si **no** hay gentle-pi (o `gate.mode` explícito ≠ `auto-detect`), para no duplicar las confirmaciones de
gentle-pi. Modos `off|dangerous|writes|all` (tabla del plan v1). Diálogo: `ctx.ui.select("⚠ <tool>: <resumen>",
["Permitir","Permitir siempre en esta sesión","Denegar","Denegar con motivo…"])` → pasa por el espejo.
"Permitir siempre" se guarda con `pi.appendEntry("rp.allow", …)` y se reconstruye desde `getBranch()`.
Sin UI local y sin relay → bloquear (fail-safe).

### 8.5 Adaptadores de `custom()` (gentle-pi `ask_user_choice` y `ask_user_question`)
Problema: en la TUI estas herramientas usan `ctx.ui.custom()` (COMPATIBILIDAD P3), que no tiene equivalente remoto.
Solución: el adaptador conoce los **parámetros** de la herramienta (los ve en `tool_call`) y el **tipo de resultado**
que espera su `custom()`, y resuelve el diálogo llamando al `done` que Pi le pasa a la *factory*.

```ts
// seguimiento: tool_call / tool_execution_start de una herramienta con adaptador → adapters.current = {toolCallId, args, adapter}
// ambas herramientas son executionMode:"sequential", así que hay como mucho una activa a la vez
adapters.race(factory, opts, runOrig) {
  const cur = this.current; let doneRef: ((v:any)=>void) | undefined;
  const wrapped = (tui, theme, kb, done) => { doneRef = done; return factory(tui, theme, kb, done); };
  const p = broker.open(cur.adapter.toPrompt(cur.args));       // kind "questionnaire"/"select"
  p.remoteAnswer.then(a => { doneRef?.(cur.adapter.toResult(cur.args, a)); send("prompt.ack", {promptId:p.id, accepted:true}); });
  return runOrig(wrapped).then(v => { if (!p.closed) send("prompt.resolved", {promptId:p.id, by:"local", answer: cur.adapter.fromResult(v)}); broker.close(p); return v; });
}
```
| Herramienta (gentle-pi 4.1.0) | `toPrompt` | `toResult` (tipo esperado) |
|---|---|---|
| `ask_user_choice {question, options[{label,description,value}], allowCustomResponse?}` | `kind:"select"`, opciones con descripción, `allowFreeText` | `{value,label,index}` (índice base 1) o `{customResponse}`; cancelado → `undefined` (`extensions/ask-user-choice.ts:54`) |
| `ask_user_question {questions[1..4]{question, header, options[2..4]{label,description,preview?}, multiSelect?}}` | `kind:"questionnaire"` | `QuestionnaireResult {cancelled, answers:[{questionIndex, question, kind:"option"|"custom"|"multi", answer, selected?}]}` (`lib/questionnaire/questionnaire-view.ts:31-44`) |

- Gentle-pi ejecuta su `captureAnswer(selection)` con el resultado → la respuesta remota queda registrada como respuesta
  humana igual que la local.
- `compat.ts` comprueba la versión de gentle-pi (lee `package.json` subiendo desde `pi.getAllTools()[i].sourceInfo.baseDir`/`path`, `ToolInfo.sourceInfo` en `types.ts:2122-2130`)
  contra el rango probado (`>=4.0 <5`). Fuera de rango → adaptador desactivado y se usa la notificación
  "esperando en la terminal". Tests de contrato con fixtures de parámetros/resultados de gentle-pi en CI.
- Adaptadores adicionales (p. ej. `@eko24ive/pi-ask`, ejemplo `question.ts` de Pi) se añaden con la misma interfaz.

### 8.6 `rp_ask_user` (herramienta propia)
Se registra en `session_start` **sólo** si no existe ninguna herramienta llamada `ask_user*`/`question*`
(los nombres son exclusivos, COMPATIBILIDAD P6). Parámetros `{question, options?, allowFreeText?}`; usa
`ctx.ui.select` (+ "Otra respuesta…" → `ctx.ui.input`) → espejo.

### 8.7 herdr
- Al abrir un prompt remoto que **no** proviene de gentle-pi (que ya emite su propio `herdr:blocked`), el plugin emite
  `pi.events.emit("herdr:blocked", {active:true, label:title})` y `{active:false}` al cerrarlo → el panel de herdr se
  marca "blocked" también para diálogos de otras extensiones.
- `ui_prompt_start` con `kind:"custom"`/`"editor"` → `terminal_wait` (notificación "esperando en la terminal").

## 9. Entrada desde el móvil

### 9.1 Entrega del mensaje (`delivery/`)
| Método | Cómo | `source` en Pi | Cuándo |
|---|---|---|---|
| `api` | `pi.sendUserMessage(content, {deliverAs})` | `extension` | sin modo Auto de gentle; adjuntos de imagen nativos |
| `interactive` | el plugin **teclea** el texto en la TUI de su propio proceso (`process.stdin.emit("data", …)`, pegado entre corchetes + Enter). Detalle y salvaguardas en RESILIENCIA §2 | `interactive` | gentle en **AUTO** (por defecto), o si el usuario lo elige; **no depende de herdr**; Linux y Windows |
| `herdr` | `pi.exec("herdr", ["agent","prompt", HERDR_PANE_ID, texto])` (sin shell) | `interactive` | alternativa si `interactive` no está disponible y el agente corre en herdr |
| comando | `pi.sendUserMessage("/…", {expandPromptTemplates:true})` (`agent-session.ts:2062`) | — | texto `/…` marcado "ejecutar como comando" |

- `method:"auto"`: gentle en AUTO → `interactive` → `herdr` → `api` + aviso "no autoriza en Auto".
- `interactive` y `herdr` sólo llevan texto; los adjuntos se guardan en el inbox y se citan por ruta.
- `interactive` requiere `ctx.mode === "tui"`; espera a que no haya diálogo abierto; guarda y restaura el borrador del
  editor; para *follow-up* espera a `agent_settled` (no depende de la tecla configurada, que en Windows es `ctrl+q`);
  confirma con el evento `input` (`source:"interactive"`, texto igual) en ≤3 s o revierte y cae al siguiente método.
- Idempotencia: el plugin recuerda los últimos 500 `clientMsgId` por agente; repetido → `ack{disposition:"duplicate"}`.
- `pi.appendEntry("rp.origin", {clientMsgId, deviceId, method})` marca el origen (auditoría; no entra al contexto).

### 9.2 Adjuntos
Igual que el plan v1: descarga `GET /v1/blobs/{id}` (token de máquina), verificación `sha256`; imágenes ≤10 MB →
`ImageContent`; resto → `<inboxDir>/<sessionId>/<YYYYMMDD-HHmmss>-<nombre-saneado>` + línea
`[Archivo adjunto desde el móvil: <ruta> (<mime>, <tamaño>)]`.

### 9.3 `agent.abort` → `ctx.abort()`.

## 10. `rp-host` (fase 3): crear agentes desde el móvil

- Servicio por PC: **Linux (PC personal)** `systemctl --user enable --now rp-host`; **Windows (PC empresa)** tarea
  programada al iniciar sesión (`schtasks /Create /SC ONLOGON /TN rp-host /TR "rp-host run"`, sin administrador);
  macOS `launchd`. Usa el `machineToken` de la config de RP.
- `~/.config/rp/host.json`:
  ```jsonc
  { "roots": ["~/proyectos"], "backend": "auto",           // auto | herdr | tmux | wt | console  (auto: herdr si está; si no tmux en Linux, wt en Windows)
    "launchers": { "gentle-shell": "gentle-shell", "pi": "pi" }, "defaultLauncher": "gentle-shell",
    "herdrSession": null }                                  // null = sesión por defecto de herdr
  ```
- `host.spawn {cwd, name?, launcher?, initialPrompt?}`:
  - **herdr** (COMPATIBILIDAD H4) — tres destinos, elegidos en la app (`herdrTarget`):
    | Destino | Comando | Uso típico |
    |---|---|---|
    | **Nuevo workspace** (defecto) | `herdr workspace create --cwd <cwd> --label <name> --env RP_SPAWN_ID=<ulid> --no-focus` | proyecto nuevo |
    | Nueva pestaña en un workspace existente | `herdr tab create --workspace <id> --cwd <cwd> --label <name> --env RP_SPAWN_ID=<ulid> --no-focus` | otro agente en el mismo proyecto |
    | Dividir un panel existente | `herdr pane split <pane_id> --direction right|down --cwd <cwd> --env RP_SPAWN_ID=<ulid> --no-focus` | agente al lado de otro |
    Los tres devuelven JSON con el panel nuevo (`.result.root_pane.pane_id` o el panel creado por el split) →
    `herdr pane run <pane> "<launcher>"`. Nunca cambian el foco de tu pantalla (`--no-focus`).
    El agente aparece en tu herdr (lo ves al volver al PC o con `herdr --remote`) y en la app.
  - Si el servidor de herdr no está corriendo (`herdr status server` falla), rp-host lo inicia sin interfaz con
    `herdr server` (proceso hijo supervisado); al abrir `herdr` en el PC te conectas a ese mismo servidor y ves el agente.
  - `host.herdr_layout {machineId}` → rp-host responde con `herdr workspace list` + `herdr tab list` (ids, etiquetas,
    cwd) para que la app muestre dónde crear el agente.
  - **tmux** (Linux): `tmux new-session -d -s rp-<short> -c <cwd> -e RP_SPAWN_ID=<ulid> "<launcher>"` (tmux ≥ 3.2).
  - **wt** (Windows Terminal): `wt.exe -w rp new-tab -d <cwd> --title <name> <launcher> --rp-spawn-id <ulid>`
    (Pi pasa flags desconocidos a las extensiones, `cli/args.ts:56-257`; gentle-shell los reenvía a Pi como passthrough).
  - **console** (Windows sin `wt`): `cmd /c start "<name>" /D <cwd> <launcher> --rp-spawn-id <ulid>`.
  - El plugin envía `spawnId` en `agent.hello`; el relay entrega `initialPrompt` como `user.message` a ese agente.
- `host.list_dirs {path}` (sólo dentro de `roots`), `host.kill {spawnId}` (sólo agentes creados por rp-host:
  `herdr workspace close` / `tmux kill-session`).
- Validaciones: `cwd` canonicalizado (`realpath`) debe estar dentro de un `root`; `launcher` debe ser una clave de
  `launchers` (nunca un comando arbitrario del móvil).

## 11. Comandos `/rp`

| Comando | Acción |
|---|---|
| `/rp pair <url> <código> [--name N] [--context personal|work|…]` | Empareja la PC (pregunta nombre/contexto si faltan) |
| `/rp status` | relay, transporte (ws/long-poll), agentId, PC, launcher, herdr, modo gentle, features, prompts abiertos |
| `/rp doctor` | DNS/TLS/WS/proxy, reloj, plugin declarado en `~/.pi/agent` y `~/.gentle-shell/agent`, `herdr` en PATH, versión gentle-pi soportada |
| `/rp on` / `/rp off [--persist]` | habilitar/deshabilitar |
| `/rp gate <auto-detect|off|dangerous|writes|all>` | modo del gate propio |
| `/rp test` | prompt de prueba de punta a punta |
| `/rp unpair` | borra credenciales locales |

## 12. Modos de Pi

| `ctx.mode` | Espejo | Respuestas | Nota |
|---|---|---|---|
| `tui` (pi, gentle-shell, dentro o fuera de herdr) | sí | terminal + móvil | caso principal |
| `rpc` (IDE, cliente RPC) | sí (`rpc-mode.ts:90-115` respeta `signal`) | cliente + móvil | subagentes gentle excluidos por `GENTLE_PI_AGENTS_CHILD` |
| `json` / `print` | no (`hasUI=false`) | sólo móvil (broker sin rama local) | agentes headless controlables desde el móvil |

Compatibilidad mínima: Pi ≥ 1.2.0. gentle-pi probado 4.x. herdr ≥ 0.9 (sólo para entrega `herdr`/rp-host).
Plataformas: Linux, macOS, Windows (plugin); rp-host: herdr en las tres, tmux en Linux/macOS.

## 13. Tests

| Nivel | Cómo |
|---|---|
| Unit | broker (carrera, timeout, cancel, ack tardío), adaptadores (`toPrompt`/`toResult` con fixtures reales de gentle-pi 4.1.0), clasificador, coalescedor, gate, saneado, detección de entorno |
| Contrato | mensajes vs `@j3pf/rp-protocol` |
| Integración Pi | SDK `createAgentSession` + proveedor falso + relay en memoria (flujo gate, respuestas remotas) |
| Integración gentle-pi | Pi + `gentle-pi@4.1.0` + plugin, en `pi --mode rpc` con `RpcClient` (+ `GENTLE_SHELL_INTERACTIVE_HOST` sin definir): confirmación de comando peligroso respondida desde el "móvil"; `ask_user_question` respondida por adaptador en TUI real dentro de `tmux`/herdr (E2E con `herdr pane read` para verificar que el diálogo se cerró) |
| E2E herdr | panel herdr con gentle-shell: `herdr agent prompt` desde la entrega `herdr`; `rp-host` crea workspace; reinicio del servidor herdr conserva `agentId` |
| Regresión gentle-ai | `gentle-ai sync` en un home de prueba conserva `npm:@j3pf/pi-rp` |
| Manual | `docs/QA.md` |

CI: matriz Pi `1.2.0`/`latest` × gentle-pi `4.1.0`/`latest`.

## 14. Tareas

| # | Tarea | Fase | Est. |
|---|---|---|---|
| P0 | **Spike S1**: parche de `ctx.ui` + cierre de diálogo TUI con `signal`, junto a `permission-gate.ts` | 0 | 1 d |
| P0b | **Spike S4**: gentle-shell (aislado y takeover) carga `npm:@j3pf/pi-rp`; responder desde fuera: confirmación de gentle-pi, `ask_user_question` por adaptador, pregunta de subagente; `/gentle:mode normal` por `sendUserMessage` | 0 | 1,5 d |
| P0c | **Spike S5**: herdr — `herdr agent prompt` como entrega, `workspace create` + `pane run gentle-shell`, reanudación conserva `sessionId` | 0 | 0,5 d |
| P0d | **Spike S6**: conectividad desde la PC Windows de la empresa (proxy, WS, TLS) | 0 | 0,5 d |
| P0e | **Spike S7**: entrega `interactive` (stdin en el proceso) en Linux y Windows, con Pi y con gentle-shell (incluido modo Vim), y que gentle-pi en AUTO la cuente como petición humana | 0 | 1 d |
| P1 | Esqueleto, config XDG, entorno, `/rp pair|status|doctor`, compat | 1 | 1,5 d |
| P2 | Conexión WS + proxy + hello/snapshot/reconexión/cola | 1 | 2 d |
| P3 | Forwarder + statuses + redacción | 1 | 1,5 d |
| P4 | Entrada: `api`, comando, abort, ack | 1 | 1 d |
| P5 | Broker + mirror + clasificador + herdr:blocked | 2 | 2,5 d |
| P6 | Adaptadores gentle-pi + fixtures | 2 | 2 d |
| P7 | Gate propio + `rp_ask_user` condicional | 2 | 1,5 d |
| P8 | Entregas `interactive` (stdin) y `herdr` + idempotencia | 2 | 1,5 d |
| P9 | Transporte long-poll de respaldo | 2 | 1 d |
| P10 | Adjuntos | 3 | 1 d |
| P11 | rp-host (herdr, tmux, Windows Terminal, consola; servicio systemd/schtasks) | 3 | 3 d |
| P12 | Tests de integración gentle-pi/herdr, publicación npm | 1–3 | 3 d |

## 15. Estado de implementación

Todo lo descrito arriba está implementado en este repositorio. Resumen por tarea y diferencias respecto al plan.

| # | Tarea | Estado |
|---|---|---|
| P0 | Spike S1 (espejo + cierre con `signal`) | ✅ [S1](spikes/S1-ui-mirror.md) |
| P0b | Spike S4 (gentle-shell) | ✅ casi completo, ver [S4](spikes/S4-gentle-shell.md) |
| P0c | Spike S5 (herdr) | ⚠️ sin herdr real ([S5](spikes/S5-herdr.md)) |
| P0d | Spike S6 (Windows empresa) | ⏳ procedimiento en [S6](spikes/S6-windows-empresa.md) |
| P0e | Spike S7 (entrega interactiva) | ✅ Linux; ⏳ Windows/Vim/Auto real ([S7](spikes/S7-entrega-interactiva.md)) |
| P1 | Esqueleto, config XDG, entorno, `/rp`, compat | ✅ `config.ts`, `environment.ts`, `commands.ts`, `compat.ts` |
| P2 | Conexión WS + proxy + hello/snapshot/reconexión/cola | ✅ `connection.ts` |
| P3 | Forwarder + statuses + redacción | ✅ `forwarder.ts`, `snapshot.ts`, `status.ts` |
| P4 | Entrada `api`, comando, abort, ack | ✅ `delivery/api.ts`, `inbound.ts` |
| P5 | Broker + mirror + clasificador + `herdr:blocked` | ✅ `prompts/`, `herdr.ts` |
| P6 | Adaptadores gentle-pi + fixtures | ✅ `prompts/adapters/` (formas tomadas del código real de gentle-pi 4.1.0 y probadas contra él) |
| P7 | Gate propio + `rp_ask_user` condicional | ✅ `prompts/gate.ts`, `prompts/askUser.ts` |
| P8 | Entregas `interactive` y `herdr` + idempotencia | ✅ `delivery/` |
| P9 | Long-poll de respaldo | ✅ `connection.ts` (`LongPollTransport`) |
| P10 | Adjuntos | ✅ `attachments.ts` |
| P11 | rp-host (herdr, tmux, wt, consola; systemd/schtasks/launchd) | ✅ `src/host/` (Windows y herdr sin ejecutar en máquina real) |
| P12 | Tests de integración gentle-pi/herdr, publicación npm | ✅ tests y `.github/workflows/ci.yml`; la publicación (`npm publish`) la haces tú |
| P13 | Agent Mesh: telemetría de comunicación inter-agente (`intercom` y `orchestrator_send_message` entrante/saliente → `CommEvent`) | ✅ `src/extension/comm.ts`, `test/comm.test.ts` |

### Decisiones y diferencias respecto al plan
- **`@j3pf/rp-protocol`** aún no existe: los tipos están en `src/shared/protocol.ts` y los validadores del contrato en
  `test/contract.ts` (escritos desde `PROTOCOLO.md`). Los fixtures JSON de `test/fixtures/protocol/` se pueden copiar a
  `rp-relay`. Al publicar el paquete, sustituir ambos por la dependencia.
- **Long-poll**: `PROTOCOLO.md` no dice cómo identifica el relay al agente en `/v1/agent/send|poll`. El plugin envía
  `x-rp-agent-id` y `x-rp-instance` (cabeceras) y los mismos valores como query en `poll`. Ajustar si el relay usa otra cosa.
- **Adjuntos**: el relay no define dónde viaja el `sha256`; el plugin lo comprueba si llega en la referencia o en la cabecera
  `x-rp-sha256`/`x-content-sha256`, y siempre verifica el tamaño.
- **Gate sin aprobador**: en sesiones sin UI la autorización espera hasta `gate.approverWaitMs` (5 s) a que el relay conecte
  antes de bloquear por seguridad; así un agente lanzado por rp-host no falla en el arranque.
- **Modo gentle desconocido**: gentle-pi publica `gentle:mode` a partir del primer turno. Mientras no se conoce, el plugin
  asume que *podría* ser Auto y teclea (correcto en cualquier modo).
- **Versión de gentle-pi**: se lee del `package.json` de nombre `gentle-pi` más cercano a la ruta de la herramienta; si no se
  encuentra, los adaptadores siguen activos (cada uno valida la forma de los parámetros) y sólo se desactivan fuera de `>=4.0 <5`.
- **SDK de Pi**: `session.dispose()` no emite `session_shutdown`; el socket está `unref()`-ado para no retener el proceso.
- **Agent Mesh (handover entrante)**: en `pi-intercom`, los mensajes de tipo `handover` se inyectan sin un marcador específico en `Message` (su payload llega como mensaje de texto estándar en `pi.sendMessage`), por lo que el lado receptor emite el evento `comm` con `action: "send"`. En cambio, el lado emisor sí intercepta la herramienta `intercom` con `action: "handover"` y emite `action: "handover"`.
- **Modo Vim**: la detección es heurística (estado de pie de página que contenga «vim»); pendiente de confirmar en S7.
