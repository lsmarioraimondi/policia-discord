'use strict';

const { randomUUID } = require('node:crypto');
const { createContext } = require('./context');
const { Mutex } = require('./mutex');
const { MuteManager } = require('./muteManager');
const { VotingManager } = require('./votingManager');
const { PermitManager } = require('./permitManager');
const { messages } = require('../messages');

const TICK_MS = 5000;
const MAX_REMUTE_ATTEMPTS = 10;

/**
 * Fachada del núcleo de Policía Discord. Toda operación pública pasa por un mutex único:
 * comandos, eventos de voz, reacciones y vencimientos se ejecutan de a uno, en orden de
 * llegada, sobre un estado que se persiste antes de actuar sobre Discord. Los gestores
 * internos (mute/votación/permisos) NO toman el mutex, para evitar bloqueos recursivos.
 *
 * Los métodos devuelven objetos `{ ok, code, ... }`; solo lanzan ante fallos inesperados
 * (p. ej. error de disco), que la capa de interacciones informa como error interno.
 */
class PoliciaService {
  constructor({ state, store, discord, clock, logger, config }) {
    this.ctx = createContext({ state, store, discord, clock, logger, config });
    this.lock = new Mutex();
    this.mute = new MuteManager(this.ctx);
    this.voting = new VotingManager(this.ctx);
    this.permits = new PermitManager(this.ctx, (userId, grantedAt) => this._onPermitTimer(userId, grantedAt));
    this.tickHandle = null;
  }

  static async create(deps) {
    const state = await deps.store.load();
    return new PoliciaService({ ...deps, state });
  }

  get state() {
    return this.ctx.state;
  }

  // =============================================================== ciclo de vida

  /** Recupera el estado persistido y arranca el barrido periódico. Llamar con Discord ya listo. */
  async start() {
    await this.recover();
    this.tickHandle = this.ctx.clock.setInterval(() => {
      this.tick().catch((err) => this.ctx.logger.error('Error en el barrido periódico:', err));
    }, TICK_MS);
  }

  shutdown() {
    if (this.tickHandle !== null) this.ctx.clock.clearInterval(this.tickHandle);
    this.tickHandle = null;
    this.permits.clearAllTimers();
  }

  recover() {
    return this.lock.run(() => this._recover());
  }

  async _recover() {
    const { state, discord, logger } = this.ctx;
    const info = { patrolActive: !!state.patrol, pollsCancelled: [], permitsRestored: 0 };

    // 1. Votaciones interrumpidas: se cancelan de forma segura (el padrón/reacciones no son confiables).
    info.pollsCancelled = this.voting.cancelWhere(() => true);

    if (state.patrol) {
      // 2. Operaciones de mute a medias.
      for (const [userId, w] of Object.entries(state.patrol.watched)) {
        if (w.pendingOp) await this.mute.resolvePendingOp(w, discord.getVoiceState(userId));
      }

      // 3. Permisos: se conservan los vencimientos originales; nunca se renuevan.
      for (const permit of this.permits.all()) {
        const vs = discord.getVoiceState(permit.userId);
        const stillThere = vs?.channelId && vs.channelId === permit.channelId;
        if (permit.expiresAt <= this.ctx.now()) {
          await this._expirePermit(permit);
        } else if (!stillThere) {
          const [cancelled] = this.permits.cancelWhere((p) => p.userId === permit.userId);
          await this.ctx.save();
          await this.permits.notifyCancelled([cancelled], 'salió del canal mientras el bot estaba apagado');
        } else {
          this.permits.schedule(permit);
          info.permitsRestored++;
        }
      }
    } else {
      this.permits.cancelWhere(() => true); // permisos huérfanos sin patrulla: nunca deberían existir
    }
    await this.ctx.save();
    await this.voting.notifyClosed(info.pollsCancelled, 'el bot se reinició durante la votación');

    // 4. Revisar usuarios conectados: re-silenciar vigilados y liberar mutes propios pendientes.
    for (const userId of Object.keys(state.patrol?.watched ?? {})) {
      await this.mute.ensureMuted(userId, { joined: false });
    }
    for (const userId of Object.keys(state.pendingReleases)) {
      await this.mute.tryRelease(userId);
    }

    if (info.patrolActive || info.pollsCancelled.length) {
      await this.ctx.announce(messages.recovery(info));
    }
    logger.info(
      `Recuperación: patrulla ${info.patrolActive ? 'activa' : 'inactiva'}, ` +
        `${info.pollsCancelled.length} votación(es) cancelada(s), ${info.permitsRestored} permiso(s) retomado(s).`,
    );
    return info;
  }

  tick() {
    return this.lock.run(() => this._tick());
  }

  async _tick() {
    const { state } = this.ctx;
    for (const permit of this.permits.due()) await this._expirePermit(permit);

    // Reintentos de re-silenciado tras un fallo de Discord.
    for (const [userId, w] of Object.entries(state.patrol?.watched ?? {})) {
      if (!w.needsRemute || state.permits[userId]) continue;
      const res = await this.mute.ensureMuted(userId);
      if (res.status === 'error') {
        w.remuteAttempts = (w.remuteAttempts ?? 0) + 1;
        if (w.remuteAttempts >= MAX_REMUTE_ATTEMPTS) {
          w.needsRemute = false;
          await this.ctx.announce(messages.remuteFailed(userId, res.error));
        }
        await this.ctx.save();
      } else {
        w.needsRemute = false;
        await this.ctx.save();
      }
    }

    // Poda de liberaciones pendientes demasiado antiguas (ver MuteManager).
    for (const userId of Object.keys(state.pendingReleases)) {
      const vs = this.ctx.discord.getVoiceState(userId);
      if (!vs?.channelId) await this.mute.tryRelease(userId); // solo descarta si expiró; si no, 'deferred'
    }
  }

  _onPermitTimer(userId, grantedAt) {
    return this.lock
      .run(async () => {
        const permit = this.permits.get(userId);
        if (permit && permit.grantedAt === grantedAt && permit.expiresAt <= this.ctx.now()) {
          await this._expirePermit(permit);
        }
      })
      .catch((err) => this.ctx.logger.error('Error al vencer un permiso:', err));
  }

  // =============================================================== patrulla

  startPatrol({ by, targetId, targetIsBot = false }) {
    return this.lock.run(async () => {
      const { state, config } = this.ctx;
      if (state.patrol) return { ok: false, code: 'PATROL_ACTIVE' };
      if (targetIsBot) return { ok: false, code: 'TARGET_IS_BOT' };

      state.patrol = {
        id: randomUUID(),
        guildId: config.guildId,
        startedAt: this.ctx.now(),
        startedBy: by,
        watched: {},
      };
      state.patrol.watched[targetId] = this.mute.newWatched(targetId, by);
      try {
        await this.ctx.save();
      } catch (err) {
        state.patrol = null;
        throw err;
      }

      const mute = await this.mute.ensureMuted(targetId, { joined: false });
      const announced = !!(await this.ctx.announce(messages.patrolStarted(state.patrol, targetId, mute)));
      return { ok: true, patrol: state.patrol, mute, announced };
    });
  }

  watch({ by, targetId, targetIsBot = false }) {
    return this.lock.run(async () => {
      const { state } = this.ctx;
      if (!state.patrol) return { ok: false, code: 'NO_PATROL' };
      if (targetIsBot) return { ok: false, code: 'TARGET_IS_BOT' };
      if (state.patrol.watched[targetId]) return { ok: false, code: 'ALREADY_WATCHED' };

      state.patrol.watched[targetId] = this.mute.newWatched(targetId, by);
      await this.ctx.save();
      const mute = await this.mute.ensureMuted(targetId, { joined: false });
      const announced = !!(await this.ctx.announce(messages.watchAdded(targetId, by, mute)));
      return { ok: true, mute, announced };
    });
  }

  unwatch({ by, targetId }) {
    return this.lock.run(async () => {
      const { state } = this.ctx;
      if (!state.patrol) return { ok: false, code: 'NO_PATROL' };
      const w = state.patrol.watched[targetId];
      if (!w) return { ok: false, code: 'NOT_WATCHED' };

      const polls = this.voting.cancelWhere((p) => p.requesterId === targetId);
      const permits = this.permits.cancelWhere((p) => p.userId === targetId);
      this.mute.disown(targetId, w);
      delete state.patrol.watched[targetId];
      await this.ctx.save();

      await this.voting.notifyClosed(polls, 'el usuario dejó de ser vigilado');
      await this.permits.notifyCancelled(permits, 'el usuario dejó de ser vigilado');
      const release = await this.mute.tryRelease(targetId);
      const announced = !!(await this.ctx.announce(messages.watchRemoved(targetId, by, release)));
      return { ok: true, release, announced };
    });
  }

  finalize({ by }) {
    return this.lock.run(async () => {
      const { state } = this.ctx;
      const patrol = state.patrol;
      if (!patrol) return { ok: false, code: 'NO_PATROL' };

      // Todo el cambio de estado primero y persistido: si el proceso muere a mitad, la patrulla
      // ya figura como finalizada y NO se reactiva. Los mutes propios quedan en pendingReleases.
      const polls = this.voting.cancelWhere(() => true);
      const permits = this.permits.cancelWhere(() => true);
      const watchedEntries = Object.entries(patrol.watched);
      const owned = [];
      const skipped = [];
      for (const [userId, w] of watchedEntries) {
        if (this.mute.disown(userId, w) === 'owned') owned.push(userId);
        else if (w.preMuted === true || w.uncertain) skipped.push(userId);
      }
      state.lastPatrol = { id: patrol.id, startedAt: patrol.startedAt, endedAt: this.ctx.now(), endedBy: by };
      state.patrol = null;
      await this.ctx.save();

      await this.voting.notifyClosed(polls, 'la patrulla finalizó');
      await this.permits.notifyCancelled(permits, 'la patrulla finalizó');

      const summary = {
        watchedCount: watchedEntries.length,
        pollsCancelled: polls.length,
        permitsCancelled: permits.length,
        released: 0,
        deferred: [],
        failed: [],
        skipped,
      };
      for (const userId of owned) {
        const res = await this.mute.tryRelease(userId);
        if (res === 'released') summary.released++;
        else if (res === 'deferred') summary.deferred.push(userId);
        else if (res === 'error') summary.failed.push(userId);
      }
      summary.announced = !!(await this.ctx.announce(messages.patrolEnded(by, summary)));
      return { ok: true, summary };
    });
  }

  // =============================================================== votaciones y permisos

  requestFloor({ userId }) {
    return this.lock.run(async () => {
      const { state, discord } = this.ctx;
      if (!state.patrol) return { ok: false, code: 'NO_PATROL' };
      const w = state.patrol.watched[userId];
      if (!w) return { ok: false, code: 'NOT_WATCHED_SELF' };
      const vs = discord.getVoiceState(userId);
      if (!vs?.channelId) return { ok: false, code: 'NOT_IN_VOICE' };
      if (this.voting.openPollOf(userId)) return { ok: false, code: 'ALREADY_REQUESTED' };
      if (state.permits[userId]) return { ok: false, code: 'HAS_PERMIT' };
      if (w.preMuted === true) return { ok: false, code: 'PREMUTED' };
      if (w.manualUnmute) return { ok: false, code: 'MANUAL_UNMUTE' };
      return this.voting.create(userId, vs.channelId);
    });
  }

  /** Cambió alguna reacción de un mensaje: recalcula y resuelve la votación correspondiente. */
  onReactionChange(messageId) {
    return this.lock.run(async () => {
      const poll = this.voting.byMessage(messageId);
      if (!poll) return { handled: false };
      const decision = await this.voting.refresh(poll);
      if (decision === 'deleted') return this._pollMessageGone(poll);
      if (decision === 'approved') await this._approve(poll);
      else if (decision === 'rejected') await this.voting.close(poll, messages.pollRejected(poll));
      return { handled: true, decision };
    });
  }

  onMessageDeleted(messageId) {
    return this.lock.run(async () => {
      const poll = this.voting.byMessage(messageId);
      if (!poll) return { handled: false };
      return this._pollMessageGone(poll);
    });
  }

  async _pollMessageGone(poll) {
    delete this.ctx.state.polls[poll.id];
    await this.ctx.save();
    await this.ctx.announce(messages.pollMessageDeleted(poll));
    return { handled: true, decision: 'deleted' };
  }

  async _approve(poll) {
    const { state, discord } = this.ctx;
    const cancel = (reason) => this.voting.close(poll, messages.pollCancelled(poll, reason));

    const w = this.ctx.watched(poll.requesterId);
    if (!state.patrol || state.patrol.id !== poll.patrolId || !w) return cancel('la patrulla o la vigilancia ya no está vigente');
    const vs = discord.getVoiceState(poll.requesterId);
    if (!vs?.channelId || vs.channelId !== poll.channelId) return cancel('el solicitante ya no está en el canal de la votación');

    const res = await this.mute.grantUnmute(poll.requesterId);
    if (!res.ok) return this.voting.close(poll, messages.pollFailed(poll, res.error));

    const permit = this.permits.grant(poll);
    delete state.polls[poll.id];
    await this.ctx.save();
    await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, messages.pollApproved(poll, permit));
  }

  /** Cierra un permiso vencido: lo elimina y vuelve a silenciar si corresponde. */
  async _expirePermit(permit) {
    const { state } = this.ctx;
    delete state.permits[permit.userId];
    this.permits.clearTimer(permit.userId);
    await this.ctx.save();
    await this.ctx.safeEdit(permit.messageChannelId, permit.messageId, messages.permitExpired(permit));
    if (state.patrol?.watched[permit.userId]) {
      const res = await this.mute.ensureMuted(permit.userId);
      if (res.status === 'error') {
        await this.ctx.announce(messages.remuteFailed(permit.userId, res.error));
      }
    }
  }

  // =============================================================== voz

  /**
   * @param {{ userId: string, oldChannelId: string|null, newChannelId: string|null,
   *           oldMute: boolean|null, newMute: boolean|null }} evt
   */
  onVoiceStateUpdate(evt) {
    return this.lock.run(() => this._onVoice(evt));
  }

  async _onVoice({ userId, oldChannelId, newChannelId, oldMute, newMute }) {
    const { state } = this.ctx;
    const w = this.ctx.watched(userId);
    const hasPending = !!state.pendingReleases[userId];

    // Cambio de mute dentro de la misma sesión de voz: ¿lo hizo el bot o alguien más?
    // (la expectativa se consume siempre, aunque el usuario ya no esté vigilado)
    if (oldChannelId && newChannelId && typeof oldMute === 'boolean' && typeof newMute === 'boolean' && oldMute !== newMute) {
      if (!this.mute.consume(userId, newMute) && (w || hasPending)) await this.mute.onExternalTransition(userId, newMute);
    }
    if (!w && !hasPending) return;

    const joined = !oldChannelId && !!newChannelId;
    const moved = !!oldChannelId && !!newChannelId && oldChannelId !== newChannelId;
    const left = !!oldChannelId && !newChannelId;

    if (w) {
      if (moved || left) {
        const polls = this.voting.cancelWhere((p) => p.requesterId === userId);
        const permits = this.permits.cancelWhere((p) => p.userId === userId);
        if (polls.length || permits.length) await this.ctx.save();
        const why = left ? 'se desconectó de voz' : 'cambió de canal de voz';
        await this.voting.notifyClosed(polls, why);
        await this.permits.notifyCancelled(permits, why);
      }
      if (joined || moved) await this.mute.ensureMuted(userId, { joined });
    } else if (joined) {
      await this.mute.tryRelease(userId);
    }
  }

  // =============================================================== consulta

  getStatus() {
    return this.lock.run(async () => {
      const { state, discord } = this.ctx;
      const patrol = state.patrol;
      const base = {
        active: !!patrol,
        lastPatrol: state.lastPatrol,
        pendingReleases: Object.entries(state.pendingReleases).map(([userId, p]) => ({ userId, since: p.since })),
      };
      if (!patrol) return base;

      const watched = Object.values(patrol.watched).map((w) => {
        const vs = discord.getVoiceState(w.userId);
        const permit = state.permits[w.userId] ?? null;
        const poll = this.voting.openPollOf(w.userId);
        return {
          userId: w.userId,
          addedAt: w.addedAt,
          inVoice: !!vs?.channelId,
          channelId: vs?.channelId ?? null,
          channelName: vs?.channelId ? discord.getChannelName(vs.channelId) : null,
          serverMute: vs?.channelId ? vs.serverMute === true : null,
          preMuted: w.preMuted,
          botMuted: w.botMuted,
          manualUnmute: w.manualUnmute,
          uncertain: w.uncertain,
          needsRemute: w.needsRemute,
          permitExpiresAt: permit?.expiresAt ?? null,
          pollId: poll?.id ?? null,
        };
      });
      const polls = this.voting.open().map((p) => ({
        id: p.id,
        requesterId: p.requesterId,
        channelId: p.channelId,
        voters: p.roster.length,
        needed: p.needed,
        yes: Object.values(p.votes).filter((v) => v === 'yes').length,
        no: Object.values(p.votes).filter((v) => v === 'no').length,
        createdAt: p.createdAt,
      }));
      const permits = this.permits.all().map((p) => ({ userId: p.userId, expiresAt: p.expiresAt }));
      return { ...base, patrol: { id: patrol.id, startedAt: patrol.startedAt, startedBy: patrol.startedBy }, watched, polls, permits };
    });
  }
}

module.exports = { PoliciaService, TICK_MS };
