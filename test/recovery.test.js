'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('./helpers');
const { MemoryStore, JsonStore } = require('../src/storage/jsonStore');
const { emptyState } = require('../src/storage/state');

async function withPermit() {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  await h.discord.vote(r.poll.messageId, 'a');
  return { h, msg: r.poll.messageId };
}

test('recupera la patrulla, los vigilados y re-silencia a los conectados', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  await h.service.applyWatch({ by: 'mod', targetId: 'u2' }); // desconectado

  // durante el reinicio, u2 entró y el mute de u1 se perdió
  h.discord.voice.get('u1').serverMute = false;
  h.discord.voice.set('u2', { channelId: 'v2', serverMute: false });

  await h.restart();
  await h.service.recover();
  const st = await h.service.getStatus();
  assert.equal(st.active, true);
  assert.equal(st.patrol.startedBy, 'mod');
  assert.deepEqual(st.watched.map((w) => w.userId).sort(), ['u1', 'u2']);
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  assert.equal(h.discord.getVoiceState('u2').serverMute, true);
});

test('reinicio durante un permiso: conserva el vencimiento original, no lo renueva', async () => {
  const { h } = await withPermit();
  const original = h.store.snapshot().permits.req;
  await h.clock.advance(50_000);

  await h.restart();
  await h.service.recover();
  const afterRestart = h.store.snapshot().permits.req;
  assert.equal(afterRestart.expiresAt, original.expiresAt);
  assert.equal(h.discord.getVoiceState('req').serverMute, false, 'sigue pudiendo hablar');

  await h.clock.advance(69_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, false);
  await h.clock.advance(1_000);
  assert.equal(h.discord.getVoiceState('req').serverMute, true, 'venció a los 120 s totales, no a 120 s desde el reinicio');
  assert.deepEqual(h.store.snapshot().permits, {});
});

test('permiso vencido mientras el bot estaba apagado: se cierra y se re-silencia al volver', async () => {
  const { h } = await withPermit();
  h.clock.jump(300_000);
  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.discord.getVoiceState('req').serverMute, true);
});

test('permiso cuyo titular cambió de canal con el bot apagado: se cancela', async () => {
  const { h } = await withPermit();
  h.discord.voice.get('req').channelId = 'v2';
  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().permits, {});
  assert.equal(h.clock.timers.length, 0);
  assert.equal(h.discord.getVoiceState('req').serverMute, true, 'vigilado en el canal nuevo: se vuelve a silenciar');
});

test('votaciones interrumpidas por un reinicio se cancelan y se comunica', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  for (const v of ['a', 'b', 'c']) await h.discord.join(v, 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  await h.discord.vote(r.poll.messageId, 'a', false); // sigue abierta (3 votantes, 2 necesarios)
  assert.equal(Object.keys(h.store.snapshot().polls).length, 1);

  await h.restart();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().polls, {});
  assert.match(h.discord.messages.get(r.poll.messageId).content, /reinició/);
  assert.match(h.discord.sent.at(-1).content, /se reinició/);
  // puede volver a pedir
  assert.equal((await h.service.requestFloor({ userId: 'req' })).ok, true);
});

test('una patrulla finalizada no se reactiva tras reiniciar', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  await h.service.applyFinalize({ by: 'mod' });

  await h.restart();
  await h.service.recover();
  assert.equal((await h.service.getStatus()).active, false);
  const calls = h.discord.muteCalls.length;
  await h.discord.leave('u1');
  await h.discord.join('u1', 'v2');
  assert.equal(h.discord.muteCalls.length, calls);
  assert.equal(h.discord.sent.at(-1).content.includes('se reinició'), false, 'sin patrulla no hay aviso de recuperación');
});

test('finalización interrumpida: la patrulla ya figura finalizada y los mutes propios se liberan al reiniciar', async () => {
  const { DiscordOpError } = require('../src/core/errors');
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
  h.discord.failMute = new DiscordOpError('UNKNOWN', 'el proceso murió aquí'); // la liberación no llega a ejecutarse
  await h.service.applyFinalize({ by: 'mod' });
  const saved = h.store.snapshot();
  assert.equal(saved.patrol, null);
  assert.ok(saved.pendingReleases.u1);

  h.discord.failMute = null;
  await h.restart();
  await h.service.recover();
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('operación de mute a medias (corte tras persistir la intención): se resuelve observando el estado real', async () => {
  const state = emptyState();
  state.patrol = {
    id: 'p',
    guildId: 'G',
    startedAt: 1,
    startedBy: 'mod',
    watched: {
      muted: { userId: 'muted', addedAt: 1, addedBy: 'mod', preMuted: false, botMuted: false, pendingOp: 'mute' },
      notApplied: { userId: 'notApplied', addedAt: 1, addedBy: 'mod', preMuted: false, botMuted: false, pendingOp: 'mute' },
      offline: { userId: 'offline', addedAt: 1, addedBy: 'mod', preMuted: false, botMuted: false, pendingOp: 'mute' },
    },
  };
  const h = await createHarness({ store: new MemoryStore(state) });
  h.discord.voice.set('muted', { channelId: 'v1', serverMute: true }); // el mute sí se aplicó
  h.discord.voice.set('notApplied', { channelId: 'v1', serverMute: false }); // no llegó a aplicarse
  await h.service.recover();
  const w = h.store.snapshot().patrol.watched;
  assert.deepEqual([w.muted.botMuted, w.muted.pendingOp], [true, null]);
  assert.deepEqual([w.notApplied.botMuted, w.notApplied.pendingOp], [true, null], 're-aplicado');
  assert.equal(h.discord.getVoiceState('notApplied').serverMute, true);
  assert.deepEqual([w.offline.botMuted, w.offline.uncertain, w.offline.pendingOp], [false, true, null]);
});

test('JsonStore: guarda y recupera el estado entre procesos y toma un lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-test-'));
  try {
    const a = new JsonStore(dir);
    a.acquireLock();
    const state = emptyState();
    state.patrol = { id: 'p1', guildId: 'G', startedAt: 5, startedBy: 'mod', watched: {} };
    await a.save(state);
    assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp')), false, 'no quedan temporales');

    // Otro proceso vivo (el padre de este test) figura como dueño del lock.
    fs.writeFileSync(path.join(dir, 'bot.lock'), String(process.ppid));
    const b = new JsonStore(dir);
    assert.throws(() => b.acquireLock(), /otra instancia/);
    assert.equal((await b.load()).patrol.id, 'p1');

    fs.rmSync(path.join(dir, 'bot.lock'));
    b.acquireLock(); // ahora sí
    assert.equal(fs.readFileSync(path.join(dir, 'bot.lock'), 'utf8'), String(process.pid));
    b.releaseLock();
    assert.equal(fs.existsSync(path.join(dir, 'bot.lock')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: un lock huérfano de un proceso muerto se recupera; un archivo corrupto no se descarta en silencio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'bot.lock'), '99999999'); // pid inexistente
    const store = new JsonStore(dir);
    store.acquireLock();
    store.releaseLock();

    assert.deepEqual(await store.load(), emptyState(), 'sin archivo => estado vacío');
    fs.writeFileSync(path.join(dir, 'state.json'), '{ esto no es json');
    await assert.rejects(() => store.load(), (err) => err.code === 'CORRUPT_STATE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('el servicio funciona de punta a punta sobre JsonStore real (reinicio incluido)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-test-'));
  try {
    const h = await createHarness({ store: new JsonStore(dir) });
    await h.discord.join('u1', 'v1');
    await h.service.applyStartPatrol({ by: 'mod', targetId: 'u1' });
    await h.restart();
    await h.service.recover();
    const st = await h.service.getStatus();
    assert.equal(st.active, true);
    assert.equal(st.watched[0].userId, 'u1');
    assert.equal(st.watched[0].serverMute, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
