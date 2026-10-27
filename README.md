# Policía Discord

Bot de Discord que funciona como un **policía de voz por patrullas**.

- Mientras **no hay patrulla activa, el bot no vigila ni silencia a nadie**.
- Un administrador inicia una patrulla eligiendo (con `@`) al primer usuario a vigilar; durante la patrulla se pueden sumar más.
- Los usuarios vigilados quedan con **server mute** en voz. Para hablar deben pedir la palabra con `/pedir-palabra`: los demás integrantes de su canal de voz **votan con reacciones** y, si hay mayoría, obtienen **120 segundos** de permiso.
- Al finalizar la patrulla el bot deja de vigilar y libera, cuando es seguro, los silencios que él mismo aplicó.

> ⚠️ **Estado:** el código está implementado y cubierto por tests automatizados con mocks (98 tests). **Todavía no fue probado en un servidor real de Discord.** Ver `INFORME_PARA_CHATGPT.md` para el plan de pruebas manuales.

---

## 1. Requisitos e instalación

- Node.js ≥ 20 (desarrollado con Node 24) y npm.
- Una aplicación de Discord con un bot (ver sección 3).

```bash
npm install
cp .env.example .env     # en Windows (cmd): copy .env.example .env
```

Completá `.env` (sección 2). Luego registrá los comandos y arrancá:

```bash
npm run register   # registra los slash commands en tu servidor (una vez, o al cambiarlos)
npm start          # arranca el bot
npm test           # corre los tests automatizados (no usan Discord real)
```

## 2. Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DISCORD_TOKEN` | sí | Token del bot. **Secreto**: nunca lo subas a Git ni lo compartas. |
| `CLIENT_ID` | sí | Application ID de la aplicación. |
| `GUILD_ID` | sí | ID del servidor donde opera el bot (el bot ignora cualquier otro). |
| `VOTING_CHANNEL_ID` | sí | ID del canal de texto para anuncios y votaciones. |
| `SPEAK_DURATION_SECONDS` | no (120) | Duración del permiso tras una votación aprobada (5–3600). |
| `DATA_DIR` | no (`./data`) | Carpeta del estado persistente. |
| `LOG_LEVEL` | no (`info`) | `debug`, `info`, `warn` o `error`. |

`.env` y `data/` están en `.gitignore`. El bot nunca imprime el token (el logger lo redacta).
No existe `TARGET_USER_ID`: los vigilados se eligen con comandos.

> 💡 Si el proyecto está dentro de una carpeta sincronizada (OneDrive, Dropbox…), conviene poner `DATA_DIR` fuera de ella (p. ej. `C:\policia-data`) para evitar bloqueos del sincronizador sobre el archivo de estado.

## 3. Crear la aplicación en el Developer Portal

1. Entrá a <https://discord.com/developers/applications> → **New Application** → nombre "Policía Discord".
2. En **General Information** copiá el **Application ID** → `CLIENT_ID`.
3. En **Bot**:
   - **Reset Token** → copiá el token → `DISCORD_TOKEN` (solo se muestra una vez).
   - En **Privileged Gateway Intents** dejá **todo apagado**: el bot **no necesita** Presence, Server Members ni Message Content.
   - Desactivá **Public Bot** si no querés que otros lo inviten.
4. Para obtener los IDs de servidor y canal: en Discord, *Ajustes → Avanzado → Modo desarrollador* y luego clic derecho sobre el servidor/canal → **Copiar ID**. (`GUILD_ID`, `VOTING_CHANNEL_ID`).

### Intents que usa el bot (todos no privilegiados)

`Guilds`, `GuildVoiceStates` (cambios de voz), `GuildMessages` (solo para saber si borran un mensaje de votación; **no** lee contenido) y `GuildMessageReactions` (votos).

## 4. Invitar el bot y permisos

Abrí esta URL reemplazando `TU_CLIENT_ID`:

```
https://discord.com/oauth2/authorize?client_id=TU_CLIENT_ID&scope=bot%20applications.commands&permissions=4262976
```

`4262976` = **Ver canales**, **Enviar mensajes**, **Añadir reacciones**, **Leer historial de mensajes** y **Silenciar miembros**. No pide Administrador.

Puntos a verificar:

- En el **canal de votaciones** el bot debe poder ver, escribir, reaccionar y leer historial.
- En los **canales de voz** no debe haber un permiso que le deniegue *Silenciar miembros*.
- Si al silenciar aparece un error de permisos, subí el rol del bot por encima de los roles de los usuarios a vigilar.
- El bot **no necesita unirse** a canales de voz.

## 5. Canal de votaciones

`VOTING_CHANNEL_ID` es el canal donde el bot publica el inicio/fin de patrulla, los avisos y los mensajes de votación (con las reacciones ✅ y ❌). Se recomienda un canal visible para todos los que participan en voz. Las menciones se publican **sin notificar** (no hacen ping).

## 6. Comandos

Se registran solo en tu servidor con `npm run register`.

| Comando | Quién | Qué hace |
|---|---|---|
| `/policia-iniciar usuario:@U` | `Gestionar servidor` | Inicia la patrulla con `@U` como primer vigilado. |
| `/vigilar usuario:@U` | `Silenciar miembros` o `Gestionar servidor` | Suma a `@U` a la patrulla activa. |
| `/dejar-vigilar usuario:@U` | idem | Quita a `@U`: cancela su votación/permiso y libera su silencio si era del bot. |
| `/policia-finalizar` | `Gestionar servidor` | Termina la patrulla y libera lo que sea seguro liberar. |
| `/policia-estado` | `Silenciar miembros` o `Gestionar servidor` | Estado completo (respuesta privada). |
| `/pedir-palabra` | cualquiera (debe estar vigilado) | Abre una votación. |

Quien tiene el permiso global de Administrador pasa todas las verificaciones, pero el bot **no exige ni usa** ese permiso. La verificación en tiempo de ejecución es la autoritativa; además los comandos se registran con permisos por defecto para ocultarlos a quien no corresponde (el dueño del servidor puede ajustarlo en *Ajustes → Integraciones*).

### Iniciar una patrulla
`/policia-iniciar usuario:@Lucas`. Si Lucas está en voz se lo silencia al instante; si no, se silenciará cuando entre a cualquier canal. La patrulla **no termina sola** (ni siquiera si Lucas se va): solo con `/policia-finalizar`.

### Agregar vigilados
`/vigilar usuario:@Otra`. Si ya estaba vigilada, el bot lo informa. No altera votaciones ni permisos de otros.

### Solicitar palabra
Un vigilado conectado a voz ejecuta `/pedir-palabra`. El bot publica:

```
🚨 POLICÍA DISCORD — PERMISO PARA HABLAR
👤 Solicitante: @Lucas
🔊 Canal: General
👥 Participantes: 6
🗳️ Votantes habilitados: 5
✅ Votos necesarios para aprobar: 3
¿Autorizan a @Lucas a hablar durante 2 minutos?
✅ A favor
❌ En contra
```

Reglas de votación:

- Votan **solo** quienes estaban en el mismo canal de voz **al crear** la solicitud (padrón fijo). Se excluyen al solicitante y a todos los bots. Entrar después al canal no da voto.
- Mayoría: `floor(votantes / 2) + 1`. Se **aprueba al instante** al alcanzarla y se **rechaza** cuando los votos en contra la vuelven imposible.
- Cada persona tiene un único voto, que puede cambiar o retirar quitando/cambiando su reacción. Las reacciones se releen del mensaje en cada cambio, por lo que no hay conteos duplicados.
- **Reacción doble (✅ y ❌): cuenta como ❌** (opción conservadora) hasta que retire una.
- Reacciones de externos al padrón y del propio bot se ignoran.
- Sin votantes habilitados (solo el solicitante y/o bots): **no se inicia** la votación y no se concede nada.
- Las votaciones **no vencen por tiempo** (versión 1). Se cancelan si el solicitante sale/cambia de canal, si lo dejan de vigilar, si termina la patrulla, si borran el mensaje o si el bot se reinicia.
- Puede haber varias votaciones simultáneas (de distintos vigilados) completamente independientes.

Si se aprueba: el bot hace *server unmute*, confirma que Discord lo aceptó, inicia el permiso (por defecto 120 s, con vencimiento absoluto) y edita el mensaje. Al vencer vuelve a silenciar. Si Discord rechaza el desmuteo, **no se considera concedido** y se informa el error. Si el vigilado sale del canal o cambia de canal, el permiso se cancela y se re-silencia.

### Terminar una patrulla
`/policia-finalizar`. Cancela votaciones y permisos, deja de vigilar a todos y levanta los silencios que el bot hubiera aplicado (ver sección 8). Desde ese momento el bot no silencia a nadie.

## 7. Operar el proceso

- **Arrancar:** `npm start`. Al conectar, el bot recupera el estado guardado (sección 9).
- **Detener:** `Ctrl+C` en la terminal (cierre ordenado). **Detener el proceso no finaliza la patrulla**: los silencios ya aplicados quedan en Discord y la patrulla sigue registrada.
- **Reiniciar:** volver a ejecutar `npm start`. Para evitar dos instancias, el bot crea `data/bot.lock`; si ve otra instancia viva, se niega a arrancar. Si el proceso murió de golpe, el lock huérfano se detecta y se limpia solo.
- Mientras el bot está apagado **no vigila**: los vigilados pueden hablar. Al volver a arrancar se re-silencia a los que estén conectados.
- El estado vive en `data/state.json` (escritura atómica). Si el archivo está corrupto el bot **se niega a arrancar** en vez de descartarlo en silencio.

## 8. Silencios, moderadores y qué garantiza (y qué no) el bot

El bot **no asume** que todo mute es suyo. Por cada vigilado guarda:

- `preMuted`: si ya estaba silenciado en la primera vez que el bot lo observó **antes de actuar**. Si ya lo estaba, ese silencio se considera de un moderador: **nunca se levanta** (ni al dejar de vigilar, ni al finalizar, ni por votación).
- `botMuted`: si el bot aplicó el mute y sigue vigente. **Solo estos se liberan.**
- Cada cambio de mute que hace el bot se registra como "esperado"; un cambio que llega **sin** haberlo hecho el bot se trata como externo:
  - Un moderador **des-silencia** a un vigilado → el bot lo respeta (no pelea) hasta que la persona se reconecte; el bot deja de considerar suyo ese mute.
  - Un moderador **silencia** a un vigilado → ese mute no se considera del bot.
- Se escribe la intención en disco **antes** de llamar a Discord, para resolver cortes a mitad de operación tras un reinicio.

Casos en que **Discord no permite saber con certeza quién aplicó un mute** (por eso se prioriza la seguridad):

1. La API solo informa *si* alguien está silenciado, no *quién* lo hizo. Solo se distingue por lo que el bot observó y recordó. (El registro de auditoría lo indicaría, pero el bot no lo usa para no pedir permisos extra.)
2. Si un moderador silencia manualmente a alguien que el bot **ya había silenciado**, no hay forma de notarlo: al liberar, el bot levantará ese silencio.
3. Si el estado se pierde (se borra `state.json`) o el bot se corta justo mientras la persona estaba fuera de voz, el bot no puede saber qué silencios eran suyos → **intervención manual**.
4. Discord **no permite cambiar el mute de alguien que no está en voz**. Si al finalizar un vigilado con silencio del bot está desconectado, el silencio queda en una lista persistente de *liberaciones pendientes* y se levanta cuando esa persona vuelva a conectarse (solo si sigue silenciada y no hubo un cambio externo). Pasados 7 días se descarta con una advertencia en el log.
5. Un vigilado silenciado por un moderador no puede pedir palabra: el bot no levanta por votación un silencio que no es suyo.

## 9. Persistencia, reinicios y recuperación

Se persiste en `data/state.json`: patrulla activa, inicio, quién la inició, vigilados (con su estado de mute), votaciones abiertas, permisos con su **vencimiento absoluto**, liberaciones pendientes y la última patrulla. Se eligió JSON atómico (archivo temporal + rename) en lugar de SQLite: el estado es pequeño, no agrega dependencias ni módulos experimentales y es legible a mano.

Al arrancar:

- Se recupera la patrulla y los vigilados, y se revisan los usuarios conectados (se re-silencia a quien corresponda).
- Los permisos conservan su vencimiento original (**no se renuevan**); los ya vencidos se cierran y re-silencian; los de quien cambió de canal/salió mientras el bot estaba apagado se cancelan.
- Las **votaciones abiertas se cancelan** y se avisa en el canal (los votos podrían haberse perdido).
- Una patrulla finalizada queda guardada como inactiva **antes** de liberar silencios: no puede reactivarse por un corte a mitad de la finalización.

### Si el proceso se apaga definitivamente sin `/policia-finalizar`

1. Volvé a arrancar el bot con el mismo `data/state.json`: recupera la patrulla. Ejecutá `/policia-finalizar` para liberar los silencios propios.
2. Si el bot no puede volver a correr (o perdiste `state.json`): los server mutes siguen aplicados. Un moderador debe quitarlos a mano (clic derecho al usuario → quitar *Silenciar en el servidor*), **solo si ese silencio fue puesto por el bot**. Con el usuario fuera de voz no se puede quitar hasta que se conecte.
3. Revisá el log del bot: cada silencio/desilencio queda registrado.

## 10. Limitaciones conocidas

- Sin vencimiento de votaciones (diseño de la v1).
- El mute de servidor solo se puede cambiar con el usuario **en voz**.
- El bot depende de la caché de estados de voz que llena el gateway; tras un reinicio solo ve a quienes Discord informó como conectados.
- Los votos se leen de reacciones: si el bot pierde la conexión y Discord no reenvía eventos, el siguiente cambio de reacción resincroniza el recuento (se relee todo el mensaje cada vez).
- Un solo servidor (`GUILD_ID`) y una sola patrulla a la vez.
- Los eventos propios se reconocen con una ventana de 15 s: un cambio manual de un moderador que coincida exactamente con una acción del bot podría confundirse con la del bot.
- Todo se ejecuta en serie (un mutex): bajo carga extrema o con la API de Discord lenta, las acciones se encolan.
- **No probado todavía en Discord real.**

## 11. Resolución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| `Configuración inválida: …` al arrancar | Falta o es inválida una variable de `.env`. |
| `Ya hay otra instancia del bot en ejecución` | Hay otro `npm start` vivo. Cerralo. Si no hay ninguno, borrá `data/bot.lock`. |
| `El archivo de estado … está corrupto` | Revisá/restaurá `data/state.json`. Si lo borrás, leé la sección 9 (se pierde el rastro de silencios propios). |
| Los comandos no aparecen | Corré `npm run register`; verificá `CLIENT_ID`/`GUILD_ID` y que invitaste el bot con `applications.commands`. |
| "El bot no tiene permiso para silenciar…" | Falta *Silenciar miembros*, un permiso del canal de voz lo deniega, o el rol del bot está por debajo del usuario. |
| La votación no tiene reacciones | Faltan *Añadir reacciones*/*Leer historial* en el canal de votaciones; agregá ✅ y ❌ a mano. |
| "No pude publicar la votación" | El bot no ve o no puede escribir en `VOTING_CHANNEL_ID`. |
| Un usuario vigilado habla | ¿El bot está apagado? ¿Un moderador lo des-silenció (`/policia-estado` lo indica)? ¿Estaba silenciado antes por un moderador? |
| Un usuario sigue silenciado tras finalizar | Estaba fuera de voz: se libera al conectarse (aparece en `/policia-estado`/anuncio). Si no, intervención manual. |
| `/pedir-palabra` dice que no hay votantes | Solo hay bots y/o el solicitante en su canal de voz. |

## 12. Estructura del proyecto

```
src/
  index.js                 entrada: conecta cliente, handlers y servicio
  register-commands.js     registra slash commands en el servidor
  config.js  logger.js  messages.js
  core/                    lógica pura, sin dependencia directa de discord.js
    service.js             fachada con mutex: patrullas, vigilados, votos, permisos, voz, recuperación
    muteManager.js         propiedad de mutes, eventos propios vs. externos, liberación
    votingManager.js  voting.js   votaciones y reglas (mayoría, padrón, recuento)
    permitManager.js       permisos con vencimiento absoluto
    mutex.js  context.js  errors.js
  discord/                 adaptadores a discord.js
    adapter.js  commands.js  commandRunner.js  handlers.js
  storage/
    jsonStore.js  state.js persistencia atómica + lock de proceso
test/                      98 tests con Discord y reloj simulados (node:test)
```
