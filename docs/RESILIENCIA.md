# RP — Escalabilidad, resiliencia e independencia

> Copia canónica en `rp-relay/docs/RESILIENCIA.md` (copiada en `rp-plugin` y `rp-app`).
> Decisiones del usuario (2026-10-13): **PC de la empresa = Windows**, **PC personal = Linux**; la política de la
> empresa permite pasar el contenido por el relay propio; **usa el modo Auto de gentle-pi**; la solución debe ser
> **escalable, resiliente y totalmente independiente**.

## 1. Qué significa "independiente" aquí (y cómo se cumple)

Ningún componente opcional ni servicio de terceros es necesario para que las funciones principales funcionen.
Todo lo opcional mejora algo, pero si falta, el sistema sigue funcionando.

| Función | Camino principal (sin dependencias externas) | Opcional (si existe) | Si falta lo opcional |
|---|---|---|---|
| Notificaciones con la app cerrada | **Canal directo**: servicio en primer plano de la app con WebSocket al relay propio (§3.1) | FCM (Google) | Sigue funcionando por el canal directo |
| Hablarle al agente en **modo Auto** de gentle-pi | **Entrega interactiva nativa**: el plugin teclea el mensaje dentro del propio proceso de Pi (§2) | herdr (`herdr agent prompt`) | Sigue funcionando sin herdr |
| Responder preguntas/autorizaciones | Espejo de diálogos + adaptadores (en el proceso de Pi) | — | — |
| Crear agentes desde el móvil | `rp-host` con backend por SO: **Linux → tmux**, **Windows → Windows Terminal** | herdr (en ambos) | Usa el backend del SO |
| TLS del relay | Relay con TLS propio (certificado ACME integrado o archivos de certificado) | Caddy delante | Funciona sin Caddy |
| Copias de seguridad | Snapshot SQLite local programado por el propio relay | Litestream → otro disco/servidor SFTP | Snapshots locales |
| Agentes | Pi (+ gentle-pi) | — | Protocolo con `agent.kind` para añadir otros agentes en el futuro sin cambiarlo |

No hay servicios en la nube obligatorios: relay en tu Ubuntu, plugin en tus PCs, app en tu teléfono.
Firebase pasa a ser **opcional** (sólo mejora el ahorro de batería).

## 2. Modo Auto de gentle-pi sin depender de herdr: entrega interactiva nativa

**Problema (verificado):** gentle-pi en Auto sólo acepta como autorización la entrada con `source:"interactive"`;
`pi.sendUserMessage` produce `source:"extension"` (COMPATIBILIDAD P4).

**Hecho verificado que lo resuelve:** la TUI de Pi lee el teclado con `process.stdin.on("data", …)` en el **mismo
proceso** donde corre el plugin (`pi-tui/src/terminal.ts:198-290`), pasando por `StdinBuffer`, que reconoce el pegado
entre corchetes (`\x1b[200~ … \x1b[201~`) y lo reenvía al editor. Pi asigna `source:"interactive"` a lo que envía el
editor (`agent-session.ts:321`). En Windows usa el mismo `process.stdin` con entrada VT activada (`terminal.ts:415`).

**Mecanismo (`delivery/interactive.ts`)**, sólo cuando `ctx.mode === "tui"`:
1. Esperar a que no haya diálogo abierto (`ui_prompt_start/end`, incluidos los paneles `custom()`); si hay uno,
   el mensaje queda en cola y la app muestra "esperando a que se cierre el diálogo" (o puede responderlo).
2. Guardar el borrador local: `draft = ctx.ui.getEditorText()`; si no está vacío, `ctx.ui.setEditorText("")`.
3. Si el agente está trabajando y la entrega pedida es *follow-up*: esperar a `agent_settled` (no depende de la tecla,
   que es configurable y en Windows es `ctrl+q`). Si es *steer*: enviar ya (Enter mientras trabaja = steer en Pi).
4. `process.stdin.emit("data", "\x1b[200~" + texto + "\x1b[201~")` y luego `process.stdin.emit("data", "\r")`.
5. Confirmar con el evento `input` (`source:"interactive"`, mismo texto) → `user.message.ack{disposition:"typed"}`.
   Si en 3 s no llega → revertir (`setEditorText(draft)`), intentar por herdr si existe, si no `api`, y avisar.
6. Restaurar el borrador: `ctx.ui.setEditorText(draft)`.

**Salvaguardas:**
- Detección de modo Vim de gentle-shell en modo *normal* (el texto serían comandos): el plugin observa la barra de
  estado/editor activo; si no puede garantizar modo inserción → no teclea y usa la vía siguiente. A confirmar en S7.
- Sólo texto; adjuntos → guardados en el inbox y referenciados por ruta dentro del texto.
- Presencia humana: como este camino hace que el mensaje cuente como tecleado (y por tanto **autoriza** en Auto),
  la app exige **desbloqueo biométrico** (BiometricPrompt, válido 5 min) antes de enviar en modo interactivo, y el
  plugin anota el origen con `pi.appendEntry("rp.origin", {delivery:"interactive", deviceId})` para auditoría.
- Interruptor por PC (`delivery.interactive: true|false`) en la config del plugin.

**Orden de preferencia de la entrega** (configurable): Auto de gentle activo → `interactive` → `herdr` → `api` con
aviso. Sin Auto → `api` (no hace falta teclear).

Se mantiene la propuesta upstream a gentle-pi (canal "humano remoto autenticado"), pero el diseño **no depende** de que
se acepte.

## 3. Resiliencia

### 3.1 Notificaciones por dos canales independientes
| Canal | Cómo | Ventaja | Coste |
|---|---|---|---|
| **Directo** (por defecto) | La app mantiene un servicio en primer plano (`FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING`, Android 14+) con WebSocket al relay; ping cada 4,5 min; reconexión con backoff y `NetworkCallback` | Sin Google; latencia <1 s | Notificación permanente discreta; batería ≈ un cliente de chat |
| **FCM** (opcional) | Igual que el plan v1 | Mejor batería en reposo | Requiere proyecto Firebase |

El relay envía por **todos** los canales activos del dispositivo; la app **deduplica por `promptId`** (una sola
notificación). Si un canal falla, el otro cubre. El relay reintenta el push de un prompt abierto a los 5 y 10 min.

### 3.2 Semántica de entrega (sin pérdidas ni duplicados)
| Mensaje | Garantía | Mecanismo |
|---|---|---|
| Eventos agente → app | al menos una vez, orden por agente | `seq` monotónico por `epoch`; la app reanuda con `sinceSeq`; el relay persiste los finales |
| Mensaje app → agente | exactamente una vez efectiva | `clientMsgId` (ULID) como clave de idempotencia: el relay y el plugin recuerdan los últimos 500 por agente y descartan repetidos; la app reintenta hasta recibir `ack` |
| Respuesta a prompt | exactamente una vez, la primera gana | `UPDATE … WHERE state='open'` atómico + `prompt.ack`; respuestas tardías → `409 already_resolved` |
| Respuesta desde la notificación sin red | se entrega al volver la red | WorkManager *expedited* con reintentos |
| Prompt abierto con el relay caído | no se pierde | el plugin lo reenvía en `agent.hello.openPrompts` al reconectar; el diálogo local sigue funcionando |

### 3.3 Fallos y cómo se comporta cada pieza
| Falla | Efecto | Recuperación |
|---|---|---|
| Relay caído | Pi sigue funcionando normal en la terminal (el plugin nunca bloquea a Pi) | systemd `Restart=always` + `WatchdogSec=30`; al volver, plugins y app resincronizan (snapshot + `sinceSeq`) |
| Disco/DB del relay corrupta | Se pierde historial reciente | Snapshots SQLite cada hora (`VACUUM INTO`), 7 días de retención; Litestream opcional para réplica continua; `rp-relay restore` |
| Red de la PC Windows de la empresa con proxy | WS bloqueado | Proxy + CA corporativa; transporte long-poll automático |
| Pi se cierra con un prompt abierto | Prompt huérfano | El relay lo cancela a los 2 min sin reconexión y retira la notificación |
| herdr reinicia | Proceso nuevo, misma sesión | `agentId` estable (`machineId:sessionId`), historial continuo |
| Teléfono sin red | — | Al volver: WS reanuda; respuestas pendientes salen por WorkManager |
| Actualización del relay | Corte de segundos | Cierre ordenado (`SIGTERM` → `1012 service restart` a los clientes → reconexión inmediata); migraciones automáticas y reversibles |
| Versiones distintas entre piezas | — | `v` de protocolo + `features` en `hello`; el relay acepta `v` actual y anterior; cierre `4002` sólo si es incompatible, con mensaje claro |

### 3.4 Pruebas de resiliencia (obligatorias en CI del relay y del plugin)
Matar el relay con un prompt abierto y respondido a medias; duplicar respuestas concurrentes desde 2 dispositivos;
cortes de red de 30 s/5 min con mensajes en vuelo; reiniciar Pi durante un `message_update`; reenvío de
`clientMsgId` repetido; restaurar backup y verificar integridad.

## 4. Escalabilidad

| Dimensión | Objetivo de diseño (probado en test de carga) | Cómo |
|---|---|---|
| PCs | 20 | Un token por PC; `MachineSummary` |
| Agentes simultáneos | 200 en total | Hub en memoria + SQLite WAL; eventos coalescidos (≤10 msg/s por agente en streaming) |
| Dispositivos | 10 | Canales por dispositivo; dedupe |
| Throughput | 1 000 eventos/s agregados, p99 reenvío < 50 ms en VPS de 1 vCPU / 1 GB | `ws` con backpressure (`bufferedAmount` > 1 MB → descartar deltas, conservar finales y pedir resync) |
| Historial | 7 días o 5 000 eventos por agente | Retención configurable |
| Relays | varios desde la app (fase 4) | Entidades con `relayId` desde v1 |
| Tipos de agente | Pi hoy | `agent.kind` en el protocolo; conectores nuevos (p. ej. hooks de otros CLIs) sin cambiar relay ni app |

Si algún día hiciera falta más (no es el caso para un usuario): el hub se separa del almacenamiento (Postgres +
pub/sub) sin cambiar el protocolo. No se construye ahora.

## 5. Específico por sistema operativo

| | PC personal — **Linux** | PC empresa — **Windows** |
|---|---|---|
| Plugin | Igual (Node ≥ 22.19) | Igual; config en `%APPDATA%\rp\config.json`; rutas con `path.win32`; inbox en `%LOCALAPPDATA%\rp\inbox` |
| gentle-shell | `gentle-shell install npm:@j3pf/pi-rp` | Igual (gentle-shell soporta Windows) |
| Entrega interactiva | `process.stdin` | `process.stdin` (entrada VT de Windows); se verifica en S7 en Windows Terminal y en herdr Windows |
| rp-host — servicio | `systemctl --user` | Tarea programada "al iniciar sesión" (`schtasks /Create /SC ONLOGON …`), sin privilegios de administrador |
| rp-host — backend sin herdr | tmux ≥ 3.2 | **Windows Terminal**: `wt.exe -w rp new-tab -d <cwd> --title <name> <launcher> --rp-spawn-id <id>` (el id va como flag de Pi registrado por el plugin, porque `wt` no pasa variables de entorno); si no hay `wt.exe`, `cmd /c start "<name>" /D <cwd> <launcher> --rp-spawn-id <id>` |
| rp-host — con herdr | `herdr workspace create … && herdr pane run …` | Igual (herdr Windows beta) |
| Red | Directa | Proxy corporativo/CA → long-poll si hace falta |
