# Instalación y Solución de Problemas (Troubleshooting) — rp-plugin

Guía práctica y completa para instalar, emparejar y operar `@j3pf/pi-rp` en cualquier máquina de desarrollo (Linux, macOS, WSL o Windows).

---

## Requisitos

- **Node.js** ≥ 22.19 (LTS recomendado).
- **Pi** (v1.2.0+) o **gentle-shell** instalados en la máquina.
- Un servidor **RP Relay** activo y accesible por red (HTTP/HTTPS o IP local/Tailscale).

---

## 1. Métodos de Instalación

### Método A: Desde la Release Oficial en GitHub (Recomendado)
Puedes instalar el paquete directamente en Pi utilizando el tarball publicado en GitHub:

```bash
# Para Pi estándar (~/.pi/agent)
pi install https://github.com/J3pf/Rp-plugin/releases/download/v0.2.2/j3pf-pi-rp-0.2.2.tgz

# Para gentle-shell (~/.gentle-shell/agent), si está instalado
gentle-shell install https://github.com/J3pf/Rp-plugin/releases/download/v0.2.2/j3pf-pi-rp-0.2.2.tgz
```

### Método B: Desde Código Fuente (Desarrollo / Clon Local)
Si descargas o clonas el repositorio:

```bash
git clone https://github.com/J3pf/Rp-plugin.git
cd Rp-plugin

# 1. Instalar dependencias y compilar TypeScript
npm install
npm run build

# 2. Instalar en Pi apuntando a la carpeta local
pi install .
```

### Método C: Herramienta `rp-host` (Para crear agentes desde el móvil)
Si deseas que la app móvil pueda abrir sesiones nuevas de Pi en esta máquina (dentro de herdr, tmux o terminal):

```bash
cd Rp-plugin
npm install -g .   # instala el binario rp-host en tu PATH

# Inicializar configuración e instalar como servicio de usuario
rp-host init
rp-host install
rp-host doctor     # comprueba la instalación y el estado del autostart
rp-host status
```

El PC debe estar emparejado con el relay desde Pi (`/rp pair`) para que `rp-host` pueda conectarse. `rp-host install` configura el inicio automático y arranca el host; las particularidades dependen del sistema:

- **Linux — systemd `--user`:** el instalador crea y habilita `rp-host.service`, captura el `PATH` actual en la unidad y usa `StartLimitIntervalSec=0` para que `Restart=always` no deje de intentarlo. Un servicio de usuario necesita *lingering* para seguir activo tras cerrar sesión o iniciar con el sistema. Comprueba el estado con `loginctl show-user $USER -p Linger` (debe indicar `Linger=yes`); si está desactivado, el instalador intenta `loginctl enable-linger $USER`. La activación puede requerir privilegios del administrador; `rp-host doctor` informa si no quedó habilitado.
- **Windows — Task Scheduler:** `rp-host` importa una tarea XML con `schtasks /Create /XML <temp-file> /TN rp-host /F`. La tarea no tiene el límite predeterminado de 72 horas (`ExecutionTimeLimit PT0S`), reinicia tras fallos hasta 999 veces con intervalos de un minuto, puede iniciar y continuar mientras funciona con batería, y arranca al iniciar sesión. Se ejecuta oculta como el usuario actual, con privilegios mínimos y sin requerir administrador.
- **macOS — launchd:** instala el agente `~/Library/LaunchAgents/dev.j3pf.rp-host.plist`, que captura el `PATH` en `EnvironmentVariables`, mantiene el proceso y escribe salida y errores en `~/Library/Logs/rp-host.log`. La carga y el arranque usan `launchctl bootstrap gui/$(id -u) <plist>` y `launchctl kickstart -k gui/$(id -u)/dev.j3pf.rp-host`.

#### Diagnóstico y reparación automática

Ejecuta `rp-host doctor` desde una terminal para inspeccionar si el servicio está instalado y ejecutándose (y si aplica, habilitado), si las rutas de Node.js y del script del host existen y no están obsoletas, y los ajustes de autostart propios de cada SO (lingering en Linux; duración, reinicios y batería en Windows; configuración de entorno de launchd en macOS). Devuelve un código de salida distinto de cero si encuentra problemas. `rp-host doctor --json` imprime el mismo diagnóstico en JSON.

La extensión de Pi también mantiene el host automáticamente: en cada `session_start`, si el PC ya está emparejado, revisa si el servicio falta, está obsoleto (por ejemplo, una ruta de Node.js que ya no existe) o no está corriendo; intenta reinstalarlo si hace falta o iniciarlo si está detenido. Esta tarea es asíncrona y no bloquea ni hace fallar la sesión de Pi, y está limitada a una comprobación cada 10 minutos. El comportamiento está habilitado por defecto; para desactivarlo persistentemente, usa `"hostAutostart": false` en `~/.config/rp/config.json` (Windows: `%APPDATA%\rp\config.json`). Para omitirlo solo en una ejecución, inicia Pi con `--rp-no-auto-host`.

---

## 2. Vinculación y Emparejamiento con el Relay

Una vez instalado el plugin en Pi:

1. **Obtener el código de emparejamiento** en el servidor de Relay:
   ```bash
   # Ejecutar en el servidor donde corre rp-relay:
   rp-relay pair machine --name "Mi Portátil" --context personal
   # Te dará un código de 8 caracteres (ejemplo: ABCD2345 o RZZC00T5)
   ```

2. **Ejecutar el comando de emparejamiento dentro de Pi**:
   Inicia Pi (`pi` o `gentle-shell`) y escribe:
   ```text
   /rp pair http://IP_O_DOMINIO_DEL_RELAY:8787 CODIGO_EMPAREJAMIENTO --name "Mi PC" --context personal
   ```

3. **Verificar el estado**:
   ```text
   /rp status
   /rp doctor
   ```

---

## 3. Resolución de Problemas (Troubleshooting)

### A. Diagnóstico Inicial con `/rp doctor`
Siempre comienza ejecutando `/rp doctor` dentro de Pi. Este comando comprueba:
- Existencia y permisos de `~/.config/rp/config.json`.
- Accesibilidad de la URL del relay (DNS, puertos, latencia).
- Validez del token de máquina (`machineToken`).
- Presencia de proxies HTTP/HTTPS en el entorno.
- Certificados TLS y estado del servicio de fondo.

### B. El host no se inicia automáticamente o tiene rutas obsoletas

1. Ejecuta `rp-host doctor` desde una terminal. Revisa si el servicio está instalado y activo (y si aplica, habilitado), la validez de las rutas de Node.js y del script, y las condiciones específicas del SO. Un resultado con problemas termina con código distinto de cero; usa `rp-host doctor --json` para obtener el diagnóstico estructurado.
2. Si acabas de actualizar Node.js, comprueba si el servicio conservó una ruta antigua. Homebrew puede cambiar la ruta versionada bajo `Cellar`, y nvm u otros gestores pueden reemplazar o quitar la instalación anterior. Una ruta ausente o versionada puede dejar el host sin iniciar.
3. La auto-reparación de Pi detecta esos servicios obsoletos al evento `session_start` y vuelve a instalarlos con las rutas actuales; también inicia el servicio si simplemente estaba detenido. No bloquea la sesión y comprueba como máximo una vez cada 10 minutos. Para forzar el diagnóstico, ejecuta `rp-host doctor`; revisa la configuración de lingering en Linux o instala/actualiza de nuevo con `rp-host install` si el problema continúa. El autostart se puede desactivar con `"hostAutostart": false` o `--rp-no-auto-host`.

---

### C. Error: "El relay rechazó el emparejamiento" o "Código expirado"
* **Causa:** Los códigos de emparejamiento generados por `rp-relay pair machine` expiran tras unos minutos o ya fueron consumidos.
* **Solución:**
  1. En el servidor del relay, genera un código nuevo:
     ```bash
     rp-relay pair machine --name "Mi PC"
     ```
  2. Vuelve a ejecutar `/rp pair <URL> <NUEVO_CODIGO>` en la terminal de Pi.

---

### D. Error de Conexión WebSocket (`ECONNREFUSED` o `4008 hello timeout`)
* **Causa:** El puerto del relay no es accesible desde tu máquina o hay un firewall/proxy bloqueando conexiones WebSocket (`ws://` / `wss://`).
* **Solución:**
  1. Verifica que el relay responda vía HTTP:
     ```bash
     curl -I http://IP_O_DOMINIO_RELAY:8787/v1/healthz
     ```
  2. Si estás tras un proxy corporativo que bloquea WebSockets, el plugin cambia automáticamente a **HTTP long-poll**. Puedes forzar la variable de entorno antes de lanzar Pi:
     ```bash
     export HTTP_PROXY="http://proxy.empresa.com:8080"
     export HTTPS_PROXY="http://proxy.empresa.com:8080"
     ```
  3. En redes corporativas estrictas, añade tu CA raíz en `~/.config/rp/config.json`:
     ```json
     {
       "caFile": "/ruta/a/certificado-empresa.crt"
     }
     ```

---

### E. La App Móvil no responde a las preguntas / Autorizaciones bloqueadas
* **Causa:** Desincronización de identificadores de sesión o falta de conexión en la app.
* **Solución:**
  1. Ejecuta `/rp test` en Pi: esto crea una pregunta de prueba interactiva ("¿Funciona la integración?") que debe aparecer tanto en tu terminal como en la aplicación móvil.
  2. Responde en el móvil: si la terminal se desbloquea inmediatamente, el circuito está completamente operativo.
  3. Si la terminal gana la respuesta antes que el móvil, el relay resolverá el prompt como local y cancelará la notificación en el móvil (regla: *la primera respuesta gana*).

---

### F. Restablecer la Configuración desde Cero
Si necesitas eliminar credenciales o cambiar de relay:
```text
/rp unpair
```
O manualmente:
```bash
rm -f ~/.config/rp/config.json
```
Y vuelve a ejecutar `/rp pair`.
