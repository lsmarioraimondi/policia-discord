'use strict';

const { randomUUID } = require('node:crypto');
const { YES, NO, POLL_TYPES, majority, buildRoster, tally, decide } = require('./voting');
const { messages } = require('../messages');

const ADMIN_TYPES = [POLL_TYPES.START_PATROL, POLL_TYPES.ADD_WATCH, POLL_TYPES.REMOVE_WATCH, POLL_TYPES.END_PATROL];

/**
 * Votaciones (pedir palabra y decisiones administrativas). Todas comparten el mismo
 * mecanismo: padrón fijo, mensaje con reacciones ✅/❌, mayoría `floor(n/2)+1` sobre el total
 * de habilitados y recuento releído de las reacciones reales (idempotente: no hay conteos
 * incrementales que puedan desincronizarse ni votos duplicados). Cada votación es
 * independiente; lo que cambia entre tipos es solo el padrón y la acción al aprobarse
 * (ver PoliciaService._approve).
 *
 * Campos de una votación: id, type, patrolId (null si aún no hay patrulla), requesterId
 * (quien la solicitó), targetId (usuario afectado; null en END_PATROL), channelId /
 * channelIds, messageId, roster, needed, votes, status, createdAt.
 */
class VotingManager {
  constructor(ctx) {
    this.ctx = ctx;
  }

  open() {
    return Object.values(this.ctx.state.polls);
  }

  /** Votación abierta de "pedir palabra" de un usuario. */
  openPollOf(userId) {
    return this.open().find((p) => p.type === POLL_TYPES.SPEAK_PERMISSION && p.targetId === userId) ?? null;
  }

  /** Votaciones administrativas abiertas (opcionalmente filtradas por tipo/afectado). */
  openAdmin({ types = ADMIN_TYPES, targetId } = {}) {
    return this.open().filter((p) => types.includes(p.type) && (targetId === undefined || p.targetId === targetId));
  }

  byMessage(messageId) {
    return this.open().find((p) => p.messageId === messageId) ?? null;
  }

  /**
   * Crea la votación: arma el padrón, publica el mensaje y persiste.
   * @param {object} spec
   * @param {string} spec.type          uno de POLL_TYPES
   * @param {string} spec.requesterId   quien la solicita
   * @param {string|null} spec.targetId usuario afectado (null en END_PATROL)
   * @param {string[]} spec.channelIds  canales de voz de los que sale el padrón
   * @param {{id:string,bot?:boolean}[]} spec.members  humanos/bots presentes en esos canales
   * @param {Iterable<string>} spec.exclude  ids que no votan (afectado, solicitante, vigilados)
   * @param {string[]} [spec.watchedIds]  solo END_PATROL: vigilados al momento de la solicitud
   * @returns {Promise<{ ok: true, poll, reactionsFailed: boolean } | { ok: false, code: string }>}
   */
  async create(spec) {
    const { state, config, discord, logger } = this.ctx;
    const { roster, participants } = buildRoster(spec.members, spec.exclude);
    if (roster.length === 0) return { ok: false, code: 'NO_VOTERS' }; // nunca se aprueba sin votantes

    const poll = {
      id: randomUUID(),
      type: spec.type,
      patrolId: state.patrol?.id ?? null,
      requesterId: spec.requesterId,
      targetId: spec.targetId ?? null,
      channelId: spec.channelIds[0] ?? null,
      channelIds: spec.channelIds,
      watchedIds: spec.watchedIds ?? [],
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

  /** Quita una votación del estado (persistiendo) y, si se da texto, actualiza su mensaje. */
  async close(poll, text) {
    delete this.ctx.state.polls[poll.id];
    await this.ctx.save();
    if (text) await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, text);
  }
}

module.exports = { VotingManager, ADMIN_TYPES };
