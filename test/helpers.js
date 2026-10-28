'use strict';

const { PoliciaService } = require('../src/core/service');
const { MemoryStore } = require('../src/storage/jsonStore');
const { DiscordOpError } = require('../src/core/errors');
const { YES, NO } = require('../src/core/voting');
const { createLogger } = require('../src/logger');

/** Reloj controlable: los temporizadores solo avanzan con advance(). */
class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.t = start;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const timer = { id: ++this.seq, at: this.t + ms, fn, every: null };
    this.timers.push(timer);
    return timer.id;
  }
  setInterval(fn, ms) {
    const timer = { id: ++this.seq, at: this.t + ms, fn, every: ms };
    this.timers.push(timer);
    return timer.id;
  }
  clearTimeout(id) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }
  clearInterval(id) {
    this.clearTimeout(id);
  }
  /** Avanza el tiempo ejecutando (y esperando) los temporizadores que venzan en el camino. */
  async advance(ms) {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every) due.at += due.every;
      else this.timers = this.timers.filter((t) => t.id !== due.id);
      await due.fn();
    }
    this.t = target;
  }
  /** Mueve el reloj sin disparar temporizadores (simula un temporizador "perdido"). */
  jump(ms) {
    this.t += ms;
  }
}

/** Discord simulado: estado de voz, mensajes con reacciones y fallos inyectables. */
class FakeDiscord {
  constructor() {
    this.voice = new Map(); // userId -> { channelId, serverMute }
    this.bots = new Set();
    this.messages = new Map(); // id -> { channelId, content, reactions: { [emoji]: Set } }
    this.nextId = 1;
    this.muteCalls = []; // { userId, mute }
    this.sent = [];
    this.service = null;
    this.inflight = [];
    this.failMute = null; // DiscordOpError a lanzar en setMute
    this.failSend = false;
    this.failReactions = false;
    this.channelNames = {};
    // timeouts (aislamiento)
    this.timeouts = new Map(); // userId -> until (timestamp absoluto)
    this.timeoutCalls = []; // { userId, until }
    this.timeoutBlockers = new Map(); // userId -> motivo (dueño / administrador / jerarquía)
    this.failTimeout = null; // DiscordOpError a lanzar en timeoutMember
  }

  getVoiceState(userId) {
    const vs = this.voice.get(userId);
    return vs ? { ...vs } : null;
  }

  async setMute(userId, mute) {
    this.muteCalls.push({ userId, mute });
    if (this.failMute) throw this.failMute;
    const vs = this.voice.get(userId);
    if (!vs) throw new DiscordOpError('NOT_IN_VOICE', 'no está en voz');
    const old = vs.serverMute;
    vs.serverMute = mute;
    if (old !== mute) {
      // Discord entrega el evento mientras el bot sigue procesando: queda en cola detrás del mutex.
      this.inflight.push(
        this.service.onVoiceStateUpdate({
          userId,
          oldChannelId: vs.channelId,
          newChannelId: vs.channelId,
          oldMute: old,
          newMute: mute,
        }),
      );
    }
  }

  async getVoiceChannelMembers(channelId) {
    return [...this.voice.entries()]
      .filter(([, vs]) => vs.channelId === channelId)
      .map(([id]) => ({ id, bot: this.bots.has(id) }));
  }

  async getTimeoutInfo(userId) {
    return { until: this.timeouts.get(userId) ?? null };
  }

  async canTimeout(userId) {
    const reason = this.timeoutBlockers.get(userId);
    return reason ? { ok: false, reason } : { ok: true };
  }

  async timeoutMember(userId, until) {
    this.timeoutCalls.push({ userId, until });
    if (this.failTimeout) throw this.failTimeout;
    this.timeouts.set(userId, until);
  }

  getChannelName(id) {
    return this.channelNames[id] ?? id;
  }

  async sendMessage(channelId, content) {
    if (this.failSend) throw new DiscordOpError('MISSING_PERMISSIONS', 'sin permiso');
    const id = `m${this.nextId++}`;
    this.messages.set(id, { channelId, content, reactions: {} });
    this.sent.push({ id, channelId, content });
    return { id, channelId };
  }

  async editMessage(channelId, messageId, content) {
    const m = this.messages.get(messageId);
    if (!m) throw new DiscordOpError('NOT_FOUND', 'mensaje borrado');
    m.content = content;
  }

  async addReactions(channelId, messageId, emojis) {
    if (this.failReactions) throw new DiscordOpError('MISSING_PERMISSIONS', 'sin permiso');
    const m = this.messages.get(messageId);
    for (const e of emojis) (m.reactions[e] ??= new Set()).add('BOT');
  }

  async fetchReactionUsers(channelId, messageId, emoji) {
    const m = this.messages.get(messageId);
    if (!m) throw new DiscordOpError('NOT_FOUND', 'mensaje borrado');
    return [...(m.reactions[emoji] ?? [])];
  }

  // ---- acciones de "usuarios reales" en el servidor simulado ----

  async flush() {
    while (this.inflight.length) await Promise.all(this.inflight.splice(0));
  }

  async join(userId, channelId, serverMute = false) {
    const old = this.voice.get(userId);
    this.voice.set(userId, { channelId, serverMute });
    await this.service.onVoiceStateUpdate({
      userId,
      oldChannelId: old?.channelId ?? null,
      newChannelId: channelId,
      oldMute: old ? old.serverMute : null,
      newMute: serverMute,
    });
    await this.flush();
  }

  async leave(userId) {
    const old = this.voice.get(userId);
    this.voice.delete(userId);
    await this.service.onVoiceStateUpdate({
      userId,
      oldChannelId: old?.channelId ?? null,
      newChannelId: null,
      oldMute: old ? old.serverMute : null,
      newMute: null,
    });
    await this.flush();
  }

  async move(userId, channelId) {
    const old = this.voice.get(userId);
    this.voice.set(userId, { channelId, serverMute: old.serverMute });
    await this.service.onVoiceStateUpdate({
      userId,
      oldChannelId: old.channelId,
      newChannelId: channelId,
      oldMute: old.serverMute,
      newMute: old.serverMute,
    });
    await this.flush();
  }

  /** Un moderador humano cambia el server mute a mano (el bot no lo esperaba). */
  async modSetMute(userId, mute) {
    const vs = this.voice.get(userId);
    const old = vs.serverMute;
    vs.serverMute = mute;
    await this.service.onVoiceStateUpdate({
      userId,
      oldChannelId: vs.channelId,
      newChannelId: vs.channelId,
      oldMute: old,
      newMute: mute,
    });
    await this.flush();
  }

  async react(messageId, emoji, userId) {
    (this.messages.get(messageId).reactions[emoji] ??= new Set()).add(userId);
    return this.service.onReactionChange(messageId);
  }

  async unreact(messageId, emoji, userId) {
    this.messages.get(messageId).reactions[emoji]?.delete(userId);
    return this.service.onReactionChange(messageId);
  }

  async vote(messageId, userId, yes = true) {
    return this.react(messageId, yes ? YES : NO, userId);
  }

  deleteMessage(messageId) {
    this.messages.delete(messageId);
    return this.service.onMessageDeleted(messageId);
  }

  lastMuteCall(userId) {
    return [...this.muteCalls].reverse().find((c) => c.userId === userId) ?? null;
  }

  /** Último mensaje de votación de cualquier tipo (palabra o administrativa). */
  lastVoteMessage(type) {
    const marker = { START_WATCH: 'INICIAR VIGILANCIA', END_WATCH: 'TERMINAR VIGILANCIA', SPEAK_PERMISSION: 'PERMISO PARA HABLAR' }[type];
    return [...this.sent].reverse().find((m) => (marker ? m.content.includes(marker) : m.content.includes('Votantes habilitados'))) ?? null;
  }

  /** Último mensaje de votación publicado (solicitud de palabra). */
  lastPollMessage() {
    return [...this.sent].reverse().find((m) => m.content.includes('PERMISO PARA HABLAR')) ?? null;
  }
}

const silentLogger = createLogger('error', [], () => {});

/**
 * Crea un entorno completo. `restart()` simula reiniciar el proceso: nuevo servicio sobre el
 * mismo almacén y el mismo Discord (los usuarios siguen en voz).
 */
async function createHarness({
  speak = 120,
  store = new MemoryStore(),
  clock = new FakeClock(),
  discord = new FakeDiscord(),
  punish = false,
} = {}) {
  const config = { guildId: 'G', votingChannelId: 'VC', speakDurationSeconds: speak };
  // Toda vigilancia es un castigo temporal. Por defecto el harness usa un castigo largo (24 h) y el
  // aislamiento desactivado, para que los tests de mutes, votaciones y permisos no dependan de los 2 minutos
  // de producción. `punish: true` o un objeto activa los valores reales de producción (120 s, aislamiento
  // tras 2 reconexiones) con las sobrescrituras indicadas.
  Object.assign(config, { basePunishmentSeconds: 86_400, maxPunishmentSeconds: 86_400, isolationDurationSeconds: 300, isolationReconnectLimit: 0 });
  if (punish) {
    Object.assign(config, {
      basePunishmentSeconds: 120,
      maxPunishmentSeconds: 86_400,
      isolationReconnectLimit: 2,
      ...(punish === true ? {} : punish),
    });
  }
  const h = { clock, discord, store, config };
  const build = async () => {
    h.service = await PoliciaService.create({ store, discord, clock, logger: silentLogger, config });
    discord.service = h.service;
    return h.service;
  };
  await build();
  h.restart = async () => {
    h.service.shutdown();
    await build();
    return h.service;
  };
  h.sentTo = (channelId) => discord.sent.filter((m) => m.channelId === channelId);
  // Acceso al estado: vigilancias activas en memoria (`watch`) y lo realmente persistido (`snapWatch`).
  h.watch = (userId) => Object.values(h.service.state.watches).find((w) => w.userId === userId) ?? null;
  h.snapWatch = (userId) => Object.values(store.snapshot().watches).find((w) => w.userId === userId) ?? null;
  h.watchedIds = () => Object.values(h.service.state.watches).map((w) => w.userId).sort();
  h.snapWatchedIds = () => Object.values(store.snapshot().watches).map((w) => w.userId).sort();
  return h;
}

module.exports = { FakeClock, FakeDiscord, createHarness, YES, NO };
