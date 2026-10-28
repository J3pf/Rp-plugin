# QA manual del plugin

Lo automatizado (`npm test`) cubre la lógica, la conexión, el contrato, Pi real y la TUI real en Linux. Esta lista es lo que
sólo se puede comprobar a mano, en tus dos PCs y con la app. Marca cada casilla por PC (Linux personal / Windows empresa).

## 0. Preparación
- [ ] `pi install npm:@j3pf/pi-rp` **y** `gentle-shell install npm:@j3pf/pi-rp`.
- [ ] `/rp pair … --name … --context personal|work`; `/rp doctor` sin `✗` (los `!` se leen: herdr y gentle-shell son opcionales).
- [ ] La PC aparece en la app con su color/contexto; `/rp status` → conectado, transporte `ws` (o `longpoll` tras proxy).

## 1. Ver y hablar
- [ ] Abrir `pi`: aparece el agente en la app con modelo, cwd, rama y estado.
- [ ] Enviar un mensaje desde el móvil: se ve en la terminal y la respuesta llega en streaming.
- [ ] Ocupado: «encolar» (follow-up) y «dirigir» (steer) se comportan distinto.
- [ ] `agent.abort` desde el móvil interrumpe una herramienta larga (`sleep 60`).
- [ ] Cerrar `pi`: el agente pasa a offline; al reabrir con `pi --continue` conserva el historial (mismo `agentId`).
- [ ] Subagentes de gentle-pi **no** aparecen como agentes sueltos.

## 2. Preguntas y autorizaciones
- [ ] Sin gentle-pi: `rm -rf algo` → notificación con Permitir/Denegar; al responder en el móvil el diálogo de la terminal se cierra.
- [ ] Responder primero en la terminal: la notificación del móvil desaparece.
- [ ] Con gentle-pi (Normal): comando peligroso → autorización en el móvil (`Allow recognized data-loss command?`).
- [ ] `ask_user_question` de gentle-pi con 2 preguntas y multi-selección: responder desde el móvil; el modelo recibe lo elegido.
- [ ] Pregunta de un **subagente** de Gentle Agents (prefijo ❀) llega al móvil.
- [ ] Un panel `custom()` desconocido produce «esperando en la terminal».
- [ ] Prompt abierto + relay caído (`systemctl stop`) → al volver, la pregunta sigue en el móvil.
- [ ] Notificaciones: con la app cerrada llegan por el canal directo (y por FCM si está configurado) sin duplicados.

## 3. Modo Auto de gentle-pi
- [ ] `/gentle:mode auto` desde la terminal; el móvil muestra «Auto».
- [ ] Mensaje del móvil con entrega interactiva (biometría): aparece tecleado en la terminal y **autoriza** lo que pide.
- [ ] Con un diálogo abierto, el mensaje espera y se entrega al cerrarse.
- [ ] Con texto sin enviar en el editor: se conserva.
- [ ] Modo Vim de gentle-shell (si lo usas): no teclea en modo normal (ver S7).

## 4. Adjuntos
- [ ] Foto desde el móvil: el agente la «ve» (entrega `api`); en entrega interactiva/herdr se cita la ruta del inbox.
- [ ] PDF: queda en `…/rp/inbox/<sesión>/<fecha>-<nombre>` y el agente lo lee por la ruta.

## 5. rp-host (crear agentes)
- [ ] `rp-host install` + reiniciar sesión: el servicio arranca solo; la app muestra `hostOnline`.
- [ ] Crear agente en una carpeta bajo `roots`: aparece en tmux (Linux) / Windows Terminal (Windows) / herdr.
- [ ] herdr: destino workspace, pestaña y panel dividido; no cambia el foco de tu pantalla.
- [ ] `initialPrompt` llega al agente nuevo.
- [ ] Una carpeta fuera de `roots` o un `launcher` inventado son rechazados.
- [ ] `host.kill` cierra sólo agentes creados por rp-host.
- [ ] Olvidar en la app un agente descubierto en herdr (confirmando el cierre): su panel desaparece en herdr.
- [ ] Cerrar a mano un panel de herdr: el agente desaparece de la app en dos sondeos (`agent.closed`, `pane_closed`).
- [ ] `host.herdr_close` con un panel inexistente responde `ok:false` (`pane_not_found`) y rp-host sigue conectado.

## 6. Resiliencia
- [ ] Reiniciar el relay con un agente trabajando: se reconecta solo y la app resincroniza.
- [ ] Cortar la red 30 s y 5 min con un mensaje en vuelo: sin pérdidas ni duplicados.
- [ ] Bloquear WebSocket (proxy): cambia a long-poll y todo sigue funcionando.
- [ ] `redactContent: true` en la PC de la empresa: en el relay no hay transcript.
- [ ] `gentle-ai sync` no quita el plugin de `~/.pi/agent/settings.json`.
