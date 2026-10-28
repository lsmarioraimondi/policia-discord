'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { buildRoster, POLL_TYPES } = require('../src/core/voting');
const { formatStatus } = require('../src/messages');

const polls = (h) => Object.values(h.store.snapshot().polls);
const muted = (h, id) => h.discord.getVoiceState(id)?.serverMute;
const msgOf = (res) => res.poll.messageId;
const yesAll = async (h, res, voters) => {
  for (const v of voters) await h.discord.vote(msgOf(res), v, true);
};
const noAll = async (h, res, voters) => {
  for (const v of voters) await h.discord.vote(msgOf(res), v, false);
};

/** Servidor de pruebas: cada entrada es canal -> usuarios. */
async function world(layout, { bots = [], punish = true } = {}) {
  const h = await createHarness({ punish });
  for (const b of bots) h.discord.bots.add(b);
  for (const [channel, users] of Object.entries(layout)) for (const u of users) await h.discord.join(u, channel);
  return h;
}

// ============================================================ padrón (reglas puras)

test('buildRoster acepta varios excluidos y no cuenta dos veces a la misma persona', () => {
  const { roster, participants } = buildRoster(
    [{ id: 'w1' }, { id: 'w2' }, { id: 'a' }, { id: 'a' }, { id: 'b' }, { id: 'bot', bot: true }],
    new Set(['w1', 'w2']),
  );
  assert.deepEqual(roster, ['a', 'b']);
  assert.equal(participants, 4);
  assert.deepEqual(buildRoster([{ id: 'x' }, { id: 'y' }], ['x']).roster, ['y']);
});

// ============================================================ START_WATCH: /vigilar

test('/vigilar solo publica la votación en el canal configurado; no hay vigilancia, mute ni patrulla', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c'] }, { bots: ['bot1'] });
  await h.discord.join('bot1', 'v1');
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  assert.equal(res.ok, true);
  const poll = res.poll;
  assert.equal(poll.type, POLL_TYPES.START_WATCH);
  assert.deepEqual(poll.roster.sort(), ['a', 'b', 'c'], 'sin el afectado ni bots');
  assert.equal(poll.needed, 2, 'floor(3/2)+1');
  assert.equal(poll.targetId, 'target');
  assert.equal(poll.requesterId, 'mod');

  const text = h.discord.lastVoteMessage('START_WATCH').content;
  assert.match(text, /INICIAR VIGILANCIA/);
  assert.match(text, /Votantes habilitados: 3/);
  assert.match(text, /Votos necesarios para aprobar: 2/);
  assert.match(text, /¿Aprueban castigar a <@target> durante 2 minutos\?/);
  assert.equal(h.discord.messages.get(poll.messageId).channelId, 'VC');
  assert.ok(h.discord.messages.get(poll.messageId).reactions['✅'].has('BOT'));

  assert.deepEqual(h.snapWatchedIds(), []);
  assert.equal(muted(h, 'target'), false);
  assert.equal(h.discord.muteCalls.length, 0);
});

test('START_WATCH aprobada: aplica el mute, inicia el castigo y registra la votación que lo autorizó', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c', 'd'] });
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' }); // 4 votantes: 3 necesarios
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(h.snapWatchedIds(), [], '2 de 4 no alcanza: la mayoría es sobre el total habilitado, no sobre quienes votaron');
  await yesAll(h, res, ['c']);

  assert.deepEqual(h.snapWatchedIds(), ['target']);
  assert.equal(h.snapWatch('target').pollId, res.poll.id);
  assert.equal(h.snapWatch('target').requestedBy, 'mod');
  assert.equal(muted(h, 'target'), true);
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Castigo de 2 minutos/);
});

test('START_WATCH rechazada: no se aplica ninguna sanción', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c'] }); // 3 votantes: 2 necesarios
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  await noAll(h, res, ['a']);
  assert.equal(polls(h).length, 1);
  await noAll(h, res, ['b']);
  assert.deepEqual(polls(h), []);
  assert.deepEqual(h.snapWatchedIds(), []);
  assert.equal(muted(h, 'target'), false);
  assert.equal(h.discord.muteCalls.length, 0);
  assert.deepEqual(h.service.state.streak, { lastUserId: null, count: 0 }, 'no es un castigo');
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Rechazada/);
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'target' })).ok, true, 'se puede volver a solicitar');
});

test('START_WATCH: el afectado no vota y los votos ajenos al padrón no cuentan', async () => {
  const h = await world({ v1: ['target', 'a'], v2: ['other'] });
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' }); // 1 votante
  await h.discord.vote(msgOf(res), 'target', true);
  await h.discord.vote(msgOf(res), 'other', true);
  assert.deepEqual(h.snapWatchedIds(), []);
  await h.discord.vote(msgOf(res), 'a', true);
  assert.deepEqual(h.snapWatchedIds(), ['target']);
});

test('/vigilar: el afectado debe estar en voz, no ser bot, no estar vigilado y debe haber votantes humanos', async () => {
  const h = await world({ v1: ['alone', 'L', 'a'] }, { bots: ['bot1'] });
  await h.discord.join('bot1', 'v2');
  await h.discord.join('alone2', 'v3');
  await h.discord.join('bot2', 'v3');
  h.discord.bots.add('bot2');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'offline' })).code, 'TARGET_NOT_IN_VOICE');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'bot1', targetIsBot: true })).code, 'TARGET_IS_BOT');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'alone2' })).code, 'NO_VOTERS', 'solo hay un bot con él');
  await h.service.applyWatch({ by: 'mod', targetId: 'L' });
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'L' })).code, 'ALREADY_WATCHED');
  assert.equal(polls(h).length, 0);
  assert.equal(h.discord.sent.filter((m) => /Votantes habilitados/.test(m.content)).length, 0, 'sin votantes nunca se aprueba nada');
});

test('/vigilar: no se duplica la votación de un mismo usuario, pero distintos usuarios coexisten', async () => {
  const h = await world({ v1: ['t1', 't2', 't3', 'a', 'b'] });
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 't1' })).ok, true);
  assert.equal((await h.service.requestWatch({ by: 'mod2', targetId: 't1' })).code, 'POLL_PENDING');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 't2' })).ok, true, 'sin bloqueos globales');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 't3' })).ok, true);
  assert.equal(polls(h).length, 3);
});

test('votaciones de inicio simultáneas de personas distintas se resuelven de forma independiente', async () => {
  const h = await world({ v1: ['t1', 't2', 'a', 'b'] });
  const [r1, r2] = await Promise.all([
    h.service.requestWatch({ by: 'modA', targetId: 't1' }),
    h.service.requestWatch({ by: 'modB', targetId: 't2' }),
  ]);
  assert.ok(r1.ok && r2.ok);
  await yesAll(h, r1, ['a', 'b']); // se aprueba solo la de t1
  assert.deepEqual(h.snapWatchedIds(), ['t1']);
  assert.equal(polls(h).length, 1);
  await noAll(h, r2, ['a', 'b']);
  assert.deepEqual(h.snapWatchedIds(), ['t1'], 'la rechazada de t2 no afecta a t1');
  assert.equal(muted(h, 't2'), false);
});

test('dos administradores solicitan al mismo usuario a la vez: una sola votación', async () => {
  const h = await world({ v1: ['t1', 'a'] });
  const results = await Promise.all([
    h.service.requestWatch({ by: 'modA', targetId: 't1' }),
    h.service.requestWatch({ by: 'modB', targetId: 't1' }),
  ]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['POLL_PENDING', 'ok']);
  assert.equal(polls(h).length, 1);
});

test('si el afectado sale o cambia de canal, la votación se cancela (aunque aún no esté vigilado)', async () => {
  for (const action of ['leave', 'move']) {
    const h = await world({ v1: ['target', 'a', 'b'] });
    const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
    if (action === 'leave') await h.discord.leave('target');
    else await h.discord.move('target', 'v2');
    assert.deepEqual(polls(h), [], action);
    assert.match(h.discord.messages.get(res.poll.messageId).content, /CANCELADA/);
    await yesAll(h, res, ['a', 'b']); // votos tardíos: sin efecto
    assert.deepEqual(h.snapWatchedIds(), [], action);
  }
});

test('si cuando se aprueba el usuario ya está vigilado por otra vía, no se duplica nada', async () => {
  const h = await world({ v1: ['target', 'a', 'x'] });
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' }); // 2 votantes: 2 necesarios
  await h.discord.vote(msgOf(res), 'a');
  await h.service.applyWatch({ by: 'mod', targetId: 'target' });
  const before = h.snapWatch('target').id;
  await h.discord.vote(msgOf(res), 'x');
  assert.equal(h.snapWatch('target').id, before);
  assert.deepEqual(h.snapWatchedIds(), ['target']);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /ya está vigilado/);
});

test('cambiar y retirar votos y la doble reacción siguen las reglas existentes', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c', 'd', 'e', 'f'] }); // 6 votantes: 4 necesarios
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  await h.discord.vote(msgOf(res), 'a', true);
  await h.discord.vote(msgOf(res), 'b', true);
  await h.discord.unreact(msgOf(res), '✅', 'a');
  await h.discord.vote(msgOf(res), 'a', false); // cambia a ❌
  assert.equal(polls(h)[0].votes.a, 'no');
  await h.discord.unreact(msgOf(res), '✅', 'b'); // retira
  assert.equal(polls(h)[0].votes.b, undefined);
  await h.discord.vote(msgOf(res), 'c', true);
  await h.discord.vote(msgOf(res), 'c', false); // ✅ y ❌ => ❌
  assert.equal(polls(h)[0].votes.c, 'no');
  assert.deepEqual(h.snapWatchedIds(), []);
});

test('un reinicio con la votación pendiente la cancela sin vigilar a nadie', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  await h.discord.vote(msgOf(res), 'a'); // 1 de 2: sigue abierta
  await h.restart();
  await h.service.recover();
  assert.deepEqual(polls(h), []);
  assert.deepEqual(h.snapWatchedIds(), []);
  assert.equal(muted(h, 'target'), false);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /reinició/);
  assert.match(h.discord.sent.at(-1).content, /vigilar a <@target>/);
  await h.discord.vote(msgOf(res), 'b'); // reacción tardía sobre una votación cancelada
  assert.deepEqual(h.snapWatchedIds(), []);
});

test('mensaje de votación borrado: se cancela la solicitud y se puede volver a pedir', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  await h.discord.deleteMessage(msgOf(res));
  assert.deepEqual(polls(h), []);
  assert.deepEqual(h.snapWatchedIds(), []);
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'target' })).ok, true);
});

test('si no se puede publicar la votación no se crea nada', async () => {
  const h = await world({ v1: ['target', 'a'] });
  h.discord.failSend = true;
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'target' })).code, 'SEND_FAILED');
  assert.deepEqual(polls(h), []);
});

// ============================================================ END_WATCH: /dejar-vigilar

test('END_WATCH aprobada: termina anticipadamente el castigo y libera el mute propio', async () => {
  const h = await world({ v1: ['w1', 'w2', 'a', 'b'] });
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  await h.service.applyWatch({ by: 'mod', targetId: 'w2' });
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  assert.equal(res.ok, true);
  assert.equal(res.poll.type, POLL_TYPES.END_WATCH);
  assert.deepEqual(res.poll.roster.sort(), ['a', 'b', 'w2']);
  assert.match(h.discord.lastVoteMessage('END_WATCH').content, /TERMINAR VIGILANCIA/);
  assert.deepEqual(h.watchedIds(), ['w1', 'w2'], 'sigue vigilado hasta el resultado');

  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(h.watchedIds(), ['w2']);
  assert.equal(muted(h, 'w1'), false);
  assert.equal(muted(h, 'w2'), true);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
  assert.equal(h.clock.timers.length, 1);
});

test('END_WATCH rechazada: continúa vigilado sin cambios', async () => {
  const h = await world({ v1: ['w1', 'a', 'b', 'c'] });
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const callsBefore = h.discord.muteCalls.length;
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' }); // 3 votantes: 2 necesarios
  await noAll(h, res, ['a', 'b']);
  assert.deepEqual(polls(h), []);
  assert.deepEqual(h.watchedIds(), ['w1']);
  assert.equal(muted(h, 'w1'), true);
  assert.equal(h.discord.muteCalls.length, callsBefore, 'ninguna llamada a Discord');
  assert.match(h.discord.messages.get(res.poll.messageId).content, /sigue vigilado/);
});

test('END_WATCH respeta la protección de mutes de moderadores', async () => {
  const h = await world({ v1: ['a', 'b'] });
  await h.discord.join('w1', 'v1', true); // ya silenciado por un moderador
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(h.watchedIds(), []);
  assert.equal(muted(h, 'w1'), true, 'el silencio del moderador queda intacto');
  assert.equal(h.discord.muteCalls.filter((c) => c.mute === false).length, 0);
});

test('/dejar-vigilar: condiciones previas y duplicados', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a'] });
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'n1' })).code, 'NOT_WATCHED');
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  await h.discord.leave('w1');
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'TARGET_NOT_IN_VOICE');
  await h.discord.join('w1', 'v1', true);
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).ok, true);
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'POLL_PENDING');
});

test('END_WATCH aprobada cancela la votación y el permiso de palabra de ese usuario', async () => {
  const h = await world({ v1: ['w1', 'a', 'b'] });
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const speak = await h.service.requestFloor({ userId: 'w1' });
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  assert.equal(polls(h).length, 2, 'coexisten mientras no sean contradictorias');
  await yesAll(h, rm, ['a', 'b']);
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);

  const h2 = await world({ v1: ['w1', 'a', 'b'] });
  await h2.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const sp = await h2.service.requestFloor({ userId: 'w1' });
  await yesAll(h2, sp, ['a', 'b']);
  assert.ok(h2.store.snapshot().permits.w1);
  const rm2 = await h2.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await yesAll(h2, rm2, ['a', 'b']);
  assert.deepEqual(h2.store.snapshot().permits, {});
  assert.equal(h2.clock.timers.length, 0);
});

test('END_WATCH: si el afectado cambia de canal la votación se cancela; si la vigilancia venció, tampoco tiene efecto', async () => {
  const h = await world({ v1: ['w1', 'a', 'b'] });
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await h.discord.move('w1', 'v2');
  assert.deepEqual(polls(h), []);
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(h.watchedIds(), ['w1']);

  const h2 = await world({ v1: ['w1', 'a', 'b'] });
  await h2.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const r2 = await h2.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await h2.clock.advance(2 * 60_000); // vence el castigo: cancela la votación de fin anticipado
  assert.deepEqual(polls(h2), []);
  assert.match(h2.discord.messages.get(r2.poll.messageId).content, /CANCELADA/);
});

test('END_WATCH no puede cerrar una vigilancia nueva del mismo usuario (otra id)', async () => {
  const h = await world({ v1: ['w1', 'a', 'b'] });
  const first = await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  // simula una votación rezagada que apunta a la vigilancia anterior
  h.service.state.polls[res.poll.id].watchId = 'otra-vigilancia';
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(h.watchedIds(), ['w1']);
  assert.equal(h.watch('w1').id, first.watch.id);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /ya no está vigente/);
});

// ============================================================ comunes

test('las votaciones se persisten con su tipo, usuario afectado y datos', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  const saved = polls(h)[0];
  assert.equal(saved.type, 'START_WATCH');
  assert.equal(saved.targetId, 'target');
  assert.equal(saved.requesterId, 'mod');
  assert.equal(saved.status, 'open');
  assert.deepEqual(saved.roster.sort(), ['a', 'b']);
  assert.ok(!('patrolId' in saved), 'las votaciones ya no dependen de una patrulla');
});

test('el estado muestra el tipo de cada votación pendiente', async () => {
  const h = await world({ v1: ['target', 'w1', 'a', 'b'] });
  await h.service.applyWatch({ by: 'mod', targetId: 'w1' });
  await h.service.requestWatch({ by: 'mod', targetId: 'target' });
  await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await h.service.requestFloor({ userId: 'w1' });
  const st = await h.service.getStatus();
  assert.deepEqual(st.polls.map((p) => p.type).sort(), ['END_WATCH', 'SPEAK_PERMISSION', 'START_WATCH']);
  const text = formatStatus(st);
  assert.match(text, /\[START_WATCH\] vigilar a <@target>/);
  assert.match(text, /\[END_WATCH\] dejar de vigilar a <@w1>/);
  assert.match(text, /\[SPEAK_PERMISSION\] palabra de <@w1>/);
});
