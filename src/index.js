'use strict';

require('dotenv').config({ quiet: true });
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits } = require('discord.js');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { JsonStore } = require('./storage/jsonStore');
const { PoliciaService } = require('./core/service');
const { DiscordAdapter } = require('./discord/adapter');
const { registerHandlers } = require('./discord/handlers');

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
};

/** Avisa (sin abortar) si faltan permisos que el bot necesita. */
async function preflight(client, config, logger) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) throw new Error('El bot no está en el servidor GUILD_ID. Invitalo primero (ver README).');
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.MuteMembers)) {
    logger.warn('Al bot le falta el permiso "Silenciar miembros" en el servidor: no podrá silenciar a nadie.');
  }
  let channel = null;
  try {
    channel = await client.channels.fetch(config.votingChannelId);
  } catch {
    /* se informa abajo */
  }
  if (!channel?.isTextBased() || channel.guildId !== config.guildId) {
    logger.warn('VOTING_CHANNEL_ID no es un canal de texto accesible de este servidor: no se podrán publicar votaciones.');
    return;
  }
  const needed = [
    ['ViewChannel', PermissionFlagsBits.ViewChannel],
    ['SendMessages', PermissionFlagsBits.SendMessages],
    ['AddReactions', PermissionFlagsBits.AddReactions],
    ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
  ];
  const perms = channel.permissionsFor(me);
  const missing = needed.filter(([, flag]) => !perms?.has(flag)).map(([n]) => n);
  if (missing.length) logger.warn(`En el canal de votaciones le faltan al bot estos permisos: ${missing.join(', ')}.`);
}

async function main() {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, [config.token]);

  const store = new JsonStore(config.dataDir);
  store.acquireLock();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages, // eventos de borrado de mensajes (NO incluye contenido)
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
    allowedMentions: { parse: [] },
  });
  const discord = new DiscordAdapter(client, config);
  const service = await PoliciaService.create({ store, discord, clock: realClock, logger, config });

  registerHandlers({ client, service, config, logger });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Recibido ${signal}: cerrando. El estado ya está guardado; la patrulla (si existe) sigue activa al reiniciar.`);
    service.shutdown();
    client.destroy();
    store.releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('Promesa rechazada sin capturar:', err));
  process.on('exit', () => store.releaseLock());

  client.once(Events.ClientReady, async () => {
    try {
      logger.info(`Conectado como ${client.user.tag}`);
      await preflight(client, config, logger);
      await service.start();
      logger.info('Policía Discord listo.');
    } catch (err) {
      logger.error('Fallo al iniciar:', err);
      shutdown('error de arranque');
    }
  });

  await client.login(config.token);
}

main().catch((err) => {
  console.error(err.code === 'INVALID_CONFIG' ? err.message : `No se pudo iniciar el bot: ${err.message}`);
  process.exit(1);
});
