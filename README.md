# rp-plugin

Pi package que conecta cada sesión de [Pi](https://github.com/earendil-works/pi) a tu relay **RP**: transmite la actividad del
agente al móvil, recibe mensajes y adjuntos, y lleva **preguntas y autorizaciones** al teléfono (responde la terminal o el
móvil, la primera respuesta gana). Funciona con `gentle-shell`/gentle-pi y dentro de herdr. Incluye `rp-host` para lanzar agentes nuevos desde el móvil (en herdr o tmux).

Instalación prevista: `pi install npm:@j3pf/pi-rp` **y** `gentle-shell install npm:@j3pf/pi-rp` (ver plan).

> Estado: **planeación**. Todavía no hay código.

| Documento | Contenido |
|---|---|
| [docs/PLAN-PLUGIN.md](docs/PLAN-PLUGIN.md) | Plan detallado del plugin |
| [docs/COMPATIBILIDAD.md](docs/COMPATIBILIDAD.md) | herdr, gentle-ai, gentle-shell/gentle-pi y separación por PC: hechos verificados y matriz requisito × entorno |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Visión global (copia; canónica en `rp-relay`) |
| [`rp-relay/docs/PROTOCOLO.md`](https://github.com/j3pf/rp-relay/blob/main/docs/PROTOCOLO.md) | Contrato de red |

## Referencias investigadas

- Pi (`earendil-works/pi`, v1.2.0): `packages/coding-agent/docs/{extensions,packages,rpc,rpc-extension-ui,json,security,sessions}.md`,
  `src/core/extensions/{types,runner}.ts`, `src/modes/{interactive/interactive-mode,rpc/rpc-mode}.ts`,
  ejemplos `permission-gate.ts`, `question.ts`, `notify.ts`, `send-user-message.ts`.
- [Remote Pi](https://github.com/jacobaraujo7/remote_pi) (Flutter + relay Rust + extensión Pi): emparejamiento QR, aprobaciones vía
  `@eko24ive/pi-ask`; **sin push real** — es la principal carencia que este proyecto cubre.
- [Happy](https://github.com/slopus/happy) / Happier (happier-dev): wrapper de CLI + servidor Fastify/Socket.IO con cifrado E2E.
- [Moshi](https://getmoshi.app/docs): terminal móvil + hook en el host que genera bandeja de aprobaciones y push.
- [gentle-shell / gentle-pi](https://github.com/Gentleman-Programming/gentle-shell) 4.1.0, [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), [herdr](https://github.com/herdrdev/herdr) 0.9.3: entorno del usuario, ver `docs/COMPATIBILIDAD.md`.
