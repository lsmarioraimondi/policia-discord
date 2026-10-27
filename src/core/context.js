'use strict';

/**
 * Contexto compartido por los gestores. Agrupa el estado en memoria (fuente de verdad
 * operativa), la persistencia y los adaptadores externos (Discord y reloj), de modo que
 * todo el núcleo se pueda probar con mocks.
 *
 * Interfaz `discord` esperada (ver src/discord/adapter.js):
 *   getVoiceState(userId)                        -> { channelId, serverMute } | null   (síncrono, caché)
 *   setMute(userId, mute, reason)                -> Promise<void>   (lanza DiscordOpError)
 *   getVoiceChannelMembers(channelId)            -> Promise<{ id, bot }[]>
 *   getChannelName(channelId)                    -> string
 *   sendMessage(channelId, content)              -> Promise<{ id, channelId }>
 *   editMessage(channelId, messageId, content)   -> Promise<void>
 *   addReactions(channelId, messageId, emojis)   -> Promise<void>
 *   fetchReactionUsers(channelId, messageId, e)  -> Promise<string[]>  (NOT_FOUND si el mensaje no existe)
 *
 * Interfaz `clock`: now(), setTimeout(fn, ms), clearTimeout(h), setInterval(fn, ms), clearInterval(h)
 */
function createContext({ state, store, discord, clock, logger, config }) {
  const ctx = {
    state,
    store,
    discord,
    clock,
    logger,
    config,
    mgr: {},
    now: () => clock.now(),
    save: () => store.save(state),
    patrol: () => state.patrol,
    watched: (userId) => state.patrol?.watched[userId] ?? null,

    /** Publica en el canal configurado. Nunca lanza: un fallo de mensajería no debe romper el estado. */
    async announce(text) {
      try {
        return await discord.sendMessage(config.votingChannelId, text);
      } catch (err) {
        logger.warn(`No se pudo publicar el anuncio: ${err.message}`);
        return null;
      }
    },

    async safeEdit(channelId, messageId, text) {
      try {
        await discord.editMessage(channelId, messageId, text);
        return true;
      } catch (err) {
        logger.warn(`No se pudo editar el mensaje ${messageId}: ${err.message}`);
        return false;
      }
    },
  };
  return ctx;
}

module.exports = { createContext };
