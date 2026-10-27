'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');

const start = (h, target = 'u1', by = 'mod') => h.service.applyStartPatrol({ by, targetId: target });

test('inicio de patrulla con usuario conectado: lo silencia y anuncia', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  const res = await start(h);
  assert.equal(res.ok, true);
  assert.equal(res.mute.status, 'muted');
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  assert.ok(h.store.snapshot().patrol.watched.u1.botMuted);
  assert.match(h.sentTo('VC')[0].content, /PATRULLA INICIADA/);
});

test('inicio de patrulla con usuario desconectado: queda registrado y se silencia al entrar', async () => {
  const h = await createHarness();
  const res = await start(h);
  assert.equal(res.mute.status, 'offline');
  assert.equal(h.discord.muteCalls.length, 0);
  assert.ok(h.store.snapshot().patrol.watched.u1);

  await h.discord.join('u1', 'v1');
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
});

test('no se puede iniciar una segunda patrulla mientras hay una activa', async () => {
  const h = await createHarness();
  await start(h);
  const second = await start(h, 'u2');
  assert.deepEqual([second.ok, second.code], [false, 'PATROL_ACTIVE']);
  assert.equal(h.store.snapshot().patrol.watched.u2, undefined);
});

test('no se puede vigilar a un bot', async () => {
  const h = await createHarness();
  const res = await h.service.applyStartPatrol({ by: 'mod', targetId: 'bot1', targetIsBot: true });
  assert.equal(res.code, 'TARGET_IS_BOT');
  assert.equal(h.store.snapshot().patrol, null);
});

test('imposible vigilar cuando no hay patrulla', async () => {
  const h = await createHarness();
  const res = await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  assert.deepEqual([res.ok, res.code], [false, 'NO_PATROL']);
  const un = await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  assert.equal(un.code, 'NO_PATROL');
  const fin = await h.service.applyFinalize({ by: 'mod' });
  assert.equal(fin.code, 'NO_PATROL');
});

test('incorporación de varios vigilados; duplicado rechazado; los demás no se alteran', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.discord.join('u2', 'v1');
  await h.discord.join('u3', 'v1');
  await start(h, 'u1');
  const callsBefore = h.discord.muteCalls.length;

  const r2 = await h.service.applyWatch({ by: 'mod', targetId: 'u2' });
  assert.equal(r2.mute.status, 'muted');
  const dup = await h.service.applyWatch({ by: 'mod', targetId: 'u2' });
  assert.equal(dup.code, 'ALREADY_WATCHED');
  assert.equal(h.discord.muteCalls.length, callsBefore + 1, 'solo se llamó a la API una vez para u2');

  assert.equal(h.discord.getVoiceState('u3').serverMute, false, 'un no vigilado jamás se toca');
  assert.deepEqual(Object.keys(h.store.snapshot().patrol.watched).sort(), ['u1', 'u2']);
});

test('detección de vigilados: solo los vigilados se silencian al entrar o cambiar de canal', async () => {
  const h = await createHarness();
  await start(h, 'u1');
  await h.discord.join('u1', 'v1');
  await h.discord.join('u9', 'v1');
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  assert.equal(h.discord.getVoiceState('u9').serverMute, false);
  assert.ok(h.discord.muteCalls.every((c) => c.userId === 'u1'));

  await h.discord.move('u1', 'v2');
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  await h.discord.move('u9', 'v2');
  assert.ok(h.discord.muteCalls.every((c) => c.userId === 'u1'));
});

test('el usuario vigilado que se desconecta y vuelve es silenciado de nuevo', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await start(h);
  await h.discord.leave('u1');
  assert.ok(h.store.snapshot().patrol.watched.u1, 'sigue vigilado aunque salga de voz');
  // Escenario pesimista: Discord NO conserva el mute al reconectar.
  await h.discord.join('u1', 'v1', false);
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  // Escenario habitual: el mute persiste y no hay llamadas redundantes.
  await h.discord.leave('u1');
  const calls = h.discord.muteCalls.length;
  await h.discord.join('u1', 'v1', true);
  assert.equal(h.discord.muteCalls.length, calls);
});

test('la patrulla no termina sola cuando el vigilado abandona voz', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await start(h);
  await h.discord.leave('u1');
  await h.clock.advance(60 * 60 * 1000);
  assert.equal((await h.service.getStatus()).active, true);
});

test('/dejar-vigilar libera el mute propio, cancela votación y permiso, y no afecta a los demás', async () => {
  const h = await createHarness();
  for (const u of ['u1', 'u2', 'voterA', 'voterB']) await h.discord.join(u, 'v1');
  await start(h, 'u1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u2' });

  await h.service.requestFloor({ userId: 'u1' });
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);

  const res = await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  assert.equal(res.ok, true);
  assert.equal(res.release, 'released');
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.equal(h.discord.getVoiceState('u2').serverMute, true, 'u2 sigue vigilado y silenciado');
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.deepEqual(Object.keys(h.store.snapshot().patrol.watched), ['u2']);

  const again = await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  assert.equal(again.code, 'NOT_WATCHED');
});

test('la patrulla puede seguir activa con la lista de vigilados vacía', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await start(h);
  await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  const st = await h.service.getStatus();
  assert.equal(st.active, true);
  assert.equal(st.watched.length, 0);
});

test('finalizar patrulla sin vigilados', async () => {
  const h = await createHarness();
  await start(h);
  await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  const res = await h.service.applyFinalize({ by: 'mod' });
  assert.equal(res.ok, true);
  assert.equal(res.summary.watchedCount, 0);
  assert.equal(h.store.snapshot().patrol, null);
});

test('finalizar: libera mutes propios, cancela todo y el bot deja de silenciar', async () => {
  const h = await createHarness();
  for (const u of ['u1', 'u2', 'voter']) await h.discord.join(u, 'v1');
  await start(h, 'u1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u2' });
  await h.service.requestFloor({ userId: 'u1' });

  const res = await h.service.applyFinalize({ by: 'mod' });
  assert.equal(res.ok, true);
  assert.equal(res.summary.released, 2);
  assert.equal(res.summary.pollsCancelled, 1);
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.equal(h.discord.getVoiceState('u2').serverMute, false);

  const calls = h.discord.muteCalls.length;
  await h.discord.leave('u1');
  await h.discord.join('u1', 'v2');
  await h.discord.join('u2', 'v2');
  assert.equal(h.discord.muteCalls.length, calls, 'tras finalizar no hay más muteos automáticos');
  assert.equal((await h.service.getStatus()).active, false);
  assert.equal(h.clock.timers.length, 0, 'sin temporizadores activos');
});

test('estado: informa vigilados, canal, mute, votaciones y permisos', async () => {
  const h = await createHarness();
  h.discord.channelNames.v1 = 'General';
  for (const u of ['u1', 'voterA']) await h.discord.join(u, 'v1');
  await start(h, 'u1');
  await h.service.requestFloor({ userId: 'u1' });
  const st = await h.service.getStatus();
  assert.equal(st.active, true);
  assert.equal(st.patrol.startedBy, 'mod');
  assert.equal(st.watched[0].channelName, 'General');
  assert.equal(st.watched[0].serverMute, true);
  assert.equal(st.polls.length, 1);
  assert.equal(st.polls[0].needed, 1);
});

test('si falla Discord al silenciar, se informa y se reintenta con el barrido', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  const { DiscordOpError } = require('../src/core/errors');
  h.discord.failMute = new DiscordOpError('MISSING_PERMISSIONS', 'x');
  const res = await start(h);
  assert.equal(res.ok, true);
  assert.equal(res.mute.status, 'error');
  assert.match(res.mute.error, /permiso/);
  assert.equal(h.store.snapshot().patrol.watched.u1.botMuted, false);

  h.discord.failMute = null;
  await h.service.tick();
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  assert.equal(h.store.snapshot().patrol.watched.u1.botMuted, true);
});
