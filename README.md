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
pi install git:github.com/J3pf/Rp-plugin@v0.2.2

# gentle-shell (~/.gentle-shell/agent) — verificado: reenvía git: a su entorno aislado
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.2.2
```

### Alternativa offline (desde tarball de la release)
Pi registra la ruta local de la carpeta donde se instala; para evitar perder el paquete si se limpian carpetas temporales o de descargas, descomprime el `.tgz` en una ubicación permanente (ej. `~/.pi/agent/packages/j3pf-pi-rp-0.2.2`):
```bash
mkdir -p ~/.pi/agent/packages/j3pf-pi-rp-0.2.2
tar -xzf j3pf-pi-rp-0.2.2.tgz -C ~/.pi/agent/packages/j3pf-pi-rp-0.2.2 --strip-components=1
cd ~/.pi/agent/packages/j3pf-pi-rp-0.2.2 && npm install --omit=dev
cd ~/.pi/agent && pi install ./packages/j3pf-pi-rp-0.2.2
```

### O desde código fuente local
```bash
git clone https://github.com/J3pf/Rp-plugin.git
cd Rp-plugin && npm install && npm run build
pi install .
```

### Actualización desde una versión previa
Para evitar que una versión anterior y la nueva carguen a la vez en Pi:
1. **Instala la nueva versión primero** (para garantizar que una falla de red nunca te deje sin plugin):
   ```bash
   pi install git:github.com/J3pf/Rp-plugin@v0.2.2
   ```
2. **Revisa las fuentes instaladas con `pi list` y desinstala la versión anterior**:
   ```bash
   pi list
   ```
   - Si la versión anterior se instaló desde git (ej. `@v0.2.1`):
     ```bash
     pi remove git:github.com/J3pf/Rp-plugin@v0.2.1
     ```
   - Si la versión anterior era una instalación local (ej. `./packages/j3pf-pi-rp-0.2.1` en `settings.json`): las rutas relativas se resuelven contra el directorio del agente, por lo que debes ejecutar `pi remove` desde `~/.pi/agent`:
     ```bash
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
| Adjuntos (imágenes inline, resto en el inbox con ruta citada) | `attachments.ts` |
| Agent Mesh: telemetría de comunicación inter-agente (`intercom` y `orchestrator_send_message` entrante/saliente → `CommEvent`) | `src/extension/comm.ts` |
| Comandos `/rp pair\|status\|doctor\|on\|off\|gate\|test\|unpair` | `commands.ts` |
| `rp-host`: autostart per-OS (systemd linger/PATH, Task Scheduler XML PT0S/batteries/restart, launchd bootstrap/logs), auto-repair on Pi `session_start`, `rp-host doctor` | `src/host/`, `src/extension/host-autostart.ts` |
| `rp-host`: recolección periódica de cuotas de IA (`piquota --json`) y reporte a `rp-relay` | `src/host/quota.ts` |

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
`rp-host` usa `host.json` (mismo directorio): `roots`, `backend`, `launchers`, `defaultLauncher`, `herdrSession`, `quotaEnabled`, `quotaCommand`, `quotaIntervalSec`.

```bash
rp-host init
rp-host install
rp-host doctor       # diagnostica el servicio y devuelve error si hay problemas
rp-host status
```

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
