'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { DiscordOpError } = require('../src/core/errors');
const { formatStatus } = require('../src/messages');

const MIN = 60_000;
const start = (h, id, by = 'mod') => h.service.applyWatch({ by, targetId: id });
const sent = (h, re) => h.discord.sent.filter((m) => re.test(m.content));

/** Servidor de pruebas con castigos reales (2 minutos, aislamiento tras 2 reconexiones). */
async function world(layout = { v1: ['L', 'P', 'a', 'b'] }, opts = {}) {
  const h = await createHarness({ punish: true, ...opts });
  for (const [channel, users] of Object.entries(layout)) for (const u of users) await h.discord.join(u, channel);
  return h;
}

// ============================================================ modelo: no existe una patrulla

test('el estado no tiene patrulla: vigilar no requiere iniciar ni finalizar nada', async () => {
  const h = await world();
  assert.ok(!('patrol' in h.service.state), 'el estado no tiene el concepto de patrulla');
  assert.deepEqual(Object.keys(h.service.state.watches), []);
  const req = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  assert.equal(req.ok, true, 'se puede solicitar con el sistema recién arrancado');
});

test('una vigilancia tiene id, usuario, inicio, vencimiento, duración, estado, votación autorizante y contadores', async () => {
  const h = await world({ v1: ['L', 'a', 'b'] });
  const req = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  await h.discord.vote(req.poll.messageId, 'a');
  await h.discord.vote(req.poll.messageId, 'b');
  const w = h.snapWatch('L');
  assert.match(w.id, /^[0-9a-f-]{36}$/);
  assert.equal(w.userId, 'L');
  assert.equal(w.status, 'active');
  assert.equal(w.pollId, req.poll.id, 'identifica la votación que autorizó el castigo');
  assert.equal(w.requestedBy, 'mod');
  assert.equal(w.expiresAt - w.startedAt, 2 * MIN);
  assert.equal(w.durationSeconds, 120);
  assert.deepEqual([w.reconnects, w.awaitingReturn, w.isolationAttempted], [0, false, false]);
  assert.deepEqual([w.preMuted, w.botMuted, w.pendingOp, w.manualUnmute], [false, true, null, false]);
});

// ============================================================ inicio

test('inicio con el usuario conectado: lo silencia y anuncia la vigilancia', async () => {
  const h = await world();
  const res = await start(h, 'L');
  assert.equal(res.ok, true);
  assert.equal(res.mute.status, 'muted');
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  assert.equal(h.snapWatch('L').botMuted, true);
  assert.match(sent(h, /VIGILANCIA INICIADA/)[0].content, /<@L>/);
});

test('inicio con el usuario desconectado: queda registrada y se silencia al entrar', async () => {
  const h = await createHarness({ punish: true });
  const res = await start(h, 'L');
  assert.equal(res.mute.status, 'offline');
  assert.equal(h.discord.muteCalls.length, 0);
  await h.discord.join('L', 'v1');
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
});

test('no se puede vigilar a un bot, ni dos veces a la misma persona', async () => {
  const h = await world();
  assert.equal((await h.service.applyWatch({ by: 'mod', targetId: 'bot1', targetIsBot: true })).code, 'TARGET_IS_BOT');
  assert.equal((await start(h, 'L')).ok, true);
  assert.equal((await start(h, 'L')).code, 'ALREADY_WATCHED');
  assert.equal(h.discord.muteCalls.filter((c) => c.userId === 'L').length, 1);
  assert.deepEqual(h.watchedIds(), ['L']);
});

test('vigilancias simultáneas de distintas personas: independientes entre sí', async () => {
  const h = await world();
  const l = await start(h, 'L');
  await h.clock.advance(30_000);
  const p = await start(h, 'P');
  assert.deepEqual(h.watchedIds(), ['L', 'P']);
  assert.notEqual(l.watch.id, p.watch.id);
  assert.equal(p.watch.expiresAt - l.watch.expiresAt, 30_000, 'cada una con su propio vencimiento');
  assert.equal(h.discord.getVoiceState('a').serverMute, false, 'un no vigilado jamás se toca');

  await h.clock.advance(90_000); // vence L, no P
  assert.deepEqual(h.watchedIds(), ['P']);
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
  assert.equal(h.discord.getVoiceState('P').serverMute, true);
  await h.clock.advance(30_000);
  assert.deepEqual(h.watchedIds(), []);
});

test('detección de vigilados: solo se silencia a los vigilados al entrar o cambiar de canal', async () => {
  const h = await createHarness({ punish: true });
  await start(h, 'L');
  await h.discord.join('L', 'v1');
  await h.discord.join('a', 'v1');
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  assert.equal(h.discord.getVoiceState('a').serverMute, false);
  await h.discord.move('L', 'v2');
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  await h.discord.move('a', 'v2');
  assert.ok(h.discord.muteCalls.every((c) => c.userId === 'L'));
});

test('el vigilado que se desconecta y vuelve sigue silenciado mientras dure el castigo', async () => {
  const h = await world(undefined, { punish: { isolationReconnectLimit: 0 } }); // sin aislamiento: se prueban solo las reconexiones
  await start(h, 'L');
  await h.discord.leave('L');
  assert.deepEqual(h.watchedIds(), ['L'], 'salir de voz no termina la vigilancia');
  await h.discord.join('L', 'v1', false); // escenario pesimista: Discord no conservó el mute
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  await h.discord.leave('L');
  const calls = h.discord.muteCalls.length;
  await h.discord.join('L', 'v1', true); // escenario habitual: el mute persiste, sin llamadas redundantes
  assert.equal(h.discord.muteCalls.length, calls);
});

test('si falla Discord al silenciar, se informa y se reintenta con el barrido', async () => {
  const h = await world();
  h.discord.failMute = new DiscordOpError('MISSING_PERMISSIONS', 'x');
  const res = await start(h, 'L');
  assert.equal(res.ok, true);
  assert.equal(res.mute.status, 'error');
  assert.match(res.mute.error, /permiso/);
  assert.equal(h.snapWatch('L').botMuted, false);
  h.discord.failMute = null;
  await h.service.tick();
  assert.equal(h.discord.getVoiceState('L').serverMute, true);
  assert.equal(h.snapWatch('L').botMuted, true);
});

// ============================================================ finalización automática

test('al vencer: se cierra solo, se elimina de las vigilancias activas, libera el mute y publica el mensaje', async () => {
  const h = await world();
  const { watch } = await start(h, 'L');
  await h.clock.advance(119_999);
  assert.deepEqual(h.watchedIds(), ['L']);
  await h.clock.advance(1);

  assert.deepEqual(h.watchedIds(), [], 'desapareció del conjunto de vigilancias activas');
  assert.deepEqual(h.snapWatchedIds(), [], 'y del estado persistido');
  assert.equal(h.service.state.watches[watch.id], undefined);
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
  assert.equal(h.clock.timers.length, 0, 'sin temporizadores ni estados temporales');
  assert.match(sent(h, /cumplió su castigo/).at(-1).content, /<@L> cumplió su castigo de 2 minutos/);
});

test('tras vencer se puede vigilar de nuevo a la misma persona o a cualquier otra, sin bloqueos', async () => {
  const h = await world();
  await start(h, 'L');
  await h.clock.advance(2 * MIN);
  const again = await h.service.requestWatch({ by: 'mod', targetId: 'L' });
  assert.equal(again.ok, true, 'ningún estado obsoleto bloquea la nueva solicitud');
  const other = await h.service.requestWatch({ by: 'mod', targetId: 'P' });
  assert.equal(other.ok, true);
  assert.equal((await start(h, 'L')).ok, true);
  assert.equal((await start(h, 'P')).ok, true);
});

test('la vigilancia vence sin ningún comando ni votación, aunque no quede nadie vigilado', async () => {
  const h = await world();
  await start(h, 'L');
  await start(h, 'P');
  await h.clock.advance(5 * MIN);
  assert.deepEqual(h.watchedIds(), []);
  const st = await h.service.getStatus();
  assert.deepEqual(st.watches, []);
  assert.match(formatStatus(st), /No hay vigilancias activas/);
  assert.equal(sent(h, /cumplió su castigo/).length, 2);
  assert.equal(sent(h, /\?|Aprueban/).length, 0, 'no se publicó ninguna votación para terminar');
});

test('al vencer se cancelan las votaciones y el permiso de palabra de ese usuario, y solo los suyos', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b'] });
  await start(h, 'L');
  await h.clock.advance(60_000);
  await start(h, 'P');
  const speakL = await h.service.requestFloor({ userId: 'L' });
  const speakP = await h.service.requestFloor({ userId: 'P' });
  await h.clock.advance(60_000); // vence L
  assert.match(h.discord.messages.get(speakL.poll.messageId).content, /CANCELADA/);
  assert.deepEqual(Object.keys(h.store.snapshot().polls), [speakP.poll.id], 'la votación de P no se toca');
  assert.deepEqual(h.watchedIds(), ['P']);
});

// ============================================================ fin anticipado

test('fin anticipado: libera el mute propio, cancela votación y permiso y no afecta a los demás', async () => {
  const h = await world({ v1: ['L', 'P', 'a', 'b'] });
  await start(h, 'L');
  await start(h, 'P');
  const speak = await h.service.requestFloor({ userId: 'L' });
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);

  const res = await h.service.applyUnwatch({ by: 'mod', targetId: 'L' });
  assert.equal(res.ok, true);
  assert.equal(res.release, 'released');
  assert.equal(h.discord.getVoiceState('L').serverMute, false);
  assert.equal(h.discord.getVoiceState('P').serverMute, true, 'P sigue vigilado');
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);
  assert.deepEqual(h.watchedIds(), ['P']);
  assert.equal(h.clock.timers.length, 1, 'solo queda el temporizador de P');
  assert.equal((await h.service.applyUnwatch({ by: 'mod', targetId: 'L' })).code, 'NOT_WATCHED');

  await h.clock.advance(5 * MIN);
  assert.equal(sent(h, /<@L> cumplió su castigo/).length, 0, 'no vence un castigo ya terminado');
});

// ============================================================ estado

test('/policia-estado informa vigilancias con vencimiento, canal, mute, votaciones y permisos', async () => {
  const h = await world({ v1: ['L', 'a'] });
  h.discord.channelNames.v1 = 'General';
  await start(h, 'L');
  await h.service.requestFloor({ userId: 'L' });
  const st = await h.service.getStatus();
  assert.equal(st.watches.length, 1);
  assert.equal(st.watches[0].channelName, 'General');
  assert.equal(st.watches[0].serverMute, true);
  assert.equal(st.watches[0].expiresAt - st.watches[0].startedAt, 2 * MIN);
  assert.equal(st.polls.length, 1);
  assert.equal(st.polls[0].needed, 1);
  const text = formatStatus(st);
  assert.match(text, /Vigilancias activas \(1\)/);
  assert.match(text, /castigo de 2 minutos/);
  assert.match(text, /Votaciones pendientes \(1\)/);
  assert.ok(!/patrulla/i.test(text), 'sin referencias a patrullas');
});
