'use strict';

const { randomUUID } = require('node:crypto');
const { nextPunishment, advanceStreak } = require('./punishment');

/**
 * Vigilancias. Una VIGILANCIA es un castigo temporal aplicado a un usuario: nace cuando se aprueba una
 * votación y termina sola cuando vence su tiempo. No existe un estado global "activo/inactivo": el conjunto
 * de vigilancias activas es `state.watches`, y una vigilancia que termina (vence, se finaliza por votación
 * o se reemplaza por un aislamiento) se ELIMINA de ese conjunto.
 *
 * - Los vencimientos son timestamps absolutos (`expiresAt`); sobreviven a reinicios sin renovarse.
 * - Hay un temporizador exacto por vigilancia y, además, un barrido periódico (`due`) que garantiza el
 *   vencimiento aunque el temporizador falle.
 * - La racha global de reincidencia es `state.streak` (independiente de las vigilancias).
 */
class WatchManager {
  constructor(ctx, onTimer) {
    this.ctx = ctx;
    this.onTimer = onTimer; // (watchId) => void (el servicio lo ejecuta dentro del mutex)
    this.timers = new Map(); // watchId -> handle
  }

  all() {
    return Object.values(this.ctx.state.watches);
  }

  byId(watchId) {
    return this.ctx.state.watches[watchId] ?? null;
  }

  /** Vigilancia activa de un usuario (como máximo una). */
  ofUser(userId) {
    return this.ctx.watched(userId);
  }

  /** Castigo que correspondería a `userId` ahora (para mostrarlo en la votación). No modifica nada. */
  peek(userId) {
    return nextPunishment(this.ctx.state.streak, userId, this.ctx.config);
  }

  /**
   * Crea una vigilancia aprobada y avanza la racha global. La duración se calcula acá, en el momento de
   * aprobarse (no en el de la solicitud). Solo esta función avanza la racha.
   * @param {{ userId: string, requestedBy: string, pollId: string|null, muteState: object }} args
   */
  create({ userId, requestedBy, pollId, muteState }) {
    const { state, config } = this.ctx;
    const { count, durationSeconds } = nextPunishment(state.streak, userId, config);
    state.streak = advanceStreak(state.streak, userId);
    const startedAt = this.ctx.now();
    const watch = {
      id: randomUUID(),
      userId,
      status: 'active',
      requestedBy,
      pollId: pollId ?? null,
      startedAt,
      expiresAt: startedAt + durationSeconds * 1000,
      durationSeconds,
      streakCount: count,
      reconnects: 0,
      awaitingReturn: false,
      isolationAttempted: false,
      isolationFailure: null,
      ...muteState,
    };
    state.watches[watch.id] = watch;
    return watch;
  }

  schedule(watch) {
    this.clearTimer(watch.id);
    const delay = Math.max(0, watch.expiresAt - this.ctx.now());
    // setTimeout no admite más de 2^31-1 ms: si salta antes, el servicio reprograma.
    const handle = this.ctx.clock.setTimeout(() => this.onTimer(watch.id), Math.min(delay, 2 ** 31 - 1));
    this.timers.set(watch.id, handle);
  }

  clearTimer(watchId) {
    const handle = this.timers.get(watchId);
    if (handle !== undefined) this.ctx.clock.clearTimeout(handle);
    this.timers.delete(watchId);
  }

  clearAllTimers() {
    for (const watchId of [...this.timers.keys()]) this.clearTimer(watchId);
  }

  /** Vigilancias cuyo vencimiento absoluto ya pasó. */
  due() {
    const now = this.ctx.now();
    return this.all().filter((w) => w.expiresAt <= now);
  }

  // ---- aislamientos (timeouts aplicados por el bot): solo seguimiento, nunca se extienden ----

  activeIsolations() {
    const now = this.ctx.now();
    return Object.values(this.ctx.state.isolations).filter((i) => i.until > now);
  }

  /** Elimina del seguimiento los aislamientos ya vencidos (Discord los levanta solo). */
  pruneIsolations() {
    const now = this.ctx.now();
    let changed = false;
    for (const [userId, i] of Object.entries(this.ctx.state.isolations)) {
      if (i.until <= now) {
        delete this.ctx.state.isolations[userId];
        changed = true;
      }
    }
    return changed;
  }
}

module.exports = { WatchManager };
