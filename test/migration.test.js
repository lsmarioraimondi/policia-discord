'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('./helpers');
const { MemoryStore, JsonStore } = require('../src/storage/jsonStore');
const { validateState, migrateV1, needsMigration, STATE_VERSION } = require('../src/storage/state');

const T0 = 1_700_000_000_000; // inicio del FakeClock
const MIN = 60_000;

const mute = (extra = {}) => ({ preMuted: false, botMuted: false, pendingOp: null, manualUnmute: false, uncertain: false, needsRemute: false, remuteAttempts: 0, ...extra });
const punishment = (id, startedAt, secs, extra = {}) => ({
  id,
  startedAt,
  expiresAt: startedAt + secs * 1000,
  durationSeconds: secs,
  streakCount: 2,
  reconnects: 1,
  awaitingReturn: true,
  isolationAttempted: false,
  isolationFailure: null,
  ...extra,
});

/** Estado en el formato anterior (v1): con "patrulla" global. */
function legacyState() {
  return {
    version: 1,
    patrol: {
      id: 'patrulla-vieja',
      guildId: 'G',
      startedAt: T0 - 10 * MIN,
      startedBy: 'admin',
      watched: {
        // con castigo vigente (v1.2): se conserva con su vencimiento absoluto
        keep: { userId: 'keep', addedAt: T0 - MIN, addedBy: 'mod', ...mute({ botMuted: true }), punishment: punishment('w-keep', T0 - MIN, 240) },
        // con castigo ya vencido al migrar
        late: { userId: 'late', addedAt: T0 - 9 * MIN, addedBy: 'mod', ...mute({ botMuted: true }), punishment: punishment('w-late', T0 - 9 * MIN, 120) },
        // mute previo de un moderador: jamás se libera
        pre: { userId: 'pre', addedAt: T0 - MIN, addedBy: 'mod', ...mute({ preMuted: true }), punishment: punishment('w-pre', T0 - MIN, 600) },
        // vigilancias indefinidas (v1.0/1.1): no pueden existir en el modelo nuevo
        oldOwned: { userId: 'oldOwned', addedAt: T0 - 60 * MIN, addedBy: 'mod', ...mute({ botMuted: true }) },
        oldPlain: { userId: 'oldPlain', addedAt: T0 - 60 * MIN, addedBy: 'mod', ...mute() },
      },
    },
    polls: {
      p1: { id: 'p1', type: 'START_PATROL', patrolId: null, requesterId: 'mod', targetId: 'x', channelId: 'v1', messageId: 'mp1', messageChannelId: 'VC', roster: ['a'], needed: 1, votes: {}, status: 'open', createdAt: T0 - MIN },
      p2: { id: 'p2', type: 'END_PATROL', patrolId: 'patrulla-vieja', requesterId: 'mod', targetId: null, channelId: 'v1', messageId: 'mp2', messageChannelId: 'VC', roster: ['a'], needed: 1, votes: {}, status: 'open', createdAt: T0 - MIN },
    },
    permits: {
      keep: { userId: 'keep', patrolId: 'patrulla-vieja', pollId: 'old', channelId: 'v1', messageChannelId: 'VC', messageId: 'mpermit', grantedAt: T0 - 30_000, expiresAt: T0 + 90_000 },
      oldPlain: { userId: 'oldPlain', patrolId: 'patrulla-vieja', pollId: 'old2', channelId: 'v1', messageChannelId: 'VC', messageId: 'mpermit2', grantedAt: T0 - 30_000, expiresAt: T0 + 90_000 },
    },
    pendingReleases: { pend: { since: T0 - 5 * MIN } },
    streak: { lastUserId: 'keep', count: 2 },
    isolations: { iso: { userId: 'iso', startedAt: T0 - MIN, until: T0 + 4 * MIN, durationSeconds: 300, punishmentId: 'x', streakCount: 1 } },
    lastPatrol: { id: 'anterior', startedAt: 1, endedAt: 2, endedBy: 'admin' },
  };
}

// ============================================================ migración pura

test('el formato anterior se detecta y la versión actual es 2', () => {
  assert.equal(STATE_VERSION, 2);
  assert.equal(needsMigration(legacyState()), true);
  assert.equal(needsMigration({ version: 2 }), false);
  assert.throws(() => validateState({ version: 99 }), /versión de estado no soportada/);
  assert.throws(() => validateState({ version: 2, watches: [], polls: {}, permits: {}, pendingReleases: {}, isolations: {}, streak: { lastUserId: null, count: 0 } }), /watches/);
});

test('migrar: conserva vigilancias con castigo (vencimiento absoluto, racha y contadores) como vigilancias independientes', () => {
  const raw = legacyState();
  const before = JSON.stringify(raw);
  const s = migrateV1(raw, T0);
  assert.equal(JSON.stringify(raw), before, 'la migración no modifica el original');
  assert.equal(s.version, 2);
  assert.ok(!('patrol' in s) && !('lastPatrol' in s), 'ya no hay patrulla en el estado');

  const keep = s.watches['w-keep'];
  assert.equal(keep.userId, 'keep');
  assert.equal(keep.status, 'active');
  assert.equal(keep.startedAt, T0 - MIN);
  assert.equal(keep.expiresAt, T0 - MIN + 240_000, 'el vencimiento absoluto no cambia');
  assert.deepEqual([keep.durationSeconds, keep.streakCount, keep.reconnects, keep.awaitingReturn], [240, 2, 1, true]);
  assert.deepEqual([keep.botMuted, keep.preMuted, keep.requestedBy], [true, false, 'mod']);
  assert.ok(!('punishment' in keep) && !('addedAt' in keep));
  assert.equal(s.watches['w-pre'].preMuted, true, 'la protección de mutes de moderadores se conserva');
  assert.deepEqual(Object.keys(s.watches).sort(), ['w-keep', 'w-late', 'w-pre']);
});

test('migrar: las vigilancias indefinidas se cierran sin descartar su mute propio (liberación pendiente)', () => {
  const s = migrateV1(legacyState(), T0);
  assert.deepEqual(s.pendingReleases.oldOwned, { since: T0 }, 'el mute del bot queda registrado para liberarse');
  assert.equal(s.pendingReleases.oldPlain, undefined, 'sin mute propio no hay nada que liberar');
  assert.deepEqual(s.pendingReleases.pend, { since: T0 - 5 * MIN }, 'las liberaciones pendientes previas se mantienen');
  assert.ok(!Object.values(s.watches).some((w) => ['oldOwned', 'oldPlain'].includes(w.userId)));
  const kinds = s.migration.notes.map((n) => `${n.kind}:${n.userId}`).sort();
  assert.deepEqual(kinds, ['legacy_watch_closed:oldOwned', 'legacy_watch_closed:oldPlain', 'watch_kept:keep', 'watch_kept:late', 'watch_kept:pre']);
});

test('migrar: se conservan votaciones, permisos, racha, aislamientos y datos de la patrulla antigua', () => {
  const s = migrateV1(legacyState(), T0);
  assert.deepEqual(Object.keys(s.polls).sort(), ['p1', 'p2']);
  assert.deepEqual(Object.keys(s.permits).sort(), ['keep', 'oldPlain']);
  assert.deepEqual(s.streak, { lastUserId: 'keep', count: 2 });
  assert.equal(s.isolations.iso.until, T0 + 4 * MIN);
  assert.deepEqual(s.migration.legacyPatrol, { id: 'patrulla-vieja', startedAt: T0 - 10 * MIN, startedBy: 'admin' });
  assert.equal(s.migration.lastPatrol.id, 'anterior');
  assert.equal(s.migration.fromVersion, 1);
  assert.equal(s.migration.reported, false);
});

test('migrar un estado v1 sin patrulla ni racha da un estado v2 vacío y válido', () => {
  const s = validateState({ version: 1, patrol: null, polls: {}, permits: {}, pendingReleases: {}, lastPatrol: null });
  assert.deepEqual(s.watches, {});
  assert.deepEqual(s.streak, { lastUserId: null, count: 0 });
  assert.deepEqual(s.isolations, {});
});

test('migrar un v1 corrupto falla en vez de descartar datos', () => {
  assert.throws(() => migrateV1({ version: 1, patrol: { watched: 'no' } }), /patrol/);
  assert.throws(() => migrateV1({ version: 1, polls: [] }), /polls/);
});

// ============================================================ respaldo en disco

test('JsonStore: antes de migrar copia el archivo original; no migra sin respaldo y no lo repite', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-mig-'));
  try {
    const file = path.join(dir, 'state.json');
    const original = JSON.stringify(legacyState(), null, 2);
    fs.writeFileSync(file, original);

    const store = new JsonStore(dir);
    const state = await store.load();
    assert.equal(state.version, 2);
    const backups = fs.readdirSync(dir).filter((f) => f.includes('backup'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^state\.json\.v1-backup-/);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original, 'el respaldo es idéntico al original');
    assert.equal(state.migration.backup, backups[0]);

    await store.save(state); // se persiste en el formato nuevo
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
    const again = await new JsonStore(dir).load(); // un segundo arranque ya no migra ni respalda otra vez
    assert.equal(again.version, 2);
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('backup')).length, 1);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original, 'el respaldo no se toca');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JsonStore: si no se puede respaldar, no se migra y el archivo original queda intacto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policia-mig-'));
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, JSON.stringify(legacyState()));
    const store = new JsonStore(dir);
    const realCopy = fs.promises.copyFile;
    fs.promises.copyFile = async () => {
      throw new Error('disco lleno');
    };
    try {
      await assert.rejects(() => store.load(), /disco lleno/);
    } finally {
      fs.promises.copyFile = realCopy;
    }
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1, 'sin migrar ni modificar');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================ recuperación del servicio sobre un estado migrado

async function migratedHarness() {
  const h = await createHarness({ punish: { isolationReconnectLimit: 2 }, store: new MemoryStore(legacyState()) });
  // quiénes están conectados al arrancar
  // Ya estaban conectados cuando arrancó el proceso (sin eventos de entrada).
  for (const u of ['keep', 'late', 'pre', 'oldOwned']) h.discord.voice.set(u, { channelId: 'v1', serverMute: true }); // mutes del bot (o del moderador en 'pre')
  h.discord.voice.set('a', { channelId: 'v1', serverMute: false });
  h.discord.voice.set('oldPlain', { channelId: 'v1', serverMute: false }); // en el canal del permiso: solo la regla de huérfanos lo cancela
  return h;
}

test('recuperar un estado migrado: vigilancias vigentes siguen, la vencida se regulariza y las antiguas se liberan', async () => {
  const h = await migratedHarness();
  await h.service.recover();

  assert.deepEqual(h.watchedIds(), ['keep', 'pre'], 'late venció durante el apagado y las indefinidas ya no existen');
  assert.equal(h.watch('keep').expiresAt, T0 - MIN + 240_000, 'vencimiento original');
  assert.equal(h.discord.getVoiceState('keep').serverMute, true);
  assert.equal(h.discord.getVoiceState('pre').serverMute, true, 'mute de moderador intacto');
  assert.equal(h.discord.getVoiceState('late').serverMute, false, 'castigo vencido: se libera su mute propio');
  assert.equal(h.discord.getVoiceState('oldOwned').serverMute, false, 'vigilancia indefinida cerrada: mute propio liberado');
  assert.equal(h.discord.muteCalls.filter((c) => c.userId === 'pre').length, 0);
  assert.equal(h.service.state.pendingReleases.oldOwned, undefined);
  assert.match(h.discord.sent.map((m) => m.content).join('\n'), /<@late> cumplió su castigo/);
  assert.equal(h.clock.timers.length, 3, 'un temporizador por vigilancia vigente (keep y pre) y el del permiso de keep');
});

test('recuperar un estado migrado: cancela las votaciones antiguas con aviso y limpia los permisos huérfanos', async () => {
  const h = await migratedHarness();
  await h.service.recover();
  assert.deepEqual(h.store.snapshot().polls, {});
  const announce = h.discord.sent.at(-1).content;
  assert.match(announce, /votación\(es\) interrumpida\(s\)/);
  assert.match(announce, /formato de datos/);
  assert.match(announce, /ya no existe la patrulla general/);
  assert.match(announce, /Vigilancias conservadas con su vencimiento original: 3/);
  assert.match(announce, /<@oldOwned>, <@oldPlain>/);
  assert.ok(h.store.snapshot().permits.keep, 'el permiso de una vigilancia vigente se conserva');
  assert.equal(h.store.snapshot().permits.oldPlain, undefined, 'el permiso de una vigilancia cerrada no puede seguir existiendo');
});

test('recuperar un estado migrado: la racha, los aislamientos y las liberaciones pendientes se conservan', async () => {
  const h = await migratedHarness();
  h.discord.voice.set('pend', { channelId: 'v1', serverMute: true });
  await h.service.recover();
  assert.equal(h.discord.getVoiceState('pend').serverMute, false, 'liberación pendiente previa resuelta');
  assert.deepEqual(h.store.snapshot().streak, { lastUserId: 'keep', count: 2 });
  assert.equal(h.store.snapshot().isolations.iso.until, T0 + 4 * MIN);

  await h.clock.advance(MIN);
  // keep está en racha de 2: su siguiente castigo sería el tercero (8 minutos) si lo vuelven a castigar
  await h.service.applyUnwatch({ by: 'mod', targetId: 'keep' });
  const next = await h.service.applyWatch({ by: 'mod', targetId: 'keep' });
  assert.equal(next.watch.streakCount, 3);
});

test('el aviso de migración se publica una sola vez, aunque se reinicie de nuevo', async () => {
  const h = await migratedHarness();
  await h.service.recover();
  assert.equal(h.store.snapshot().migration.reported, true);
  h.discord.sent.length = 0;
  await h.restart();
  await h.service.recover();
  assert.ok(!h.discord.sent.some((m) => /formato de datos/.test(m.content)));
});

test('un reinicio inmediato tras migrar no pierde ni duplica nada (la migración es idempotente)', async () => {
  const h = await migratedHarness();
  await h.service.recover();
  const afterFirst = JSON.stringify(h.watchedIds());
  await h.restart();
  await h.service.recover();
  assert.equal(JSON.stringify(h.watchedIds()), afterFirst);
  assert.equal(Object.values(h.service.state.watches).length, 2);
});
