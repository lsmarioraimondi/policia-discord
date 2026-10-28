'use strict';

const { messages } = require('../messages');

/**
 * Permisos temporales para hablar. Los vencimientos se guardan como timestamps absolutos
 * (`expiresAt`), nunca como "tiempo restante", así sobreviven a reinicios sin renovarse.
 * Hay dos mecanismos independientes de vencimiento: un temporizador exacto por permiso y un
 * barrido periódico (`tick`) que garantiza que ningún permiso quede abierto si un temporizador falla.
 */
class PermitManager {
  constructor(ctx, onTimer) {
    this.ctx = ctx;
    this.onTimer = onTimer; // (userId, grantedAt) => void (el servicio lo ejecuta dentro del mutex)
    this.timers = new Map();
  }

  get(userId) {
    return this.ctx.state.permits[userId] ?? null;
  }

  all() {
    return Object.values(this.ctx.state.permits);
  }

  grant(poll) {
    const { state, config } = this.ctx;
    const grantedAt = this.ctx.now();
    const permit = {
      userId: poll.requesterId,
      watchId: poll.watchId ?? null,
      pollId: poll.id,
      channelId: poll.channelId,
      messageChannelId: poll.messageChannelId,
      messageId: poll.messageId,
      grantedAt,
      expiresAt: grantedAt + config.speakDurationSeconds * 1000,
    };
    state.permits[permit.userId] = permit;
    this.schedule(permit);
    return permit;
  }

  schedule(permit) {
    this.clearTimer(permit.userId);
    const delay = Math.max(0, permit.expiresAt - this.ctx.now());
    // setTimeout no admite más de 2^31-1 ms; el barrido periódico cubre cualquier caso extremo.
    const handle = this.ctx.clock.setTimeout(() => this.onTimer(permit.userId, permit.grantedAt), Math.min(delay, 2 ** 31 - 1));
    this.timers.set(permit.userId, handle);
  }

  clearTimer(userId) {
    const handle = this.timers.get(userId);
    if (handle !== undefined) this.ctx.clock.clearTimeout(handle);
    this.timers.delete(userId);
  }

  clearAllTimers() {
    for (const userId of [...this.timers.keys()]) this.clearTimer(userId);
  }

  /** Quita (sincrónico) los permisos que cumplan el predicado y cancela sus temporizadores. */
  cancelWhere(predicate) {
    const cancelled = this.all().filter(predicate);
    for (const permit of cancelled) {
      delete this.ctx.state.permits[permit.userId];
      this.clearTimer(permit.userId);
    }
    return cancelled;
  }

  async notifyCancelled(permits, reason) {
    for (const permit of permits) {
      await this.ctx.safeEdit(permit.messageChannelId, permit.messageId, messages.permitCancelled(permit, reason));
    }
  }

  /** Permisos cuyo vencimiento absoluto ya pasó. */
  due() {
    const now = this.ctx.now();
    return this.all().filter((p) => p.expiresAt <= now);
  }
}

module.exports = { PermitManager };
