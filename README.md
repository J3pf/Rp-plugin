# rp-plugin

Pi package (`@j3pf/pi-rp`) que conecta cada sesión de [Pi](https://github.com/earendil-works/pi) a tu relay **RP**: transmite la
actividad del agente al móvil, recibe mensajes y adjuntos, y lleva **preguntas y autorizaciones** al teléfono (responde la
terminal o el móvil, la primera respuesta gana). Funciona con `gentle-shell`/gentle-pi y dentro de herdr. Incluye `rp-host`
para lanzar agentes nuevos desde el móvil (en herdr, tmux o Windows Terminal).

> Estado: **implementado** (extensión + `rp-host`). Verificado contra Pi 1.2.0 y gentle-pi 4.1.0 reales; ver
> [docs/spikes](docs/spikes/README.md) para lo que queda por confirmar en tu hardware (Windows de la empresa, herdr real).

## Instalación (por cada PC)

### Desde la release oficial de GitHub (Recomendado)
```bash
# Pi estándar (~/.pi/agent)
pi install git:github.com/J3pf/Rp-plugin@v0.3.5

# gentle-shell (~/.gentle-shell/agent) — verificado: reenvía git: a su entorno aislado
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.3.5
```

### Alternativa offline (desde tarball de la release)
Pi registra la ruta local de la carpeta donde se instala; para evitar perder el paquete si se limpian carpetas temporales o de descargas, descomprime el `.tgz` en una ubicación permanente (ej. `~/.pi/agent/packages/j3pf-pi-rp-0.3.5`):
```bash
mkdir -p ~/.pi/agent/packages/j3pf-pi-rp-0.3.5
tar -xzf j3pf-pi-rp-0.3.5.tgz -C ~/.pi/agent/packages/j3pf-pi-rp-0.3.5 --strip-components=1
cd ~/.pi/agent/packages/j3pf-pi-rp-0.3.5 && npm install --omit=dev
cd ~/.pi/agent && pi install ./packages/j3pf-pi-rp-0.3.5
```

### O desde código fuente local
```bash
git clone https://github.com/J3pf/Rp-plugin.git
cd Rp-plugin && npm install && npm run build
pi install .
```

### Actualización desde una versión previa

#### Caso 1: Actualización de una instalación `git:` existente (lo más común)
`pi install` actualiza el clon en el directorio del agente, hace checkout del nuevo tag y reemplaza la entrada en `settings.json` automáticamente:
```bash
# Para Pi estándar
pi install git:github.com/J3pf/Rp-plugin@v0.3.5

# Para gentle-shell
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.3.5

# Confirmar actualización y reiniciar sesiones de Pi
pi list
```
> ⚠️ **ADVERTENCIA IMPORTANTE:** **NO** ejecutes `pi remove` con el ref anterior (ej. `pi remove git:github.com/J3pf/Rp-plugin@v0.2.2`). Pi empareja paquetes por repositorio y no por versión/ref; ejecutar `pi remove` **desinstalaría por completo el plugin**.

#### Caso 2: Migración desde una ruta local previa (ej. `./packages/j3pf-pi-rp-0.2.1`)
`pi remove` aplica únicamente para limpiar entradas locales anteriores y evitar que ambas versiones carguen al mismo tiempo:
1. **Instala la nueva versión primero** (para no quedar sin plugin si la red falla):
   ```bash
   pi install git:github.com/J3pf/Rp-plugin@v0.3.5
   ```
2. **Elimina la ruta local anterior situándote en `~/.pi/agent`**:
   ```bash
   pi list
   cd ~/.pi/agent && pi remove ./packages/j3pf-pi-rp-0.2.1
   ```
3. **Reinicia tus sesiones de Pi**. Para actualizar el servicio del host en la máquina, ejecuta `rp-host install` (o deja que la auto-reparación lo migre en el siguiente inicio).

### Emparejamiento
Una vez instalado, abre Pi (`pi` o `gentle-shell`) y ejecuta:
```bash
/rp pair http://IP_O_DOMINIO_DEL_RELAY:8787 CODIGO_EMPAREJAMIENTO --name "Mi PC" --context personal
/rp doctor                                 # comprueba red, proxy, CA y conectividad
```

> Guía detallada y solución de problemas en [docs/INSTALACION.md](docs/INSTALACION.md). Requiere Node ≥ 22.19.

## Qué hace

| Función | Dónde |
|---|---|
| Conexión WS (con proxy) + respaldo HTTP long-poll, reconexión, cola acotada | `src/extension/connection.ts` |
| Eventos de Pi → `agent.event` (coalescidos, truncados, `redactContent`) y snapshot | `forwarder.ts`, `snapshot.ts`, `status.ts` |
| Espejo de diálogos (`select/confirm/input`) + carrera terminal ⇄ móvil | `prompts/mirror.ts`, `prompts/broker.ts` |
| Adaptadores de `ask_user` (@eko24ive/pi-ask) y `ask_user_choice` / `ask_user_question` (gentle-pi) (`custom()`) | `prompts/adapters/` |
| Autorizaciones propias (si no hay gentle-pi) y herramienta `rp_ask_user` condicional | `prompts/gate.ts`, `prompts/askUser.ts` |
| Mensajes del móvil: `api`, **`interactive`** (teclea en la TUI → autoriza en modo Auto), `herdr`, comandos | `delivery/` |
| Comandos slash desde móvil: `/model` (con arg o interactivo) y `/thinking` (con nivel o interactivo) ejecutados en sesión | `src/extension/delivery/slash-commands.ts` |
| Adjuntos (imágenes inline, resto en el inbox con ruta citada) | `attachments.ts` |
| Agent Mesh: telemetría de comunicación inter-agente (`intercom` y `orchestrator_send_message` entrante/saliente → `CommEvent`) | `src/extension/comm.ts` |
| Comandos `/rp pair\|status\|doctor\|on\|off\|gate\|test\|unpair` | `commands.ts` |
| `rp-host`: autostart per-OS (systemd linger/PATH, Task Scheduler XML PT0S/batteries/restart, launchd bootstrap/logs), auto-repair on Pi `session_start`, `rp-host doctor` | `src/host/`, `src/extension/host-autostart.ts` |
| `rp-host`: recolección periódica de cuotas de IA (`piquota --json`) y reporte a `rp-relay` | `src/host/quota.ts` |
| Consentimiento de review de gentle-pi respondible desde el móvil (espejo guardado del componente: acciones, `Effect:` y cuerpo renderizado; la respuesta se entrega por el `done` del propio componente) | `src/extension/prompts/adapters/review-consent.ts` |
| Sincronía de ciclo de vida con herdr en ambos sentidos: cerrar el panel lo borra de la app (`agent.closed`) y olvidar el agente en la app cierra su panel (`host.herdr_close` → `herdr pane close`) | `src/host/herdr-bridge.ts`, `src/host/connection.ts` |

Documentos: [INSTALACION](docs/INSTALACION.md) (instalación y troubleshooting) · [PLAN-PLUGIN](docs/PLAN-PLUGIN.md) (plan + estado de implementación) · [RESILIENCIA](docs/RESILIENCIA.md) ·
[COMPATIBILIDAD](docs/COMPATIBILIDAD.md) · [ARQUITECTURA](docs/ARQUITECTURA.md) · [QA manual](docs/QA.md) ·
[Spikes](docs/spikes/README.md) · contrato de red: [`rp-relay/docs/PROTOCOLO.md`](https://github.com/j3pf/rp-relay/blob/main/docs/PROTOCOLO.md).

## Configuración

`~/.config/rp/config.json` (Windows: `%APPDATA%\rp\config.json`; respeta `XDG_CONFIG_HOME`; permisos 600). La escribe
`/rp pair`; el resto es opcional (valores por defecto entre paréntesis):

```jsonc
{
  "redactContent": false,                  // true: sólo estados/preguntas/respuestas, sin transcript
  "gate": { "mode": "auto-detect",         // auto-detect|off|dangerous|writes|all (auto-detect: off con gentle-pi)
            "dangerousPatterns": ["\\brm\\s+-[a-z]*r", "\\bsudo\\b"], "alwaysAllowTools": ["read","grep","find","ls"],
            "useAnnotations": true, "approverWaitMs": 5000 },
  "mirrorDialogs": true,
  "delivery": { "method": "auto", "interactive": true },   // auto|api|interactive|herdr
  "subagents": "skip",                     // skip|connect
  "hostAutostart": true,                    // false: no comprobar/reparar el servicio rp-host al iniciar Pi
  "inboxDir": null
}
```
Variables: `RP_RELAY_URL`, `RP_DISABLED=1`, `RP_CONFIG`, `RP_DEBUG=1`; flags de Pi `--rp-off`, `--rp-spawn-id` y `--rp-no-auto-host` (omite el autostart para esa ejecución).
`rp-host` usa `host.json` (mismo directorio). Las carpetas que el teléfono puede explorar se gestionan con `rp-host roots` (`list`, `add <ruta>`, `remove <ruta>`); si no configuras ninguna, usa las carpetas de proyectos habituales que existan (`~/Projects`, `~/dev`, `~/code`, …) y, si no hay ninguna, `rp-host doctor` y la app te piden ejecutar `rp-host roots add <ruta>`. Campos: `roots`, `backend`, `launchers`, `defaultLauncher`, `herdrSession`, `quotaEnabled`, `quotaCommand`, `quotaIntervalSec`, `serve`.

```bash
rp-host init
rp-host install
rp-host doctor       # diagnostica el servicio y devuelve error si hay problemas
rp-host status
```

### Modo directo (`/rp serve`)

Si no tienes dónde montar el relay, `/rp serve` levanta uno embebido detrás de un túnel y te da un QR para el móvil:

```bash
/rp serve                 # cloudflared (por defecto)
/rp serve --funnel        # Tailscale Funnel
/rp serve --tunnel none   # sin túnel, sólo para probar en local
/rp serve --data-dir ~/.rp-direct --name "Mi PC"
```

Qué hace, en orden: crea (o reutiliza) el par de claves P-256 de esta máquina en `<data-dir>/machine.key` con permisos `600`; levanta el túnel y el relay embebido; empareja **esta PC** contra su propio relay por loopback y guarda `machineId`/`machineToken` en `<data-dir>/machine.json` (por eso un reinicio no vuelve a emparejar, y la URL puede cambiar sin perder la PC); pide un código de dispositivo de 10 minutos y pinta el QR v2 en la conversación:

```
rp://pair?u=<publicUrl>&c=<código>&k=direct&f=<huella>&n=<nombre>
```

`k=direct` y `f` (huella de la clave de máquina) hacen que la app fije la identidad del endpoint antes de enviar nada: si la clave no coincide, el emparejamiento se rechaza. La app necesita volver a escanear el QR cuando la URL pública cambia; `/rp serve` lo avisa y `/rp status` muestra el endpoint y la huella actuales. `/rp off` y `/rp unpair` apagan el stack.

#### Cifrado de extremo a extremo (`enc1`)

Cuando el móvil anuncia la capacidad `enc1`, la máquina sella el contenido antes de que salga del proceso:

- **Qué se sella**: título, mensaje y etiquetas de opciones de `prompt.open`; `preview` de `prompt.settled`; `text`/`preview`/`detail` de `agent.event`; `lastPreview` de `agent.snapshot`; y el **cuerpo entero del push**, una copia por dispositivo.
- **Qué no se sella**: ids, tipos, `kind`, `category`, `danger`, estados, horas y tamaños. El relay los necesita para enrutar, guardar y paginar.
- **Claves**: una clave por par (dispositivo, máquina) con `ECDH P-256` + `HKDF-SHA256` + `AES-256-GCM`; el par se direcciona con el AAD (`keyIdEmisor`, tipo, id), nunca con claves distintas por sentido. El `keyId` de cada clave es la huella de 22 caracteres que va en el QR.
- **Push**: cada dispositivo recibe su propia copia sellada, así que la notificación conserva título, agente, máquina y opciones. El relay sólo reenvía cadenas opacas.
- **Degradación**: sin clave de dispositivo (v1) o con más de un dispositivo `enc1` (el `prompt.open` sólo puede llevar un título), el contenido viaja en claro y la UI lo marca; el push por dispositivo sigue sellado siempre que haya claves. El fan-out conversacional multi-dispositivo está en `odd/tasks/multi-endpoint.md`.

La máquina NO depende de `@j3pf/rp-protocol`: replica la cripto en `src/shared/e2e/` y se valida contra el mismo vector de interoperabilidad que la app.

### Modo directo por CLI (`rp-host serve`)

Conecta el móvil sin montar un relay propio: `rp-host serve` levanta un relay **embebido** detrás de un túnel automático y publica su URL. El relay corre como proceso hijo porque su base de datos (`better-sqlite3`) es nativa y no debe entrar como dependencia de una extensión de Pi; el túnel corre como segundo proceso hijo supervisado.

```bash
rp-host serve                                  # cloudflared (por defecto): URL https://…trycloudflare.com
rp-host serve --tunnel tailscale               # Tailscale Funnel: URL https://<nodo>.<tailnet>.ts.net
rp-host serve --tunnel none                    # sin túnel: sólo http://127.0.0.1:<puerto> (pruebas locales)
rp-host serve --data-dir ~/.rp-direct           # dónde viven la config y los datos del relay embebido
rp-host serve --relay-command "rp-relay"        # cómo lanzar el relay (por defecto, `rp-relay` del PATH)
rp-host serve --relay-path /ruta/rp-relay/dist/cli/index.js   # o apuntar a un clon/instalación concreta
```

Al arrancar escribe una única línea JSON en stdout, pensada para que la extensión pinte el QR de emparejamiento:

```json
{"publicUrl":"https://x.trycloudflare.com","port":60109,"dataDir":"/home/tu/rp/direct","tunnel":"cloudflared"}
```

Orden de arranque: se elige un puerto libre en loopback, se levanta el túnel (su URL hace falta antes que la config del relay), se escribe `<data-dir>/relay.json` con perfil `single-host` y `publicUrl` del túnel, y se arranca el relay hasta que responde `/healthz`. Si el relay no llega a estar sano, se cierra el túnel y no queda ningún proceso huérfano. `Ctrl-C`/`SIGTERM` apaga el relay y el túnel en orden.

Requiere el relay instalado aparte (`npm i -g @j3pf/rp-relay`) salvo que uses `--relay-path`. Campos de `host.json`: `serve.tunnel` (`cloudflared`|`tailscale`|`none`), `serve.relayCommand`, `serve.relayPath`, `serve.dataDir`. Variables equivalentes: `RP_SERVE_TUNNEL`, `RP_SERVE_RELAY_COMMAND`, `RP_SERVE_DATA_DIR`.

Después de emparejar el PC con `/rp pair`, `rp-host install` configura el servicio de usuario para cada SO. Linux usa systemd `--user` con PATH capturado y lingering; Windows importa una tarea XML (UTF-16LE con BOM) ejecutada de forma invisible mediante `conhost.exe --headless` (sin ventanas emergentes, sin límite de duración de 72h, con reinicios y ejecución en batería, evitando scripts .vbs propensos a bloqueos corporativos); macOS instala un agente launchd con PATH y logs. Al iniciar una sesión Pi (`session_start`), la extensión comprueba el servicio y, si falta, está obsoleto o no corre, intenta instalarlo/repararlo o iniciarlo en segundo plano sin bloquear ni hacer fallar Pi. La comprobación se limita a una vez cada 10 minutos.

El autostart está habilitado por defecto. Para deshabilitarlo de forma persistente, configura `"hostAutostart": false` en `~/.config/rp/config.json` (Windows: `%APPDATA%\rp\config.json`); para omitirlo solo en una ejecución, inicia Pi con `--rp-no-auto-host`. Consulta [la guía de instalación](docs/INSTALACION.md) para los detalles por sistema operativo y diagnóstico.

## Desarrollo

```bash
npm install
npm run typecheck && npm run build
npm run test:unit       # unidad, conexión/resiliencia, contrato, host, Pi real (SDK + proveedor simulado)
npm run test:e2e        # TUI real en tmux + gentle-shell/gentle-pi reales (necesita tmux)
GENTLE_AI_BIN=/ruta/gentle-ai npx vitest run test/gentle-ai-sync.test.ts   # regresión A1 (binario Go de gentle-ai)
npm run fixtures        # regenera test/fixtures/protocol/*.json (compartidos con rp-relay / rp-app)
```

El protocolo (v1) está replicado en `src/shared/protocol.ts` y validado por `test/contract.ts` contra `PROTOCOLO.md`
mientras `@j3pf/rp-protocol` no esté publicado.

## Referencias investigadas

- Pi (`earendil-works/pi`, v1.2.0): `packages/coding-agent/docs/{extensions,packages,rpc,rpc-extension-ui,json,security,sessions}.md`,
  `src/core/extensions/{types,runner}.ts`, `src/modes/{interactive/interactive-mode,rpc/rpc-mode}.ts`,
  ejemplos `permission-gate.ts`, `question.ts`, `notify.ts`, `send-user-message.ts`.
- [Remote Pi](https://github.com/jacobaraujo7/remote_pi) (Flutter + relay Rust + extensión Pi): emparejamiento QR, aprobaciones vía
  `@eko24ive/pi-ask`; **sin push real** — es la principal carencia que este proyecto cubre.
- [Happy](https://github.com/slopus/happy) / Happier (happier-dev): wrapper de CLI + servidor Fastify/Socket.IO con cifrado E2E.
- [Moshi](https://getmoshi.app/docs): terminal móvil + hook en el host que genera bandeja de aprobaciones y push.
- [gentle-shell / gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) 4.1.0, [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), [herdr](https://github.com/herdrdev/herdr) 0.9.3: entorno del usuario, ver `docs/COMPATIBILIDAD.md`.
