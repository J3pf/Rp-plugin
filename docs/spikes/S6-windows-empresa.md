# S6 — Conectividad desde la PC Windows de la empresa

**Resultado: ⏳ pendiente** (necesita esa máquina). El plugin ya implementa todo lo que el spike debe validar; este
documento es el procedimiento.

## Implementado y probado en local (Linux)
- `HTTPS_PROXY` / `NO_PROXY` mediante `proxy-agent` tanto para WebSocket como para HTTP; CA corporativa con
  `NODE_EXTRA_CA_CERTS` (Node la respeta).
- Si el *upgrade* WS falla 3 veces seguidas → transporte **long-poll** (`/v1/agent/send` + `/v1/agent/poll`); reintento de WS cada 10 min.
- Rutas de Windows (`%APPDATA%\rp\config.json`, `%LOCALAPPDATA%\rp\inbox`) cubiertas con pruebas de unidad que simulan `win32`.

## Procedimiento en la PC de la empresa
1. `pi install npm:@j3pf/pi-rp` y `gentle-shell install npm:@j3pf/pi-rp`.
2. `/rp pair https://relay… CÓDIGO --name "PC Empresa" --context work`.
3. `/rp doctor` y guardar la salida: DNS, TLS, `/healthz`, WebSocket, reloj, proxy, CA, plugin declarado en ambos homes, herdr, gentle-pi.
4. Si «WebSocket» sale `!`: confirmar que `/rp status` muestra `transporte longpoll` tras unos segundos y que el móvil ve el agente.
5. Con inspección TLS: exportar la CA de la empresa y definir `NODE_EXTRA_CA_CERTS=C:\ruta\ca.pem` (variable de usuario).
6. Si la política lo exige: `"redactContent": true` en `%APPDATA%\rp\config.json`.

Criterio de «hecho»: el agente aparece en la app y una pregunta de prueba (`/rp test`) llega y se responde desde el móvil.
