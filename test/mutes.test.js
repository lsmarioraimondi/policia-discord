'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { DiscordOpError } = require('../src/core/errors');

const unmuteCalls = (h, userId) => h.discord.muteCalls.filter((c) => c.userId === userId && c.mute === false);
const watch = (h, id) => h.service.applyWatch({ by: 'mod', targetId: id });
const endEarly = (h, id) => h.service.applyUnwatch({ by: 'mod', targetId: id });

test('un usuario ya silenciado por un moderador nunca se des-silencia (fin anticipado)', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1', true); // silenciado antes de la vigilancia
  await watch(h, 'u1');
  assert.equal(h.snapWatch('u1').preMuted, true);
  assert.equal(h.discord.muteCalls.length, 0, 'el bot no necesita silenciarlo');

  const res = await endEarly(h, 'u1');
  assert.equal(res.release, 'none');
  assert.equal(unmuteCalls(h, 'u1').length, 0);
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
});

test('un usuario ya silenciado por un moderador nunca se des-silencia (al vencer el castigo)', async () => {
  const h = await createHarness({ punish: true });
  await h.discord.join('u1', 'v1', true);
  await h.discord.join('u2', 'v1', false);
  await watch(h, 'u1');
  await watch(h, 'u2');
  await h.clock.advance(120_000);
  assert.deepEqual(h.watchedIds(), []);
  assert.equal(h.discord.getVoiceState('u1').serverMute, true, 'sigue silenciado por el moderador');
  assert.equal(h.discord.getVoiceState('u2').serverMute, false, 'el mute del bot sí se libera');
  assert.equal(unmuteCalls(h, 'u1').length, 0);
});

test('un vigilado silenciado por un moderador no puede levantarse el silencio por votación', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1', true);
  await h.discord.join('a', 'v1');
  await watch(h, 'u1');
  const res = await h.service.requestFloor({ userId: 'u1' });
  assert.equal(res.code, 'PREMUTED');
  assert.equal(h.discord.lastPollMessage(), null);
});

test('mute previo detectado recién al conectarse (estaba desconectado al iniciar)', async () => {
  const h = await createHarness();
  await watch(h, 'u1');
  assert.equal(h.snapWatch('u1').preMuted, null);
  await h.discord.join('u1', 'v1', true);
  assert.equal(h.snapWatch('u1').preMuted, true);
  assert.equal(h.discord.muteCalls.length, 0);
  await endEarly(h, 'u1');
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
});

test('un moderador que des-silencia a mano durante la vigilancia: el bot no pelea y no lo vuelve a tocar', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  const calls = h.discord.muteCalls.length;

  await h.discord.modSetMute('u1', false);
  const w = h.snapWatch('u1');
  assert.equal(w.manualUnmute, true);
  assert.equal(w.botMuted, false);
  assert.equal(h.discord.muteCalls.length, calls, 'sin bucle de eventos: no re-silencia');

  await endEarly(h, 'u1');
  assert.equal(unmuteCalls(h, 'u1').length, 0, 'no hay nada propio que liberar');
});

test('tras un des-silencio manual, al reconectarse se vuelve a aplicar la vigilancia', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.modSetMute('u1', false);
  await h.discord.leave('u1');
  await h.discord.join('u1', 'v1', false);
  assert.equal(h.discord.getVoiceState('u1').serverMute, true);
  assert.equal(h.snapWatch('u1').manualUnmute, false);
});

test('un moderador silencia durante un permiso: el bot no considera suyo ese mute', async () => {
  const h = await createHarness();
  await h.discord.join('req', 'v1');
  await h.discord.join('a', 'v1');
  await watch(h, 'req');
  const r = await h.service.requestFloor({ userId: 'req' });
  await h.discord.vote(r.poll.messageId, 'a');
  await h.discord.modSetMute('req', true); // mod lo silencia en pleno permiso

  const calls = h.discord.muteCalls.length;
  await h.clock.advance(120_000);
  assert.equal(h.discord.muteCalls.length, calls, 'al vencer el permiso no se pisa el mute del moderador');
  await endEarly(h, 'req');
  assert.equal(h.discord.getVoiceState('req').serverMute, true, 'el mute del moderador queda intacto');
});

test('los cambios provocados por el propio bot no generan bucles de eventos', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.flush();
  assert.equal(h.discord.muteCalls.length, 1, 'un solo setMute pese al evento de retorno');
  assert.equal(h.snapWatch('u1').manualUnmute, false);
});

test('terminar la vigilancia con el usuario desconectado: el mute propio queda pendiente y se libera al conectarse', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.leave('u1'); // el mute del servidor persiste fuera de voz
  const res = await endEarly(h, 'u1');
  assert.equal(res.release, 'deferred');
  assert.ok(h.store.snapshot().pendingReleases.u1, 'queda registrado de forma persistente');
  assert.deepEqual(h.snapWatchedIds(), [], 'la vigilancia ya no figura como activa');

  await h.discord.join('u1', 'v1', true); // vuelve y Discord conserva el mute
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('vencimiento con el usuario desconectado: deja de figurar vigilado y la liberación queda pendiente', async () => {
  const h = await createHarness({ punish: true });
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.leave('u1');
  await h.clock.advance(120_000);
  assert.deepEqual(h.snapWatchedIds(), []);
  assert.deepEqual(Object.keys(h.store.snapshot().pendingReleases), ['u1']);
  await h.discord.join('u1', 'v1', true);
  assert.equal(h.discord.getVoiceState('u1').serverMute, false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('liberación pendiente: si ya no está silenciado se descarta sin tocar nada', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.leave('u1');
  await endEarly(h, 'u1');
  const calls = h.discord.muteCalls.length;
  await h.discord.join('u1', 'v1', false);
  assert.equal(h.discord.muteCalls.length, calls);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('liberación pendiente: un moderador que lo des-silencia primero cancela la liberación', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  h.discord.failMute = new DiscordOpError('UNKNOWN', 'API caída'); // no se puede liberar ahora
  const res = await endEarly(h, 'u1');
  assert.equal(res.release, 'error');
  assert.ok(h.store.snapshot().pendingReleases.u1);
  h.discord.failMute = null;
  await h.discord.modSetMute('u1', false);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
});

test('fallo al liberar: se informa y queda pendiente (nunca se promete lo imposible)', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  h.discord.failMute = new DiscordOpError('MISSING_PERMISSIONS', 'x');
  const res = await endEarly(h, 'u1');
  assert.equal(res.ok, true);
  assert.equal(res.release, 'error');
  assert.match(h.discord.sent.at(-1).content, /manualmente/);
  assert.deepEqual(h.snapWatchedIds(), [], 'la vigilancia igual termina');
  assert.ok(h.store.snapshot().pendingReleases.u1);
});

test('si se vuelve a vigilar a alguien con un mute propio pendiente, la propiedad continúa', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await watch(h, 'u1');
  await h.discord.leave('u1');
  await endEarly(h, 'u1');
  assert.ok(h.store.snapshot().pendingReleases.u1);

  await watch(h, 'u1');
  const w = h.snapWatch('u1');
  assert.deepEqual([w.botMuted, w.preMuted], [true, false]);
  assert.deepEqual(h.store.snapshot().pendingReleases, {});
  await h.discord.join('u1', 'v1', true);
  const res = await endEarly(h, 'u1');
  assert.equal(res.release, 'released');
});

test('nunca se afecta a usuarios no vigilados ni siquiera ante eventos de mute ajenos', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.discord.join('other', 'v1');
  await watch(h, 'u1');
  await h.discord.modSetMute('other', true);
  await h.discord.modSetMute('other', false);
  await h.discord.move('other', 'v2');
  await h.discord.leave('other');
  assert.ok(h.discord.muteCalls.every((c) => c.userId === 'u1'));
});

test('un error de Discord al silenciar queda marcado y no rompe la vigilancia', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  h.discord.failMute = new DiscordOpError('MISSING_PERMISSIONS', 'x');
  await watch(h, 'u1');
  const st = await h.service.getStatus();
  assert.equal(st.watches.length, 1);
  assert.equal(st.watches[0].needsRemute, true);
});
