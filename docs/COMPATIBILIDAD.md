# RP — Compatibilidad con el entorno del usuario (herdr, gentle-ai, gentle-shell/gentle-pi) y separación por PC

> Copia canónica en `rp-relay/docs/COMPATIBILIDAD.md` (copiada en `rp-plugin` y `rp-app`).
> Investigación del 2026-10-13 leyendo el código fuente de cada proyecto. Versiones analizadas:

| Proyecto | Repo | Versión / commit | Qué es |
|---|---|---|---|
| Pi | `earendil-works/pi` | `@earendil-works/pi-coding-agent` 1.2.0 (`7d75a0e`) | El agente |
| gentle-shell / gentle-pi | `Gentleman-Programming/gentle-shell` (= `gentle-pi`, mismo código; npm `gentle-pi`) | 4.1.0 (2026-10-12) | Paquete de Pi (extensiones, skills, temas) **+ lanzador `gentle-shell`** |
| gentle-ai | `Gentleman-Programming/gentle-ai` | `main` 2026-10-13 (Go) | Instalador/configurador; para Pi instala `npm:gentle-pi`, `npm:gentle-engram`, `npm:pi-web-access`, `npm:pi-btw` |
| herdr | `herdrdev/herdr` (antes `ogulcancelik/herdr`) | 0.9.3 | Multiplexor de terminal para agentes (Rust), con CLI/socket API |

---

## 1. Hechos verificados que afectan al diseño

### 1.1 gentle-shell (lanzador)
| # | Hecho | Evidencia | Consecuencia para RP |
|---|---|---|---|
| G1 | Por defecto usa un **directorio de Pi aislado** `~/.gentle-shell/agent` (exporta `PI_CODING_AGENT_DIR` a esa ruta). Modos: `isolated` (defecto), `--link` (usa `~/.pi/agent`), `--home <dir>`. La ruta original viaja en `GENTLE_SHELL_USER_PI_HOME`. | `lib/gentle-shell-launcher.ts:195-228, 984-990` | Un paquete instalado con `pi install` **no** se carga dentro de `gentle-shell` (salvo `--link`). Hay que instalar el plugin **también** con `gentle-shell install npm:@j3pf/pi-rp`. La config de RP **no** puede vivir en `PI_CODING_AGENT_DIR` (serían dos emparejamientos): va en `~/.config/rp/`. |
| G2 | En modo *takeover* arranca Pi con `--no-extensions` y vuelve a inyectar con `-e` los demás paquetes de `settings.json`, **pero se salta los paquetes instalados desde git** (sólo inyecta npm y rutas locales). | `lib/gentle-shell-launcher.ts:700-760, 935-970` | El plugin se distribuye **por npm** (`npm:@j3pf/pi-rp`), nunca `git:`. |
| G3 | `gentle-shell <subcomando>` (install/remove/list/update/config) se pasa a `pi` con el home de gentle-shell. | `lib/gentle-shell-launcher.ts:895-903` | `gentle-shell install npm:@j3pf/pi-rp` funciona. |
| G4 | Los subagentes (Gentle Agents) son **procesos `pi --mode rpc` hijos** con `GENTLE_PI_AGENTS_CHILD=1`, y reciben las mismas extensiones que el padre. | `lib/agents-runner.ts:306`, `lib/child-package-injection.ts` | El plugin **no** debe registrarse como agente en los hijos (si no, cada subagente aparecería como agente suelto). Se desactiva con `GENTLE_PI_AGENTS_CHILD=1`. |
| G5 | Las **preguntas de los subagentes** se responden en el padre con el `ctx.ui` del padre (`answerThroughUi` → `ui.select/confirm/input/editor`). | `extensions/gentle-agents.ts:438-460` | El espejo de diálogos del plugin del padre las lleva al móvil sin código extra. |

### 1.2 gentle-pi (extensiones)
| # | Hecho | Evidencia | Consecuencia |
|---|---|---|---|
| P1 | Confirmación de comandos peligrosos (modo Normal) usa **`ctx.ui.confirm(title, preview)`**, emite antes `pi-permission-system:permission-request {requestId, state:"waiting", toolName:"bash"}` y `herdr:blocked`. | `extensions/gentle-ai.ts:1845-1940` | Espejable → llega al móvil. El evento permite clasificarlo como **autorización** (`category:"permission"`). |
| P2 | Otros consentimientos (perfiles, clones externos, revisión, mensajes entre orquestadores, YOLO) usan `ctx.ui.select/confirm/input`. | `lib/foreign-target-grants.ts:21`, `lib/review-consent-ui.ts:102`, `lib/session-messaging-grants.ts:93`, … | Espejables. |
| P3 | Las herramientas del modelo **`ask_user_choice`** y **`ask_user_question`** (cuestionario de 1–4 preguntas, opción múltiple, previews) usan en la TUI **`ctx.ui.custom()`** (componente propio); sólo en "RPC interactivo" usan `select/input`. | `extensions/ask-user-choice.ts:226-300`, `extensions/ask-user-question.ts` | No espejables con el método general → el plugin incluye **adaptadores** que conocen sus parámetros y su tipo de resultado (`ChoiceResult`, `QuestionnaireResult`) y resuelven el `custom()` llamando a su `done(...)`. Ver PLAN-PLUGIN §8.5. |
| P4 | Modo de permisos **Auto**: un clasificador sólo acepta como autorización la entrada con `source === "interactive"` (lo tecleado) o respuestas humanas a diálogos; **ignora mensajes de extensiones y RPC**. `pi.sendUserMessage` produce `source:"extension"`. | `lib/auto-permission-runtime.ts:302-306`, `pi/src/core/agent-session.ts:2418` | En modo Auto, una orden enviada desde el móvil por la vía normal **no autoriza** acciones: el clasificador las denegaría. Solución principal (independiente de herdr): **entrega interactiva nativa** — el plugin teclea el mensaje en la TUI de su propio proceso (RESILIENCIA §2); alternativa herdr (H3). Las **respuestas** a diálogos sí cuentan (pasan por la UI). |
| P5 | El modo se publica en el footer: `setStatus("gentle:mode", "Permissions: AUTO|NORMAL|YOLO")` y `setStatus("gentle:yolo", …)`. | `lib/yolo-session-policy.ts:8-11,133-135` | El plugin observa `setStatus` (espejo) y la app muestra el modo y avisa en Auto. |
| P6 | Nombres de herramientas en Pi son **exclusivos**; un choque impide cargar ("Tool X conflicts with …"). | `gentle-ai internal/agents/pi/adapter.go:56-64` | El plugin nunca registra `ask_user*`; su herramienta propia se llama `rp_ask_user` y sólo se activa si no hay otra herramienta de preguntas. |
| P7 | gentle-pi ya integra herdr (`extensions/gentle-herdr-activity.ts`, eventos `herdr:blocked`). | código | El plugin emite `herdr:blocked` sólo para prompts que nadie más reportó. |

### 1.3 herdr
| # | Hecho | Evidencia | Consecuencia |
|---|---|---|---|
| H1 | Pi corre **dentro** de paneles de herdr como proceso normal; la integración de herdr para Pi es otra extensión (`herdr-agent-state.ts`) instalada en `$PI_CODING_AGENT_DIR/extensions`. | `src/integration/assets/pi/herdr-agent-state.ts`, `docs/.../integrations.mdx` | El plugin funciona igual dentro de herdr. Coexisten sin conflicto (no registran herramientas). |
| H2 | Variables en cada panel: `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, `HERDR_WORKSPACE_ID`, `HERDR_SESSION`. | `cli-reference.mdx §Environment variables` | El plugin reporta la ubicación herdr del agente; la app la muestra ("workspace api · pane 3"). |
| H3 | `herdr agent prompt <pane_id> <texto>` escribe el texto en la terminal del agente y pulsa Enter (bracketed paste); falla con `agent_blocked` si el agente está bloqueado en un diálogo. | `cli-reference.mdx §Agents` | Método de entrega alternativo **`herdr`**: el mensaje del móvil entra como si se tecleara (`source:"interactive"`) → compatible con gentle-pi Auto, comandos `/…` y plantillas. |
| H4 | `herdr workspace create --cwd P --label L --env K=V --no-focus` devuelve JSON con `.result.root_pane.pane_id`; `herdr pane run <pane> <cmd>` ejecuta un comando en ese panel. | `cli-reference.mdx §Workspaces, §Panes` | `rp-host` crea agentes nuevos **dentro de herdr** (backend preferido) lanzando `gentle-shell` o `pi`. |
| H5 | Tras reiniciar el servidor herdr se **reanudan** las sesiones de Pi (mismo archivo de sesión, proceso nuevo). | README herdr, `session-state` | `agentId` debe ser estable por sesión de Pi (no por proceso) para conservar historial en la app. |
| H6 | herdr puede conectar máquinas por SSH ("several machines, one window"): los agentes corren en la máquina remota. | README herdr | Cada PC donde corre Pi tiene su propio plugin emparejado; la "PC" en RP es **donde corre Pi**, no donde está la ventana de herdr. |
| H7 | herdr corre en Linux, macOS y Windows (beta). | README herdr | Plugin y `rp-host` deben ser multiplataforma (Node; nada de APIs sólo POSIX en el plugin). |

### 1.4 gentle-ai
| # | Hecho | Evidencia | Consecuencia |
|---|---|---|---|
| A1 | `gentle-ai install/sync` reescribe `packages` de `~/.pi/agent/settings.json` **conservando** paquetes ajenos; sólo elimina una lista fija de paquetes "retirados" (`rpiv-todo`, `pi-subagents-j0k3r`, `rpiv-ask-user-question`). | `internal/agents/pi/adapter.go:49-75, 297-350` | `npm:@j3pf/pi-rp` sobrevive a `gentle-ai sync`. Test de regresión en la fase 0. |
| A2 | La configuración de gentle-pi vive en `~/.pi/gentle-ai` (o `GENTLE_AI_PI_CONFIG_DIR`). | `internal/agents/pi/config_dir.go` | Sin interacción con RP. |

---

## 2. Matriz de cumplimiento (requisito × entorno)

Leyenda: ✅ funciona por diseño con evidencia de código · 🟡 funciona con la condición indicada · 🔬 a confirmar en spike de fase 0 (la evidencia indica que sí).

| Requisito | Pi en terminal normal | Pi dentro de herdr | gentle-shell (aislado o takeover) | gentle-shell dentro de herdr |
|---|---|---|---|---|
| Ver **todos** mis agentes en vivo | ✅ | ✅ (+ ubicación herdr) | ✅ si el plugin está instalado en su home (G1) | ✅ |
| Separados **por PC** | ✅ | ✅ | ✅ | ✅ |
| Subagentes no ensucian la lista | n/a | n/a | ✅ desactivado en hijos (G4) | ✅ |
| Hablarles (texto) | ✅ `sendUserMessage`; en gentle Auto → entrega interactiva (🔬 S7) | ✅ (+ `herdr` como alternativa) | ✅ Normal/YOLO · ✅🔬 **Auto** con entrega interactiva nativa, sin herdr (RESILIENCIA §2, spike S7) | ✅🔬 ídem |
| Adjuntar archivos/imágenes | ✅ | ✅ | ✅ | ✅ (en entrega interactiva/herdr las imágenes van como ruta de archivo) |
| Interrumpir (abort) | ✅ `ctx.abort()` | ✅ | ✅ | ✅ |
| Notificación de **autorización** + responder | ✅ gate propio del plugin y diálogos de otras extensiones (espejo) | ✅ (+ herdr marca "blocked") | ✅ confirmaciones de gentle-pi (P1, P2) — 🔬 S1/S4 | ✅ |
| Notificación de **pregunta** + responder | ✅ `rp_ask_user` / diálogos | ✅ | ✅ `ask_user_choice` / `ask_user_question` vía adaptadores (P3) — 🔬 S4 | ✅ |
| Preguntas de **subagentes** | n/a | n/a | ✅ llegan por el `ctx.ui` del padre (G5) | ✅ |
| Diálogos `custom()` desconocidos (paneles, editores propios) | 🟡 notificación "esperando en la terminal" (no se pueden responder remotamente) | 🟡 ídem | 🟡 ídem | 🟡 ídem |
| Crear agente nuevo desde el móvil | ✅ `rp-host` + tmux | ✅ `rp-host` + herdr (H4) | ✅ lanzador configurable `gentle-shell` | ✅ |
| Sobrevive reinicio/reanudación | ✅ | ✅ mismo `agentId` (H5) | ✅ | ✅ |
| Instalación sobrevive a `gentle-ai sync` | ✅ (A1) | ✅ | ✅ | ✅ |

**Modo Auto de gentle-pi** (lo usas): por diseño sólo acepta lo tecleado. El plan lo cubre **sin depender de herdr**: el plugin teclea el mensaje del móvil en la TUI de su propio proceso (Linux y Windows), protegido con biometría en el teléfono (RESILIENCIA §2). Respaldo: herdr (`herdr agent prompt`) y, como último recurso, el botón "Pasar a Normal" (envía `/gentle:mode normal` como comando; Pi lo permite, `agent-session.ts:2062`; que gentle-pi lo acepte por esa vía se confirma en S4). Las **respuestas** a preguntas y autorizaciones siempre cuentan. Pendiente de confirmar en el spike S7.

---

## 3. Separación por PC (personal / empresa)

### 3.1 Modelo
- **PC = máquina emparejada** (una por equipo donde corre Pi). Cada una tiene: `name` ("Portátil personal"), `context` (`personal` | `work` | texto libre), `color`, `icon`, `quietHours` opcional.
- Se fija al emparejar: `/rp pair <url> <código> --name "PC Empresa" --context work` (o se pregunta con `ctx.ui.input/select`), y se puede editar desde la app.
- Los agentes heredan la PC (`machineId`); ningún agente existe sin PC.

### 3.2 En la app
- Selector superior persistente: **Todas · Personal · Empresa** (uno por cada `context`, más "Todas"), con el color de la PC. Afecta a la lista de agentes, a Pendientes y al contador de badges.
- Dentro de "Todas", agrupación por PC con cabecera de color.
- **Canales de notificación por PC**: un `NotificationChannelGroup` por máquina con sus canales (autorizaciones, preguntas, terminado, errores). Así puedes, desde Ajustes de Android, silenciar "PC Empresa" fuera de horario sin tocar "PC Personal". Además horas silenciosas por PC dentro de la app (fase 4).
- Cada notificación muestra la PC: "🏢 PC Empresa · api-gateway — ⚠ Permitir `rm -rf dist`?".

### 3.3 En el relay
- `machines.context/color/icon/quiet_hours`; `PATCH /v1/machines/{id}`.
- Preferencias de notificación por dispositivo **y por PC** (`notify_prefs.machines[machineId]`).
- Revocar una PC corta todos sus agentes al instante.

### 3.4 Consideraciones de la PC de la empresa
| Tema | Plan |
|---|---|
| Proxy corporativo / inspección TLS | El plugin respeta `HTTPS_PROXY`/`NO_PROXY` (agente `proxy-agent`) y `NODE_EXTRA_CA_CERTS`. `/rp doctor` prueba DNS, TLS, WebSocket y latencia. |
| WebSocket bloqueado | Transporte de respaldo **HTTP long-poll** (`POST /v1/agent/poll` + `POST /v1/agent/send`), mismo protocolo de mensajes. Se activa solo si el WS falla 3 veces seguidas (fase 2). |
| Política de datos de la empresa (el usuario confirmó que está permitido; se deja la opción por si cambia) | El código y las conversaciones de la PC de la empresa pasan por **tu** relay. Si la política lo prohíbe: (a) `RP` permite **un relay por PC** — la app soporta varios relays (modelo de datos preparado desde v1, UI en fase 4) y la PC de la empresa puede apuntar a un relay interno de la empresa; o (b) en la PC de empresa poner `redactContent: true` en la config del plugin → sólo viajan estados, títulos de preguntas/autorizaciones y respuestas, no el transcript. |
| Windows en la PC de la empresa (confirmado) | Plugin multiplataforma; `rp-host` usa Windows Terminal/consola o herdr (Windows beta). Detalle en RESILIENCIA §5. |
