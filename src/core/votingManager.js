'use strict';

const { randomUUID } = require('node:crypto');
const { YES, NO, majority, buildRoster, tally, decide } = require('./voting');
const { messages } = require('../messages');

/**
 * Votaciones de "pedir palabra". Cada votación es independiente: tiene su propio mensaje,
 * su padrón fijo y su registro de votos. Los votos se recalculan siempre desde las
 * reacciones reales del mensaje (idempotente: no hay conteos incrementales que puedan
 * desincronizarse ni votos duplicados).
 */
class VotingManager {
  constructor(ctx) {
    this.ctx = ctx;
  }

  open() {
    return Object.values(this.ctx.state.polls);
  }

  openPollOf(userId) {
    return this.open().find((p) => p.requesterId === userId) ?? null;
  }

  byMessage(messageId) {
    return this.open().find((p) => p.messageId === messageId) ?? null;
  }

  /**
   * Crea la votación: arma el padrón, publica el mensaje y persiste.
   * @returns {Promise<{ ok: true, poll, reactionsFailed: boolean } | { ok: false, code: string }>}
   */
  async create(userId, voiceChannelId) {
    const { state, config, discord, logger } = this.ctx;

    let members;
    try {
      members = await discord.getVoiceChannelMembers(voiceChannelId);
    } catch (err) {
      logger.warn(`No se pudo leer el canal de voz ${voiceChannelId}: ${err.message}`);
      return { ok: false, code: 'INTERNAL' };
    }
    const { roster, participants } = buildRoster(members, userId);
    if (roster.length === 0) return { ok: false, code: 'NO_VOTERS' };

    const poll = {
      id: randomUUID(),
      patrolId: state.patrol.id,
      requesterId: userId,
      channelId: voiceChannelId,
      messageId: null,
      messageChannelId: config.votingChannelId,
      roster,
      participants,
      needed: majority(roster.length),
      votes: {},
      status: 'open',
      createdAt: this.ctx.now(),
    };

    let sent;
    try {
      sent = await discord.sendMessage(config.votingChannelId, messages.pollBody(poll, config.speakDurationSeconds));
    } catch (err) {
      logger.warn(`No se pudo publicar la votación: ${err.message}`);
      return { ok: false, code: 'SEND_FAILED' };
    }
    poll.messageId = sent.id;
    poll.messageChannelId = sent.channelId ?? config.votingChannelId;

    state.polls[poll.id] = poll;
    await this.ctx.save();

    let reactionsFailed = false;
    try {
      await discord.addReactions(poll.messageChannelId, poll.messageId, [YES, NO]);
    } catch (err) {
      reactionsFailed = true;
      logger.warn(`No se pudieron agregar las reacciones a la votación ${poll.id}: ${err.message}`);
    }
    return { ok: true, poll, reactionsFailed };
  }

  /**
   * Recalcula los votos desde las reacciones reales y decide.
   * @returns {Promise<'approved'|'rejected'|'open'|'deleted'>}
   */
  async refresh(poll) {
    const { discord, logger } = this.ctx;
    let yesUsers;
    let noUsers;
    try {
      yesUsers = await discord.fetchReactionUsers(poll.messageChannelId, poll.messageId, YES);
      noUsers = await discord.fetchReactionUsers(poll.messageChannelId, poll.messageId, NO);
    } catch (err) {
      if (err.kind === 'NOT_FOUND') return 'deleted';
      logger.warn(`No se pudieron leer las reacciones de ${poll.id}: ${err.message}`);
      return 'open';
    }
    const { votes, yes, no } = tally(poll.roster, yesUsers, noUsers);
    const changed = JSON.stringify(votes) !== JSON.stringify(poll.votes);
    poll.votes = votes;
    if (changed) await this.ctx.save();
    return decide(poll.roster.length, poll.needed, yes, no);
  }

  /** Quita del estado (sincrónico) las votaciones que cumplan el predicado y las devuelve. */
  cancelWhere(predicate) {
    const cancelled = this.open().filter(predicate);
    for (const poll of cancelled) delete this.ctx.state.polls[poll.id];
    return cancelled;
  }

  /** Cierra el mensaje de votaciones ya removidas del estado. Nunca lanza. */
  async notifyClosed(polls, reason) {
    for (const poll of polls) {
      await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, messages.pollCancelled(poll, reason));
    }
  }

  /** Quita una votación y actualiza su mensaje con el resultado. */
  async close(poll, text) {
    delete this.ctx.state.polls[poll.id];
    await this.ctx.save();
    await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, text);
  }
}

module.exports = { VotingManager };
