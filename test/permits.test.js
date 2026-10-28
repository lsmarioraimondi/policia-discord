'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { DiscordOpError } = require('../src/core/errors');

/** req vigilado + votantes en v1; la votación queda abierta. */
async function setup(voters = ['a'], opts = {}) {
  const h = await createHarness(opts);
  await h.discord.join('req', 'v1');
  for (const v of voters) await h.discord.join(v, 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
  const res = await h.service.requestFloor({ userId: 'req' });
  return { h, poll: res.poll, msg: res.poll.messageId, voters };
}

async function approve(h, msg, voters) {
  for (const v of voters) await h.discord.vote(msg, v);
}

test('permiso aprobado: unmute, 120 s de permiso y re-mute automático al vencer', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  const permit = h.store.snapshot().permits.req;
  assert.equal(permit.expiresAt - permit.grantedAt, 120_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);

  await h.clock.advance(119_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false, 'sigue hablando antes del vencimiento');
  await h.clock.advance(1_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, true, 'vuelve a silenciarse al vencer');
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.match(h.discord.messages.get(msg).content, /PERMISO VENCIDO/);

  // puede volver a solicitar
  assert.equal((await h.service.requestFloor({ userId: 'req' })).ok, true);
});

test('la duración sale de la configuración (SPEAK_DURATION_SECONDS)', async () => {
  const { h, msg, voters } = await setup(['a'], { speak: 30 });
  await approve(h, msg, voters);
  await h.clock.advance(29_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
  await h.clock.advance(1_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('el bot no vuelve a silenciar durante un permiso vigente', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  const calls = h.discord.muteCalls.length;
  await h.service.tick();
  await h.discord.flush();
  assert.equal(h.discord.muteCalls.length, calls);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
});

test('Discord rechaza el desmuteo: no hay permiso y se informa el error', async () => {
  const { h, msg, voters } = await setup(['a']);
  h.discord.failMute = new DiscordOpError('MISSING_PERMISSIONS', 'sin permiso');
  await approve(h, msg, voters);
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(msg).content, /NO CONCEDIDO/);
  assert.match(h.discord.messages.get(msg).content, /permiso para silenciar/);
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.equal(h.snapWatch('req').botMuted, true, 'el mute sigue siendo del bot');
});

test('permisos de distintos usuarios son independientes', async () => {
  const h = await createHarness();
  for (const u of ['p1', 'p2', 'x']) await h.discord.join(u, 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'p1' });
  await h.service.applyWatch({ by: 'mod', targetId: 'p2' });
  const r1 = await h.service.requestFloor({ userId: 'p1' });
  await h.discord.vote(r1.poll.messageId, 'x'); // roster p1: [p2, x] => 2 necesarios
  await h.discord.vote(r1.poll.messageId, 'p2');
  assert.ok(h.store.snapshot().permits.p1);

  await h.clock.advance(60_000);
  const r2 = await h.service.requestFloor({ userId: 'p2' });
  await h.discord.vote(r2.poll.messageId, 'x');
  await h.discord.vote(r2.poll.messageId, 'p1');
  const permits = h.store.snapshot().permits;
  assert.ok(permits.p1 && permits.p2);
  assert.equal(permits.p2.expiresAt - permits.p1.expiresAt, 60_000);

  await h.clock.advance(60_000); // vence p1 pero no p2
  assert.equal(h.discord.getVoiceState('p1').serverMute, true);
  assert.equal(h.discord.getVoiceState('p2').serverMute, false);
  assert.deepEqual(Object.keys(h.store.snapshot().permits), ['p2']);
  await h.clock.advance(60_000);
  assert.equal(h.discord.getVoiceState('p2').serverMute, true);
});

test('abandonar voz durante el permiso lo cancela; al volver se vuelve a silenciar', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  await h.discord.leave('req');
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.clock.timers.length, 1, 'solo queda el temporizador del castigo: el del permiso se canceló');
  assert.match(h.discord.messages.get(msg).content, /PERMISO CANCELADO/);

  await h.discord.join('req', 'v1', false); // sigue sin silencio (el permiso lo había levantado)
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('cambiar de canal durante el permiso lo cancela y vuelve a silenciar en el canal nuevo', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  await h.discord.move('req', 'v2');
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.equal(h.discord.getVoiceState('req').channelId, 'v2');
});

test('quitar de la vigilancia durante un permiso lo cancela y deja al usuario sin silencio', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  const res = await h.service.applyUnwatch({ by: 'mod', targetId: 'req' });
  assert.equal(res.ok, true);
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
  await h.clock.advance(200_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false, 'el temporizador viejo no actúa');
});

test('terminar la vigilancia durante un permiso vigente lo cancela sin re-silenciar', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  const before = h.discord.muteCalls.length;
  const res = await h.service.applyUnwatch({ by: 'mod', targetId: 'req' });
  assert.equal(res.ok, true);
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.discord.muteCalls.length, before, 'ya estaba habilitado a hablar: no hay nada que liberar');
  await h.clock.advance(200_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
});

test('el barrido cierra permisos vencidos aunque el temporizador se haya perdido', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  h.clock.timers = []; // temporizador perdido
  h.clock.jump(121_000);
  await h.service.tick();
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.deepEqual(h.store.snapshot().permits, {});
});

test('el temporizador de un permiso anterior no cierra un permiso nuevo', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  const oldGrant = h.store.snapshot().permits.req.grantedAt;
  await h.discord.leave('req');
  await h.discord.join('req', 'v1');
  await h.clock.advance(10_000);
  const r = await h.service.requestFloor({ userId: 'req' });
  await h.discord.vote(r.poll.messageId, 'a');
  const second = h.store.snapshot().permits.req;
  assert.notEqual(second.grantedAt, oldGrant);
  await h.service._onPermitTimer('req', oldGrant); // temporizador viejo disparado tarde
  assert.ok(h.store.snapshot().permits.req, 'el permiso nuevo sigue vigente');
});

test('falla el re-mute al vencer: el permiso se cierra igual y se reintenta', async () => {
  const { h, msg, voters } = await setup(['a']);
  await approve(h, msg, voters);
  h.discord.failMute = new DiscordOpError('UNKNOWN', 'caída de la API');
  await h.clock.advance(120_000);
  assert.deepEqual(h.store.snapshot().permits, {}, 'nunca queda un permiso indefinido');
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
  assert.ok(h.discord.sent.some((m) => /No pude volver a silenciar/.test(m.content)));

  h.discord.failMute = null;
  await h.service.tick();
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});
