# Operación

Guía para operar el bot: iniciarlo, detenerlo, reiniciarlo, entender qué pasa ante fallos y recuperar silencios. Para el diseño interno ver [ARQUITECTURA.md](ARQUITECTURA.md); para desplegar en la nube, [DESPLIEGUE.md](DESPLIEGUE.md).

## Arrancar, detener y reiniciar

- **Arrancar:** `npm start`. Al conectar, el bot recupera el estado guardado y deja un resumen en el log.
- **Detener:** `Ctrl+C` (o `SIGTERM`) hace un cierre ordenado. El estado ya está en disco en todo momento. **Detener el proceso no cancela las vigilancias**: siguen registradas con su vencimiento y los silencios ya aplicados quedan en Discord.
- **Reiniciar:** volver a ejecutar `npm start`.
- **Una sola instancia:** el bot crea `bot.lock` (con su pid) dentro de `DATA_DIR`. Si detecta otra instancia viva se niega a arrancar; un lock huérfano de un proceso muerto se limpia solo.
- Mientras el bot está apagado **no vigila**: los vigilados pueden hablar. Al volver, re-silencia a los que estén conectados.

## Qué pasa en un reinicio

| Elemento | Comportamiento |
|---|---|
| Vigilancias activas | Se recuperan; se revisa quién está conectado y se re-silencia a quien corresponda. |
| Permisos vigentes | Conservan su **vencimiento original** (no se renuevan). |
| Permisos vencidos con el bot apagado | Se cierran y se vuelve a silenciar. |
| Permisos de quien salió o cambió de canal | Se cancelan. |
| Votaciones abiertas (palabra, vigilar, dejar de vigilar) | **Se cancelan** y se avisa en el canal; hay que volver a solicitarlas. Ninguna acción se ejecuta por una votación interrumpida. |
| Vigilancias (castigos) vigentes | Conservan su **vencimiento original** y sus contadores de reconexión; no se reinician los minutos. |
| Vigilancias vencidas con el bot apagado | Se regularizan al volver: dejan de figurar vigiladas, se libera el mute propio (si es seguro, o queda pendiente) y se publica que cumplió su castigo. |
| Aislamientos | Se conservan para seguimiento con su vencimiento original; **nunca se reaplican ni se extienden**. Los vencidos se descartan. |
| Racha de reincidencia | Se conserva (se guarda en `state.json`). |
| Vigilancia terminada | No se reactiva. |

## Migración del estado desde la versión con "patrulla"

Si `state.json` está en el formato anterior (v1), al arrancar el bot **primero copia el archivo original** (`state.json.v1-backup-<fecha>`, junto al original) y luego migra a v2; si no puede copiarlo, no migra y no arranca. Reglas conservadoras:

- Las vigilancias con castigo vigente se conservan con su vencimiento absoluto, racha y contadores; las ya vencidas se regularizan al arrancar.
- Las vigilancias antiguas sin vencimiento no existen en el modelo nuevo: se cierran, y si el bot las había silenciado, el silencio queda como *liberación pendiente* (nada se descarta en silencio).
- Racha, aislamientos, liberaciones pendientes y permisos se conservan; las votaciones abiertas se cancelan con aviso (como en cualquier reinicio).
- Se publica **un solo aviso** con el detalle. Para volver atrás, detené el bot, restaurá el respaldo como `state.json` y usá la versión anterior del código.

## Archivo de estado

`state.json` en `DATA_DIR` (por defecto `./data`). Se escribe de forma atómica. Si está corrupto o es incompatible, el bot **no arranca** y muestra el motivo: revisalo o restauralo a mano. Si lo borrás, el bot pierde el rastro de qué silencios eran suyos (ver más abajo). Es un archivo sensible: no lo subas a Git (ya está en `.gitignore`).

## Recuperar silencios

**Caso normal.** Cuando una vigilancia termina (vence o se finaliza por votación) el bot libera sola el silencio que aplicó. Si el usuario estaba desconectado, la vigilancia igual deja de figurar como activa y el silencio queda en *liberaciones pendientes* (se ven en `/policia-estado`), que se levantan al conectarse, solo si sigue silenciado. Pasados 7 días se descarta con una advertencia en el log.

**El proceso murió.**
1. Volvé a arrancar el bot **con el mismo `state.json`**: regulariza las vigilancias vencidas durante la caída y libera sus silencios propios.
2. Si querés liberar a alguien antes de tiempo, usá `/dejar-vigilar` (con votación).

**No se puede volver a correr el bot, o se perdió `state.json`.** Los server mutes siguen aplicados en Discord y el bot ya no sabe cuáles eran suyos. Un moderador debe quitarlos a mano (clic derecho al usuario → desmarcar *Silenciar en el servidor*), **solo si ese silencio lo puso el bot**; revisá el log del bot (cada `setMute` queda registrado). Con el usuario fuera de voz no se puede quitar hasta que se conecte.

**Estado incierto.** Si `/policia-estado` marca "estado de mute incierto tras un reinicio", el bot no reclamó ese mute: decidí manualmente si corresponde quitarlo.

## Comportamiento ante fallos

- **Falla `setMute` al silenciar:** se informa el error, el vigilado queda marcado "pendiente de re-silenciar" y el barrido lo reintenta cada 5 s (hasta 10 veces; luego avisa para intervención manual).
- **Discord rechaza el desmuteo de una votación aprobada:** el permiso **no** se concede y se informa el error.
- **No se puede aplicar el aislamiento** (dueño, Administrador, rol por encima del bot, falta *Aislar temporalmente a miembros*, error de Discord, o ya hay un timeout de otro moderador): se publica el motivo, el aislamiento **no** se considera aplicado y el castigo original continúa hasta vencer. No se reintenta (una vez por castigo).
- **Falla el re-mute al vencer un permiso:** el permiso se cierra igual (nunca queda indefinido), se avisa y se reintenta.
- **Falla la liberación al terminar una vigilancia:** la vigilancia igual termina; el silencio queda pendiente y se avisa para revisión manual.
- **No se puede publicar en el canal de votaciones:** no se crea la solicitud y se informa; los demás anuncios fallan sin romper el estado.
- **Se borra el mensaje de una votación:** la solicitud se cancela y se avisa. Es también la forma de descartar una votación pendiente que nadie vota (no vencen por tiempo).
- **Una votación aprobada ya no es válida al ejecutarse** (la vigilancia ya terminó, el usuario ya no está en el canal, etc.): se cancela con el motivo y no se ejecuta nada.
- **Falla escribir en disco:** el comando falla con un mensaje genérico (el detalle va al log).
- **Un moderador cambia mutes a mano:** el bot no pelea ni revierte sus cambios (ver [ARQUITECTURA.md](ARQUITECTURA.md)); un des-silencio manual se respeta hasta que la persona se reconecte.

## Resolución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| `Configuración inválida: …` al arrancar | Falta o es inválida una variable de entorno; el mensaje indica cuál. |
| `Ya hay otra instancia del bot en ejecución` | Hay otro proceso vivo con el mismo `DATA_DIR`. Cerralo; si no existe, borrá `bot.lock`. |
| `El archivo de estado … está corrupto` | Revisá o restaurá `state.json`. |
| Los comandos no aparecen | Ejecutá `npm run register`; verificá `CLIENT_ID`/`GUILD_ID` y que el bot se invitó con `applications.commands`. |
| "El bot no tiene permiso para silenciar…" | Falta *Silenciar miembros*, un permiso del canal de voz lo deniega, o el rol del bot está por debajo del usuario. |
| La votación no tiene reacciones | Faltan *Añadir reacciones* o *Leer historial* en el canal de votaciones; agregá ✅ y ❌ a mano. |
| "No pude publicar la votación" | El bot no ve o no puede escribir en `VOTING_CHANNEL_ID`. |
| Un vigilado habla | ¿Bot apagado? ¿Un moderador lo des-silenció (`/policia-estado` lo indica)? ¿Estaba silenciado antes por un moderador? ¿Tiene un permiso vigente? |
| Sigue silenciado tras terminar su vigilancia | Estaba fuera de voz: se libera al conectarse. Si no, intervención manual. |
| "El bot no pudo aislar…" (anuncio) | Ver el motivo del anuncio: subí el rol del bot por encima del usuario, otorgale *Aislar temporalmente a miembros*; al dueño y a los Administradores Discord no los deja aislar. |
| Un castigado sigue silenciado después de vencer | Estaba desconectado: se libera al conectarse (aparece como liberación pendiente). Si tenía un mute previo de un moderador, el bot no lo toca. |
| Un comando de votación dice que no hay votantes | En el canal del afectado solo hay bots y/o él mismo. Una vigilancia así no se puede terminar por votación, pero vence sola. |
| "no está conectado a un canal de voz" al usar `/vigilar` o `/dejar-vigilar` | Esas votaciones exigen que el afectado esté en voz. |
| "Ese usuario ya está cumpliendo una vigilancia" | Tiene un castigo vigente. Esperá a que venza o pedí `/dejar-vigilar`. Una vez vencido se puede volver a vigilar sin bloqueos. |
| Siguen apareciendo `/policia-iniciar` o `/policia-finalizar` en Discord | Ya no existen en el código. Ejecutá `npm run register`: reemplaza los comandos del servidor y lista los que quitó. |
| "Ya hay una votación pendiente…" | Hay una solicitud duplicada para ese usuario. Esperá su resultado o borrá su mensaje para cancelarla. |
| `/pedir-palabra` dice que está silenciado por un moderador | Por seguridad el bot no levanta por votación un silencio que no aplicó. |
| Errores de `rename`/`EPERM` al guardar | Carpeta sincronizada (OneDrive, Dropbox): poné `DATA_DIR` fuera de ella. |

## Limitaciones operativas

- Un servidor a la vez; una única instancia del bot.
- Las votaciones no vencen por tiempo y se cancelan en cada reinicio. Una vigilancia cuyo usuario está solo (o desconectado) no puede terminarse por votación, pero vence sola.
- Las acciones se ejecutan en serie: con la API de Discord lenta se encolan.
- Si se pierden eventos del gateway, el recuento de votos se resincroniza en el siguiente cambio de reacción (no hay relectura periódica).
- Las pruebas funcionales completas en un servidor real siguen pendientes.
