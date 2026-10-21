# Instalación y Solución de Problemas (Troubleshooting) — rp-plugin

Guía práctica y completa para instalar, emparejar y operar `@j3pf/pi-rp` en cualquier máquina de desarrollo (Linux, macOS, WSL o Windows).

---

## Requisitos

- **Node.js** ≥ 22.19 (LTS recomendado).
- **Pi** (v1.2.0+) o **gentle-shell** instalados en la máquina.
- Un servidor **RP Relay** activo y accesible por red (HTTP/HTTPS o IP local/Tailscale).

---

## 1. Métodos de Instalación

### Método A: Desde GitHub (Recomendado)
`pi install` gestiona paquetes clonando desde repositorios git mediante el prefijo `git:` (nota: `pi install` no descarga directamente URLs de tarballs `.tgz` HTTP, sino que espera un repositorio git o una ruta local):

```bash
# Para Pi estándar (~/.pi/agent)
pi install git:github.com/J3pf/Rp-plugin@v0.2.8

# Para gentle-shell (~/.gentle-shell/agent) — verificado: gentle-shell reenvía la fuente git: a su home aislado
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.2.8
```

### Método B: Desde Tarball de la Release (Alternativa Offline)
Pi registra la ruta local donde reside el paquete. Para evitar que la instalación quede huérfana si se borran directorios temporales o de descargas, descomprime el tarball en una carpeta permanente del agente (por ejemplo `~/.pi/agent/packages/j3pf-pi-rp-0.2.8`):

```bash
# 1. Crear carpeta permanente y descomprimir el tarball de la release
mkdir -p ~/.pi/agent/packages/j3pf-pi-rp-0.2.8
tar -xzf j3pf-pi-rp-0.2.8.tgz -C ~/.pi/agent/packages/j3pf-pi-rp-0.2.8 --strip-components=1

# 2. Instalar dependencias de producción
cd ~/.pi/agent/packages/j3pf-pi-rp-0.2.8 && npm install --omit=dev

# 3. Registrar el paquete en Pi desde la carpeta del agente
cd ~/.pi/agent && pi install ./packages/j3pf-pi-rp-0.2.8
```

### Método C: Desde Código Fuente (Desarrollo / Clon Local)
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

### Actualización desde una versión anterior

#### Caso 1: Actualización de una instalación `git:` existente (lo habitual)
`pi install` actualiza el clon en el directorio del agente, hace checkout del nuevo tag y actualiza la entrada en `settings.json` automáticamente:
```bash
# Para Pi estándar
pi install git:github.com/J3pf/Rp-plugin@v0.2.8

# Para gentle-shell
gentle-shell install git:github.com/J3pf/Rp-plugin@v0.2.8

# Verificar que la versión activa sea la nueva
pi list
```
> ⚠️ **ADVERTENCIA IMPORTANTE:** **NO** ejecutes `pi remove` con el ref anterior (ej. `pi remove git:github.com/J3pf/Rp-plugin@v0.2.4`). Pi empareja paquetes por repositorio y no por ref; ejecutar `pi remove` **desinstalaría por completo el plugin**.

#### Caso 2: Migración desde una ruta local previa (ej. `./packages/j3pf-pi-rp-0.2.1`)
`pi remove` aplica únicamente para limpiar entradas locales anteriores y evitar que ambas versiones carguen simultáneamente:
1. **Instala la nueva versión primero** (de este modo una falla de red o de instalación nunca deja el entorno sin plugin):
   ```bash
   pi install git:github.com/J3pf/Rp-plugin@v0.2.8
   ```
2. **Revisa las fuentes instaladas con `pi list` y elimina la ruta local anterior situándote en `~/.pi/agent`**:
   ```bash
   pi list
   cd ~/.pi/agent && pi remove ./packages/j3pf-pi-rp-0.2.1
   ```
3. **Reinicia las sesiones de Pi**. Para actualizar el servicio `rp-host` en la máquina actual:
   ```bash
   rp-host install   # o dejar que la auto-reparación de Pi lo migre automáticamente
   rp-host doctor
   ```

### Método D: Herramienta `rp-host` (Para crear agentes desde el móvil)
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
- **Windows — Task Scheduler:** `rp-host` importa una tarea XML codificada en **UTF-16LE con BOM** (`FF FE`) y `encoding="UTF-16"`, formato nativo estricto de Task Scheduler que evita errores de análisis malformado con `schtasks /Create /XML`. La tarea se ejecuta de forma completamente invisible (windowless) mediante `conhost.exe --headless "<node>" "<script>" run`, evitando abrir ventanas de consola permanentes en el escritorio (cuya clausura terminaría el host). Se optó por `conhost.exe --headless` (estándar en Windows 10 1809+ y Windows 11) en lugar de scripts `.vbs` auxiliares porque VBScript está en vías de depreciación y los archivos `.vbs` suelen ser bloqueados por reglas corporativas de Attack Surface Reduction (ASR) o antivirus empresariales. La tarea no tiene límite de 72 horas (`ExecutionTimeLimit PT0S`), reinicia tras fallos (999 × 1 min), funciona en batería (`DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false`) y corre bajo el usuario actual con privilegios mínimos sin requerir administrador.
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
