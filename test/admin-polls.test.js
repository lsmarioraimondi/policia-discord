'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { buildRoster, POLL_TYPES } = require('../src/core/voting');
const { formatStatus } = require('../src/messages');
const { MemoryStore } = require('../src/storage/jsonStore');

const polls = (h) => Object.values(h.store.snapshot().polls);
const watched = (h) => Object.keys(h.store.snapshot().patrol?.watched ?? {}).sort();
const muted = (h, id) => h.discord.getVoiceState(id)?.serverMute;
const msgOf = (res) => res.poll.messageId;
const yesAll = async (h, res, voters) => {
  for (const v of voters) await h.discord.vote(msgOf(res), v, true);
};
const noAll = async (h, res, voters) => {
  for (const v of voters) await h.discord.vote(msgOf(res), v, false);
};

/** Servidor de pruebas: cada entrada es [canal, [usuarios]]. */
async function world(layout, { bots = [] } = {}) {
  const h = await createHarness();
  for (const b of bots) h.discord.bots.add(b);
  for (const [channel, users] of Object.entries(layout)) for (const u of users) await h.discord.join(u, channel);
  return h;
}

const startPatrolOn = async (h, target) => {
  const res = await h.service.applyStartPatrol({ by: 'mod', targetId: target });
  assert.equal(res.ok, true);
  return res;
};

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

// ============================================================ START_PATROL

test('START_PATROL: /policia-iniciar solo publica la votación; la patrulla no empieza ni se silencia a nadie', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c'] }, { bots: ['bot1'] });
  await h.discord.join('bot1', 'v1');
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  assert.equal(res.ok, true);
  const poll = res.poll;
  assert.equal(poll.type, POLL_TYPES.START_PATROL);
  assert.deepEqual(poll.roster.sort(), ['a', 'b', 'c'], 'sin el afectado ni bots');
  assert.equal(poll.needed, 2);
  assert.equal(poll.targetId, 'target');
  assert.equal(poll.requesterId, 'mod');

  const text = h.discord.lastVoteMessage('START_PATROL').content;
  assert.match(text, /INICIAR PATRULLA/);
  assert.match(text, /Votantes habilitados: 3/);
  assert.match(text, /Votos necesarios para aprobar: 2/);
  assert.equal(h.discord.messages.get(poll.messageId).channelId, 'VC');
  assert.ok(h.discord.messages.get(poll.messageId).reactions['✅'].has('BOT'));

  assert.equal(h.store.snapshot().patrol, null, 'sin patrulla hasta el resultado favorable');
  assert.equal(muted(h, 'target'), false);
  assert.equal(h.discord.muteCalls.length, 0);
});

test('START_PATROL aprobada: inicia la patrulla, agrega al usuario y lo silencia', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c', 'd'] });
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' }); // 4 votantes: 3 necesarios
  await yesAll(h, res, ['a', 'b']);
  assert.equal(h.store.snapshot().patrol, null, '2 de 4 no alcanza: hace falta mayoría del total habilitado');
  await yesAll(h, res, ['c']);

  const p = h.store.snapshot().patrol;
  assert.ok(p);
  assert.equal(p.startedBy, 'mod', 'la inició el moderador que lo solicitó');
  assert.deepEqual(watched(h), ['target']);
  assert.equal(muted(h, 'target'), true);
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
  assert.ok(h.discord.sent.some((m) => /PATRULLA INICIADA/.test(m.content)));
});

test('START_PATROL rechazada: no hay patrulla ni mute', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c'] }); // 3 votantes: 2 necesarios
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  await noAll(h, res, ['a']);
  assert.equal(polls(h).length, 1);
  await noAll(h, res, ['b']);
  assert.deepEqual(polls(h), []);
  assert.equal(h.store.snapshot().patrol, null);
  assert.equal(muted(h, 'target'), false);
  assert.equal(h.discord.muteCalls.length, 0);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Rechazada/);
  // se puede volver a solicitar
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' })).ok, true);
});

test('START_PATROL: el usuario afectado no puede votar; votos ajenos al padrón no cuentan', async () => {
  const h = await world({ v1: ['target', 'a'], v2: ['other'] });
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' }); // 1 votante
  await h.discord.vote(msgOf(res), 'target', true);
  await h.discord.vote(msgOf(res), 'other', true);
  assert.equal(h.store.snapshot().patrol, null);
  await h.discord.vote(msgOf(res), 'a', true);
  assert.ok(h.store.snapshot().patrol);
});

test('START_PATROL: el afectado debe estar en voz y debe haber otros votantes humanos', async () => {
  const h = await world({ v1: ['alone'] }, { bots: ['bot1'] });
  await h.discord.join('bot1', 'v1');
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'offline' })).code, 'TARGET_NOT_IN_VOICE');
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'alone' })).code, 'NO_VOTERS');
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'bot1', targetIsBot: true })).code, 'TARGET_IS_BOT');
  assert.deepEqual(polls(h), []);
  assert.equal(h.store.snapshot().patrol, null, 'sin votantes nunca se aprueba automáticamente');
  assert.equal(h.discord.sent.length, 0);
});

test('START_PATROL: evita solicitudes duplicadas o contradictorias', async () => {
  const h = await world({ v1: ['t1', 't2', 'a', 'b'] });
  const first = await h.service.requestStartPatrol({ by: 'mod', targetId: 't1' });
  assert.equal(first.ok, true);
  assert.equal((await h.service.requestStartPatrol({ by: 'mod2', targetId: 't1' })).code, 'POLL_PENDING');
  assert.equal((await h.service.requestStartPatrol({ by: 'mod2', targetId: 't2' })).code, 'POLL_PENDING');
  assert.equal(polls(h).length, 1);

  await yesAll(h, first, ['a', 'b']); // aprobada: ahora hay patrulla
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 't2' })).code, 'PATROL_ACTIVE');
});

test('START_PATROL: si el afectado sale o cambia de canal, la votación se cancela y no tiene efecto', async () => {
  for (const action of ['leave', 'move']) {
    const h = await world({ v1: ['target', 'a', 'b'] });
    const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
    if (action === 'leave') await h.discord.leave('target');
    else await h.discord.move('target', 'v2');
    assert.deepEqual(polls(h), [], action);
    assert.match(h.discord.messages.get(res.poll.messageId).content, /CANCELADA/);
    await yesAll(h, res, ['a', 'b']); // votos tardíos: sin efecto
    assert.equal(h.store.snapshot().patrol, null, action);
  }
});

test('START_PATROL: si cuando se aprueba ya hay otra patrulla, no se pisa nada', async () => {
  const h = await world({ v1: ['target', 'a', 'x'] });
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' }); // 2 votantes: 2 necesarios
  await h.discord.vote(msgOf(res), 'a');
  await startPatrolOn(h, 'x'); // otra vía crea una patrulla en el medio
  await h.discord.vote(msgOf(res), 'x');
  assert.deepEqual(watched(h), ['x']);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /ya hay una patrulla activa/);
});

test('votaciones administrativas: cambiar y retirar votos y doble reacción siguen las reglas existentes', async () => {
  const h = await world({ v1: ['target', 'a', 'b', 'c', 'd', 'e', 'f'] }); // 6 votantes: 4 necesarios
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
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
  assert.equal(h.store.snapshot().patrol, null);
});

test('START_PATROL: dos moderadores a la vez sobre usuarios distintos: solo una votación', async () => {
  const h = await world({ v1: ['t1', 't2', 'a', 'b'] });
  const results = await Promise.all([
    h.service.requestStartPatrol({ by: 'modA', targetId: 't1' }),
    h.service.requestStartPatrol({ by: 'modB', targetId: 't2' }),
  ]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['POLL_PENDING', 'ok']);
  assert.equal(polls(h).length, 1);
  assert.equal(h.discord.sent.length, 1);
});

test('START_PATROL: un reinicio con la votación pendiente la cancela sin iniciar nada', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  await h.discord.vote(msgOf(res), 'a'); // 1 de 2: sigue abierta
  await h.restart();
  await h.service.recover();
  assert.deepEqual(polls(h), []);
  assert.equal(h.store.snapshot().patrol, null);
  assert.equal(muted(h, 'target'), false);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /reinició/);
  assert.match(h.discord.sent.at(-1).content, /iniciar patrulla vigilando a/);
  await h.discord.vote(msgOf(res), 'b'); // reacción tardía sobre una votación cancelada
  assert.equal(h.store.snapshot().patrol, null);
});

// ============================================================ ADD_WATCH

test('ADD_WATCH: no se vigila hasta que se aprueba; luego se incorpora y se silencia', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.poll.roster.sort(), ['a', 'b', 'w1'], 'otros vigilados del canal sí pueden votar; el afectado no');
  assert.equal(res.poll.needed, 2);
  assert.deepEqual(watched(h), ['w1']);
  assert.equal(muted(h, 'n1'), false);

  await yesAll(h, res, ['a']);
  assert.deepEqual(watched(h), ['w1'], 'con 1 de 3 sigue sin vigilarse');
  await yesAll(h, res, ['b']);
  assert.deepEqual(watched(h), ['n1', 'w1']);
  assert.equal(muted(h, 'n1'), true);
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
});

test('ADD_WATCH rechazada: no se incorpora', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a', 'b', 'c'] });
  await startPatrolOn(h, 'w1');
  const res = await h.service.requestWatch({ by: 'mod', targetId: 'n1' }); // [a,b,c,w1]: 3 necesarios
  await noAll(h, res, ['a']);
  assert.equal(polls(h).length, 1, 'con 1 en contra todavía es posible aprobar');
  await noAll(h, res, ['b']); // 4 - 2 < 3: ya es imposible
  assert.deepEqual(polls(h), []);
  assert.deepEqual(watched(h), ['w1']);
  assert.equal(muted(h, 'n1'), false);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Rechazada/);
});

test('ADD_WATCH: condiciones previas y solicitudes contradictorias', async () => {
  const h = await world({ v1: ['w1', 'n1', 'n2', 'a'] });
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'n1' })).code, 'NO_PATROL');
  await startPatrolOn(h, 'w1');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'w1' })).code, 'ALREADY_WATCHED');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'bot', targetIsBot: true })).code, 'TARGET_IS_BOT');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'offline' })).code, 'TARGET_NOT_IN_VOICE');

  const first = await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
  assert.equal(first.ok, true);
  assert.equal((await h.service.requestWatch({ by: 'mod2', targetId: 'n1' })).code, 'POLL_PENDING');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'n2' })).ok, true, 'usuarios distintos coexisten');
  assert.equal(polls(h).length, 2);
});

test('ADD_WATCH: dos administradores a la vez sobre el mismo usuario: una sola votación', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a'] });
  await startPatrolOn(h, 'w1');
  const results = await Promise.all([
    h.service.requestWatch({ by: 'modA', targetId: 'n1' }),
    h.service.requestWatch({ by: 'modB', targetId: 'n1' }),
  ]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['POLL_PENDING', 'ok']);
  assert.equal(polls(h).length, 1);
});

test('ADD_WATCH: si el afectado cambia de canal o sale, se cancela (también sin estar vigilado aún)', async () => {
  for (const action of ['leave', 'move']) {
    const h = await world({ v1: ['w1', 'n1', 'a', 'b'] });
    await startPatrolOn(h, 'w1');
    const res = await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
    if (action === 'leave') await h.discord.leave('n1');
    else await h.discord.move('n1', 'v2');
    assert.deepEqual(polls(h), [], action);
    await yesAll(h, res, ['a', 'b', 'w1']);
    assert.deepEqual(watched(h), ['w1'], action);
    assert.match(h.discord.messages.get(res.poll.messageId).content, /CANCELADA/);
  }
});

test('ADD_WATCH: no altera votaciones de palabra ni permisos de otros', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  const speak = await h.service.requestFloor({ userId: 'w1' });
  const add = await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
  assert.equal(polls(h).length, 2, 'coexisten');
  await yesAll(h, add, ['a', 'b']);
  assert.deepEqual(watched(h), ['n1', 'w1']);
  assert.equal(polls(h).length, 1);
  assert.equal(polls(h)[0].id, speak.poll.id);
  assert.deepEqual(polls(h)[0].votes, {});
});

test('ADD_WATCH: aprobada después de que la patrulla terminó por otra vía, se cancela', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  const add = await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
  await h.service.applyFinalize({ by: 'mod' }); // cancela todas las votaciones
  assert.deepEqual(polls(h), []);
  await yesAll(h, add, ['a', 'b', 'w1']);
  assert.equal(h.store.snapshot().patrol, null);
  assert.equal(muted(h, 'n1'), false);
});

// ============================================================ REMOVE_WATCH

test('REMOVE_WATCH aprobada: deja de vigilar y libera el mute propio', async () => {
  const h = await world({ v1: ['w1', 'w2', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  await h.service.applyWatch({ by: 'mod', targetId: 'w2' });
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.poll.roster.sort(), ['a', 'b', 'w2']);
  assert.deepEqual(watched(h), ['w1', 'w2'], 'sigue vigilado hasta el resultado');
  assert.equal(muted(h, 'w1'), true);

  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(watched(h), ['w2']);
  assert.equal(muted(h, 'w1'), false, 'mute propio liberado');
  assert.equal(muted(h, 'w2'), true, 'los demás siguen vigilados');
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
});

test('REMOVE_WATCH rechazada: continúa vigilado sin cambios', async () => {
  const h = await world({ v1: ['w1', 'a', 'b', 'c'] });
  await startPatrolOn(h, 'w1');
  const callsBefore = h.discord.muteCalls.length;
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' }); // 3 votantes: 2 necesarios
  await noAll(h, res, ['a', 'b']);
  assert.deepEqual(polls(h), []);
  assert.deepEqual(watched(h), ['w1']);
  assert.equal(muted(h, 'w1'), true);
  assert.equal(h.discord.muteCalls.length, callsBefore, 'ninguna llamada a Discord');
  assert.match(h.discord.messages.get(res.poll.messageId).content, /sigue vigilado/);
});

test('REMOVE_WATCH respeta la protección de mutes de moderadores (mute previo no se levanta)', async () => {
  const h = await world({ v1: ['a', 'b'] });
  await h.discord.join('w1', 'v1', true); // ya silenciado por un moderador
  await startPatrolOn(h, 'w1');
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(watched(h), []);
  assert.equal(muted(h, 'w1'), true, 'el silencio del moderador queda intacto');
  assert.equal(h.discord.muteCalls.filter((c) => c.mute === false).length, 0);
});

test('REMOVE_WATCH: condiciones previas y duplicados', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a'] });
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'NO_PATROL');
  await startPatrolOn(h, 'w1');
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'n1' })).code, 'NOT_WATCHED');
  await h.discord.leave('w1');
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'TARGET_NOT_IN_VOICE');
  await h.discord.join('w1', 'v1', true);
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).ok, true);
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'POLL_PENDING');
});

test('REMOVE_WATCH y ADD_WATCH del mismo usuario son mutuamente excluyentes; con END_PATROL también', async () => {
  const h = await world({ v1: ['w1', 'n1', 'a'] });
  await startPatrolOn(h, 'w1');
  await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  const end = await h.service.requestEndPatrol({ by: 'mod' });
  assert.equal(end.code, 'ADMIN_POLLS_PENDING');
  await h.service.requestWatch({ by: 'mod', targetId: 'n1' });
  assert.equal(polls(h).length, 2);
});

test('REMOVE_WATCH aprobada cancela la votación y el permiso de palabra de ese usuario', async () => {
  const h = await world({ v1: ['w1', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  const speak = await h.service.requestFloor({ userId: 'w1' });
  const rm = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  assert.equal(polls(h).length, 2, 'coexisten mientras no sean contradictorias');
  await yesAll(h, rm, ['a', 'b']);
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);

  // con un permiso vigente también se cancela
  const h2 = await world({ v1: ['w1', 'a', 'b'] });
  await startPatrolOn(h2, 'w1');
  const sp = await h2.service.requestFloor({ userId: 'w1' });
  await yesAll(h2, sp, ['a', 'b']);
  assert.ok(h2.store.snapshot().permits.w1);
  const rm2 = await h2.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await yesAll(h2, rm2, ['a', 'b']);
  assert.deepEqual(h2.store.snapshot().permits, {});
  assert.equal(h2.clock.timers.length, 0);
});

test('REMOVE_WATCH: afectado fuera de voz tras solicitar la votación => se cancela', async () => {
  const h = await world({ v1: ['w1', 'a', 'b'] });
  await startPatrolOn(h, 'w1');
  const res = await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' });
  await h.discord.move('w1', 'v2');
  assert.deepEqual(polls(h), []);
  await yesAll(h, res, ['a', 'b']);
  assert.deepEqual(watched(h), ['w1']);
});

// ============================================================ END_PATROL

async function endWorld() {
  // v1: w1 + w3 (vigilados) y a, c ; v2: w2 (vigilado) y d, e ; v3: f (sin vigilados) ; bot en v1
  const h = await world({ v1: ['w1', 'w3', 'a', 'c'], v2: ['w2', 'd', 'e'], v3: ['f'] }, { bots: ['bot1'] });
  await h.discord.join('bot1', 'v1');
  await startPatrolOn(h, 'w1');
  await h.service.applyWatch({ by: 'mod', targetId: 'w2' });
  await h.service.applyWatch({ by: 'mod', targetId: 'w3' });
  return h;
}

test('END_PATROL: el padrón es la unión de humanos no vigilados en los canales de los vigilados', async () => {
  const h = await endWorld();
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  assert.equal(res.ok, true);
  assert.equal(res.poll.type, POLL_TYPES.END_PATROL);
  assert.deepEqual(res.poll.roster.sort(), ['a', 'c', 'd', 'e'], 'sin vigilados, sin bots y sin quien está en un canal sin vigilados');
  assert.equal(res.poll.needed, 3);
  assert.deepEqual(res.poll.channelIds.sort(), ['v1', 'v2']);
  const text = h.discord.lastVoteMessage('END_PATROL').content;
  assert.match(text, /FINALIZAR PATRULLA/);
  assert.match(text, /Votantes habilitados: 4/);
  assert.equal(h.store.snapshot().patrol !== null, true, 'sigue la patrulla hasta el resultado');
  assert.equal(muted(h, 'w1'), true);
});

test('END_PATROL: una persona = un voto aunque se vea desde varios vigilados', async () => {
  const h = await world({ v1: ['w1', 'w2', 'a'] }); // dos vigilados en el mismo canal
  await startPatrolOn(h, 'w1');
  await h.service.applyWatch({ by: 'mod', targetId: 'w2' });
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  assert.deepEqual(res.poll.roster, ['a']);
  assert.deepEqual(res.poll.channelIds, ['v1'], 'canal compartido listado una vez');
  assert.equal(res.poll.needed, 1);
});

test('END_PATROL aprobada: ejecuta la finalización completa', async () => {
  const h = await endWorld();
  const speak = await h.service.requestFloor({ userId: 'w2' });
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await yesAll(h, res, ['a', 'c']);
  assert.notEqual(h.store.snapshot().patrol, null, '2 de 4 no alcanza');
  await yesAll(h, res, ['d']);

  const s = h.store.snapshot();
  assert.equal(s.patrol, null);
  assert.deepEqual(s.polls, {}, 'cancela también las demás votaciones');
  assert.match(h.discord.messages.get(speak.poll.messageId).content, /CANCELADA/);
  for (const w of ['w1', 'w2', 'w3']) assert.equal(muted(h, w), false, `${w} liberado`);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /Aprobada/);
  assert.ok(h.discord.sent.some((m) => /PATRULLA FINALIZADA/.test(m.content)));
  assert.equal(h.clock.timers.length, 0);

  const calls = h.discord.muteCalls.length;
  await h.discord.move('w1', 'v3');
  assert.equal(h.discord.muteCalls.length, calls, 'ya no se silencia a nadie');
});

test('END_PATROL rechazada: la patrulla y las vigilancias continúan sin cambios', async () => {
  const h = await endWorld();
  const callsBefore = h.discord.muteCalls.length;
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await noAll(h, res, ['a']);
  assert.equal(polls(h).length, 1);
  await noAll(h, res, ['c']); // 4 - 2 < 3: ya es imposible
  assert.deepEqual(polls(h), []);
  assert.deepEqual(watched(h), ['w1', 'w2', 'w3']);
  assert.equal(muted(h, 'w1'), true);
  assert.equal(h.discord.muteCalls.length, callsBefore);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /continúan/);
});

test('END_PATROL: los vigilados no pueden votar ni influir', async () => {
  const h = await endWorld();
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await yesAll(h, res, ['w1', 'w2', 'w3', 'bot1', 'f']);
  assert.notEqual(h.store.snapshot().patrol, null);
  assert.deepEqual(polls(h)[0].votes, {});
});

test('END_PATROL: sin vigilados conectados o sin humanos no vigilados, no se puede votar ni se aprueba', async () => {
  const h = await world({ v1: ['w1'], v2: ['x'] });
  await startPatrolOn(h, 'w1');
  assert.equal((await h.service.requestEndPatrol({ by: 'mod' })).code, 'NO_VOTERS', 'vigilado solo en su canal');
  await h.discord.leave('w1');
  assert.equal((await h.service.requestEndPatrol({ by: 'mod' })).code, 'NO_VOTERS', 'ningún vigilado conectado');
  assert.equal((await h.service.requestEndPatrol({ by: 'mod' })).ok, false);
  assert.deepEqual(polls(h), []);
  assert.notEqual(h.store.snapshot().patrol, null, 'nunca se finaliza automáticamente');
});

test('END_PATROL: sin patrulla y duplicados', async () => {
  const h = await endWorld();
  assert.equal((await h.service.requestEndPatrol({ by: 'mod' })).ok, true);
  assert.equal((await h.service.requestEndPatrol({ by: 'mod2' })).code, 'END_PENDING');
  assert.equal((await h.service.requestWatch({ by: 'mod', targetId: 'f' })).code, 'END_PENDING');
  assert.equal((await h.service.requestUnwatch({ by: 'mod', targetId: 'w1' })).code, 'END_PENDING');
  assert.equal(polls(h).length, 1);

  const empty = await createHarness();
  assert.equal((await empty.service.requestEndPatrol({ by: 'mod' })).code, 'NO_PATROL');
});

test('END_PATROL: coexiste con votaciones de palabra y dos administradores a la vez crean una sola', async () => {
  const h = await endWorld();
  const speak = await h.service.requestFloor({ userId: 'w1' });
  assert.equal(speak.ok, true);
  const results = await Promise.all([h.service.requestEndPatrol({ by: 'modA' }), h.service.requestEndPatrol({ by: 'modB' })]);
  assert.deepEqual(results.map((r) => r.code ?? 'ok').sort(), ['END_PENDING', 'ok']);
  assert.equal(polls(h).length, 2);
  // una solicitud de palabra nueva sigue siendo posible mientras END_PATROL está abierta
  assert.equal((await h.service.requestFloor({ userId: 'w2' })).ok, true);
});

test('END_PATROL: el padrón queda congelado aunque un vigilado cambie de canal', async () => {
  const h = await endWorld();
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await h.discord.move('w2', 'v3');
  assert.equal(polls(h).length, 1, 'no se cancela: no es una votación sobre un usuario concreto');
  assert.deepEqual(polls(h)[0].roster.sort(), ['a', 'c', 'd', 'e']);
  await yesAll(h, res, ['a', 'c', 'd']);
  assert.equal(h.store.snapshot().patrol, null);
});

test('END_PATROL: un reinicio con la votación pendiente la cancela y la patrulla sigue', async () => {
  const h = await endWorld();
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await h.restart();
  await h.service.recover();
  assert.deepEqual(polls(h), []);
  assert.deepEqual(watched(h), ['w1', 'w2', 'w3']);
  assert.match(h.discord.messages.get(res.poll.messageId).content, /reinició/);
  assert.match(h.discord.sent.at(-1).content, /finalizar la patrulla/);
});

test('END_PATROL: finalizar con mutes de moderadores mantiene la protección', async () => {
  const h = await world({ v1: ['a', 'b'] });
  await h.discord.join('w1', 'v1', true);
  await h.discord.join('w2', 'v1', false);
  await startPatrolOn(h, 'w1');
  await h.service.applyWatch({ by: 'mod', targetId: 'w2' });
  const res = await h.service.requestEndPatrol({ by: 'mod' });
  await yesAll(h, res, ['a', 'b']);
  assert.equal(h.store.snapshot().patrol, null);
  assert.equal(muted(h, 'w1'), true, 'el silencio previo del moderador no se toca');
  assert.equal(muted(h, 'w2'), false);
});

// ============================================================ comunes

test('mensaje de votación borrado: se cancela la solicitud administrativa', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  const res = await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  await h.discord.deleteMessage(msgOf(res));
  assert.deepEqual(polls(h), []);
  assert.equal(h.store.snapshot().patrol, null);
  assert.ok(h.discord.sent.at(-1).content.includes('iniciar patrulla'));
  // y ahora se puede volver a solicitar
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' })).ok, true);
});

test('si no se puede publicar la votación administrativa no se crea nada', async () => {
  const h = await world({ v1: ['target', 'a'] });
  h.discord.failSend = true;
  assert.equal((await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' })).code, 'SEND_FAILED');
  assert.deepEqual(polls(h), []);
  assert.equal(h.store.snapshot().patrol, null);
});

test('las votaciones administrativas se persisten con su tipo y datos', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  const saved = polls(h)[0];
  assert.equal(saved.type, 'START_PATROL');
  assert.equal(saved.targetId, 'target');
  assert.equal(saved.requesterId, 'mod');
  assert.equal(saved.patrolId, null);
  assert.deepEqual(saved.roster.sort(), ['a', 'b']);
  assert.equal(saved.status, 'open');
});

test('estados guardados antes de existir los tipos se migran como votaciones de palabra al recuperar', async () => {
  const state = {
    version: 1,
    patrol: { id: 'p', guildId: 'G', startedAt: 1, startedBy: 'mod', watched: { u1: { userId: 'u1', addedAt: 1, addedBy: 'mod', preMuted: false, botMuted: false, pendingOp: null } } },
    polls: { old: { id: 'old', patrolId: 'p', requesterId: 'u1', channelId: 'v1', messageId: 'm9', messageChannelId: 'VC', roster: ['a'], needed: 1, votes: {}, status: 'open', createdAt: 1 } },
    permits: {},
    pendingReleases: {},
    lastPatrol: null,
  };
  const h = await createHarness({ store: new MemoryStore(state) });
  await h.service.recover();
  assert.deepEqual(polls(h), []);
  assert.match(h.discord.sent.at(-1).content, /palabra de <@u1>/);
});

test('el estado muestra el tipo de cada votación pendiente (con y sin patrulla)', async () => {
  const h = await world({ v1: ['target', 'a', 'b'] });
  await h.service.requestStartPatrol({ by: 'mod', targetId: 'target' });
  let st = await h.service.getStatus();
  assert.equal(st.active, false);
  assert.equal(st.polls[0].type, 'START_PATROL');
  assert.match(formatStatus(st), /\[START_PATROL\] iniciar patrulla vigilando a <@target>/);

  const h2 = await endWorld();
  await h2.service.requestFloor({ userId: 'w1' });
  await h2.service.requestEndPatrol({ by: 'mod' });
  st = await h2.service.getStatus();
  assert.deepEqual(st.polls.map((p) => p.type).sort(), ['END_PATROL', 'SPEAK_PERMISSION']);
  const text = formatStatus(st);
  assert.match(text, /\[END_PATROL\] finalizar la patrulla/);
  assert.match(text, /\[SPEAK_PERMISSION\] palabra de <@w1>/);
});
