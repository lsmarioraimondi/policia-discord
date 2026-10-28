'use strict';

const { errorText } = require('./errors');

const EXPECT_TTL_MS = 15_000;
const PENDING_RELEASE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REASON_MUTE = 'Policía Discord: vigilancia activa';
const REASON_UNMUTE = 'Policía Discord: permiso para hablar';
const REASON_RELEASE = 'Policía Discord: fin de vigilancia';

/**
 * Estrategia conservadora de propiedad de los server mutes.
 *
 * Por cada vigilado se guarda:
 *  - preMuted   (null|bool): estado de server mute observado ANTES de la primera acción del bot.
 *                            true  => el mute no es del bot, nunca se levanta.
 *  - botMuted   (bool):      el bot aplicó un mute que sigue vigente => es "propio" y puede liberarse.
 *  - pendingOp  (null|'mute'|'unmute'): intención escrita ANTES de llamar a Discord, para resolver cortes a mitad.
 *  - manualUnmute (bool):    un moderador lo des-silenció durante la vigilancia; el bot lo respeta hasta que se reconecte.
 *  - uncertain  (bool):      tras un reinicio no se pudo saber si un mute pendiente se aplicó.
 *
 * Mute "propio" = botMuted && preMuted !== true. Solo esos se liberan, y solo si el usuario
 * sigue silenciado y no se detectó un cambio externo. Los cambios que provoca el propio bot se
 * reconocen con "expectativas" (userId + valor esperado) para evitar bucles de eventos.
 */
class MuteManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.expectations = new Map(); // userId -> [{ value, until }]
  }

  // ---- expectativas de eventos propios -------------------------------------------------

  expect(userId, value) {
    const list = this.expectations.get(userId) ?? [];
    list.push({ value, until: this.ctx.now() + EXPECT_TTL_MS });
    this.expectations.set(userId, list);
  }

  unexpect(userId, value) {
    const list = this.expectations.get(userId) ?? [];
    const idx = list.findLastIndex((e) => e.value === value);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** true si el cambio de mute observado fue provocado por el propio bot (y lo consume). */
  consume(userId, value) {
    const now = this.ctx.now();
    const list = (this.expectations.get(userId) ?? []).filter((e) => e.until > now);
    const idx = list.findIndex((e) => e.value === value);
    if (idx >= 0) list.splice(idx, 1);
    this.expectations.set(userId, list);
    return idx >= 0;
  }

  // ---- utilidades ----------------------------------------------------------------------

  owns(w) {
    return w.botMuted === true && w.preMuted !== true;
  }

  /**
   * Campos de gestión del mute con los que nace una vigilancia (ver storage/state.js).
   * Si quedó un mute del bot sin liberar de una vigilancia anterior, la propiedad continúa.
   */
  initialMuteState(userId) {
    const { state } = this.ctx;
    const record = {
      preMuted: null,
      botMuted: false,
      pendingOp: null,
      manualUnmute: false,
      uncertain: false,
      needsRemute: false,
      remuteAttempts: 0,
    };
    if (state.pendingReleases[userId]) {
      record.preMuted = false;
      record.botMuted = true;
      delete state.pendingReleases[userId];
    }
    return record;
  }

  async _setMute(userId, value, reason) {
    this.ctx.logger.info(`setMute usuario=${userId} mute=${value} (${reason})`);
    this.expect(userId, value);
    try {
      await this.ctx.discord.setMute(userId, value, reason);
    } catch (err) {
      this.unexpect(userId, value);
      throw err;
    }
  }

  // ---- aplicar vigilancia --------------------------------------------------------------

  /**
   * Garantiza que un vigilado conectado esté silenciado (salvo permiso vigente, mute ajeno o
   * des-silencio manual). Nunca lanza. Devuelve { status, error? }.
   * @param {{ joined?: boolean }} [opts] joined: el usuario acaba de (re)conectarse.
   */
  async ensureMuted(userId, { joined = false } = {}) {
    const { state, discord, logger } = this.ctx;
    const w = this.ctx.watched(userId);
    if (!w) return { status: 'not_watched' };
    if (state.permits[userId]) return { status: 'permit' };

    const vs = discord.getVoiceState(userId);
    if (!vs?.channelId) return { status: 'offline' };

    if (joined && w.manualUnmute) {
      w.manualUnmute = false;
      await this.ctx.save();
    }
    if (w.manualUnmute) return { status: 'manual_unmute' };
    if (w.pendingOp) await this.resolvePendingOp(w, vs);

    if (vs.serverMute) {
      if (w.botMuted) return { status: 'muted' };
      if (w.preMuted === null) {
        w.preMuted = true; // ya estaba silenciado antes de intervenir: no es nuestro
        await this.ctx.save();
      }
      return { status: 'foreign_mute' };
    }

    // No está silenciado: corresponde silenciar.
    try {
      w.preMuted ??= false;
      w.pendingOp = 'mute';
      await this.ctx.save();
      await this._setMute(userId, true, REASON_MUTE);
      w.botMuted = true;
      w.pendingOp = null;
      w.needsRemute = false;
      w.remuteAttempts = 0;
      await this.ctx.save();
      return { status: 'muted' };
    } catch (err) {
      w.pendingOp = null;
      w.botMuted = false;
      w.needsRemute = true;
      logger.warn(`No se pudo silenciar a ${userId}: ${err.message}`);
      try {
        await this.ctx.save();
      } catch (saveErr) {
        logger.error(`No se pudo guardar el estado tras un fallo de mute: ${saveErr.message}`);
      }
      return { status: 'error', error: errorText(err), kind: err.kind };
    }
  }

  /**
   * Levanta el silencio propio para conceder un permiso. No toca silencios ajenos.
   * @returns {Promise<{ ok: boolean, code?: string, error?: string }>}
   */
  async grantUnmute(userId) {
    const w = this.ctx.watched(userId);
    const vs = this.ctx.discord.getVoiceState(userId);
    if (!w || !vs?.channelId) return { ok: false, code: 'NOT_IN_VOICE', error: 'el usuario no está en voz' };
    if (!vs.serverMute) return { ok: true }; // ya puede hablar; el permiso igual vence y se re-silencia
    if (!w.botMuted) {
      return { ok: false, code: 'FOREIGN_MUTE', error: 'el silencio actual no lo aplicó el bot (moderador); no se levanta' };
    }
    try {
      w.pendingOp = 'unmute';
      await this.ctx.save();
      await this._setMute(userId, false, REASON_UNMUTE);
      w.botMuted = false;
      w.pendingOp = null;
      await this.ctx.save();
      return { ok: true };
    } catch (err) {
      w.pendingOp = null; // el silencio sigue siendo del bot
      try {
        await this.ctx.save();
      } catch {
        /* se reintenta en la próxima escritura */
      }
      return { ok: false, code: err.kind ?? 'UNKNOWN', error: errorText(err) };
    }
  }

  // ---- liberación ----------------------------------------------------------------------

  /**
   * Al quitar a alguien de la vigilancia: si el mute era propio, queda registrado como
   * "pendiente de liberar" (persistente) para que se levante cuando sea seguro y posible.
   * @returns {'owned'|'not_owned'}
   */
  disown(userId, w) {
    if (this.owns(w)) {
      this.ctx.state.pendingReleases[userId] = { since: this.ctx.now() };
      return 'owned';
    }
    return 'not_owned';
  }

  /**
   * Intenta liberar un mute propio pendiente.
   * Devuelve 'none' | 'watched' | 'expired' | 'deferred' | 'already_free' | 'released' | 'error'.
   */
  async tryRelease(userId) {
    const { state, discord, logger } = this.ctx;
    const pending = state.pendingReleases[userId];
    if (!pending) return 'none';
    if (this.ctx.watched(userId)) return 'watched';

    if (this.ctx.now() - pending.since > PENDING_RELEASE_MAX_AGE_MS) {
      delete state.pendingReleases[userId];
      await this.ctx.save();
      logger.warn(`Liberación pendiente de ${userId} descartada por antigüedad (>7 días): revisar manualmente.`);
      return 'expired';
    }

    const vs = discord.getVoiceState(userId);
    if (!vs?.channelId) return 'deferred'; // Discord no permite cambiar el mute de alguien fuera de voz
    if (!vs.serverMute) {
      delete state.pendingReleases[userId];
      await this.ctx.save();
      return 'already_free';
    }
    try {
      await this._setMute(userId, false, REASON_RELEASE);
      delete state.pendingReleases[userId];
      await this.ctx.save();
      return 'released';
    } catch (err) {
      logger.warn(`No se pudo liberar a ${userId}: ${err.message}`);
      return 'error';
    }
  }

  // ---- cambios de mute observados ------------------------------------------------------

  /** Cambio de serverMute NO provocado por el bot, dentro de una misma sesión de voz. */
  async onExternalTransition(userId, newMute) {
    const { state, logger } = this.ctx;
    const w = this.ctx.watched(userId);
    if (w) {
      if (newMute === false) {
        // Un moderador (u otra herramienta) levantó el silencio: no pelear con él.
        w.manualUnmute = true;
        w.botMuted = false;
        logger.info(`Des-silencio externo detectado en vigilado ${userId}: el bot lo respeta hasta que se reconecte.`);
      } else {
        // Silenciado por alguien más: ese mute no es nuestro.
        w.manualUnmute = false;
        if (!w.botMuted && w.preMuted === null) w.preMuted = true;
        logger.info(`Silencio externo detectado en vigilado ${userId}.`);
      }
      await this.ctx.save();
    } else if (state.pendingReleases[userId] && newMute === false) {
      delete state.pendingReleases[userId]; // alguien más ya lo liberó
      await this.ctx.save();
    }
  }

  // ---- recuperación --------------------------------------------------------------------

  /** Resuelve una operación a medias (corte entre persistir la intención y confirmarla). */
  async resolvePendingOp(w, vs) {
    if (!w.pendingOp) return;
    if (vs?.channelId) {
      // El estado observado es la verdad: si sigue silenciado, el mute es del bot.
      w.botMuted = vs.serverMute === true && w.preMuted !== true;
    } else {
      w.botMuted = false; // no se puede saber: conservador, no reclamar propiedad
      w.uncertain = true;
    }
    w.pendingOp = null;
    await this.ctx.save();
  }
}

module.exports = { MuteManager, PENDING_RELEASE_MAX_AGE_MS };
