# Arquitectura

Este documento explica cómo está organizado Policía Discord y las decisiones que garantizan un comportamiento seguro. Para instalación y uso ver el [README](../README.md); para operación y fallos, [OPERACION.md](OPERACION.md).

## Modelo de dominio

> **Una vigilancia es un castigo temporal que comienza con una votación aprobada y termina automáticamente cuando vence su duración.**

No existe una "patrulla" global que haya que iniciar o finalizar. El estado es un conjunto de **vigilancias activas** (`state.watches`), una por usuario como máximo. Una vigilancia que termina (por vencimiento, por fin anticipado votado o por aislamiento) se **elimina** de ese conjunto: no hay vigilancias "inactivas" ni estados obsoletos que puedan bloquear una solicitud nueva.

```
Vigilancia { id, userId, status: 'active', requestedBy, pollId,        <- votación que la autorizó
             startedAt, expiresAt, durationSeconds, streakCount,       <- tiempos ABSOLUTOS
             reconnects, awaitingReturn, isolationAttempted, isolationFailure,
             preMuted, botMuted, pendingOp, manualUnmute, uncertain, needsRemute, remuteAttempts }  <- gestión segura del mute
```

Fuera de las vigilancias se guarda: la **racha** de reincidencia (`streak = { lastUserId, count }`), los **aislamientos** aplicados (`isolations`), las **votaciones** abiertas (`polls`), los **permisos de palabra** (`permits`) y las **liberaciones de mute pendientes** (`pendingReleases`).

## Estructura

```
src/
  index.js                 arranque: cliente, intents, handlers, recuperación, señales
  register-commands.js     registra los slash commands en GUILD_ID y elimina los que ya no existen
  config.js  logger.js  messages.js
  core/                    lógica del bot, sin dependencia directa de discord.js
    service.js             fachada con mutex: vigilancias, votos, permisos, voz, recuperación
    watchManager.js        vigilancias: creación (avanza la racha), temporizadores, aislamientos vigentes
    punishment.js          reglas puras: duración exponencial y racha global (centralizado)
    muteManager.js         propiedad de mutes, eventos propios vs. externos, liberación
    votingManager.js       votaciones de todos los tipos (crear, releer reacciones, cancelar, cerrar)
    voting.js              reglas puras: tipos, mayoría, padrón, recuento, decisión
    permitManager.js       permisos de palabra y sus temporizadores
    mutex.js  context.js  errors.js
  discord/                 adaptadores finos sobre discord.js
    adapter.js             implementación real de la interfaz "discord" del núcleo
    commands.js            definición de slash commands y niveles de permiso
    commandRunner.js       lógica de cada comando (recibe datos simples, devuelve texto)
    handlers.js            eventos de discord.js -> núcleo
  storage/
    jsonStore.js           persistencia atómica, lock de proceso y respaldo previo a migrar
    state.js               formato del estado (v2) y migración desde el formato anterior (v1)
test/                      196 tests (node:test) con Discord y reloj simulados
```

El núcleo (`src/core`) solo conoce una interfaz `discord` (`getVoiceState`, `setMute`, `sendMessage`, `fetchReactionUsers`, `timeoutMember`, etc.) y un reloj inyectable. Por eso los tests reemplazan Discord y el tiempo por simulaciones y nunca operan sobre usuarios reales.

## Un mutex global

Comandos, eventos de voz, reacciones, vencimientos y el barrido periódico pasan por **un único mutex** (`core/mutex.js`) y se ejecutan de a uno, en orden de llegada. Así se evitan las condiciones de carrera entre `setMute()` y los `voiceStateUpdate` que ese mismo cambio dispara, entre un vencimiento y una reconexión, o entre dos moderadores que actúan a la vez. Los gestores internos no toman el mutex (evita interbloqueos); solo la fachada `service.js` lo hace. Es solo exclusión mutua de operaciones: **no hay ningún bloqueo funcional global** (las vigilancias y votaciones de personas distintas son independientes). Costo: las llamadas a la API se serializan, algo aceptable a esta escala.

Los comandos usan `deferReply` porque la espera por el mutex y la API puede superar los 3 s que Discord concede para responder.

## Ciclo de vida de una vigilancia

1. **Solicitud** (`/vigilar`, `requestWatch`): verifica que el afectado no sea un bot, esté en voz, no tenga una vigilancia vigente y no tenga ya una votación de inicio pendiente. Publica la votación (`START_WATCH`) con el padrón de su canal. No modifica nada más.
2. **Aprobación** (`_approveAdmin`): revalida las condiciones (la votación pudo tardar), cierra la votación y recién entonces ejecuta `_startWatch`: crea la vigilancia con la duración calculada **en ese momento**, avanza la racha, programa el vencimiento, guarda el estado y aplica el *server mute*. Si se rechaza, no se toca nada.
3. **Durante el castigo**: el usuario se re-silencia al entrar o cambiar de canal; sus salidas y regresos se cuentan (ver aislamiento); puede pedir la palabra.
4. **Fin**, por una de tres vías, todas con el mismo cierre (`_closeWatch`): cancela sus votaciones y su permiso, limpia su temporizador, registra su mute propio como pendiente de liberar y lo intenta liberar, **elimina la vigilancia del estado**, persiste y avisa.
   - **Vencimiento** (`_expireWatch`): automático, sin votación ni comando.
   - **Fin anticipado** (`/dejar-vigilar`, `END_WATCH`): requiere votación.
   - **Aislamiento** por reconexiones (`_tryIsolation`).

El cierre no toca la racha. Lo ejecutan, ante la misma vigilancia, el temporizador exacto y el barrido de 5 s, siempre dentro del mutex y revalidando que la vigilancia exista y esté vencida; por eso un temporizador tardío o repetido no puede cerrar una vigilancia nueva del mismo usuario (otro `id`). `_onVoice` también regulariza una vigilancia vencida **antes** de procesar un evento, de modo que una reconexión posterior al vencimiento nunca cuenta ni silencia.

## Racha y duración (centralizadas en `core/punishment.js`)

`computeDuration(count, base, max) = min(base · 2^(count-1), max)` (exponente acotado: sin desbordes). `nextPunishment` y `advanceStreak` implementan la regla: el castigo aprobado a la **misma persona que recibió el castigo aprobado inmediatamente anterior** aumenta `count`; a cualquier otra lo reinicia en 1. Solo `WatchManager.create` avanza la racha, y solo se llama cuando se crea una vigilancia; por eso rechazos, pendientes, permisos, vencimientos, desconexiones, aislamientos, fines anticipados y reinicios no la tocan. La votación guarda la duración *propuesta* (`proposedSeconds`) solo para mostrarla; la aplicada se recalcula al aprobar y el resultado indica si difiere.

## Reconexiones y aislamiento

En `_onVoice`, para un castigado: una **salida** (`canal → ninguno`) marca `awaitingReturn`; un **regreso** (`ninguno → canal`) con `awaitingReturn` incrementa `reconnects` y lo limpia. Como es un indicador y no un contador de eventos, los eventos duplicados no suman; un cambio de canal, de mute o de sordera no es salida ni regreso; el ingreso inicial no tiene salida previa. Los contadores pertenecen a la vigilancia, así que son independientes por persona y por castigo y arrancan en cero con cada castigo nuevo. Al llegar a `ISOLATION_RECONNECT_LIMIT` (2) se llama `_tryIsolation`:

1. `isolationAttempted = true` se persiste **antes** de actuar (un solo intento por vigilancia, aun con reinicios o fallos).
2. Se consulta el timeout vigente (`getTimeoutInfo`, a la API): si existe uno de otro moderador, **no se toca** (ni se sobrescribe ni se acorta) y se informa.
3. `canTimeout` valida: no es el dueño, no tiene Administrador, el bot tiene `ModerateMembers` y su rol está por encima.
4. `timeoutMember` aplica `communicationDisabledUntil` (timeout nativo, no ban/kick).
5. Si todo salió bien: se registra en `state.isolations`, se cierra la vigilancia con `_closeWatch` (un solo guardado) y se publica el motivo. Si algo falla: `isolationFailure` queda guardado, se informa y la vigilancia **continúa** hasta su vencimiento.

El aislamiento es independiente de las vigilancias activas: se persiste solo para seguimiento, nunca se reaplica ni se extiende tras un reinicio, y se poda cuando vence (Discord levanta el timeout por sí solo).

## Propiedad de los mutes (estrategia conservadora)

El bot **no asume** que todo mute es suyo. Cada vigilancia guarda:

| Campo | Significado |
|---|---|
| `preMuted` | Si ya estaba silenciado cuando el bot lo observó por primera vez, **antes de actuar**. Si es `true`, ese mute se considera de un moderador y **nunca se levanta**. `null` = aún no observado (estaba desconectado). |
| `botMuted` | El bot aplicó un mute que sigue vigente. **Solo estos se liberan.** |
| `pendingOp` | `'mute'`/`'unmute'`: intención escrita en disco **antes** de llamar a Discord, para resolver cortes a mitad de operación. |
| `manualUnmute` | Un moderador des-silenció al vigilado durante la vigilancia; el bot lo respeta hasta que se reconecte. |
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

Cuando una vigilancia termina, si su mute era propio se registra en `pendingReleases` (persistente) y se intenta liberar. Si el usuario no está en voz, **la vigilancia igual deja de figurar como activa** y el silencio queda pendiente: se libera cuando se conecte, **solo si sigue silenciado** y sin cambio externo. Pasados **7 días** se descarta con una advertencia (constante en `muteManager.js`). Si se vuelve a vigilar a esa persona, la propiedad del mute continúa.

## Votaciones

Todas las decisiones pasan por **un único mecanismo de votación** (`votingManager.js` + `voting.js`); lo que cambia entre tipos es solo el padrón y la acción al aprobarse (`PoliciaService._approve`).

| Tipo | La solicita | Padrón (congelado al crear) | Al aprobarse |
|---|---|---|---|
| `START_WATCH` | `/vigilar` | humanos del canal del afectado, sin él ni bots | crea la vigilancia (castigo) y silencia al afectado |
| `END_WATCH` | `/dejar-vigilar` | ídem | termina anticipadamente la vigilancia (libera su mute si es propio) |
| `SPEAK_PERMISSION` | un vigilado (`/pedir-palabra`) | humanos de su canal, sin él | unmute + permiso de palabra |

- Una votación guarda: `id`, `type`, `requesterId`, `targetId`, `watchId` (la vigilancia a la que se refiere, en `END_WATCH` y `SPEAK_PERMISSION`), `channelId`, `messageId`, `roster`, `needed`, `votes`, `status`, `createdAt`, y en `START_WATCH` la duración propuesta.
- **Padrón:** humanos presentes, sin repetidos, sin bots y sin el afectado/solicitante. Queda **fijo**. Sin votantes no se crea la votación: nunca se aprueba nada automáticamente.
- **Mayoría** `floor(n/2)+1` sobre el **total de habilitados**. Se aprueba al instante al alcanzarla y se rechaza cuando los votos en contra la vuelven imposible.
- Cada cambio de reacción relee las listas de usuarios de ✅ y ❌ del mensaje y **recalcula** el recuento desde cero (idempotente). Costo: 2 llamadas REST por evento de reacción. Reacción doble ✅+❌ → ❌. Se ignoran externos al padrón y al propio bot.
- **Duplicados:** se rechaza (`POLL_PENDING`) una segunda votación `START_WATCH` o `END_WATCH` para el mismo usuario; las de personas distintas, y las de palabra, coexisten sin bloqueos globales. Para descartar una pendiente se borra su mensaje.
- **Acciones inmediatas vs. solicitudes:** `applyWatch`/`applyUnwatch` (que usa `_approveAdmin` y los tests) ejecutan de inmediato; los comandos usan solo `request*`.
- **Cancelación segura:** una votación sobre un usuario se cancela si el afectado **sale o cambia de canal** (incluso antes de estar vigilado), si su vigilancia termina, si se borra su mensaje o si el bot se reinicia. Votos tardíos sobre una votación cancelada no tienen efecto. Al aprobarse se revalida todo antes de actuar y la votación se cierra antes de ejecutar la acción.

### Permiso de palabra

Aprobada una `SPEAK_PERMISSION`: se verifica que la vigilancia siga vigente (mismo `watchId`) y el usuario en el canal original, se hace *unmute*, se confirma que Discord lo aceptó y recién entonces se crea el permiso (`expiresAt` absoluto, temporizador exacto + barrido de 5 s). El permiso **no extiende** la vigilancia: si esta termina antes, el permiso se cancela. Si el re-mute falla al vencer el permiso, este se cierra igual (nunca queda abierto), se avisa y se reintenta hasta 10 veces.

## Persistencia

`state.json` en `DATA_DIR` (formato v2) contiene: vigilancias activas, votaciones abiertas, permisos con su vencimiento, liberaciones pendientes, racha y aislamientos.

- **JSON atómico** (archivo temporal + `rename`, con reintentos ante `EPERM/EBUSY` de Windows) en lugar de SQLite: el estado es pequeño, no agrega dependencias y es legible a mano. Las escrituras se serializan.
- **Se persiste antes de actuar sobre Discord.** `_closeWatch` elimina la vigilancia y mueve el mute propio a `pendingReleases` **antes** de intentar liberarlo: un corte a mitad nunca resucita una vigilancia terminada.
- Archivo corrupto o incompatible → el bot **se niega a arrancar** en vez de descartarlo en silencio.
- **Lock de proceso** (`bot.lock` con el pid, dentro de `DATA_DIR`): impide dos instancias a la vez; un lock huérfano de un proceso muerto se limpia solo.

### Migración desde el formato anterior (v1, con "patrulla")

Al cargar un `state.json` v1, `JsonStore.load` **copia el archivo original** (`state.json.v1-backup-<fecha>`; si no puede, no migra y el bot no arranca) y `migrateV1` (función pura) construye el estado v2 sin modificar el original:

- **Vigilancias con castigo** (v1.2): se conservan como vigilancias independientes con el mismo `id`, inicio, vencimiento **absoluto**, racha, contadores de reconexión y gestión de mute. Si ya vencieron, se regularizan al arrancar.
- **Vigilancias sin castigo** (v1.0/1.1, indefinidas): no pueden existir en el modelo nuevo. Se cierran y, si el bot las había silenciado, su mute pasa a *liberación pendiente* (nunca se descarta en silencio).
- Se conservan tal cual: racha, aislamientos, liberaciones pendientes, permisos y votaciones (estas últimas se cancelan al recuperar, como en cualquier reinicio; los tipos antiguos se mapean para redactar su cancelación).
- Los datos de la patrulla antigua (id, inicio, autor, `lastPatrol`) quedan resumidos en `state.migration`, junto con una nota por usuario y el nombre del respaldo. El aviso de migración se publica **una sola vez**.

## Recuperación al arrancar

Con Discord listo, `service.start()` ejecuta (dentro del mutex):

1. Avisa de la migración (si la hubo) y cancela **todas** las votaciones abiertas, de cualquier tipo (sus reacciones pudieron perderse).
2. Resuelve operaciones de mute a medias observando el estado real.
3. **Vigilancias:** las vencidas durante el apagado se cierran ahora (con su anuncio y la liberación del mute que corresponda); el resto se reprograma con su `expiresAt` **original**.
4. Permisos: conserva su vencimiento original; cierra los vencidos; cancela los de quien cambió de canal o salió con el bot apagado y los huérfanos (sin vigilancia).
5. Revisa a los vigilados conectados (re-silencia a quien corresponda), intenta las liberaciones pendientes y poda aislamientos vencidos.
6. Publica un aviso si hubo vigilancias recuperadas, votaciones canceladas, castigos vencidos o migración, y arranca el barrido de 5 s.

## Seguridad y permisos

- Privilegios mínimos: el bot pide solo *Ver canales, Enviar mensajes, Añadir reacciones, Leer historial, Silenciar miembros y Aislar temporalmente a miembros* (este último únicamente para el aislamiento). No usa Administrador, self-bots ni *Message Content Intent*.
- Permisos de comandos (verificación en tiempo de ejecución autoritativa; los permisos por defecto solo ocultan comandos en la interfaz): `vigilar`, `dejar-vigilar` y `policia-estado` → `MuteMembers` o `ManageGuild`; `pedir-palabra` → cualquiera, pero el núcleo exige que esté vigilado. Los permisos de comando controlan quién puede **solicitar** una votación; votar puede hacerlo cualquiera que esté en el padrón. Quien tenga Administrador pasa todos los niveles.
- Solo opera en `GUILD_ID`. Se rechaza vigilar bots y usuarios que no sean miembros.
- `register-commands.js` usa `PUT` sobre los comandos del servidor: cualquier comando que ya no exista en el código se elimina de Discord. Informa qué se quitó y avisa si hay comandos globales de la aplicación.
- Mensajes con `allowedMentions: { parse: [] }` (menciones sin ping). El logger redacta el token.
- Los errores internos se informan al usuario con un mensaje genérico; el detalle va solo al log.
