'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { majority, buildRoster, tally, decide } = require('../src/core/voting');
const { createHarness, YES, NO } = require('./helpers');

test('cálculo de mayorías: floor(n/2)+1', () => {
  const expected = { 1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 6: 4, 7: 4, 10: 6 };
  for (const [n, needed] of Object.entries(expected)) assert.equal(majority(Number(n)), needed, `n=${n}`);
});

test('padrón: excluye solicitante y bots, sin repetidos', () => {
  const { roster, participants } = buildRoster(
    [
      { id: 'req' },
      { id: 'a' },
      { id: 'b' },
      { id: 'b' },
      { id: 'bot1', bot: true },
    ],
    'req',
  );
  assert.deepEqual(roster, ['a', 'b']);
  assert.equal(participants, 3, 'participantes = humanos incluyendo al solicitante');
});

test('recuento: ignora externos y reacciones del bot; ✅+❌ cuenta como ❌', () => {
  const roster = ['a', 'b', 'c', 'd'];
  const r = tally(roster, ['a', 'b', 'c', 'outsider', 'BOT'], ['c', 'x']);
  assert.deepEqual(r.votes, { a: 'yes', b: 'yes', c: 'no' });
  assert.deepEqual([r.yes, r.no], [2, 1]);
});

test('decisión: aprobada al llegar a la mayoría, rechazada cuando ya es imposible', () => {
  assert.equal(decide(5, 3, 2, 2), 'open');
  assert.equal(decide(5, 3, 3, 0), 'approved');
  assert.equal(decide(5, 3, 0, 3), 'rejected');
  assert.equal(decide(5, 3, 1, 2), 'open');
  assert.equal(decide(2, 2, 0, 1), 'rejected');
  assert.equal(decide(1, 1, 0, 1), 'rejected');
  assert.equal(decide(4, 3, 0, 2), 'rejected');
  assert.equal(decide(4, 3, 1, 1), 'open');
});

async function setup(voters, extra = {}) {
  const h = await createHarness(extra);
  await h.discord.join('req', 'v1');
  for (const v of voters) await h.discord.join(v, 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const res = await h.service.requestFloor({ userId: 'req' });
  return { h, res, msg: res.poll?.messageId };
}

test('/pedir-palabra publica el mensaje con padrón, umbral y reacciones del bot', async () => {
  const { h, res } = await setup(['a', 'b', 'c', 'd']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.poll.roster.sort(), ['a', 'b', 'c', 'd']);
  assert.equal(res.poll.needed, 3);
  assert.equal(res.poll.participants, 5);
  const text = h.discord.lastPollMessage().content;
  assert.match(text, /Participantes: 5/);
  assert.match(text, /Votantes habilitados: 4/);
  assert.match(text, /Votos necesarios para aprobar: 3/);
  assert.match(text, /2 minutos/);
  assert.ok(h.discord.messages.get(res.poll.messageId).reactions[YES].has('BOT'));
  assert.ok(h.discord.messages.get(res.poll.messageId).reactions[NO].has('BOT'));
});

test('los bots y el solicitante no cuentan como votantes', async () => {
  const h = await createHarness();
  h.discord.bots.add('musicbot');
  await h.discord.join('req', 'v1');
  await h.discord.join('musicbot', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const res = await h.service.requestFloor({ userId: 'req' });
  assert.deepEqual(res.poll.roster, ['a']);
  assert.equal(res.poll.needed, 1);
  // el solicitante vota a favor de sí mismo: no debe contar
  await h.discord.vote(res.poll.messageId, 'req', true);
  await h.discord.vote(res.poll.messageId, 'musicbot', true);
  assert.equal(h.store.snapshot().polls[res.poll.id].status, 'open');
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('sin votantes habilitados no se inicia la votación ni se concede permiso', async () => {
  const { h, res } = await setup([]);
  assert.deepEqual([res.ok, res.code], [false, 'NO_VOTERS']);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.equal(h.discord.lastPollMessage(), null);
});

test('aprobación inmediata al alcanzar la mayoría (3 de 5)', async () => {
  const { h, res, msg } = await setup(['a', 'b', 'c', 'd', 'e']);
  await h.discord.vote(msg, 'a');
  await h.discord.vote(msg, 'b');
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  await h.discord.vote(msg, 'c');
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
  assert.ok(h.store.snapshot().permits.req);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(msg).content, /PERMISO CONCEDIDO/);
  assert.ok(res.ok);
});

test('rechazo cuando los votos en contra hacen imposible la mayoría', async () => {
  const { h, msg } = await setup(['a', 'b', 'c', 'd', 'e']);
  await h.discord.vote(msg, 'a', false);
  await h.discord.vote(msg, 'b', false);
  assert.ok(Object.keys(h.store.snapshot().polls).length === 1);
  await h.discord.vote(msg, 'c', false);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.equal(h.store.snapshot().permits.req, undefined);
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.match(h.discord.messages.get(msg).content, /RECHAZADO/);
  // puede volver a pedir
  const again = await h.service.requestFloor({ userId: 'req' });
  assert.equal(again.ok, true);
});

test('cambiar y retirar votos', async () => {
  const { h, res, msg } = await setup(['a', 'b', 'c', 'd']); // necesarios: 3
  await h.discord.vote(msg, 'a', true);
  await h.discord.vote(msg, 'b', true);
  // a cambia su voto de ✅ a ❌
  await h.discord.unreact(msg, YES, 'a');
  await h.discord.vote(msg, 'a', false);
  assert.equal(h.store.snapshot().polls[res.poll.id].votes.a, 'no');
  // b retira su voto
  await h.discord.unreact(msg, YES, 'b');
  assert.equal(h.store.snapshot().polls[res.poll.id].votes.b, undefined);
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('un voto doble ✅ y ❌ se resuelve de forma determinista como ❌ y no se cuenta dos veces', async () => {
  const { h, res, msg } = await setup(['a', 'b', 'c']); // necesarios: 2
  await h.discord.vote(msg, 'a', true);
  await h.discord.vote(msg, 'a', false);
  const poll = h.store.snapshot().polls[res.poll.id];
  assert.deepEqual(poll.votes, { a: 'no' });
  await h.discord.vote(msg, 'b', true);
  assert.equal(h.store.snapshot().polls[res.poll.id].status, 'open');
  // a retira ❌ y queda su ✅ => ahora cuenta como a favor
  await h.discord.unreact(msg, NO, 'a');
  assert.equal(h.discord.getVoiceState('req').serverMute, false, '2 a favor => aprobado');
});

test('usuarios externos al padrón no influyen (ni en contra ni a favor)', async () => {
  const { h, res, msg } = await setup(['a', 'b', 'c']);
  await h.discord.join('late', 'v1'); // entra DESPUÉS de crear la solicitud
  await h.discord.vote(msg, 'late', true);
  await h.discord.vote(msg, 'outsider', true);
  assert.deepEqual(h.store.snapshot().polls[res.poll.id].votes, {});
  await h.discord.vote(msg, 'late', false);
  await h.discord.vote(msg, 'outsider', false);
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);
  assert.equal(h.store.snapshot().polls[res.poll.id].roster.length, 3, 'el padrón permanece fijo');
});

test('votaciones simultáneas e independientes en el mismo canal', async () => {
  const h = await createHarness();
  for (const u of ['p1', 'p2', 'x', 'y']) await h.discord.join(u, 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'p1' });
  await h.service.applyWatch({ by: 'mod', targetId: 'p2' });
  const [r1, r2] = await Promise.all([
    h.service.requestFloor({ userId: 'p1' }),
    h.service.requestFloor({ userId: 'p2' }),
  ]);
  assert.ok(r1.ok && r2.ok);
  assert.notEqual(r1.poll.id, r2.poll.id);
  assert.notEqual(r1.poll.messageId, r2.poll.messageId);
  assert.deepEqual(r1.poll.roster.sort(), ['p2', 'x', 'y'], 'p2 puede votar en la solicitud de p1');
  assert.deepEqual(r2.poll.roster.sort(), ['p1', 'x', 'y']);

  // x y p2 votan a favor de p1 (2 de 3): aprobado. La votación de p2 no se ve afectada.
  await h.discord.vote(r1.poll.messageId, 'x');
  await h.discord.vote(r1.poll.messageId, 'p2');
  assert.equal(h.discord.getVoiceState('p1').serverMute, false);
  assert.equal(h.discord.getVoiceState('p2').serverMute, true);
  const polls = h.store.snapshot().polls;
  assert.deepEqual(Object.keys(polls), [r2.poll.id]);
  assert.deepEqual(polls[r2.poll.id].votes, {}, 'ningún voto se filtró a la otra votación');

  // p2 es rechazada por x, y y p1
  await h.discord.vote(r2.poll.messageId, 'x', false);
  await h.discord.vote(r2.poll.messageId, 'y', false);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.ok(h.store.snapshot().permits.p1, 'el permiso de p1 sigue intacto');
  assert.equal(h.store.snapshot().permits.p2, undefined);
});

test('condiciones de /pedir-palabra', async () => {
  const h = await createHarness();
  const req = (userId) => h.service.requestFloor({ userId });
  assert.equal((await req('u1')).code, 'NO_PATROL');

  await h.discord.join('u1', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  assert.equal((await req('a')).code, 'NOT_WATCHED_SELF');

  await h.service.applyWatch({ by: 'mod', targetId: 'off' });
  assert.equal((await req('off')).code, 'NOT_IN_VOICE');

  assert.equal((await req('u1')).ok, true);
  assert.equal((await req('u1')).code, 'ALREADY_REQUESTED');
});

test('no se puede pedir palabra con un permiso vigente', async () => {
  const { h, res, msg } = await setup(['a']);
  await h.discord.vote(msg, 'a');
  assert.ok(h.store.snapshot().permits.req);
  assert.equal((await h.service.requestFloor({ userId: 'req' })).code, 'HAS_PERMIT');
  assert.ok(res.ok);
});

test('si se borra el mensaje de votación, la solicitud se cancela y el padrón no concede nada', async () => {
  const { h, msg } = await setup(['a', 'b']);
  await h.discord.deleteMessage(msg);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  // una reacción tardía sobre un mensaje inexistente es inocua
  const res = await h.service.onReactionChange(msg);
  assert.equal(res.handled, false);
});

test('si el mensaje se borra mientras se procesa una reacción, se cancela sin conceder permiso', async () => {
  const { h, msg } = await setup(['a', 'b']);
  h.discord.messages.get(msg).reactions[YES] = new Set(['a', 'b']);
  h.discord.messages.delete(msg);
  const out = await h.service.onReactionChange(msg);
  assert.equal(out.decision, 'deleted');
  assert.equal(h.store.snapshot().permits.req, undefined);
});

test('si fallan las reacciones automáticas la votación igual queda abierta y se avisa', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  h.discord.failReactions = true;
  const res = await h.service.requestFloor({ userId: 'req' });
  assert.equal(res.ok, true);
  assert.equal(res.reactionsFailed, true);
});

test('si no se puede publicar la votación no se crea la solicitud', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  h.discord.failSend = true;
  const res = await h.service.requestFloor({ userId: 'req' });
  assert.equal(res.code, 'SEND_FAILED');
  assert.deepEqual(h.store.snapshot().polls, {});
});

test('el solicitante que abandona o cambia de canal cancela su votación', async () => {
  for (const action of ['leave', 'move']) {
    const { h, msg } = await setup(['a', 'b']);
    if (action === 'leave') await h.discord.leave('req');
    else await h.discord.move('req', 'v2');
    assert.deepEqual(h.store.snapshot().polls, {}, action);
    assert.match(h.discord.messages.get(msg).content, /CANCELADA/);
    // votos tardíos no tienen efecto
    await h.discord.vote(msg, 'a');
    await h.discord.vote(msg, 'b');
    assert.equal(h.store.snapshot().permits.req, undefined);
  }
});

test('aprobación pero el solicitante ya no está en el canal original: no se concede', async () => {
  const { h, msg } = await setup(['a', 'b']);
  // se mueve sin que el bot reciba aún el evento (carrera): el estado de voz ya cambió
  h.discord.voice.get('req').channelId = 'v2';
  await h.discord.vote(msg, 'a');
  await h.discord.vote(msg, 'b');
  assert.equal(h.store.snapshot().permits.req, undefined);
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
  assert.deepEqual(h.store.snapshot().polls, {});
});

test('finalizar con votaciones abiertas las cancela', async () => {
  const { h, msg } = await setup(['a', 'b']);
  await h.service.applyFinalize({ by: 'mod' });
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(msg).content, /CANCELADA/);
  await h.discord.vote(msg, 'a');
  await h.discord.vote(msg, 'b');
  assert.equal(h.discord.getVoiceState('req').serverMute, false, 'liberado por el fin de patrulla, no por la votación');
});
