'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers');
const { computeDuration, nextPunishment, advanceStreak, ordinal } = require('../src/core/punishment');
const { loadConfig, ISOLATION_RECONNECT_LIMIT } = require('../src/config');
const { formatStatus } = require('../src/messages');
const { DiscordOpError } = require('../src/core/errors');
const { MemoryStore } = require('../src/storage/jsonStore');

const MIN = 60_000;
const polls = (h) => Object.values(h.store.snapshot().polls);
const sentMatching = (h, re) => h.discord.sent.filter((m) => re.test(m.content));
const yesAll = async (h, res, voters) => {
  for (const v of voters) await h.discord.vote(res.poll.messageId, v, true);
};

/** Castiga a `id` por la vía directa (castigo ya aprobado por votación). */
const punish = (h, id) => h.service.applyWatch({ by: 'mod', targetId: id });

/** Servidor de pruebas con castigos activados: layout = { canal: [usuarios] }. */
async function world(layout = { v1: ['L', 'P', 'a', 'b'] }, opts = {}) {
  const h = await createHarness({ punish: true, ...opts });
  for (const [channel, users] of Object.entries(layout)) for (const u of users) await h.discord.join(u, channel);
  return h;
}

/** Ciclo completo de reconexión: sale y vuelve (el mute de servidor persiste en Discord). */
async function cycle(h, userId, channel = 'v1') {
  await h.discord.leave(userId);
  await h.discord.join(userId, channel, true);
}

// ============================================================ reglas puras: duración y racha

test('duración: 2, 4, 8, 16 y 32 minutos para castigos consecutivos', () => {
  const minutes = [1, 2, 3, 4, 5, 6].map((n) => computeDuration(n, 120, 86_400) / 60);
  assert.deepEqual(minutes, [2, 4, 8, 16, 32, 64]);
});

test('duración: el tope máximo se aplica sin alterar el criterio de reincidencia y no desborda', () => {
  assert.equal(computeDuration(10, 120, 86_400), 61_440);
  assert.equal(computeDuration(11, 120, 86_400), 86_400, 'tope de 24 horas');
  assert.equal(computeDuration(12, 120, 86_400), 86_400);
  for (const huge of [60, 1_000, 10 ** 9, Number.MAX_SAFE_INTEGER]) {
    assert.equal(computeDuration(huge, 120, 86_400), 86_400);
    assert.ok(Number.isFinite(computeDuration(huge, 120, 86_400)));
  }
  assert.equal(computeDuration(3, 120, 300), 300, 'tope configurable');
  assert.equal(computeDuration(0, 120, 86_400), 120, 'valores inválidos no producen duraciones imposibles');
});

test('racha: depende del orden global de castigos aprobados, no del historial por usuario', () => {
  const cfg = { basePunishmentSeconds: 120, maxPunishmentSeconds: 86_400 };
  let streak = { lastUserId: null, count: 0 };
  const got = [];
  for (const id of ['Lucas', 'Lucas', 'Pedro', 'Lucas', 'Lucas']) {
    got.push(nextPunishment(streak, id, cfg).durationSeconds / 60);
    streak = advanceStreak(streak, id);
  }
  assert.deepEqual(got, [2, 4, 2, 2, 4]);
  assert.deepEqual(streak, { lastUserId: 'Lucas', count: 2 });
});

test('racha: nextPunishment no modifica nada y ordinal formatea', () => {
  const streak = { lastUserId: 'L', count: 2 };
  assert.deepEqual(nextPunishment(streak, 'L', { basePunishmentSeconds: 120, maxPunishmentSeconds: 86_400 }), {
    count: 3,
    durationSeconds: 480,
  });
  assert.deepEqual(streak, { lastUserId: 'L', count: 2 });
  assert.deepEqual([1, 2, 3, 10, 11].map(ordinal), ['primer', 'segundo', 'tercer', 'décimo', '11.º']);
});

// ============================================================ configuración

test('configuración: variables nuevas con valores por defecto y validación', () => {
  const base = { DISCORD_TOKEN: 't', CLIENT_ID: '123456789012345678', GUILD_ID: '223456789012345678', VOTING_CHANNEL_ID: '323456789012345678' };
  const def = loadConfig(base);
  assert.deepEqual(
    [def.basePunishmentSeconds, def.isolationDurationSeconds, def.maxPunishmentSeconds, def.isolationReconnectLimit],
    [120, 300, 86_400, ISOLATION_RECONNECT_LIMIT],
  );
  assert.equal(ISOLATION_RECONNECT_LIMIT, 2);

  const custom = loadConfig({ ...base, BASE_PUNISHMENT_SECONDS: '60', ISOLATION_DURATION_SECONDS: '600', MAX_PUNISHMENT_SECONDS: '3600' });
  assert.deepEqual([custom.basePunishmentSeconds, custom.isolationDurationSeconds, custom.maxPunishmentSeconds], [60, 600, 3600]);

  assert.throws(() => loadConfig({ ...base, BASE_PUNISHMENT_SECONDS: 'abc' }), /BASE_PUNISHMENT_SECONDS/);
  assert.throws(() => loadConfig({ ...base, BASE_PUNISHMENT_SECONDS: '1' }), /BASE_PUNISHMENT_SECONDS/);
  assert.throws(() => loadConfig({ ...base, ISOLATION_DURATION_SECONDS: '0' }), /ISOLATION_DURATION_SECONDS/);
  assert.throws(() => loadConfig({ ...base, ISOLATION_DURATION_SECONDS: '99999999' }), /ISOLATION_DURATION_SECONDS/);
  assert.throws(() => loadConfig({ ...base, BASE_PUNISHMENT_SECONDS: '500', MAX_PUNISHMENT_SECONDS: '100' }), /no puede ser menor/);
});

test('.env.example documenta las variables nuevas', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  for (const v of ['BASE_PUNISHMENT_SECONDS=120', 'ISOLATION_DURATION_SECONDS=300', 'MAX_PUNISHMENT_SECONDS=86400']) {
    assert.ok(text.includes(v), v);
  }
  assert.ok(!/DISCORD_TOKEN=\S/.test(text), 'sin secretos');
});

// ============================================================ castigo: inicio y vencimiento

test('castigo inicial de 2 minutos con timestamps absolutos; la racha queda registrada', async () => {
  const h = await world();
  const t0 = h.clock.now();
  const res = await punish(h, 'L');
  assert.equal(res.watch.durationSeconds, 120);
  assert.equal(res.watch.streakCount, 1);
  assert.equal(res.watch.startedAt, t0);
  assert.equal(res.watch.expiresAt, t0 + 2 * MIN);
  assert.deepEqual(h.store.snapshot().streak, { lastUserId: 'L', count: 1 });
  assert.equal(h.snapWatch('L').expiresAt, t0 + 2 * MIN, 'persistido');
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  assert.match(sentMatching(h, /VIGILANCIA INICIADA/)[0].content, /Castigo de 2 minutos/);
});

test('vencimiento automático: libera el mute del bot, cancela votaciones/permisos y anuncia, sin votación', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.clock.advance(30_000);
  await punish(h, 'P'); // vence 30 s después que el de L
  const speak = await h.service.requestFloor({ userId: 'L' });
  assert.equal(polls(h).length, 1);

  await h.clock.advance(89_000); // t = 119 s
  assert.deepEqual(h.watchedIds(), ['L', 'P']);
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  await h.clock.advance(1_000);

  assert.deepEqual(h.watchedIds(), ['P'], 'solo P sigue castigado');
  assert.ok(!h.watchedIds().includes('L'), 'L cumplió su castigo');
  assert.equal(h.discord.getVoiceState('L').serverMute, false, 'mute del bot liberado');
  assert.deepEqual(polls(h), [], 'votación de palabra cancelada');
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);
  assert.equal(sentMatching(h, /cumplió su castigo de 2 minutos/).length >= 1, true);
  assert.deepEqual(h.store.snapshot().streak, { lastUserId: 'P', count: 1 }, 'la racha no se reinicia por vencer');
});

test('sin vigilados tras vencer el último castigo no queda ningún estado activo y se conserva la racha', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.clock.advance(2 * MIN);
  const st = await h.service.getStatus();
  assert.deepEqual(st.watches, []);
  assert.deepEqual(st.streak, { lastUserId: 'L', count: 1 });
  assert.equal(h.clock.timers.length, 0, 'sin temporizadores colgados');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
});

test('si sale de voz el tiempo sigue corriendo; al volver sigue silenciado mientras dure el castigo', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.discord.leave('L');
  await h.clock.advance(60_000);
  await h.discord.join('L', 'v1', false); // en este escenario Discord no conservó el mute
  assert.equal(h.discord.getVoiceState('L').serverMute, true, 'sigue castigado');
  assert.equal(h.watch('L').expiresAt - h.watch('L').startedAt, 2 * MIN, 'el reloj no se reinició');
  await h.clock.advance(59_999);
  assert.ok(h.watchedIds().includes('L'));
  await h.clock.advance(1);
  assert.ok(!h.watchedIds().includes('L'));
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
});

test('vencimiento con el usuario desconectado: el mute propio queda pendiente y se libera al volver', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.discord.leave('L');
  await h.clock.advance(2 * MIN);
  assert.ok(!h.watchedIds().includes('L'));
  assert.ok(h.store.snapshot().pendingReleases.L);
  await h.discord.join('L', 'v1', true);
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('vencimiento respeta mutes de moderadores: un silencio previo no se levanta', async () => {
  const h = await world({ v1: ['a', 'b'] });
  await h.discord.join('L', 'v1', true); // ya silenciado por un moderador
  await punish(h, 'L');
  await h.clock.advance(2 * MIN);
  assert.ok(!h.watchedIds().includes('L'));
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  assert.equal(h.discord.muteCalls.filter((c) => c.mute === false).length, 0);
});

test('castigos simultáneos de personas diferentes son independientes', async () => {
  const h = await world();
  const l = await punish(h, 'L');
  await h.clock.advance(30_000);
  const p = await punish(h, 'P');
  assert.equal(p.watch.durationSeconds, 120, 'otra persona: la racha vuelve a 2 minutos');
  assert.equal(p.watch.expiresAt - l.watch.expiresAt, 30_000);

  await h.clock.advance(90_000); // vence L
  assert.deepEqual(h.watchedIds(), ['P']);
  assert.equal(h.discord.getVoiceState('P').serverMute, true);
  await h.clock.advance(30_000); // vence P
  assert.deepEqual(h.watchedIds(), []);
});

test('no se puede iniciar otro castigo contra alguien que ya cumple uno vigente', async () => {
  const h = await world();
  await punish(h, 'L');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'L' })).code, 'ALREADY_WATCHED');
  assert.equal((await h.service.applyWatch({ by: 'mod', targetId: 'L' })).code, 'ALREADY_WATCHED');
  assert.equal(h.service.state.streak.count, 1, 'los intentos rechazados no tocan la racha');
});

// ============================================================ racha consecutiva global

test('duplicación consecutiva: 2, 4, 8, 16 y 32 minutos a la misma persona', async () => {
  const h = await world();
  const got = [];
  for (let i = 0; i < 5; i++) {
    const r = await punish(h, 'L');
    got.push([r.watch.streakCount, r.watch.durationSeconds / 60]);
    await h.clock.advance(r.watch.durationSeconds * 1000);
    assert.ok(!h.watchedIds().includes('L'));
  }
  assert.deepEqual(got, [[1, 2], [2, 4], [3, 8], [4, 16], [5, 32]]);
});

test('la racha se interrumpe cuando otra persona recibe un castigo aprobado: Lucas 2, 4, Pedro 2, Lucas 2, 4', async () => {
  const h = await world();
  const got = [];
  for (const id of ['L', 'L', 'P', 'L', 'L']) {
    const r = await punish(h, id);
    got.push(r.watch.durationSeconds / 60);
    await h.clock.advance(r.watch.durationSeconds * 1000);
  }
  assert.deepEqual(got, [2, 4, 2, 2, 4]);
});

test('el tope configurable limita la duración sin cambiar la secuencia de reincidencia', async () => {
  const h = await world(undefined, { punish: { maxPunishmentSeconds: 300 } });
  const got = [];
  for (let i = 0; i < 4; i++) {
    const r = await punish(h, 'L');
    got.push([r.watch.streakCount, r.watch.durationSeconds]);
    await h.clock.advance(r.watch.durationSeconds * 1000);
  }
  assert.deepEqual(got, [[1, 120], [2, 240], [3, 300], [4, 300]]);
});

test('la racha NO se reinicia por rechazos, solicitudes pendientes, permisos, vencimientos, desconexiones, fines anticipados ni reinicios', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b', 'c'] });
  await punish(h, 'L'); // L #1
  await h.clock.advance(2 * MIN);
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 }, 'vencer no reinicia');

  // solicitud pendiente de otra persona: no cuenta
  const pending = await h.service.requestWatch({ by: 'mod', targetId: 'P' });
  assert.ok(pending.ok);
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 });

  // votación rechazada de otra persona: no cuenta
  await h.discord.vote(pending.poll.messageId, 'a', false);
  await h.discord.vote(pending.poll.messageId, 'b', false);
  assert.deepEqual(polls(h), []);
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 }, 'rechazada: no es castigo');

  // desconexiones y reinicio del bot
  await h.discord.leave('L');
  await h.discord.join('L', 'v1');
  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().streak, { lastUserId: 'L', count: 1 }, 'persistida');

  const again = await punish(h, 'L');
  assert.equal(again.watch.streakCount, 2);
  assert.equal(again.watch.durationSeconds, 240);
});

test('un permiso para hablar no modifica la racha', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  await punish(h, 'L');
  const speak = await h.service.requestFloor({ userId: 'L' });
  await yesAll(h, speak, ['a', 'b']);
  assert.ok(h.store.snapshot().permits.L);
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 });
});

test('la racha persiste tras reiniciar el bot y continúa duplicando', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.clock.advance(2 * MIN);
  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 });
  const r = await punish(h, 'L');
  assert.equal(r.watch.durationSeconds, 240);
});

// ============================================================ votaciones: mensajes y duración aplicada

test('la votación de inicio muestra duración propuesta y el resultado la duración aplicada', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  const req = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  const body = h.discord.messages.get(req.poll.messageId).content;
  assert.match(body, /¿Aprueban castigar a <@L> durante 2 minutos\?/);
  assert.match(body, /primer castigo de la racha/);
  assert.equal(h.service.state.streak.count, 0, 'una solicitud pendiente no cuenta');

  await yesAll(h, req, ['a', 'b']);
  assert.equal(polls(h).length, 0);
  const result = h.discord.messages.get(req.poll.messageId).content;
  assert.match(result, /Aprobada/);
  assert.match(result, /Castigo de 2 minutos \(primer castigo de la racha\)/);
  assert.match(result, /vence/);
});

test('mensaje de votación: "¿Aprueban castigar a @Lucas durante 8 minutos? Es su tercer castigo consecutivo."', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b'] });
  for (let i = 0; i < 2; i++) {
    const r = await punish(h, 'L');
    await h.clock.advance(r.watch.durationSeconds * 1000);
  }
  const req = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  assert.match(
    h.discord.messages.get(req.poll.messageId).content,
    /¿Aprueban castigar a <@L> durante 8 minutos\? Es su tercer castigo consecutivo\./,
  );
  assert.equal(req.poll.proposedSeconds, 480);
  await yesAll(h, req, ['a', 'b', 'P']);
  assert.equal(h.watch('L').durationSeconds, 480);
  assert.match(h.discord.messages.get(req.poll.messageId).content, /Castigo de 8 minutos \(tercer castigo consecutivo\)/);
});

test('si la racha cambia entre la propuesta y la aprobación, se aplica la duración vigente y se aclara', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b'] });
  const first = await punish(h, 'L');
  await h.clock.advance(first.watch.durationSeconds * 1000); // L #1 cumplido
  const forL = await h.service.requestWatch({ by: 'mod', targetId: 'L' }); // propone 4 minutos
  const forP = await h.service.requestWatch({ by: 'mod', targetId: 'P' }); // propone 2 minutos
  assert.equal(forL.poll.proposedSeconds, 240);

  await yesAll(h, forP, ['a', 'b']); // P recibe su castigo: rompe la racha de L
  await yesAll(h, forL, ['a', 'b']);
  assert.equal(h.watch('L').durationSeconds, 120, 'la racha ya no es de L: 2 minutos');
  assert.match(h.discord.messages.get(forL.poll.messageId).content, /se había propuesto 4 minutos/);
});

test('una votación rechazada no cuenta como castigo', async () => {
  const h = await world({ v1: ['L', 'a', 'b', 'c'] });
  const req = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  await h.discord.vote(req.poll.messageId, 'a', false);
  await h.discord.vote(req.poll.messageId, 'b', false);
  assert.deepEqual(h.service.state.streak, { lastUserId: null, count: 0 });
  const r = await punish(h, 'L');
  assert.equal(r.watch.durationSeconds, 120);
});

// ============================================================ finalización anticipada

test('finalización anticipada por votación: no borra la racha y cancela el temporizador', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b'] });
  await punish(h, 'L');
  await punish(h, 'P');
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'L' });
  await yesAll(h, rm, ['a', 'b']);
  assert.deepEqual(h.watchedIds(), ['P']);
  assert.deepEqual(h.service.state.streak, { lastUserId: 'P', count: 1 });
  assert.equal(h.clock.timers.length, 1, 'solo queda el temporizador de P');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);

  await h.clock.advance(5 * MIN);
  assert.equal(sentMatching(h, /<@L> cumplió su castigo/).length, 0, 'no vence un castigo ya terminado');
  assert.deepEqual(h.watchedIds(), []);
});

test('terminar anticipadamente a L y castigarlo de nuevo cuenta como consecutivo (4 minutos)', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  await punish(h, 'L');
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'L' });
  await yesAll(h, rm, ['a', 'b']);
  const r = await punish(h, 'L');
  assert.equal(r.watch.durationSeconds, 240);
});

// ============================================================ permisos para hablar

test('el permiso de palabra no extiende el castigo: si vence antes, el castigo termina y el permiso se cancela', async () => {
  const h = await world({ v1: ['L', 'a'] });
  await punish(h, 'L'); // vence a los 120 s
  await h.clock.advance(60_000);
  const speak = await h.service.requestFloor({ userId: 'L' });
  await yesAll(h, speak, ['a']);
  const permit = h.store.snapshot().permits.L;
  assert.equal(permit.expiresAt - h.clock.now(), 120_000, 'el permiso dura 120 s desde la aprobación (hasta 180 s)');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);

  await h.clock.advance(60_000); // vence el castigo con el permiso todavía vigente
  assert.deepEqual(h.watchedIds(), []);
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADO/);
  const calls = h.discord.muteCalls.length;
  await h.clock.advance(120_000);
  assert.equal(h.discord.muteCalls.length, calls, 'nadie vuelve a silenciar al usuario');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
});

test('al vencer el castigo se cancelan la solicitud de palabra y la votación de fin anticipado', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  await punish(h, 'L');
  const speak = await h.service.requestFloor({ userId: 'L' });
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'L' });
  assert.equal(polls(h).length, 2);
  await h.clock.advance(2 * MIN);
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);
  assert.match(h.discord.messages.get(rm.poll.messageId).content, /CANCELADA/);
  await yesAll(h, rm, ['a', 'b']); // votos tardíos: sin efecto
  assert.deepEqual(h.watchedIds(), []);
});

// ============================================================ reconexiones y aislamiento

test('una reconexión (salida y regreso) se cuenta pero no aísla', async () => {
  const h = await world();
  await punish(h, 'L');
  await h.discord.leave('L');
  assert.equal(h.watch('L').awaitingReturn, true);
  assert.equal(h.watch('L').reconnects, 0, 'la salida sola no cuenta');
  await h.discord.join('L', 'v1', true);
  assert.deepEqual([h.watch('L').reconnects, h.watch('L').awaitingReturn], [1, false]);
  assert.equal(h.discord.timeoutCalls.length, 0);
  assert.ok(h.watchedIds().includes('L'));
});

test('dos reconexiones aplican el aislamiento de 5 minutos, terminan el castigo y conservan la racha', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L');
  await h.clock.advance(10_000);
  const tIso = h.clock.now();
  await cycle(h, 'L');

  assert.deepEqual(h.discord.timeoutCalls, [{ userId: 'L', until: tIso + 5 * MIN }]);
  assert.deepEqual(h.watchedIds(), [], 'deja de estar vigilado');
  assert.deepEqual(h.service.state.streak, { lastUserId: 'L', count: 1 }, 'la racha no cambia');
  assert.equal(h.discord.getVoiceState('L').serverMute, false, 'se libera el mute del bot');
  const iso = h.store.snapshot().isolations.L;
  assert.equal(iso.until, tIso + 5 * MIN);
  assert.equal(iso.durationSeconds, 300);
  assert.equal(h.clock.timers.length, 0, 'sin temporizadores de castigo');
  const msg = sentMatching(h, /AISLAMIENTO/)[0].content;
  assert.match(msg, /<@L>/);
  assert.match(msg, /5 minutos/);
  assert.match(msg, /no se suman minutos/);
  assert.equal(sentMatching(h, /cumplió su castigo/).length, 0, 'no es un vencimiento normal');
});

test('el aislamiento no cuenta como castigo nuevo: el siguiente castigo a L sigue la secuencia (4 minutos)', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  assert.ok(h.store.snapshot().isolations.L);
  const next = await punish(h, 'L');
  assert.equal(next.watch.durationSeconds, 240);
  assert.equal(next.watch.reconnects, 0, 'contador nuevo para el castigo nuevo');
});

test('cambiar de canal no cuenta como reconexión', async () => {
  const h = await world({ v1: ['L', 'a'], v2: ['b'] });
  await punish(h, 'L');
  for (const ch of ['v2', 'v1', 'v2', 'v1', 'v2']) await h.discord.move('L', ch);
  assert.deepEqual([h.watch('L').reconnects, h.watch('L').awaitingReturn], [0, false]);
  assert.equal(h.discord.timeoutCalls.length, 0);
});

test('cambios de mute o ensordecimiento no cuentan como salida ni regreso', async () => {
  const h = await world();
  await punish(h, 'L');
  for (const m of [false, true, false, true]) await h.discord.modSetMute('L', m);
  await h.service.onVoiceStateUpdate({ userId: 'L', oldChannelId: 'v1', newChannelId: 'v1', oldMute: true, newMute: true }); // p. ej. ensordecer
  assert.deepEqual([h.watch('L').reconnects, h.watch('L').awaitingReturn], [0, false]);
});

test('el ingreso inicial no es una reconexión', async () => {
  const h = await createHarness({ punish: true });
  await punish(h, 'L'); // desconectado al empezar el castigo
  await h.discord.join('L', 'v1');
  assert.deepEqual([h.watch('L').reconnects, h.watch('L').awaitingReturn], [0, false]);
});

test('los eventos duplicados no suman: salida repetida y regreso repetido cuentan un solo ciclo', async () => {
  const h = await world();
  await punish(h, 'L');
  const left = { userId: 'L', oldChannelId: 'v1', newChannelId: null, oldMute: true, newMute: null };
  const joined = { userId: 'L', oldChannelId: null, newChannelId: 'v1', oldMute: null, newMute: true };
  await h.service.onVoiceStateUpdate(left);
  await h.service.onVoiceStateUpdate(left);
  await h.service.onVoiceStateUpdate(joined);
  await h.service.onVoiceStateUpdate(joined);
  assert.equal(h.watch('L').reconnects, 1);
  assert.equal(h.discord.timeoutCalls.length, 0);
});

test('volver a cualquier canal de voz del servidor cuenta como regreso', async () => {
  const h = await world({ v1: ['L', 'a'], v2: ['b'] });
  await punish(h, 'L');
  await h.discord.leave('L');
  await h.discord.join('L', 'v2', true);
  await h.discord.leave('L');
  await h.discord.join('L', 'v2', true);
  assert.equal(h.discord.timeoutCalls.length, 1);
  assert.deepEqual(h.watchedIds(), []);
});

test('si el castigo vence con el usuario desconectado, regresar después no genera aislamiento', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L'); // 1 reconexión
  await h.clock.advance(100_000);
  await h.discord.leave('L');
  await h.clock.advance(21_000); // vence mientras está desconectado
  assert.deepEqual(h.watchedIds(), []);
  await h.discord.join('L', 'v1', true);
  assert.equal(h.discord.timeoutCalls.length, 0);
  assert.deepEqual(h.store.snapshot().isolations, {});
});

test('desconexión justo cuando está por vencer: el regreso posterior al vencimiento (temporizador perdido) no cuenta', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L'); // 1 reconexión
  await h.discord.leave('L');
  h.clock.timers = []; // el temporizador se perdió
  h.clock.jump(2 * MIN + 1);
  await h.discord.join('L', 'v1', true); // 2.ª reconexión, pero el castigo ya venció
  assert.equal(h.discord.timeoutCalls.length, 0, 'sin aislamiento');
  assert.deepEqual(h.watchedIds(), [], 'se regulariza el vencimiento primero');
  assert.equal(h.discord.getVoiceState('L').serverMute, false, 'no vuelve a silenciarse');
  assert.equal(sentMatching(h, /cumplió su castigo/).length, 1);
});

test('el contador es independiente por persona y se reinicia con cada castigo nuevo', async () => {
  const h = await world();
  await punish(h, 'L');
  await punish(h, 'P');
  await cycle(h, 'L');
  await cycle(h, 'P');
  assert.deepEqual([h.watch('L').reconnects, h.watch('P').reconnects], [1, 1]);
  assert.equal(h.discord.timeoutCalls.length, 0, '1 + 1 no es 2 para nadie');

  await h.clock.advance(2 * MIN); // vencen ambos
  const second = await punish(h, 'L'); // castigo nuevo de L
  assert.equal(second.watch.reconnects, 0);
  await cycle(h, 'L');
  assert.equal(h.watch('L').reconnects, 1);
  assert.equal(h.discord.timeoutCalls.length, 0);
});

test('el aislamiento se intenta como máximo una vez por castigo (aunque falle)', async () => {
  const h = await world();
  h.discord.timeoutBlockers.set('L', 'es el dueño del servidor (Discord no permite aislarlo)');
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  const failedMsgs = sentMatching(h, /no pude aplicarle el aislamiento/);
  assert.equal(failedMsgs.length, 1);
  assert.match(failedMsgs[0].content, /dueño del servidor/);
  assert.match(failedMsgs[0].content, /vigilancia original continúa/);
  assert.ok(h.watchedIds().includes('L'), 'se conserva la vigilancia original');
  assert.deepEqual(h.store.snapshot().isolations, {}, 'no se considera aislado');
  assert.match(h.watch('L').isolationFailure, /dueño/);

  await cycle(h, 'L');
  await cycle(h, 'L');
  assert.equal(sentMatching(h, /no pude aplicarle el aislamiento/).length, 1, 'sin reintentos');
  assert.equal(h.discord.timeoutCalls.length, 0);
  assert.equal(h.discord.getVoiceState('L').serverMute, true, 'sigue silenciado');
  await h.clock.advance(2 * MIN);
  assert.deepEqual(h.watchedIds(), [], 'el castigo vence con normalidad');
});

test('fallo de la API al aplicar el timeout: se informa sin romper el estado y la vigilancia continúa', async () => {
  const h = await world();
  await punish(h, 'L');
  h.discord.failTimeout = new DiscordOpError('MISSING_PERMISSIONS', 'Missing Permissions');
  await cycle(h, 'L');
  await cycle(h, 'L');
  assert.equal(h.discord.timeoutCalls.length, 1);
  assert.deepEqual(h.store.snapshot().isolations, {});
  assert.match(sentMatching(h, /no pude aplicarle el aislamiento/)[0].content, /Aislar temporalmente a miembros/);
  assert.ok(h.watchedIds().includes('L'));
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  const st = await h.service.getStatus();
  assert.match(st.watches[0].isolationFailure, /Discord rechazó el timeout/);
  assert.match(formatStatus(st), /aislamiento no aplicado/);
});

test('un timeout vigente de otro moderador no se sobrescribe ni se acorta', async () => {
  const h = await world();
  const modUntil = h.clock.now() + 60 * MIN;
  h.discord.timeouts.set('L', modUntil);
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  assert.equal(h.discord.timeoutCalls.length, 0, 'el bot no toca el timeout ajeno');
  assert.equal(h.discord.timeouts.get('L'), modUntil);
  assert.match(sentMatching(h, /no pude aplicarle el aislamiento/)[0].content, /otro moderador/);
  assert.ok(h.watchedIds().includes('L'));
  assert.deepEqual(h.store.snapshot().isolations, {});
});

test('un timeout viejo ya vencido no impide el aislamiento', async () => {
  const h = await world();
  h.discord.timeouts.set('L', h.clock.now() - MIN);
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  assert.equal(h.discord.timeoutCalls.length, 1);
  assert.ok(h.store.snapshot().isolations.L);
});

test('restricciones de Discord (administrador, jerarquía) se informan y no rompen nada', async () => {
  for (const reason of [
    'tiene el permiso de Administrador (Discord no permite aislar administradores)',
    'su rol más alto está por encima o al mismo nivel que el del bot (jerarquía de roles)',
  ]) {
    const h = await world();
    h.discord.timeoutBlockers.set('L', reason);
    await punish(h, 'L');
    await cycle(h, 'L');
    await cycle(h, 'L');
    assert.ok(sentMatching(h, /no pude aplicarle el aislamiento/)[0].content.includes(reason));
    assert.ok(h.watchedIds().includes('L'));
  }
});

test('el aislamiento no agrega minutos ni cambia castigos futuros; usa ISOLATION_DURATION_SECONDS', async () => {
  const h = await world(undefined, { punish: { isolationDurationSeconds: 600 } });
  await punish(h, 'L');
  await cycle(h, 'L');
  const t = h.clock.now();
  await cycle(h, 'L');
  assert.equal(h.store.snapshot().isolations.L.until, t + 10 * MIN);
  assert.equal(h.discord.timeouts.get('L'), t + 10 * MIN);
  await h.clock.advance(30 * MIN);
  assert.equal(h.discord.timeoutCalls.length, 1, 'el bot no extiende ni reaplica el timeout');
});

test('aislamiento: se canceló la votación y el permiso del castigado', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  await punish(h, 'L');
  const speak = await h.service.requestFloor({ userId: 'L' });
  await cycle(h, 'L'); // la salida ya cancela la votación de palabra
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);
  await cycle(h, 'L');
  assert.deepEqual(h.watchedIds(), []);
});

// ============================================================ reinicios

test('reinicio durante un castigo: no se reinician los 2 minutos', async () => {
  const h = await world();
  const r = await punish(h, 'L');
  await h.clock.advance(70_000);
  await h.restart();
  await h.service.recover();
  assert.equal(h.watch('L').expiresAt, r.watch.expiresAt);
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  await h.clock.advance(49_999);
  assert.ok(h.watchedIds().includes('L'));
  await h.clock.advance(1);
  assert.ok(!h.watchedIds().includes('L'), 'vence a los 120 s originales, no a 120 s desde el reinicio');
});

test('castigo vencido durante el apagado: se regulariza al volver y se publica', async () => {
  const h = await world();
  await punish(h, 'L');
  await punish(h, 'P');
  h.clock.jump(5 * MIN);
  await h.restart();
  const info = await h.service.recover();
  assert.equal(info.watchesServed, 2);
  assert.deepEqual(h.watchedIds(), []);
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
  assert.ok(sentMatching(h, /<@L> cumplió su castigo/).length === 1);
  assert.match(h.discord.sent.at(-1).content, /Castigos vencidos durante el apagado: 2/);
  assert.equal(h.clock.timers.length, 0);
});

test('los contadores de reconexión y las salidas pendientes sobreviven a un reinicio', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L'); // 1 reconexión
  await h.discord.leave('L'); // salida pendiente de regreso
  await h.restart();
  await h.service.recover();
  assert.deepEqual([h.watch('L').reconnects, h.watch('L').awaitingReturn], [1, true]);
  await h.discord.join('L', 'v1', true); // el regreso tras el reinicio completa el 2.º ciclo
  assert.equal(h.discord.timeoutCalls.length, 1);
  assert.deepEqual(h.watchedIds(), []);
});

test('reinicio durante un aislamiento: se conserva, no se reaplica ni se extiende y se poda al vencer', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  const iso = h.store.snapshot().isolations.L;
  await h.clock.advance(2 * MIN);

  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().isolations.L, iso, 'sigue registrado con su vencimiento original');
  assert.equal(h.discord.timeoutCalls.length, 1, 'no se vuelve a aplicar');
  assert.equal((await h.service.getStatus()).isolations[0].until, iso.until);

  h.clock.jump(4 * MIN); // pasa el vencimiento del aislamiento
  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().isolations, {});
  assert.equal(h.discord.timeoutCalls.length, 1);
  assert.equal(h.discord.timeouts.get('L'), iso.until, 'el timeout de Discord nunca se modificó');
});

test('el barrido poda aislamientos vencidos', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L');
  await cycle(h, 'L');
  h.clock.jump(6 * MIN);
  await h.service.tick();
  assert.deepEqual(h.store.snapshot().isolations, {});
});

// ============================================================ carreras temporizador / eventos

test('el barrido cierra un castigo vencido aunque el temporizador se haya perdido', async () => {
  const h = await world();
  await punish(h, 'L');
  h.clock.timers = [];
  h.clock.jump(2 * MIN + 1);
  await h.service.tick();
  assert.deepEqual(h.watchedIds(), []);
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
});

test('el temporizador de un castigo anterior no cierra un castigo nuevo del mismo usuario', async () => {
  const h = await world();
  const first = await punish(h, 'L');
  await h.clock.advance(2 * MIN);
  const second = await punish(h, 'L');
  assert.notEqual(first.watch.id, second.watch.id);
  await h.service._onWatchTimer(first.watch.id); // temporizador viejo disparado tarde
  assert.ok(h.watchedIds().includes('L'));
  assert.equal(h.watch('L').id, second.watch.id);
});

test('un temporizador que salta antes de tiempo se reprograma sin cerrar el castigo', async () => {
  const h = await world();
  const r = await punish(h, 'L');
  await h.clock.advance(30_000);
  await h.service._onWatchTimer(r.watch.id);
  assert.ok(h.watchedIds().includes('L'));
  assert.equal(h.clock.timers.length, 1, 'reprogramado');
  await h.clock.advance(90_000);
  assert.deepEqual(h.watchedIds(), []);
});

test('vencimiento y votación de fin anticipado simultáneos: un solo cierre y estado coherente', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  await punish(h, 'L');
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'L' });
  h.discord.messages.get(rm.poll.messageId).reactions['✅'] = new Set(['a', 'b']);
  await h.clock.advance(2 * MIN - 1);
  await Promise.all([h.clock.advance(1), h.service.onReactionChange(rm.poll.messageId)]);
  await h.discord.flush();
  assert.deepEqual(h.watchedIds(), []);
  assert.deepEqual(polls(h), []);
  assert.equal(h.clock.timers.length, 0);
  const closes = sentMatching(h, /cumplió su castigo|dejó de estar vigilado/);
  assert.equal(closes.length, 1, 'solo un anuncio de cierre');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
});

test('vencimiento y reconexión simultáneos: la reconexión tardía no aísla', async () => {
  const h = await world();
  await punish(h, 'L');
  await cycle(h, 'L');
  await h.discord.leave('L');
  await h.clock.advance(2 * MIN - 5_000);
  await Promise.all([h.clock.advance(5_000), h.discord.join('L', 'v1', true)]);
  await h.discord.flush();
  assert.equal(h.discord.timeoutCalls.length, 0);
  assert.deepEqual(h.watchedIds(), []);
});

// ============================================================ estado

test('/policia-estado muestra castigo, reconexiones, racha y aislamientos', async () => {
  const h = await world();
  await punish(h, 'L');
  await punish(h, 'P');
  await cycle(h, 'P');
  let text = formatStatus(await h.service.getStatus());
  assert.match(text, /castigo de 2 minutos \(primer castigo de la racha\), vence/);
  assert.match(text, /reconexiones 1\/2/);
  assert.match(text, /Racha:\*\* último castigo a <@P>/);

  await cycle(h, 'P');
  text = formatStatus(await h.service.getStatus());
  assert.match(text, /Aislamientos vigentes:\*\* <@P>/);
  assert.match(text, /Racha/);
});
