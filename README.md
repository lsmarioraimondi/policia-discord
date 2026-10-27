# 🚔 Policía Discord

Bot de Discord que funciona como un **policía de voz por patrullas**: una patrulla se inicia, se modifica y se termina **por votación**; los usuarios vigilados quedan con *server mute* y solo pueden hablar si **los demás integrantes de su canal de voz lo aprueban por votación**.

- Sin patrulla activa, el bot **no vigila ni silencia a nadie**.
- Un administrador *propone* iniciar la patrulla con `@usuario`; los usuarios conectados al mismo canal votan con ✅/❌. Lo mismo ocurre para sumar vigilados, dejar de vigilar y finalizar la patrulla: **nada cambia hasta que la votación se aprueba**.
- Un vigilado pide la palabra con `/pedir-palabra`; si la mayoría vota a favor obtiene **120 segundos** (configurable) para hablar.
- Al finalizar, el bot libera únicamente los silencios que **él** aplicó. No pisa los de los moderadores.

> **Estado de las pruebas:** hay 140 tests automatizados con Discord simulado. El registro de comandos y la conexión a Discord ya fueron verificados; **las pruebas funcionales completas en un servidor real siguen pendientes**. Hasta entonces, considerá el bot como no probado en producción.

## Requisitos

- **Node.js ≥ 20** (desarrollado y probado con 24.22.1; las dependencias exigen ≥ 18; `npm test` usa patrones de archivos que requieren Node ≥ 21).
- **discord.js 14.27** y **dotenv 18** (instalados con `npm install`; no hay otras dependencias).
- Una aplicación de Discord con un bot.

## Instalación rápida

```bash
npm install
cp .env.example .env      # en Windows (cmd): copy .env.example .env
npm run register          # registra los slash commands en tu servidor
npm start                 # arranca el bot
npm test                  # tests automatizados (no usan Discord real)
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DISCORD_TOKEN` | sí | Token del bot. **Secreto**: nunca lo subas a Git ni lo compartas. |
| `CLIENT_ID` | sí | Application ID de la aplicación. |
| `GUILD_ID` | sí | Servidor donde opera el bot (ignora cualquier otro). |
| `VOTING_CHANNEL_ID` | sí | Canal de texto para anuncios y votaciones. |
| `SPEAK_DURATION_SECONDS` | no (120) | Duración del permiso tras una votación aprobada (5–3600). |
| `DATA_DIR` | no (`./data`) | Carpeta del estado persistente. |
| `LOG_LEVEL` | no (`info`) | `debug`, `info`, `warn` o `error`. |

`.env` y `data/` están excluidos de Git y el bot nunca imprime el token.

## Configurar Discord

1. En el [Developer Portal](https://discord.com/developers/applications) creá una aplicación y copiá el **Application ID** (`CLIENT_ID`).
2. En **Bot**: *Reset Token* → `DISCORD_TOKEN`. Dejá **apagados** todos los *Privileged Gateway Intents* (el bot no los necesita; usa `Guilds`, `GuildVoiceStates`, `GuildMessages` sin leer contenido, y `GuildMessageReactions`).
3. Con el *Modo desarrollador* activo, copiá el ID del servidor (`GUILD_ID`) y del canal de votaciones (`VOTING_CHANNEL_ID`).
4. Invitá el bot (reemplazá `TU_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=TU_CLIENT_ID&scope=bot%20applications.commands&permissions=4262976
```

Ese entero equivale a **Ver canales, Enviar mensajes, Añadir reacciones, Leer historial y Silenciar miembros**. No pide Administrador y no necesita unirse a canales de voz. Verificá que ningún canal de voz le deniegue *Silenciar miembros* y, si Discord devuelve un error de permisos, que el rol del bot esté por encima de los usuarios a vigilar.

## Comandos

Quien ejecuta un comando administrativo solo **publica una votación** en `VOTING_CHANNEL_ID`. La acción se ejecuta únicamente si la votación se aprueba.

| Comando | Quién puede solicitarlo | Votación (tipo) y padrón |
|---|---|---|
| `/policia-iniciar usuario:@U` | `Gestionar servidor` | `START_PATROL`: humanos del canal de voz de `@U`, sin `@U` ni bots. Si se aprueba: inicia la patrulla, vigila a `@U` y lo silencia. |
| `/vigilar usuario:@U` | `Silenciar miembros` o `Gestionar servidor` | `ADD_WATCH`: igual que arriba. Si se aprueba, `@U` se incorpora. |
| `/dejar-vigilar usuario:@U` | idem | `REMOVE_WATCH`: igual. Si se aprueba, deja de vigilarse y se libera su silencio **solo si era del bot**; si se rechaza, sigue vigilado. |
| `/policia-finalizar` | `Gestionar servidor` | `END_PATROL`: unión de los humanos **no vigilados** que comparten canal con algún vigilado (cada persona vota una vez). Si se aprueba: finalización completa. |
| `/policia-estado` | `Silenciar miembros` o `Gestionar servidor` | Sin votación. Vigilados, canales, mutes, votaciones pendientes (con su tipo) y permisos (respuesta privada). |
| `/pedir-palabra` | cualquier vigilado en voz | `SPEAK_PERMISSION`: canal del solicitante, sin él ni bots. Si se aprueba: 120 s para hablar. |

Los anuncios y las votaciones se publican sin notificar (sin ping); las respuestas a quien ejecuta son privadas. Si cambiás las descripciones de los comandos, volvé a ejecutar `npm run register`.

## Ejemplo de uso

1. `/policia-iniciar usuario:@Lucas` (Lucas debe estar en voz con otras personas) → se publica la votación; al alcanzar la mayoría se inicia la patrulla y Lucas queda silenciado. La patrulla no termina sola, ni siquiera si Lucas se va del canal.
2. `/vigilar usuario:@Ana` → otra votación entre quienes están con Ana; recién al aprobarse Ana se suma, sin alterar votaciones ni permisos ajenos.
3. Lucas ejecuta `/pedir-palabra` y el bot publica:

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

4. Al llegar a 3 votos ✅ el bot lo des-silencia al instante; a los 2 minutos vuelve a silenciarlo.
5. `/policia-finalizar` → votación `END_PATROL`; si se aprueba, la patrulla termina y desde ahí el bot no silencia a nadie.

### Reglas de votación

- Votan solo quienes estaban en el padrón **al crear la solicitud** (padrón fijo; ver la tabla de comandos). Nunca votan el afectado/solicitante ni los bots.
- Mayoría `floor(votantes / 2) + 1` **sobre el total de habilitados, no sobre quienes votaron**: se aprueba al instante al alcanzarla y se rechaza cuando ya es imposible alcanzarla.
- Un voto por persona, que puede cambiar o retirar. **Reaccionar con ✅ y ❌ a la vez cuenta como ❌.**
- Sin votantes habilitados no se inicia la votación ni se aprueba nada. Las votaciones no vencen por tiempo.
- Las votaciones sobre un usuario (iniciar/vigilar/dejar de vigilar) exigen que esté **conectado a voz**.
- Se rechazan las solicitudes duplicadas o contradictorias: una sola `START_PATROL`; una sola `ADD/REMOVE_WATCH` por usuario; `END_PATROL` no coexiste con `ADD/REMOVE_WATCH` pendientes. Las de palabra coexisten con todas. Para cancelar una votación pendiente, borrá su mensaje.
- Salir o cambiar de canal el usuario afectado, dejar de ser vigilado, borrar el mensaje, finalizar la patrulla o reiniciar el bot cancelan la votación (y el permiso).

## Seguridad y limitaciones conocidas

- Discord **no informa quién aplicó un mute**: el bot solo libera los que él observó y recordó. Si un moderador silencia a mano a alguien que el bot ya había silenciado, el bot no puede notarlo.
- Un vigilado **ya silenciado por un moderador** no se des-silencia nunca y no puede pedir palabra.
- Discord **no permite cambiar el mute de alguien que no está en voz**: esos silencios quedan como *liberaciones pendientes* hasta que la persona se conecte (se descartan a los 7 días con una advertencia).
- Detener el proceso **no finaliza la patrulla**; con el bot apagado nadie se vigila. Las votaciones abiertas (de cualquier tipo) se cancelan en cada reinicio.
- Como finalizar o dejar de vigilar exige votantes conectados, **una patrulla cuyos vigilados están solos o desconectados no puede finalizarse hasta que haya votantes** (ver [OPERACION.md](docs/OPERACION.md)).
- Una sola patrulla y un solo servidor a la vez; debe correr **una única instancia** del bot.
- Mantené `DISCORD_TOKEN` fuera del repositorio; si se expone, regeneralo (*Reset Token*).

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md): módulos, propiedad de mutes, persistencia, mutex y recuperación.
- [`docs/OPERACION.md`](docs/OPERACION.md): detener/reiniciar, fallos, recuperar silencios y resolución de problemas.
- [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md): despliegue en Railway desde GitHub.
