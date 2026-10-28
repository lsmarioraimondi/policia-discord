'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { Mutex } = require('../src/core/mutex');

test('el mutex ejecuta en orden y sigue funcionando tras un error', async () => {
  const m = new Mutex();
  const log = [];
  const p1 = m.run(async () => {
    await new Promise((r) => setTimeout(r, 15));
    log.push(1);
  });
  const p2 = m.run(async () => {
    log.push(2);
    throw new Error('boom');
  });
  const p3 = m.run(async () => log.push(3));
  await p1;
  await assert.rejects(p2, /boom/);
  await p3;
  assert.deepEqual(log, [1, 2, 3]);
});

test('dos administradores vigilan a personas distintas a la vez: ambas vigilancias son independientes', async () => {
  const h = await createHarness();
  const results = await Promise.all([
    h.service.applyWatch({ by: 'adminA', targetId: 'u1' }),
    h.service.applyWatch({ by: 'adminB', targetId: 'u2' }),
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true], 'no hay ningún bloqueo global');
  assert.deepEqual(h.snapWatchedIds(), ['u1', 'u2']);
  assert.equal(h.sentTo('VC').filter((m) => /VIGILANCIA INICIADA/.test(m.content)).length, 2);
});

test('dos administradores vigilan al mismo usuario a la vez: una sola incorporación', async () => {
  const h = await createHarness();
  await h.discord.join('u2', 'v1');
  await h.service.applyWatch({ by: 'adminA', targetId: 'u1' });
  const results = await Promise.all([
    h.service.applyWatch({ by: 'adminA', targetId: 'u2' }),
    h.service.applyWatch({ by: 'adminB', targetId: 'u2' }),
  ]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['ALREADY_WATCHED', 'ok']);
  assert.equal(h.discord.muteCalls.filter((c) => c.userId === 'u2').length, 1);
});

test('terminar una vigilancia y vigilar a otra persona a la vez: sin estados inconsistentes', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.discord.join('u2', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  const [end, start] = await Promise.all([
    h.service.applyUnwatch({ by: 'mod', targetId: 'u1' }),
    h.service.applyWatch({ by: 'mod', targetId: 'u2' }),
  ]);
  assert.equal(end.ok, true);
  assert.equal(start.ok, true);
  assert.deepEqual(h.snapWatchedIds(), ['u2']);
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.equal(h.discord.getVoiceState('u2').serverMute, true);
  assert.equal(h.clock.timers.length, 1, 'solo el temporizador de u2');
});

test('el mismo vigilado pide palabra dos veces a la vez: una sola votación', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
  const results = await Promise.all([h.service.requestFloor({ userId: 'req' }), h.service.requestFloor({ userId: 'req' })]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['ALREADY_REQUESTED', 'ok']);
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);
  assert.equal(h.discord.sent.filter((m) => /PERMISO PARA HABLAR/.test(m.content)).length, 1);
});

test('votos a favor y fin de la vigilancia en carrera: nunca queda un permiso ni temporizador colgado', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  h.discord.messages.get(r.poll.messageId).reactions['✅'] = new Set(['a']);
  await Promise.all([h.service.onReactionChange(r.poll.messageId), h.service.applyUnwatch({ by: 'mod', targetId: 'req' })]);
  await h.discord.flush();
  const s = h.store.snapshot();
  assert.deepEqual([s.watches, s.permits, s.polls], [{}, {}, {}]);
  assert.equal(h.clock.timers.length, 0);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
});

test('ráfaga de eventos de voz mientras se vota: el estado final es coherente', async () => {
  const h = await createHarness();
  for (const u of ['req', 'a', 'b']) await h.discord.join(u, 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  h.discord.messages.get(r.poll.messageId).reactions['✅'] = new Set(['a', 'b']);
  await Promise.all([
    h.service.onReactionChange(r.poll.messageId),
    h.discord.move('req', 'v2'),
    h.discord.move('req', 'v1'),
  ]);
  await h.discord.flush();
  const s = h.store.snapshot();
  // Cualquiera sea el orden, no puede haber a la vez un permiso y una votación del mismo usuario.
  assert.ok(!(s.permits.req && Object.keys(s.polls).length));
  if (s.permits.req) assert.equal(h.discord.getVoiceState('req').serverMute, false);
  else assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('un fallo de disco al guardar no deja una vigilancia a medio crear', async () => {
  const h = await createHarness();
  h.store.failNextSave = true;
  await assert.rejects(() => h.service.applyWatch({ by: 'mod', targetId: 'u1' }), /disco/);
  assert.deepEqual((await h.service.getStatus()).watches, []);
  assert.deepEqual(h.service.state.streak, { lastUserId: null, count: 0 }, 'la racha se revierte');
  const ok = await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  assert.equal(ok.ok, true, 'el mutex no quedó bloqueado');
  assert.equal(ok.watch.streakCount, 1);
});
