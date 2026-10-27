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
   | `DATA_DIR` | `/data` (ver el volumen, abajo) |
   | `LOG_LEVEL` | `info` (opcional) |

3. **Volumen persistente:** el estado de la patrulla vive en `DATA_DIR`. Sin volumen, el sistema de archivos del contenedor se borra en cada despliegue y el bot **pierde** la patrulla, los permisos y el rastro de los silencios propios.
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

## Una única instancia

El bot debe ejecutarse **en una sola instancia**: no hay coordinación entre instancias, y dos procesos silenciarían/liberarían a la vez y se pisarían el estado.

- **No** aumentes las réplicas. Railway no permite volúmenes con réplicas, y cada servicio admite un solo volumen.
- Al redesplegar un servicio con volumen, Railway evita tener dos despliegues activos sobre el mismo volumen, por lo que hay **una breve caída**. Durante esa caída no se vigila (ver [OPERACION.md](OPERACION.md), sección de reinicios).
- No ejecutes el bot a la vez en Railway y en tu PC con el mismo token y servidor.
- Por defecto, al redesplegar Railway envía `SIGTERM` al despliegue anterior con 0 segundos de gracia antes de `SIGKILL` (configurable con `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). Es aceptable: el bot persiste su estado **antes** de actuar sobre Discord, así que un corte no pierde la patrulla.
- Si querés que el servicio se reinicie solo tras un fallo, configurá la política de reinicio del servicio (p. ej. `ON_FAILURE` o `ALWAYS` en `railway.json`).

## Después del despliegue

1. Verificá en los logs que no haya advertencias de permisos (*Silenciar miembros*, canal de votaciones).
2. Usá `/policia-estado` para confirmar que responde.
3. Seguí con las pruebas funcionales en un servidor de prueba: **siguen pendientes**.
4. Cada `git push` a la rama configurada dispara un redeploy (con su breve caída). Si hay una patrulla activa, conviene esperar a que termine.

## Backup y datos

El volumen contiene `state.json`. Si lo necesitás, copialo periódicamente: sin ese archivo el bot no sabe qué silencios eran suyos (ver [OPERACION.md](OPERACION.md)). No lo subas a GitHub.
