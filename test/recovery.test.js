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
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
  const r = await h.service.requestFloor({ userId: 'req' });
  await h.discord.vote(r.poll.messageId, 'a');
  return { h, msg: r.poll.messageId };
}

test('recupera las vigilancias activas y re-silencia a los conectados', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  await h.service.applyWatch({ by: 'mod', targetId: 'u2' }); // desconectado

  // durante el reinicio, u2 entró y el mute de u1 se perdió
  h.discord.voice.get('u1').serverMute = false;
  h.discord.voice.set('u2', { channelId: 'v2', serverMute: false });

  await h.restart();
  await h.service.recover();
  const st = await h.service.getStatus();
  assert.deepEqual(st.watches.map((w) => w.userId).sort(), ['u1', 'u2']);
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
  assert.equal(h.clock.timers.length, 1, 'solo el temporizador de la vigilancia');
  assert.equal(h.discord.getVoiceState('req').serverMute, true, 'vigilado en el canal nuevo: se vuelve a silenciar');
});

test('votaciones interrumpidas por un reinicio se cancelan y se comunica', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  for (const v of ['a', 'b', 'c']) await h.discord.join(v, 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'req' });
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

test('una vigilancia terminada no se reactiva tras reiniciar', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });

  await h.restart();
  await h.service.recover();
  assert.deepEqual((await h.service.getStatus()).watches, []);
  const calls = h.discord.muteCalls.length;
  await h.discord.leave('u1');
  await h.discord.join('u1', 'v2');
  assert.equal(h.discord.muteCalls.length, calls);
  assert.equal(h.discord.sent.at(-1).content.includes('se reinició'), false, 'sin vigilancias ni votaciones no hay aviso de recuperación');
});

test('cierre interrumpido: la vigilancia ya figura terminada y el mute propio se libera al reiniciar', async () => {
  const { DiscordOpError } = require('../src/core/errors');
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
  h.discord.failMute = new DiscordOpError('UNKNOWN', 'el proceso murió aquí'); // la liberación no llega a ejecutarse
  await h.service.applyUnwatch({ by: 'mod', targetId: 'u1' });
  const saved = h.store.snapshot();
  assert.deepEqual(saved.watches, {});
  assert.ok(saved.pendingReleases.u1);

  h.discord.failMute = null;
  await h.restart();
  await h.service.recover();
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('operación de mute a medias (corte tras persistir la intención): se resuelve observando el estado real', async () => {
  const state = emptyState();
  const future = 1_700_000_000_000 + 3_600_000;
  const mk = (userId) => ({
    id: `w-${userId}`, userId, status: 'active', requestedBy: 'mod', pollId: null,
    startedAt: 1_700_000_000_000, expiresAt: future, durationSeconds: 3600, streakCount: 1,
    reconnects: 0, awaitingReturn: false, isolationAttempted: false, isolationFailure: null,
    preMuted: false, botMuted: false, pendingOp: 'mute', manualUnmute: false, uncertain: false, needsRemute: false, remuteAttempts: 0,
  });
  for (const id of ['muted', 'notApplied', 'offline']) state.watches[`w-${id}`] = mk(id);
  const h = await createHarness({ store: new MemoryStore(state) });
  h.discord.voice.set('muted', { channelId: 'v1', serverMute: true }); // el mute sí se aplicó
  h.discord.voice.set('notApplied', { channelId: 'v1', serverMute: false }); // no llegó a aplicarse
  await h.service.recover();
  const w = (id) => h.snapWatch(id);
  assert.deepEqual([w('muted').botMuted, w('muted').pendingOp], [true, null]);
  assert.deepEqual([w('notApplied').botMuted, w('notApplied').pendingOp], [true, null], 're-aplicado');
  assert.equal(h.discord.getVoiceState('notApplied').serverMute, true);
  assert.deepEqual([w('offline').botMuted, w('offline').uncertain, w('offline').pendingOp], [false, true, null]);
});

test('JsonStore: guarda y recupera el estado entre procesos y toma un lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-test-'));
  try {
    const a = new JsonStore(dir);
    a.acquireLock();
    const state = emptyState();
    state.streak = { lastUserId: 'x', count: 3 };
    await a.save(state);
    assert.equal(fs.existsSync(path.join(dir, 'state.json.tmp')), false, 'no quedan temporales');

    // Otro proceso vivo (el padre de este test) figura como dueño del lock.
    fs.writeFileSync(path.join(dir, 'bot.lock'), String(process.ppid));
    const b = new JsonStore(dir);
    assert.throws(() => b.acquireLock(), /otra instancia/);
    assert.deepEqual((await b.load()).streak, { lastUserId: 'x', count: 3 });

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
    await h.service.applyWatch({ by: 'mod', targetId: 'u1' });
    await h.restart();
    await h.service.recover();
    const st = await h.service.getStatus();
    assert.equal(st.watches.length, 1);
    assert.equal(st.watches[0].userId, 'u1');
    assert.equal(st.watches[0].serverMute, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
