'use strict';

const { createContext } = require('./context');
const { Mutex } = require('./mutex');
const { MuteManager } = require('./muteManager');
const { VotingManager } = require('./votingManager');
const { POLL_TYPES } = require('./voting');
const { PermitManager } = require('./permitManager');
const { WatchManager } = require('./watchManager');
const { errorText } = require('./errors');
const { messages } = require('../messages');

const TICK_MS = 5000;
const MAX_REMUTE_ATTEMPTS = 10;

/** Tipos de votación de formatos anteriores -> tipo actual (solo para redactar bien su cancelación al migrar). */
const LEGACY_POLL_TYPES = {
  START_PATROL: POLL_TYPES.START_WATCH,
  ADD_WATCH: POLL_TYPES.START_WATCH,
  REMOVE_WATCH: POLL_TYPES.END_WATCH,
};

/**
 * Fachada del núcleo de Policía Discord. Toda operación pública pasa por un mutex único:
 * comandos, eventos de voz, reacciones y vencimientos se ejecutan de a uno, en orden de
 * llegada, sobre un estado que se persiste antes de actuar sobre Discord. Los gestores
 * internos (mute/votación/permisos/vigilancias) NO toman el mutex, para evitar bloqueos recursivos.
 *
 * Modelo: una VIGILANCIA es un castigo temporal por usuario. Comienza cuando se aprueba una votación
 * (`START_WATCH`) y termina automáticamente al vencer, por una votación de fin anticipado (`END_WATCH`)
 * o por aislamiento. No hay ningún estado global que iniciar o finalizar para poder vigilar.
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
    this.watches = new WatchManager(this.ctx, (watchId) => this._onWatchTimer(watchId));
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
    this.watches.clearAllTimers();
  }

  recover() {
    return this.lock.run(() => this._recover());
  }

  async _recover() {
    const { state, discord, logger } = this.ctx;
    const info = { watchesActive: 0, pollsCancelled: [], permitsRestored: 0, watchesServed: 0, migration: null };

    // 0. Migración desde un formato anterior: se informa una sola vez.
    if (state.migration && !state.migration.reported) {
      info.migration = state.migration;
      state.migration.reported = true;
    }

    // 1. Votaciones interrumpidas: se cancelan de forma segura (el padrón/reacciones no son confiables).
    for (const poll of Object.values(state.polls)) {
      poll.type = LEGACY_POLL_TYPES[poll.type] ?? poll.type ?? POLL_TYPES.SPEAK_PERMISSION;
      poll.targetId ??= poll.requesterId;
    }
    info.pollsCancelled = this.voting.cancelWhere(() => true);

    // 2. Operaciones de mute a medias.
    for (const w of this.watches.all()) {
      if (w.pendingOp) await this.mute.resolvePendingOp(w, discord.getVoiceState(w.userId));
    }

    // 3. Vigilancias: las vencidas durante el apagado se regularizan ahora (sin votación); el resto se
    // reprograma con su vencimiento ORIGINAL (nunca se reinician los minutos).
    for (const w of this.watches.all()) {
      if (w.expiresAt <= this.ctx.now()) {
        if ((await this._expireWatch(w.id)).ok) info.watchesServed++;
      } else {
        this.watches.schedule(w);
      }
    }

    // 4. Permisos: se conservan los vencimientos originales; nunca se renuevan. Un permiso sin
    // vigilancia activa no puede existir.
    for (const permit of this.permits.all()) {
      const vs = discord.getVoiceState(permit.userId);
      const stillThere = vs?.channelId && vs.channelId === permit.channelId;
      if (!this.ctx.watched(permit.userId)) {
        const orphans = this.permits.cancelWhere((p) => p.userId === permit.userId);
        await this.ctx.save();
        await this.permits.notifyCancelled(orphans, 'la vigilancia ya no está vigente');
      } else if (permit.expiresAt <= this.ctx.now()) {
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

    this.watches.pruneIsolations(); // aislamientos vencidos: Discord ya levantó el timeout
    await this.ctx.save();
    await this.voting.notifyClosed(info.pollsCancelled, 'el bot se reinició durante la votación');

    // 5. Revisar usuarios conectados: re-silenciar vigilados y liberar mutes propios pendientes.
    for (const w of this.watches.all()) await this.mute.ensureMuted(w.userId, { joined: false });
    for (const userId of Object.keys(state.pendingReleases)) await this.mute.tryRelease(userId);

    info.watchesActive = this.watches.all().length;
    if (info.watchesActive || info.pollsCancelled.length || info.watchesServed || info.migration) {
      await this.ctx.announce(messages.recovery(info));
    }
    logger.info(
      `Recuperación: ${info.watchesActive} vigilancia(s) activa(s), ${info.watchesServed} vencida(s) durante el apagado, ` +
        `${info.pollsCancelled.length} votación(es) cancelada(s), ${info.permitsRestored} permiso(s) retomado(s).`,
    );
    if (info.migration) {
      logger.warn(
        `Estado migrado desde el formato v${info.migration.fromVersion}. Respaldo del original: ${info.migration.backup ?? '(estado en memoria)'}.`,
      );
    }
    return info;
  }

  tick() {
    return this.lock.run(() => this._tick());
  }

  async _tick() {
    const { state } = this.ctx;
    // Primero las vigilancias vencidas (cancelan sus permisos/votaciones), luego los permisos.
    for (const w of this.watches.due()) await this._expireWatch(w.id);
    for (const permit of this.permits.due()) await this._expirePermit(permit);
    if (this.watches.pruneIsolations()) await this.ctx.save();

    // Reintentos de re-silenciado tras un fallo de Discord.
    for (const w of this.watches.all()) {
      if (!w.needsRemute || state.permits[w.userId]) continue;
      const res = await this.mute.ensureMuted(w.userId);
      if (res.status === 'error') {
        w.remuteAttempts = (w.remuteAttempts ?? 0) + 1;
        if (w.remuteAttempts >= MAX_REMUTE_ATTEMPTS) {
          w.needsRemute = false;
          await this.ctx.announce(messages.remuteFailed(w.userId, res.error));
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

  _onWatchTimer(watchId) {
    return this.lock
      .run(async () => {
        const w = this.watches.byId(watchId);
        if (!w) return; // ya terminó por otra vía
        if (w.expiresAt <= this.ctx.now()) await this._expireWatch(watchId);
        else this.watches.schedule(w); // el temporizador saltó antes (tope de setTimeout)
      })
      .catch((err) => this.ctx.logger.error('Error al vencer una vigilancia:', err));
  }

  // =============================================================== vigilancias (acciones ya autorizadas)
  //
  // Estas acciones se ejecutan de inmediato. Los comandos de Discord NO las llaman directamente:
  // pasan por una votación (request*) y la acción se ejecuta recién al aprobarse (_approveAdmin).
  // El vencimiento es la única terminación que no requiere votación.

  applyWatch(args) {
    return this.lock.run(() => this._startWatch(args));
  }

  applyUnwatch(args) {
    return this.lock.run(() => this._endWatchEarly(args));
  }

  /** Crea la vigilancia (castigo), avanza la racha global, programa su vencimiento y silencia al usuario. */
  async _startWatch({ by, targetId, targetIsBot = false, pollId = null }) {
    const { state } = this.ctx;
    if (targetIsBot) return { ok: false, code: 'TARGET_IS_BOT' };
    if (this.ctx.watched(targetId)) return { ok: false, code: 'ALREADY_WATCHED' };

    const prev = { streak: state.streak, pending: state.pendingReleases[targetId] };
    const watch = this.watches.create({
      userId: targetId,
      requestedBy: by,
      pollId,
      muteState: this.mute.initialMuteState(targetId), // la propiedad de un mute propio pendiente continúa
    });
    try {
      await this.ctx.save();
    } catch (err) {
      delete state.watches[watch.id];
      state.streak = prev.streak;
      if (prev.pending) state.pendingReleases[targetId] = prev.pending;
      throw err;
    }
    this.watches.schedule(watch);

    const mute = await this.mute.ensureMuted(targetId, { joined: false });
    const announced = !!(await this.ctx.announce(messages.watchStarted(watch, by, mute)));
    return { ok: true, watch, mute, announced };
  }

  /** Fin anticipado (ya autorizado por votación). No toca la racha. */
  async _endWatchEarly({ by, targetId }) {
    const w = this.ctx.watched(targetId);
    if (!w) return { ok: false, code: 'NOT_WATCHED' };
    const out = await this._closeWatch(w, 'el usuario dejó de ser vigilado');
    const announced = !!(await this.ctx.announce(messages.watchEndedEarly(targetId, by, out.release)));
    return { ok: true, release: out.release, announced };
  }

  /**
   * Cierra una vigilancia (vencimiento, fin anticipado o aislamiento): la ELIMINA de las vigilancias
   * activas, cancela sus votaciones y su permiso, limpia su temporizador, registra su mute propio como
   * pendiente de liberar y lo intenta liberar. NO toca la racha ni la de otros usuarios.
   */
  async _closeWatch(w, reason) {
    const { state } = this.ctx;
    const polls = this.voting.cancelWhere((p) => p.targetId === w.userId);
    const permits = this.permits.cancelWhere((p) => p.userId === w.userId);
    this.watches.clearTimer(w.id);
    this.mute.disown(w.userId, w);
    delete state.watches[w.id];
    await this.ctx.save();

    await this.voting.notifyClosed(polls, reason);
    await this.permits.notifyCancelled(permits, reason);
    const release = await this.mute.tryRelease(w.userId);
    return { ok: true, release, watch: w };
  }

  /** Fin natural de una vigilancia: no requiere votación ni comando. */
  async _expireWatch(watchId) {
    const w = this.watches.byId(watchId);
    if (!w || w.expiresAt > this.ctx.now()) return { ok: false, code: 'NOT_DUE' };
    const out = await this._closeWatch(w, 'el castigo venció');
    await this.ctx.announce(messages.watchServed(w.userId, w, out.release));
    return { ok: true, release: out.release };
  }

  /**
   * Aislamiento (timeout nativo de Discord) tras alcanzar el límite de reconexiones. Se intenta como
   * máximo UNA vez por vigilancia. Nunca pisa ni acorta un timeout de otro moderador. Si falla, la
   * vigilancia original continúa hasta su vencimiento. Devuelve true si la vigilancia terminó por esto.
   */
  async _tryIsolation(w) {
    const { state, discord, config, logger } = this.ctx;
    if (w.isolationAttempted) return false;
    w.isolationAttempted = true; // antes de actuar: ni un reinicio ni un fallo permiten un segundo intento
    await this.ctx.save();

    let failure = null;
    let isolation = null;
    try {
      const current = await discord.getTimeoutInfo(w.userId);
      if (current.until && current.until > this.ctx.now()) {
        failure = 'ya tiene un timeout vigente de otro moderador (el bot no lo sobrescribe ni lo acorta)';
      } else {
        const check = await discord.canTimeout(w.userId);
        if (!check.ok) {
          failure = check.reason;
        } else {
          const startedAt = this.ctx.now();
          const until = startedAt + config.isolationDurationSeconds * 1000;
          await discord.timeoutMember(w.userId, until, 'Policía Discord: reconexiones reiteradas durante un castigo');
          isolation = {
            userId: w.userId,
            startedAt,
            until,
            durationSeconds: config.isolationDurationSeconds,
            watchId: w.id,
            streakCount: w.streakCount,
          };
        }
      }
    } catch (err) {
      logger.warn(`No se pudo aplicar el aislamiento a ${w.userId}: ${err.message}`);
      failure =
        err.kind === 'MISSING_PERMISSIONS'
          ? 'Discord rechazó el timeout (el bot necesita "Aislar temporalmente a miembros" y un rol por encima del usuario)'
          : errorText(err);
    }

    if (!isolation) {
      w.isolationFailure = failure;
      await this.ctx.save();
      await this.ctx.announce(messages.isolationFailed(w.userId, w, failure));
      return false;
    }
    state.isolations[w.userId] = isolation; // se guarda junto con el cierre de la vigilancia (un solo guardado)
    await this._closeWatch(w, 'el castigo terminó por aislamiento');
    await this.ctx.announce(messages.isolationApplied(w.userId, w, isolation));
    return true;
  }

  // =============================================================== solicitudes (votaciones)
  //
  // Ninguna de estas solicitudes modifica la vigilancia: solo publican una votación. Se rechazan al
  // crearlas las duplicadas o contradictorias (una votación de inicio o de fin por usuario). No hay ningún
  // bloqueo global: las votaciones de distintos usuarios coexisten, y las de palabra con todas ellas.

  /** `/vigilar`: solicita una vigilancia (castigo temporal). No depende de ningún estado global. */
  requestWatch({ by, targetId, targetIsBot = false }) {
    return this.lock.run(async () => {
      if (targetIsBot) return { ok: false, code: 'TARGET_IS_BOT' };
      if (!this.ctx.discord.getVoiceState(targetId)?.channelId) return { ok: false, code: 'TARGET_NOT_IN_VOICE' };
      if (this.ctx.watched(targetId)) return { ok: false, code: 'ALREADY_WATCHED' };
      if (this.voting.openAdmin({ types: [POLL_TYPES.START_WATCH], targetId }).length) return { ok: false, code: 'POLL_PENDING' };
      return this._createTargetPoll(POLL_TYPES.START_WATCH, by, targetId);
    });
  }

  /** `/dejar-vigilar`: solicita terminar anticipadamente la vigilancia de un usuario. */
  requestUnwatch({ by, targetId }) {
    return this.lock.run(async () => {
      const w = this.ctx.watched(targetId);
      if (!w) return { ok: false, code: 'NOT_WATCHED' };
      if (this.voting.openAdmin({ types: [POLL_TYPES.END_WATCH], targetId }).length) return { ok: false, code: 'POLL_PENDING' };
      return this._createTargetPoll(POLL_TYPES.END_WATCH, by, targetId, w.id);
    });
  }

  /** Votación sobre un usuario concreto: el padrón es su canal de voz, sin él ni bots. */
  async _createTargetPoll(type, by, targetId, watchId = null) {
    const vs = this.ctx.discord.getVoiceState(targetId);
    if (!vs?.channelId) return { ok: false, code: 'TARGET_NOT_IN_VOICE' };
    const members = await this._membersOf([vs.channelId]);
    if (!members) return { ok: false, code: 'INTERNAL' };
    // La duración se propone según la racha ACTUAL; la definitiva se calcula al aprobarse.
    const proposed = type === POLL_TYPES.START_WATCH ? this.watches.peek(targetId) : null;
    return this.voting.create({
      type,
      requesterId: by,
      targetId,
      watchId,
      channelIds: [vs.channelId],
      members,
      exclude: [targetId],
      proposedSeconds: proposed?.durationSeconds,
      proposedCount: proposed?.count,
    });
  }

  /** Unión (sin repetidos) de los presentes en varios canales de voz; null si Discord falla. */
  async _membersOf(channelIds) {
    const byId = new Map();
    try {
      for (const channelId of channelIds) {
        for (const m of await this.ctx.discord.getVoiceChannelMembers(channelId)) byId.set(m.id, m);
      }
    } catch (err) {
      this.ctx.logger.warn(`No se pudo leer el padrón de voz: ${err.message}`);
      return null;
    }
    return [...byId.values()];
  }

  // =============================================================== votaciones y permisos

  requestFloor({ userId }) {
    return this.lock.run(async () => {
      const { state, discord } = this.ctx;
      const w = this.ctx.watched(userId);
      if (!w) return { ok: false, code: 'NOT_WATCHED_SELF' };
      const vs = discord.getVoiceState(userId);
      if (!vs?.channelId) return { ok: false, code: 'NOT_IN_VOICE' };
      if (this.voting.openPollOf(userId)) return { ok: false, code: 'ALREADY_REQUESTED' };
      if (state.permits[userId]) return { ok: false, code: 'HAS_PERMIT' };
      if (w.preMuted === true) return { ok: false, code: 'PREMUTED' };
      if (w.manualUnmute) return { ok: false, code: 'MANUAL_UNMUTE' };
      const members = await this._membersOf([vs.channelId]);
      if (!members) return { ok: false, code: 'INTERNAL' };
      return this.voting.create({
        type: POLL_TYPES.SPEAK_PERMISSION,
        requesterId: userId,
        targetId: userId,
        watchId: w.id,
        channelIds: [vs.channelId],
        members,
        exclude: [userId],
      });
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

  /** Una votación alcanzó la mayoría: ejecuta la acción propia de su tipo. */
  _approve(poll) {
    return poll.type === POLL_TYPES.SPEAK_PERMISSION ? this._approveSpeak(poll) : this._approveAdmin(poll);
  }

  async _approveSpeak(poll) {
    const { state, discord } = this.ctx;
    const cancel = (reason) => this.voting.close(poll, messages.pollCancelled(poll, reason));

    const w = this.ctx.watched(poll.targetId);
    if (!w || (poll.watchId && w.id !== poll.watchId)) return cancel('la vigilancia ya no está vigente');
    const vs = discord.getVoiceState(poll.targetId);
    if (!vs?.channelId || vs.channelId !== poll.channelId) return cancel('el solicitante ya no está en el canal de la votación');

    const res = await this.mute.grantUnmute(poll.targetId);
    if (!res.ok) return this.voting.close(poll, messages.pollFailed(poll, res.error));

    const permit = this.permits.grant(poll);
    delete state.polls[poll.id];
    await this.ctx.save();
    await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, messages.pollApproved(poll, permit));
  }

  /**
   * Ejecuta una acción administrativa aprobada. Antes de actuar se revalida que las condiciones
   * sigan vigentes (la votación pudo tardar) y se cierra la votación para que la acción no la cancele.
   */
  async _approveAdmin(poll) {
    const { discord } = this.ctx;
    const cancel = (reason) => this.voting.close(poll, messages.pollCancelled(poll, reason));
    const current = this.ctx.watched(poll.targetId);
    const inChannel = () => discord.getVoiceState(poll.targetId)?.channelId === poll.channelId;

    switch (poll.type) {
      case POLL_TYPES.START_WATCH:
        if (current) return cancel('el usuario ya está vigilado');
        if (!inChannel()) return cancel('el usuario afectado ya no está en el canal de la votación');
        break;
      case POLL_TYPES.END_WATCH:
        if (!current || (poll.watchId && current.id !== poll.watchId)) return cancel('la vigilancia ya no está vigente');
        if (!inChannel()) return cancel('el usuario afectado ya no está en el canal de la votación');
        break;
      default:
        return cancel('tipo de votación desconocido');
    }

    await this.voting.close(poll); // deja de estar abierta antes de ejecutar la acción
    const target = messages.user(poll.targetId);
    let res;
    let outcome;
    if (poll.type === POLL_TYPES.START_WATCH) {
      res = await this._startWatch({ by: poll.requesterId, targetId: poll.targetId, pollId: poll.id });
      outcome = res.ok && `${target} queda vigilado — ${messages.describeMute(res.mute)}. ${messages.punishmentOutcome(poll, res.watch)}`;
    } else {
      res = await this._endWatchEarly({ by: poll.requesterId, targetId: poll.targetId });
      outcome = res.ok && `${target} deja de estar vigilado (fin anticipado del castigo).`;
    }
    const text = res.ok ? messages.adminApproved(poll, outcome) : messages.pollCancelled(poll, `no se pudo ejecutar (${res.code})`);
    await this.ctx.safeEdit(poll.messageChannelId, poll.messageId, text);
    return res;
  }

  /** Cierra un permiso vencido: lo elimina y vuelve a silenciar si corresponde. */
  async _expirePermit(permit) {
    const { state } = this.ctx;
    delete state.permits[permit.userId];
    this.permits.clearTimer(permit.userId);
    await this.ctx.save();
    await this.ctx.safeEdit(permit.messageChannelId, permit.messageId, messages.permitExpired(permit));
    if (this.ctx.watched(permit.userId)) {
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
    const joined = !oldChannelId && !!newChannelId;
    const moved = !!oldChannelId && !!newChannelId && oldChannelId !== newChannelId;
    const left = !!oldChannelId && !newChannelId;

    // Cambio de mute dentro de la misma sesión de voz: ¿lo hizo el bot o alguien más?
    // (la expectativa se consume siempre, aunque el usuario ya no esté vigilado)
    if (oldChannelId && newChannelId && typeof oldMute === 'boolean' && typeof newMute === 'boolean' && oldMute !== newMute) {
      if (!this.mute.consume(userId, newMute) && (w || hasPending)) await this.mute.onExternalTransition(userId, newMute);
    }

    // Una vigilancia vencida (el temporizador aún no corrió) se regulariza antes de cualquier otra cosa:
    // así una reconexión posterior al vencimiento nunca cuenta ni silencia.
    if (w && w.expiresAt <= this.ctx.now()) {
      await this._expireWatch(w.id);
      return;
    }

    // Si el usuario afectado sale o cambia de canal, el padrón de sus votaciones (palabra, inicio o fin
    // anticipado de vigilancia) deja de ser válido; también se cancela su permiso. Esto aplica aunque
    // todavía no esté vigilado (START_WATCH).
    if (moved || left) {
      const polls = this.voting.cancelWhere((p) => p.targetId === userId);
      const permits = this.permits.cancelWhere((p) => p.userId === userId);
      if (polls.length || permits.length) await this.ctx.save();
      const why = left ? 'se desconectó de voz' : 'cambió de canal de voz';
      await this.voting.notifyClosed(polls, `el usuario afectado ${why}`);
      await this.permits.notifyCancelled(permits, why);
    }

    if (w) {
      // Reconexiones: solo cuentan los ciclos COMPLETOS salida -> regreso. Cambiar de canal, mutear o
      // ensordecer no son salidas; un evento repetido no suma porque `awaitingReturn` es un indicador.
      if (left && !w.awaitingReturn) {
        w.awaitingReturn = true;
        await this.ctx.save();
      } else if (joined && w.awaitingReturn) {
        w.awaitingReturn = false;
        w.reconnects += 1;
        await this.ctx.save();
        const limit = this.ctx.config.isolationReconnectLimit;
        if (limit > 0 && w.reconnects >= limit && (await this._tryIsolation(w))) return;
      }
      if (joined || moved) await this.mute.ensureMuted(userId, { joined });
    } else if (joined && hasPending) {
      await this.mute.tryRelease(userId);
    }
  }

  // =============================================================== consulta

  getStatus() {
    return this.lock.run(async () => {
      const { state, discord } = this.ctx;
      const watches = this.watches
        .all()
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map((w) => {
          const vs = discord.getVoiceState(w.userId);
          const permit = state.permits[w.userId] ?? null;
          const poll = this.voting.openPollOf(w.userId);
          return {
            id: w.id,
            userId: w.userId,
            startedAt: w.startedAt,
            expiresAt: w.expiresAt,
            durationSeconds: w.durationSeconds,
            streakCount: w.streakCount,
            reconnects: w.reconnects,
            awaitingReturn: w.awaitingReturn,
            isolationFailure: w.isolationFailure,
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
        type: p.type,
        requesterId: p.requesterId,
        targetId: p.targetId,
        channelId: p.channelId,
        voters: p.roster.length,
        needed: p.needed,
        yes: Object.values(p.votes).filter((v) => v === 'yes').length,
        no: Object.values(p.votes).filter((v) => v === 'no').length,
        createdAt: p.createdAt,
      }));
      return {
        watches,
        polls,
        permits: this.permits.all().map((p) => ({ userId: p.userId, expiresAt: p.expiresAt })),
        streak: { ...state.streak },
        isolations: this.watches.activeIsolations().map((i) => ({ userId: i.userId, until: i.until })),
        isolationReconnectLimit: this.ctx.config.isolationReconnectLimit ?? 0,
        pendingReleases: Object.entries(state.pendingReleases).map(([userId, p]) => ({ userId, since: p.since })),
      };
    });
  }
}

module.exports = { PoliciaService, TICK_MS };
