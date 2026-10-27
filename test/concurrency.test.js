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

test('dos administradores inician patrulla a la vez: solo una se crea', async () => {
  const h = await createHarness();
  const results = await Promise.all([
    h.service.applyStartPatrol({ by: 'adminA', targetId: 'u1' }),
    h.service.applyStartPatrol({ by: 'adminB', targetId: 'u2' }),
  ]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  const watched = Object.keys(h.store.snapshot().patrol.watched);
  assert.equal(watched.length, 1);
  assert.equal(h.sentTo('VC').filter((m) => /PATRULLA INICIADA/.test(m.content)).length, 1);
});

test('dos administradores vigilan al mismo usuario a la vez: una sola incorporación', async () => {
  const h = await createHarness();
  await h.discord.join('u2', 'v1');
  await h.service.applyStartPatrol({ by: 'adminA', targetId: 'u1' });
  const results = await Promise.all([
    h.service.applyWatch({ by: 'adminA', targetId: 'u2' }),
    h.service.applyWatch({ by: 'adminB', targetId: 'u2' }),
  ]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['ALREADY_WATCHED', 'ok']);
  assert.equal(h.discord.muteCalls.filter((c) => c.userId === 'u2').length, 1);
});

test('finalizar y vigilar simultáneos: sin estados inconsistentes', async () => {
  const h = await createHarness();
  await h.discord.join('u2', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  const [fin, watch] = await Promise.all([
    h.service.applyFinalize({ by: 'mod' }),
    h.service.applyWatch({ by: 'mod', targetId: 'u2' }),
  ]);
  assert.equal(fin.ok, true);
  assert.equal(watch.code, 'NO_PATROL', 'se ejecutó después de finalizar, por orden de llegada');
  assert.equal(h.discord.getVoiceState('u2').serverMute, false);
});

test('el mismo vigilado pide palabra dos veces a la vez: una sola votación', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const results = await Promise.all([h.service.requestFloor({ userId: 'req' }), h.service.requestFloor({ userId: 'req' })]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['ALREADY_REQUESTED', 'ok']);
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);
  assert.equal(h.discord.sent.filter((m) => /PERMISO PARA HABLAR/.test(m.content)).length, 1);
});

test('votos a favor y finalización en carrera: nunca queda un permiso ni temporizador colgado', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  h.discord.messages.get(r.poll.messageId).reactions['✅'] = new Set(['a']);
  await Promise.all([h.service.onReactionChange(r.poll.messageId), h.service.applyFinalize({ by: 'mod' })]);
  await h.discord.flush();
  const s = h.store.snapshot();
  assert.deepEqual([s.patrol, s.permits, s.polls], [null, {}, {}]);
  assert.equal(h.clock.timers.length, 0);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
});

test('ráfaga de eventos de voz mientras se vota: el estado final es coherente', async () => {
  const h = await createHarness();
  for (const u of ['req', 'a', 'b']) await h.discord.join(u, 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
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

test('un fallo de disco al guardar no deja una patrulla a medio crear', async () => {
  const h = await createHarness();
  h.store.failNextSave = true;
  await assert.rejects(() => h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' }), /disco/);
  assert.equal((await h.service.getStatus()).active, false);
  const ok = await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  assert.equal(ok.ok, true, 'el mutex no quedó bloqueado');
});
