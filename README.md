# 🚔 Policía Discord

Bot de Discord que silencia en voz, de forma temporal y **por votación**, a quien el resto del canal decide castigar.

> **Una vigilancia es un castigo temporal que comienza con una votación aprobada y termina automáticamente cuando vence su duración.**

- No hay "patrullas" ni modos que activar: cualquier moderador puede pedir `/vigilar @usuario` en cualquier momento.
- Los usuarios humanos del mismo canal de voz votan con ✅/❌. **Nada se aplica hasta que la votación se aprueba por mayoría absoluta.**
- Si se aprueba, el usuario queda con *server mute* durante **2 minutos**. La duración se **duplica** por cada castigo consecutivo a la misma persona (2, 4, 8, 16, 32…, con tope).
- Al vencer, la vigilancia se cierra sola: sin votación ni comandos. El bot libera únicamente el silencio que **él** aplicó, sin pisar los de los moderadores.
- Un vigilado puede pedir la palabra con `/pedir-palabra` (votación; **120 s** de permiso, sin extender el castigo).
- Si un castigado se desconecta y vuelve **2 veces** durante su castigo, el bot lo **aísla 5 minutos** con el *timeout* nativo de Discord.

> **Estado de las pruebas:** hay 196 tests automatizados con Discord simulado. El registro de comandos y la conexión a Discord ya fueron verificados; **las pruebas funcionales completas en un servidor real siguen pendientes**. Hasta entonces, considerá el bot como no probado en producción.

## Requisitos

- **Node.js ≥ 20** (desarrollado y probado con 24.22.1; las dependencias exigen ≥ 18; `npm test` usa patrones de archivos que requieren Node ≥ 21).
- **discord.js 14.27** y **dotenv 18** (instalados con `npm install`; no hay otras dependencias).
- Una aplicación de Discord con un bot.

## Instalación rápida

```bash
npm install
cp .env.example .env      # en Windows (cmd): copy .env.example .env
npm run register          # registra los slash commands (y elimina los que ya no existen)
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
| `SPEAK_DURATION_SECONDS` | no (120) | Duración del permiso de palabra tras una votación aprobada (5–3600). |
| `BASE_PUNISHMENT_SECONDS` | no (120) | Duración del primer castigo de una racha (5–2.592.000). |
| `MAX_PUNISHMENT_SECONDS` | no (86400 = 24 h) | **Tope** de la duración exponencial; no puede ser menor que la base. |
| `ISOLATION_DURATION_SECONDS` | no (300) | Duración del aislamiento (timeout) por reconexiones (10–2.419.200; máx. de Discord: 28 días). |
| `DATA_DIR` | no (`./data`) | Carpeta del estado persistente. |
| `LOG_LEVEL` | no (`info`) | `debug`, `info`, `warn` o `error`. |

`.env` y `data/` están excluidos de Git y el bot nunca imprime el token.

## Configurar Discord

1. En el [Developer Portal](https://discord.com/developers/applications) creá una aplicación y copiá el **Application ID** (`CLIENT_ID`).
2. En **Bot**: *Reset Token* → `DISCORD_TOKEN`. Dejá **apagados** todos los *Privileged Gateway Intents* (el bot no los necesita; usa `Guilds`, `GuildVoiceStates`, `GuildMessages` sin leer contenido, y `GuildMessageReactions`).
3. Con el *Modo desarrollador* activo, copiá el ID del servidor (`GUILD_ID`) y del canal de votaciones (`VOTING_CHANNEL_ID`).
4. Invitá el bot (reemplazá `TU_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=TU_CLIENT_ID&scope=bot%20applications.commands&permissions=1099515890752
```

Ese entero equivale a **Ver canales, Enviar mensajes, Añadir reacciones, Leer historial, Silenciar miembros y Aislar temporalmente a miembros** (este último solo para el aislamiento). No pide Administrador y no necesita unirse a canales de voz. Para aislar, el rol del bot debe estar **por encima** del rol más alto del usuario; Discord no permite aislar al dueño del servidor ni a quien tenga Administrador. Verificá que ningún canal de voz le deniegue *Silenciar miembros*.

## Comandos

| Comando | Quién puede usarlo | Qué hace |
|---|---|---|
| `/vigilar usuario:@U` | `Silenciar miembros` o `Gestionar servidor` | Solicita una vigilancia (castigo) sobre `@U`. `@U` debe estar en voz y no tener una vigilancia vigente. **Publica una votación**; si se aprueba, `@U` queda silenciado y comienza el castigo. |
| `/dejar-vigilar usuario:@U` | idem | Solicita **terminar antes de tiempo** la vigilancia de `@U`. Votación; si se aprueba, se libera su silencio (solo si era del bot). Si se rechaza, sigue castigado. |
| `/policia-estado` | idem | Muestra las vigilancias activas con sus vencimientos, las votaciones pendientes, los permisos, la racha y los aislamientos (respuesta privada). |
| `/pedir-palabra` | cualquier vigilado en voz | Pide autorización para hablar (votan los demás humanos de su canal). |

Los comandos anteriores `/policia-iniciar` y `/policia-finalizar` **ya no existen**: no hay una patrulla general que iniciar o finalizar. `npm run register` los elimina de Discord. Los anuncios y las votaciones se publican sin notificar (sin ping); las respuestas a quien ejecuta son privadas.

## Ejemplo de uso

1. `/vigilar usuario:@Lucas` (Lucas debe estar en voz con otras personas). El bot publica en el canal de votaciones:

```
🚨 POLICÍA DISCORD — VOTACIÓN: INICIAR VIGILANCIA
🛡️ Solicitada por: @Mod
👤 Usuario afectado: @Lucas
🔊 Canal: General
🗳️ Votantes habilitados: 5
✅ Votos necesarios para aprobar: 3
¿Aprueban castigar a @Lucas durante 2 minutos? Es su primer castigo de la racha (sin reincidencia consecutiva).
✅ A favor
❌ En contra
```

2. Al llegar a 3 votos ✅, Lucas queda silenciado y el mensaje muestra la **duración finalmente aplicada**. A los 2 minutos, el bot lo libera solo y avisa que cumplió su castigo.
3. Después de vencer se puede volver a vigilar a Lucas (o a cualquiera) sin ningún bloqueo; si es Lucas otra vez de forma consecutiva, durará 4 minutos.
4. Mientras está castigado, Lucas puede ejecutar `/pedir-palabra`: si los demás aprueban, habla 120 s; el castigo igual vence a su hora.

### Reglas de votación (todas las votaciones)

- Votan solo quienes estaban en el padrón **al crear la solicitud** (padrón fijo): los humanos del canal de voz del afectado, sin él ni los bots.
- Mayoría `floor(votantes / 2) + 1` **sobre el total de habilitados, no sobre quienes votaron**: se aprueba al instante al alcanzarla y se rechaza cuando ya es imposible alcanzarla.
- Un voto por persona, que puede cambiar o retirar. **Reaccionar con ✅ y ❌ a la vez cuenta como ❌.**
- Sin votantes habilitados no se crea la votación ni se aprueba nada. Las votaciones no vencen por tiempo.
- No hay bloqueos globales: votaciones de distintas personas coexisten. Solo se rechaza una solicitud duplicada para el mismo usuario. Para cancelar una votación pendiente, borrá su mensaje.
- Se cancelan si el afectado sale o cambia de canal, si su vigilancia termina, si borran el mensaje o si el bot se reinicia.

## Castigos temporales

- **Duración:** `BASE_PUNISHMENT_SECONDS` (2 minutos) × 2 por cada castigo *consecutivo* a la misma persona, con tope `MAX_PUNISHMENT_SECONDS` (24 h por defecto). El vencimiento es un **timestamp absoluto**: no se reinicia al salir de voz ni al reiniciar el bot.
- **"Consecutivo"** depende solo del **orden global** de castigos aprobados en el servidor: *Lucas 2, Lucas 4, Pedro 2, Lucas 2, Lucas 4*. No cuentan ni interrumpen la racha las votaciones rechazadas o pendientes, los permisos de palabra, los vencimientos, las desconexiones, los aislamientos, los fines anticipados ni los reinicios (la racha se guarda en disco).
- **Aislamiento por reconexiones:** si durante **un mismo castigo** el usuario completa **2 ciclos de salida y regreso** a voz (a cualquier canal), el bot le aplica un *timeout* de `ISOLATION_DURATION_SECONDS` (5 minutos). No cuentan el ingreso inicial, los cambios de canal, los cambios de mute/ensordecimiento ni los eventos repetidos, ni los regresos posteriores al vencimiento. El castigo original **termina** (no se suman minutos), la racha se conserva y se publica el motivo. Se intenta **una sola vez por castigo**.
- **Protecciones:** nunca se sobrescribe ni se acorta un timeout de otro moderador. Si el timeout no puede aplicarse (dueño, Administrador, jerarquía de roles, falta de permiso o error de Discord), se informa el motivo, **no** se considera aplicado y la vigilancia original continúa hasta vencer.

## Seguridad y limitaciones conocidas

- Discord **no informa quién aplicó un mute**: el bot solo libera los que él observó y recordó. Si un moderador silencia a mano a alguien que el bot ya había silenciado, el bot no puede notarlo.
- Un vigilado **ya silenciado por un moderador** no se des-silencia nunca y no puede pedir palabra.
- Discord **no permite cambiar el mute de alguien que no está en voz**: si una vigilancia termina con el usuario desconectado, deja de figurar vigilado y el silencio queda como *liberación pendiente* hasta que se conecte (se descarta a los 7 días con una advertencia).
- Votar `/dejar-vigilar` o `/vigilar` exige que el afectado esté en voz con otras personas; si no hay votantes, no se puede votar (el castigo igual vence solo).
- Detener el proceso **no cancela las vigilancias**; con el bot apagado nadie se vigila, y al volver se regularizan. Las votaciones abiertas se cancelan en cada reinicio.
- Un solo servidor a la vez y **una única instancia** del bot.
- Mantené `DISCORD_TOKEN` fuera del repositorio; si se expone, regeneralo (*Reset Token*).

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md): modelo de vigilancias, racha, mutes, persistencia, migración y recuperación.
- [`docs/OPERACION.md`](docs/OPERACION.md): detener/reiniciar, migración, fallos, recuperar silencios y resolución de problemas.
- [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md): despliegue en Railway desde GitHub.
