# Arquitectura

Este documento explica cómo está organizado Policía Discord y las decisiones que garantizan un comportamiento seguro. Para instalación y uso ver el [README](../README.md); para operación y fallos, [OPERACION.md](OPERACION.md).

## Estructura

```
src/
  index.js                 arranque: cliente, intents, handlers, recuperación, señales
  register-commands.js     registra los slash commands en GUILD_ID (npm run register)
  config.js  logger.js  messages.js
  core/                    lógica del bot, sin dependencia directa de discord.js
    service.js             fachada con mutex: patrullas, vigilados, votos, permisos, voz, recuperación
    muteManager.js         propiedad de mutes, eventos propios vs. externos, liberación
    votingManager.js       votaciones (crear, releer reacciones, cancelar, cerrar)
    voting.js              reglas puras: mayoría, padrón, recuento, decisión
    permitManager.js       permisos temporales y sus temporizadores
    mutex.js  context.js  errors.js
  discord/                 adaptadores finos sobre discord.js
    adapter.js             implementación real de la interfaz "discord" del núcleo
    commands.js            definición de slash commands y niveles de permiso
    commandRunner.js       lógica de cada comando (recibe datos simples, devuelve texto)
    handlers.js            eventos de discord.js -> núcleo
  storage/
    jsonStore.js  state.js persistencia atómica y lock de proceso
test/                      98 tests (node:test) con Discord y reloj simulados
```

El núcleo (`src/core`) solo conoce una interfaz `discord` (`getVoiceState`, `setMute`, `sendMessage`, `fetchReactionUsers`, etc.) y un reloj inyectable. Por eso los tests reemplazan Discord y el tiempo por simulaciones y nunca operan sobre usuarios reales.

## Un mutex global

Comandos, eventos de voz, reacciones, vencimientos y el barrido periódico pasan por **un único mutex** (`core/mutex.js`) y se ejecutan de a uno, en orden de llegada. Así se evitan las condiciones de carrera entre `setMute()` y los `voiceStateUpdate` que ese mismo cambio dispara, o entre dos administradores que actúan a la vez. Los gestores internos no toman el mutex (evita interbloqueos); solo la fachada `service.js` lo hace. Costo: las llamadas a la API se serializan, algo aceptable a esta escala; con la API lenta las acciones se encolan.

Los comandos usan `deferReply` porque la espera por el mutex y la API puede superar los 3 s que Discord concede para responder.

## Propiedad de los mutes (estrategia conservadora)

El bot **no asume** que todo mute es suyo. Por cada vigilado guarda:

| Campo | Significado |
|---|---|
| `preMuted` | Si ya estaba silenciado cuando el bot lo observó por primera vez, **antes de actuar**. Si es `true`, ese mute se considera de un moderador y **nunca se levanta**. `null` = aún no observado (estaba desconectado). |
| `botMuted` | El bot aplicó un mute que sigue vigente. **Solo estos se liberan.** |
| `pendingOp` | `'mute'`/`'unmute'`: intención escrita en disco **antes** de llamar a Discord, para resolver cortes a mitad de operación. |
| `manualUnmute` | Un moderador des-silenció al vigilado durante la patrulla; el bot lo respeta hasta que se reconecte. |
| `uncertain` | Tras un reinicio no se pudo saber si una operación pendiente se aplicó; el bot no reclama propiedad. |
| `needsRemute` | Falló un re-silenciado; se reintenta con el barrido. |

Un mute es "propio" si `botMuted && preMuted !== true`.

### Eventos propios vs. externos (sin bucles)

Antes de cada `setMute` el bot registra una **expectativa** (usuario + valor, TTL 15 s). Cuando llega el `voiceStateUpdate` con ese cambio, la consume y lo ignora. Un cambio de `serverMute` **sin** expectativa, dentro de una misma sesión de voz, es *externo*:

- Un moderador **des-silencia** a un vigilado → `manualUnmute = true`, `botMuted = false`; el bot no pelea.
- Un moderador **silencia** a un vigilado → ese mute no se considera del bot.
- Si el usuario tenía una liberación pendiente y alguien más lo des-silencia, la liberación se descarta.

### Qué no se puede saber

- La API de Discord informa *si* alguien está silenciado, **no quién** lo hizo. Solo se distingue por lo observado y recordado. (El registro de auditoría lo indicaría, pero requeriría el permiso `ViewAuditLog` y no se usa.)
- Si un moderador silencia manualmente a alguien que el bot **ya** había silenciado, no hay forma de notarlo: al liberar se levantará ese silencio.
- La ventana de 15 s de las expectativas puede confundir un cambio manual exactamente simultáneo con uno del bot.
- Si el estado se pierde, el bot no sabe qué mutes eran suyos (ver [OPERACION.md](OPERACION.md)).
- Discord **no permite cambiar el mute de alguien fuera de voz** (error 40032). No está verificado si el mute persiste al desconectarse y reconectarse; el código funciona en ambos casos.

### Liberaciones pendientes

Al dejar de vigilar a alguien o finalizar, si el mute era propio se registra en `pendingReleases` (persistente) y se intenta liberar. Si el usuario no está en voz queda pendiente y se libera cuando se conecte, **solo si sigue silenciado** y sin cambio externo. Pasados **7 días** se descarta con una advertencia (constante en `muteManager.js`). Si se vuelve a vigilar a esa persona, la propiedad del mute continúa.

## Votaciones

- El padrón se calcula al crear la solicitud: humanos del canal sin solicitante ni bots, sin repetidos; queda **fijo**.
- Cada cambio de reacción relee las listas de usuarios de ✅ y ❌ del mensaje y **recalcula** el recuento desde cero (idempotente; sin conteos incrementales que se desincronicen). Costo: 2 llamadas REST por evento de reacción.
- Reacción doble ✅+❌ → ❌ (determinista). Se ignoran externos al padrón y al propio bot.
- Aprobada: se verifica que la patrulla siga activa, que el usuario siga vigilado y en el canal original, se hace *unmute*, se confirma que Discord lo aceptó y recién entonces se crea el permiso. Si Discord lo rechaza, no hay permiso.
- Cada votación tiene id único, patrulla, solicitante, canal de voz, mensaje, padrón, votos, umbral, estado y fecha. Nunca se mezclan votos entre solicitudes.

## Permisos temporales

Se guardan con `expiresAt` **absoluto**, nunca como tiempo restante, de modo que un reinicio no los renueva. Hay dos mecanismos independientes de vencimiento: un temporizador exacto por permiso y un **barrido cada 5 s** que cierra cualquier permiso vencido aunque un temporizador falle. Un temporizador viejo no cierra un permiso nuevo (se compara `grantedAt`). Si el re-mute falla al vencer, el permiso se cierra igual (nunca queda abierto), se avisa y se reintenta hasta 10 veces.

## Persistencia

`data/state.json` (ruta según `DATA_DIR`) contiene: patrulla activa, inicio y autor, vigilados con su estado de mute, votaciones abiertas, permisos con su vencimiento, liberaciones pendientes y la última patrulla.

- **JSON atómico** (archivo temporal + `rename`, con reintentos ante `EPERM/EBUSY` de Windows) en lugar de SQLite: el estado es pequeño, no agrega dependencias ni módulos experimentales y es legible a mano. Las escrituras se serializan.
- **Se persiste antes de actuar sobre Discord.** `finalize` marca la patrulla como inactiva y mueve los mutes propios a `pendingReleases` **antes** de intentar liberarlos: un corte a mitad nunca reactiva una patrulla finalizada.
- Archivo corrupto o incompatible → el bot **se niega a arrancar** en vez de descartarlo en silencio.
- **Lock de proceso** (`bot.lock` con el pid, dentro de `DATA_DIR`): impide dos instancias a la vez; un lock huérfano de un proceso muerto se limpia solo.

## Recuperación al arrancar

Con Discord listo, `service.start()` ejecuta (dentro del mutex):

1. Cancela las votaciones abiertas (sus reacciones pudieron perderse) y lo avisa en el canal.
2. Resuelve operaciones de mute a medias observando el estado real.
3. Permisos: conserva su vencimiento original; cierra y re-silencia los vencidos; cancela los de quien cambió de canal o salió con el bot apagado; reprograma los vigentes.
4. Revisa a los vigilados conectados (re-silencia a quien corresponda) e intenta las liberaciones pendientes.
5. Publica un aviso si había patrulla o votaciones canceladas, y arranca el barrido de 5 s.

## Seguridad y permisos

- Privilegios mínimos: el bot pide solo *Ver canales, Enviar mensajes, Añadir reacciones, Leer historial y Silenciar miembros*. No usa Administrador, self-bots ni *Message Content Intent*.
- Permisos de comandos (verificación en tiempo de ejecución autoritativa; los permisos por defecto solo ocultan comandos en la interfaz): `iniciar`/`finalizar` → `ManageGuild`; `vigilar`/`dejar-vigilar`/`estado` → `MuteMembers` o `ManageGuild`; `pedir-palabra` → cualquiera, pero el núcleo exige que esté vigilado. Quien tenga Administrador pasa todos los niveles.
- Solo opera en `GUILD_ID`. Se rechaza vigilar bots y usuarios que no sean miembros.
- Mensajes con `allowedMentions: { parse: [] }` (menciones sin ping). El logger redacta el token.
- Los errores internos se informan al usuario con un mensaje genérico; el detalle va solo al log.
