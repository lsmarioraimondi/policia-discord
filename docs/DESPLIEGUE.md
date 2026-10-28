# Despliegue en Railway

Instrucciones para ejecutar el bot en [Railway](https://railway.com) desde un repositorio de GitHub. Para el uso del bot ver el [README](../README.md); para fallos y recuperación, [OPERACION.md](OPERACION.md).

> **Estado:** esta guía se redactó a partir de la documentación de Railway; **el despliegue todavía no fue probado**. Verificá cada paso y la interfaz actual de Railway.

## Antes de empezar

- El repositorio en GitHub **no debe contener** `.env`, `data/` ni tokens (están en `.gitignore`). Los secretos se cargan como variables en Railway.
- Si tu token estuvo expuesto en algún momento, regeneralo (Developer Portal → Bot → *Reset Token*).
- Registrá los slash commands **una sola vez** desde tu PC (`npm run register` con tu `.env` local) o con una ejecución puntual; **no** hace falta repetirlo en cada despliegue.
- Node.js: Railway detecta el proyecto Node automáticamente. El proyecto declara `"engines": { "node": ">=20" }` y se desarrolló con Node 24.

## Pasos

1. **Crear el proyecto:** en Railway, *New Project* → *Deploy from GitHub repo* y elegí `policia-discord` (autorizá la app de Railway en GitHub si lo pide) y la rama a desplegar.
2. **Variables de entorno:** en el servicio, pestaña *Variables*, cargá:

   | Variable | Valor |
   |---|---|
   | `DISCORD_TOKEN` | el token del bot |
   | `CLIENT_ID` | Application ID |
   | `GUILD_ID` | ID del servidor |
   | `VOTING_CHANNEL_ID` | ID del canal de votaciones |
   | `SPEAK_DURATION_SECONDS` | `120` (opcional) |
   | `BASE_PUNISHMENT_SECONDS` | `120` (opcional) |
   | `MAX_PUNISHMENT_SECONDS` | `86400` (opcional; tope de 24 h) |
   | `ISOLATION_DURATION_SECONDS` | `300` (opcional) |
   | `DATA_DIR` | `/data` (ver el volumen, abajo) |
   | `LOG_LEVEL` | `info` (opcional) |

3. **Volumen persistente:** el estado (vigilancias activas, racha, aislamientos, permisos y rastro de los silencios propios) vive en `DATA_DIR`. Sin volumen, el sistema de archivos del contenedor se borra en cada despliegue y el bot **lo pierde todo**.
   - Creá el volumen desde la paleta de comandos (`⌘K` / `Ctrl+K`) o con clic derecho en el lienzo del proyecto, y asocialo al servicio.
   - Elegí como *mount path* `/data` y poné `DATA_DIR=/data`. (Si preferís el valor por defecto `./data`, el mount path debe ser `/app/data`, porque los archivos de la aplicación viven en `/app`.)
   - El volumen solo se monta cuando arranca el contenedor: **no está disponible durante el build ni el pre-deploy**.
   - Railway define `RAILWAY_VOLUME_MOUNT_PATH` automáticamente; podés usarlo como valor de `DATA_DIR` (`${{RAILWAY_VOLUME_MOUNT_PATH}}`).
   - Si ves errores de permisos al escribir en el volumen, Railway indica definir `RAILWAY_RUN_UID=0` en el servicio.
4. **Comando de inicio:** el comando por defecto de un proyecto Node es `npm start` (equivale a `node src/index.js`), y suele detectarse solo. Si lo configurás a mano (*Settings* del servicio), usá una de estas opciones:

   - Simple: `npm start`
   - **Recomendada con volumen:**

     ```
     sh -c 'rm -f "$DATA_DIR/bot.lock"; exec node src/index.js'
     ```

     Motivo: el bot guarda un `bot.lock` con su número de proceso dentro de `DATA_DIR`. Si el contenedor muere de golpe, ese archivo queda en el volumen y, en el contenedor nuevo, otro proceso podría tener ese mismo número y el bot se negaría a arrancar creyendo que hay otra instancia (`Ya hay otra instancia…`). Como en Railway tenés **una única instancia**, borrar el lock al arrancar es seguro. `exec` hace que la señal de apagado llegue al bot. Esto desactiva a propósito la protección contra doble instancia, así que **no la uses si pudiera haber dos instancias** compartiendo el volumen (no es posible en Railway con volumen, ver abajo).

   También podés fijarlo en un `railway.json` en la raíz (`"deploy": { "startCommand": "…" }`), que tiene prioridad sobre la configuración del panel.
5. **Desplegar:** Railway construye y arranca el servicio. En *Deployments → View logs* deberías ver `Conectado como …` y `Policía Discord listo.`.

## Actualizar desde una versión con "patrulla" (migración automática)

Si el volumen ya tiene un `state.json` de la versión anterior (con patrulla), **no hay que hacer nada manual en el estado**:

1. Al primer arranque con esta versión, el bot **copia el archivo original** dentro del mismo volumen (`state.json.v1-backup-<fecha>`) y recién entonces migra al formato nuevo. Si no puede respaldar (disco lleno, permisos), no migra y el bot no arranca, con el error en los logs. Guardá una copia del respaldo antes de borrarlo.
2. Las vigilancias con castigo vigente se conservan con su vencimiento original; las antiguas sin vencimiento se cierran y su silencio propio queda pendiente de liberar. El bot publica **una sola vez** un aviso con el detalle en `VOTING_CHANNEL_ID`.
3. Después de desplegar, ejecutá **`npm run register`** desde tu PC (con el mismo `.env` local): reemplaza los comandos del servidor y elimina `/policia-iniciar` y `/policia-finalizar`, que ya no existen. El script informa qué comandos quitó. Hasta que lo ejecutes, esos dos comandos seguirán visibles en Discord pero responden con un error interno inofensivo.
4. No hay variables nuevas respecto de la versión anterior, ni cambios de volumen, comando de inicio o instancias.

## Cambios por los castigos temporales y el aislamiento

- **Variables nuevas** (las tres son opcionales; sin ellas rigen los valores por defecto): `BASE_PUNISHMENT_SECONDS`, `MAX_PUNISHMENT_SECONDS` e `ISOLATION_DURATION_SECONDS`. Agregalas en la pestaña *Variables* del servicio y en tu `.env` local.
- **Permiso nuevo de Discord:** *Aislar temporalmente a miembros* (`ModerateMembers`). Si el bot ya estaba invitado, agregáselo a su rol en *Ajustes del servidor → Roles* (o reinvitalo con la URL del README, que ya lo incluye) y verificá que el rol del bot esté por encima de los usuarios a aislar. Sin este permiso el bot sigue funcionando, solo que no aplica el aislamiento (lo avisa al arrancar y al intentarlo).
- No hay cambios de infraestructura: el volumen, el comando de inicio y la instancia única son los mismos. Los castigos, la racha y los aislamientos se guardan en el mismo `state.json` del volumen, así que **conservarlo es más importante todavía**: sin él se pierde la racha y el seguimiento.
- Los despliegues y reinicios causan una breve caída; los castigos usan timestamps absolutos, por lo que un castigo que venza durante la caída se regulariza al volver el bot (el usuario queda libre con algo de retraso) y los minutos nunca se reinician.

## Una única instancia

El bot debe ejecutarse **en una sola instancia**: no hay coordinación entre instancias, y dos procesos silenciarían/liberarían a la vez y se pisarían el estado.

- **No** aumentes las réplicas. Railway no permite volúmenes con réplicas, y cada servicio admite un solo volumen.
- Al redesplegar un servicio con volumen, Railway evita tener dos despliegues activos sobre el mismo volumen, por lo que hay **una breve caída**. Durante esa caída no se vigila (ver [OPERACION.md](OPERACION.md), sección de reinicios).
- No ejecutes el bot a la vez en Railway y en tu PC con el mismo token y servidor.
- Por defecto, al redesplegar Railway envía `SIGTERM` al despliegue anterior con 0 segundos de gracia antes de `SIGKILL` (configurable con `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). Es aceptable: el bot persiste su estado **antes** de actuar sobre Discord, así que un corte no pierde las vigilancias.
- Si querés que el servicio se reinicie solo tras un fallo, configurá la política de reinicio del servicio (p. ej. `ON_FAILURE` o `ALWAYS` en `railway.json`).

## Después del despliegue

1. Verificá en los logs que no haya advertencias de permisos (*Silenciar miembros*, canal de votaciones).
2. Usá `/policia-estado` para confirmar que responde (con una migración reciente, revisá también el aviso publicado en el canal de votaciones).
3. Seguí con las pruebas funcionales en un servidor de prueba: **siguen pendientes**.
4. Cada `git push` a la rama configurada dispara un redeploy (con su breve caída). Si hay vigilancias activas, conviene esperar a que venzan.

## Backup y datos

El volumen contiene `state.json`. Si lo necesitás, copialo periódicamente: sin ese archivo el bot no sabe qué silencios eran suyos (ver [OPERACION.md](OPERACION.md)). No lo subas a GitHub.
