# RP — Arquitectura general (Relay + App Android + Plugin de Pi)

> Documento maestro. Es el mismo para los tres repos (`rp-relay`, `rp-plugin`, `rp-app`).
> La copia canónica vive en `rp-relay/docs/ARQUITECTURA.md`; el contrato de red en
> `rp-relay/docs/PROTOCOLO.md`. Cada repo tiene además su plan detallado:
> `rp-relay/docs/PLAN-RELAY.md`, `rp-plugin/docs/PLAN-PLUGIN.md`, `rp-app/docs/PLAN-APP.md`.

Fecha de la investigación: 2026-10-13. Versión de Pi analizada: `@earendil-works/pi-coding-agent` **1.2.0**
(commit `7d75a0e` de `earendil-works/pi`, 2026-10-12).

---

## 1. Objetivo

Desde un teléfono Android:

1. **Ver todos mis agentes Pi** que estén corriendo (en cualquier máquina), con su estado en vivo.
2. **Hablarles**: enviar mensajes, interrumpir (abort), encolar seguimiento (follow-up) o dirigir (steer).
3. **Adjuntar archivos** (imágenes y cualquier otro archivo).
4. **Recibir notificaciones push** cuando un agente **pregunta algo** o **pide autorización**, y **responder o aceptar
   directamente** (incluso desde la propia notificación, sin abrir la app).

Todo pasando por un **Relay propio** instalable en **Ubuntu Server**.

## 2. Componentes

```
┌──────────────────────┐        wss://relay/ws/app          ┌────────────────────────────┐
│  App Android (rp-app)│◄──────────────────────────────────►│                            │
│  Kotlin + Compose    │        https://relay/v1/...         │   Relay (rp-relay)         │
│                      │◄──────────────────────────────────►│   Node 22 + TypeScript     │
└─────────▲────────────┘                                     │   Fastify + ws + SQLite    │
          │  FCM (push, payload cifrado)                      │   Ubuntu 22.04 / 24.04     │
          │                                                   │                            │
   ┌──────┴───────┐   HTTP v1 API (firebase-admin)            │                            │
   │ Google FCM   │◄──────────────────────────────────────────┤                            │
   └──────────────┘                                           └─────────────▲──────────────┘
                                                                            │ wss://relay/ws/agent
                                                     (conexión SALIENTE desde cada Pi; sin abrir puertos)
                     ┌──────────────────────────────────────────────────────┼─────────────────────────┐
                     │ Máquina A                                            │                         │
                     │  ┌─────────────┐  ┌─────────────┐   ┌────────────────┴──┐                      │
                     │  │ pi (TUI)    │  │ pi (TUI)    │   │ rp-host (opcional, │  tmux new-session ... │
                     │  │ +rp-plugin  │  │ +rp-plugin  │   │ fase 3: lanzar     │──────► pi +rp-plugin  │
                     │  └─────────────┘  └─────────────┘   │ agentes desde app) │                      │
                     │                                     └────────────────────┘                      │
                     └─────────────────────────────────────────────────────────────────────────────────┘
```

| Componente | Repo | Qué es | Stack decidido |
|---|---|---|---|
| **Relay** | `rp-relay` | Servidor central: autenticación, enrutamiento en tiempo real, historial, cola de preguntas/autorizaciones, envío de push, almacén temporal de adjuntos. | Node.js 22 LTS, TypeScript, Fastify 5, `ws`, SQLite (`better-sqlite3`), `firebase-admin`, systemd o Docker + Caddy (TLS). |
| **Plugin** | `rp-plugin` | *Pi package* (extensión TypeScript) que se carga dentro de cada proceso `pi`. Conecta el agente al relay, transmite eventos, inyecta mensajes, y reenvía diálogos/autorizaciones al móvil. Incluye `rp-host` (fase 3). | TypeScript, cargado por Pi con `jiti`; dependencias: `ws`, `typebox` (provista por Pi). |
| **App** | `rp-app` | Cliente Android nativo. | Kotlin 2.x, Jetpack Compose + Material 3, OkHttp (WS/HTTP), kotlinx.serialization, Room, DataStore, Hilt, FCM, CameraX + ML Kit (QR). |

## 3. Decisiones clave (y por qué)

| # | Decisión | Alternativas descartadas | Motivo |
|---|---|---|---|
| D1 | **Integración con Pi vía extensión (plugin) dentro del proceso `pi`**, no envolviendo `pi --mode rpc`. | Wrapper RPC (como Happy hace con Claude Code). | El usuario sigue usando Pi normalmente en su terminal; el plugin "engancha" cualquier sesión (TUI, tmux, etc.). La API de extensiones de Pi expone todo lo necesario (ver §4). El modo RPC se reserva sólo como plan B. |
| D2 | **Conexiones salientes** desde plugin y app hacia el relay (WebSocket sobre TLS). | Que el relay se conecte a las máquinas. | No hay que abrir puertos en las máquinas de desarrollo; funciona detrás de NAT. |
| D3 | **Relay en TypeScript** (mismo lenguaje que el plugin). | Rust (Remote Pi), Go. | Comparte los esquemas del protocolo (TypeBox) con el plugin → validación idéntica en ambos lados, menos incertidumbre. La carga (1 usuario, decenas de agentes) es trivial para Node. |
| D4 | **SQLite** como única base de datos. | Postgres, Redis. | Un solo usuario, un solo servidor. Cero operación; backup = copiar un archivo. |
| D5 | **Push con FCM (Firebase Cloud Messaging) mensajes *data* de prioridad alta, con payload cifrado AES‑256‑GCM** por dispositivo. | Socket persistente en servicio foreground; UnifiedPush/ntfy. | FCM es lo único que despierta la app de forma fiable en Doze/app cerrada sin gastar batería. Google sólo ve texto cifrado. UnifiedPush queda como alternativa opcional (fase 4) para quien no quiera Google. |
| D6 | **Responder desde la notificación** con botones de acción (Permitir / Denegar / opciones) y *RemoteInput* (respuesta de texto), enviados por HTTPS directo al relay. | Obligar a abrir la app. | Requisito principal del usuario. |
| D7 | **"Primera respuesta gana"**: una pregunta se puede responder en la terminal **o** en el móvil; la que llegue primero resuelve y la otra se cancela automáticamente. | Bloquear la terminal mientras el móvil decide. | Los diálogos de Pi aceptan `AbortSignal` (verificado en código), así que se puede cancelar el diálogo de la terminal cuando responde el móvil, y viceversa. |
| D8 | **TLS sí, cifrado extremo a extremo no (v1)**. | E2E tipo Happy. | El relay es del propio usuario. E2E añade gestión de claves compleja sin beneficio real en este modelo de amenazas. Se deja el protocolo preparado (campo `enc`) para fase futura. |
| D9 | **Emparejamiento por código QR / código corto de un solo uso**, tokens de larga duración guardados hasheados (SHA‑256) en el relay. | Usuario/contraseña, OAuth. | Un solo dueño; mínimo de fricción; revocable por dispositivo. |
| D10 | **App Android nativa (Kotlin/Compose)**. | Flutter, React Native/Expo. | Sólo se pide Android; acceso directo a notificaciones ricas (acciones, RemoteInput, canales, `setAuthenticationRequired`), FCM y Keystore sin puentes. |

## 4. Hechos verificados de Pi (base de certeza del plan)

Verificados leyendo el código fuente de Pi 1.2.0 (`packages/coding-agent`):

| Necesidad | API de Pi | Dónde se verificó |
|---|---|---|
| Cargar el plugin en todas las sesiones | Pi packages: `pi install git:github.com/j3pf/rp-plugin@vX` o `npm:`; se guarda en `~/.pi/agent/settings.json`. | `docs/packages.md` |
| Saber cuándo arranca/termina una sesión | Eventos `session_start` (`reason: startup|reload|new|resume|fork`) y `session_shutdown`. No abrir sockets en la *factory*, sí en `session_start`. | `docs/extensions.md` §lifecycle, `types.ts:755,824` |
| Ver lo que hace el agente en vivo | Eventos `agent_start`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `agent_settled`, `session_info_changed`, `model_select`, `thinking_level_select`. | `types.ts:1405-1437`, `docs/json.md` |
| Historial de la sesión | `ctx.sessionManager.getBranch()`, `getSessionId()`, `getSessionFile()`, `getSessionName()`, `getHeader()`. | `session-manager.ts:1140-1529` |
| Enviar un mensaje del móvil al agente | `pi.sendUserMessage(content: string | (TextContent|ImageContent)[], { deliverAs?: "steer"|"followUp" })`. Ocupado → requiere `deliverAs`. | `types.ts:1741`, ejemplo `send-user-message.ts` |
| Adjuntar imágenes | `ImageContent = { type:"image", data: base64, mimeType }` dentro de `sendUserMessage`. | `ai/src/types.ts:430` |
| Interrumpir | `ctx.abort()`; `ctx.isIdle()`. | `runner.ts createContext()` |
| Autorizaciones de herramientas | Evento `tool_call` puede devolver `{ block: true, reason }`. Pi **no pide permisos por defecto**; las autorizaciones las crean extensiones (ej. `permission-gate.ts`). | `docs/security.md`, `examples/extensions/permission-gate.ts` |
| Preguntas / diálogos | `ctx.ui.select/confirm/input/editor/custom`. `select/confirm/input` aceptan `{ signal, timeout }`. | `types.ts:114-160` |
| Diálogo de terminal cancelable | El TUI escucha `opts.signal` y cierra el diálogo al abortar. | `interactive-mode.ts:2690-2800` |
| Detectar *cualquier* diálogo bloqueante (incluso de otras extensiones) | Eventos `ui_prompt_start` / `ui_prompt_end` con `kind` y `title`. | `runner.ts:577-620`, `types.ts:1039-1055` |
| Interceptar diálogos de **otras** extensiones | `ctx.ui` es **el mismo objeto** para todas las extensiones del runner (`runner.uiContext`, objeto plano creado con spread). Reemplazar sus métodos `select/confirm/input` en `session_start` intercepta todos los diálogos. ⚠️ No es API pública → ver riesgo R1. | `runner.ts:572-591, 889-891` |
| Comunicación con otras extensiones | `pi.events` (bus compartido). Útil para integrar `@eko24ive/pi-ask`. | `docs/extensions.md` |

## 5. Flujos principales

### 5.1 Pregunta / autorización → notificación → respuesta desde el móvil

```
pi (tool_call bash "rm -rf build")
  └─ rp-plugin permission gate → ctx.ui.select("⚠ ¿Permitir?", [Permitir, Permitir siempre (sesión), Denegar])
        ├─ (A) diálogo normal en la terminal  (con AbortSignal)
        └─ (B) prompt.open ──ws──► relay ── guarda prompt (state=open) ──► FCM (data, prioridad alta, cifrado)
                                         └─ ws ──► apps conectadas
Teléfono: notificación heads-up con botones [Permitir] [Denegar] [Abrir]
  └─ toca "Permitir" → POST /v1/prompts/{id}/answer (token del dispositivo)
        relay: UPDATE prompts SET state='resolved' WHERE id=? AND state='open'  (primera respuesta gana)
        relay ──ws──► plugin: prompt.answer
              plugin: aborta el diálogo de terminal (A) y resuelve la promesa con "Permitir"
              plugin ──► prompt.ack
        relay ──FCM "cancel" + ws──► todos los dispositivos: retirar notificación
```
Si se responde en la terminal primero: plugin envía `prompt.resolved {by:"local"}` → relay marca resuelto → FCM "cancel" retira la notificación del teléfono.

### 5.2 Mensaje del móvil al agente (con adjuntos)

1. App sube cada archivo: `POST /v1/blobs` (multipart, máx. 25 MB) → `blobId`.
2. App envía por WS `user.message { agentId, text, attachments:[blobId…], delivery: "auto"|"steer"|"followUp" }`.
3. Relay reenvía al plugin. Plugin descarga los blobs (`GET /v1/blobs/{id}` con token de máquina).
   - Imágenes (`image/png|jpeg|webp|gif`) → `ImageContent` base64.
   - Resto → se guardan en `~/.pi/agent/rp/inbox/<sessionId>/<timestamp>-<nombre>` y se añade al texto
     `[Archivo adjunto: /ruta/absoluta (mime, tamaño)]` para que el agente lo lea con su herramienta `read`.
4. Plugin llama `pi.sendUserMessage(...)` (si ocupado: `deliverAs` según preferencia, por defecto `followUp`).
5. Pi emite `message_start` del usuario → vuelve a la app como confirmación.

### 5.3 Ver todos los agentes

Cada proceso `pi` con el plugin = 1 **agente** (`agentId` = `sessionId` de Pi + sufijo de proceso). Al conectar envía
`agent.hello` con máquina, cwd, rama git, nombre de sesión, modelo, estado. El relay mantiene la lista viva (online /
offline con última vez visto, conservados 7 días). La app la muestra agrupada por máquina con contador de preguntas
pendientes.

## 6. Seguridad (resumen)

- TLS obligatorio (Caddy con Let's Encrypt, o Tailscale + certificado `tailscale cert`).
- Tokens: 256 bits aleatorios, se guardan sólo como SHA‑256 en SQLite. Dispositivos y máquinas revocables desde el CLI
  del relay y desde la app.
- Códigos de emparejamiento: 8 caracteres base32 (≈40 bits) + expiración 10 min + un solo uso + máx. 5 intentos/min por IP.
- Payload FCM cifrado con clave AES‑256‑GCM por dispositivo generada en el emparejamiento (Google no ve contenido).
- Opción "requerir desbloqueo para aprobar" (Android 12+ `Notification.Action.Builder.setAuthenticationRequired(true)`).
- El plugin nunca ejecuta comandos recibidos: sólo inyecta mensajes y respuestas a diálogos que el propio Pi pidió.
- Rate limiting en endpoints públicos; tamaño máximo de frame WS 1 MB; validación de esquema en cada mensaje.

## 7. Fases y entregables

| Fase | Contenido | Criterio de "hecho" |
|---|---|---|
| **0. Spikes (1 semana)** | S1: interceptar `ctx.ui` y cancelar diálogo TUI con `signal` (Pi 1.2.0). S2: FCM data high‑priority con app cerrada + acción en notificación → HTTP. S3: relay mínimo WS eco. | Cada spike con demo grabada y nota en `docs/spikes/`. |
| **1. MVP "ver y hablar" (2–3 sem.)** | Relay (auth, WS, agentes, eventos, historial). Plugin (conexión, eventos, `sendUserMessage`, abort). App (emparejar, lista de agentes, chat en vivo, enviar texto). | Desde el móvil veo 2 agentes en 2 máquinas, les escribo y veo la respuesta en streaming. |
| **2. Preguntas, autorizaciones y push (2 sem.)** | Prompts en relay + FCM. Plugin: permission gate, `ask_user`, espejo de diálogos. App: bandeja, hoja de respuesta, notificaciones con acciones y RemoteInput. | Con la app cerrada llega la notificación; "Permitir" desde la notificación desbloquea el agente en <2 s; la terminal se cierra sola. |
| **3. Adjuntos + lanzar agentes (1–2 sem.)** | Blobs, cámara/archivos en la app; `rp-host` para crear agentes en tmux desde el móvil. | Envío una foto y un PDF; creo un agente nuevo en `~/proyecto` desde el móvil. |
| **4. Pulido (continuo)** | Integración `pi-ask`, UnifiedPush opcional, horas silenciosas, widgets, búsquedas, E2E opcional, propuesta upstream a Pi de API oficial de "UI provider". | — |

## 8. Riesgos y mitigaciones

| # | Riesgo | Prob. | Mitigación |
|---|---|---|---|
| R1 | Interceptar `ctx.ui` de otras extensiones depende de un detalle interno de Pi (objeto compartido mutable). Podría cambiar. | Media | (a) Detección en runtime: si el parche no se aplica, se desactiva el espejo y quedan los mecanismos oficiales (permission gate y `ask_user` propios, que **sí** usan API pública porque son nuestros); (b) test de contrato en CI contra la versión fijada de Pi; (c) abrir issue/PR upstream proponiendo un hook oficial (`ui_prompt` interceptable). Además `ui_prompt_start` (API pública) garantiza al menos una **notificación** "agente esperando en la terminal" aunque no se pueda responder. |
| R2 | Diálogos `custom()` (TUI propio de otras extensiones) y `editor()` no se pueden responder remotamente. | Cierta | Se notifica igualmente vía `ui_prompt_start` ("esperando en la terminal"). |
| R3 | FCM retrasado por el fabricante (Xiaomi/Huawei con optimizaciones agresivas). | Media | Prioridad alta + guía en la app para excluir de optimización de batería; reintento de push cada 5 min mientras la pregunta siga abierta (máx. 3). |
| R4 | Requiere crear proyecto Firebase propio. | Cierta | Guía paso a paso en `PLAN-RELAY.md §9`; el relay funciona sin FCM (sólo notificaciones con la app abierta). |
| R5 | Cambios de API entre versiones de Pi. | Media | `peerDependencies: "*"` + matriz de CI contra la versión mínima soportada (1.2.0) y `latest`; capa `pi-compat.ts` que aísla accesos. |
