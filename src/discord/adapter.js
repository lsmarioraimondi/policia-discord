'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { DiscordOpError } = require('../core/errors');

function mapError(err) {
  if (err instanceof DiscordOpError) return err;
  const code = err?.code;
  if (code === 40032) return new DiscordOpError('NOT_IN_VOICE', err.message, err);
  if (code === 50013 || code === 50001) return new DiscordOpError('MISSING_PERMISSIONS', err.message, err);
  if ([10003, 10007, 10008, 10013].includes(code)) return new DiscordOpError('NOT_FOUND', err.message, err);
  return new DiscordOpError('UNKNOWN', err?.message ?? String(err), err);
}

/** Implementación real de la interfaz `discord` del núcleo (ver src/core/context.js) sobre discord.js. */
class DiscordAdapter {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.noMentions = { parse: [] };
  }

  get guild() {
    return this.client.guilds.cache.get(this.config.guildId) ?? null;
  }

  getVoiceState(userId) {
    const vs = this.guild?.voiceStates.cache.get(userId);
    if (!vs?.channelId) return null;
    return { channelId: vs.channelId, serverMute: vs.serverMute === true };
  }

  async setMute(userId, mute, reason) {
    const guild = this.guild;
    if (!guild) throw new DiscordOpError('NOT_FOUND', 'el bot no está en el servidor configurado');
    try {
      await guild.members.edit(userId, { mute, reason });
    } catch (err) {
      throw mapError(err);
    }
  }

  async getVoiceChannelMembers(channelId) {
    const guild = this.guild;
    if (!guild) return [];
    const states = [...guild.voiceStates.cache.values()].filter((s) => s.channelId === channelId);
    const members = [];
    for (const state of states) {
      let bot = state.member?.user?.bot;
      if (bot === undefined) {
        try {
          bot = (await guild.members.fetch(state.id)).user.bot;
        } catch {
          bot = false; // ante la duda cuenta como humano: eleva el umbral, nunca lo reduce
        }
      }
      members.push({ id: state.id, bot: !!bot });
    }
    return members;
  }

  async _member(userId, force = false) {
    const guild = this.guild;
    if (!guild) throw new DiscordOpError('NOT_FOUND', 'el bot no está en el servidor configurado');
    try {
      return await guild.members.fetch({ user: userId, force });
    } catch (err) {
      throw mapError(err);
    }
  }

  /** Timeout vigente del miembro (se consulta a la API, no a la caché). */
  async getTimeoutInfo(userId) {
    const member = await this._member(userId, true);
    return { until: member.communicationDisabledUntilTimestamp ?? null };
  }

  /**
   * ¿Puede el bot aplicar un timeout a este miembro? Discord no permite aislar al dueño ni a quien
   * tenga Administrador, exige el permiso ModerateMembers y un rol del bot por encima del usuario.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  async canTimeout(userId) {
    const member = await this._member(userId);
    const guild = this.guild;
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (member.id === guild.ownerId) return { ok: false, reason: 'es el dueño del servidor (Discord no permite aislarlo)' };
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return { ok: false, reason: 'tiene el permiso de Administrador (Discord no permite aislar administradores)' };
    }
    if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return { ok: false, reason: 'al bot le falta el permiso "Aislar temporalmente a miembros" (ModerateMembers)' };
    }
    if (!member.manageable) {
      return { ok: false, reason: 'su rol más alto está por encima o al mismo nivel que el del bot (jerarquía de roles)' };
    }
    return { ok: true };
  }

  /** Aplica el timeout nativo de Discord hasta `untilMs` (timestamp absoluto). */
  async timeoutMember(userId, untilMs, reason) {
    const guild = this.guild;
    if (!guild) throw new DiscordOpError('NOT_FOUND', 'el bot no está en el servidor configurado');
    try {
      await guild.members.edit(userId, { communicationDisabledUntil: new Date(untilMs), reason });
    } catch (err) {
      throw mapError(err);
    }
  }

  getChannelName(channelId) {
    return this.client.channels.cache.get(channelId)?.name ?? channelId;
  }

  async _textChannel(channelId) {
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      throw mapError(err);
    }
    if (!channel?.isTextBased()) throw new DiscordOpError('NOT_FOUND', `el canal ${channelId} no es de texto`);
    return channel;
  }

  async sendMessage(channelId, content) {
    const channel = await this._textChannel(channelId);
    try {
      const msg = await channel.send({ content, allowedMentions: this.noMentions });
      return { id: msg.id, channelId: msg.channelId };
    } catch (err) {
      throw mapError(err);
    }
  }

  async editMessage(channelId, messageId, content) {
    const channel = await this._textChannel(channelId);
    try {
      await channel.messages.edit(messageId, { content, allowedMentions: this.noMentions });
    } catch (err) {
      throw mapError(err);
    }
  }

  async addReactions(channelId, messageId, emojis) {
    const channel = await this._textChannel(channelId);
    try {
      const msg = await channel.messages.fetch(messageId);
      for (const emoji of emojis) await msg.react(emoji); // secuencial: conserva el orden
    } catch (err) {
      throw mapError(err);
    }
  }

  async fetchReactionUsers(channelId, messageId, emoji) {
    const channel = await this._textChannel(channelId);
    try {
      const msg = await channel.messages.fetch({ message: messageId, force: true });
      const reaction = msg.reactions.cache.get(emoji);
      if (!reaction) return [];
      const ids = [];
      let after;
      for (;;) {
        const page = await reaction.users.fetch({ limit: 100, after });
        for (const u of page.values()) ids.push(u.id);
        if (page.size < 100) break;
        after = page.last().id;
      }
      return ids;
    } catch (err) {
      throw mapError(err);
    }
  }
}

module.exports = { DiscordAdapter, mapError };
