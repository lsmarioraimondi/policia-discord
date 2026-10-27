'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');
const { createHarness } = require('./helpers');
const { runCommand } = require('../src/discord/commandRunner');
const { buildCommandJSON, hasPermissionLevel } = require('../src/discord/commands');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { mapError } = require('../src/discord/adapter');

const perms = (...flags) => new PermissionsBitField(flags);
const MOD = perms(PermissionFlagsBits.MuteMembers);
const ADMIN = perms(PermissionFlagsBits.ManageGuild);
const NONE = perms();
const target = (id = 'u1', extra = {}) => ({ id, bot: false, isMember: true, ...extra });

const run = (h, name, permissions, extra = {}) =>
  runCommand({ name, guildId: 'G', userId: 'mod', permissions, ...extra }, h.service, h.config);

test('permisos: iniciar/finalizar exigen ManageGuild; vigilar/estado aceptan MuteMembers', async () => {
  const h = await createHarness();
  assert.match(await run(h, 'policia-iniciar', MOD, { target: target() }), /No tenés permisos/);
  assert.match(await run(h, 'policia-iniciar', NONE, { target: target() }), /No tenés permisos/);
  assert.match(await run(h, 'policia-iniciar', null, { target: target() }), /No tenés permisos/);
  assert.match(await run(h, 'policia-iniciar', ADMIN, { target: target() }), /Patrulla iniciada/);

  assert.match(await run(h, 'vigilar', NONE, { target: target('u2') }), /No tenés permisos/);
  assert.match(await run(h, 'vigilar', MOD, { target: target('u2') }), /agregado/);
  assert.match(await run(h, 'dejar-vigilar', NONE, { target: target('u2') }), /No tenés permisos/);
  assert.match(await run(h, 'policia-estado', NONE), /No tenés permisos/);
  assert.match(await run(h, 'policia-estado', MOD), /Patrulla activa/);
  assert.match(await run(h, 'policia-finalizar', MOD), /No tenés permisos/);
  assert.match(await run(h, 'policia-finalizar', ADMIN), /Patrulla finalizada/);
  assert.equal(h.store.snapshot().patrol, null);
});

test('los comandos no ejecutan nada en un servidor distinto al configurado', async () => {
  const h = await createHarness();
  const out = await runCommand(
    { name: 'policia-iniciar', guildId: 'OTRO', userId: 'mod', permissions: ADMIN, target: target() },
    h.service,
    h.config,
  );
  assert.match(out, /solo funciona/);
  assert.equal(h.store.snapshot().patrol, null);
});

test('no se vigila a bots ni a usuarios que no están en el servidor', async () => {
  const h = await createHarness();
  assert.match(await run(h, 'policia-iniciar', ADMIN, { target: target('x', { isMember: false }) }), /no es miembro/);
  assert.match(await run(h, 'policia-iniciar', ADMIN, { target: target('b', { bot: true }) }), /bot/);
  assert.equal(h.store.snapshot().patrol, null);
});

test('respuestas claras cuando no se cumplen las condiciones de /pedir-palabra', async () => {
  const h = await createHarness();
  assert.match(await run(h, 'pedir-palabra', NONE), /No hay una patrulla activa/);
  await h.discord.join('u1', 'v1');
  await run(h, 'policia-iniciar', ADMIN, { target: target('u1') });
  assert.match(await run(h, 'pedir-palabra', NONE), /No estás siendo vigilado/);
  const asU1 = (n) => runCommand({ name: n, guildId: 'G', userId: 'u1', permissions: NONE }, h.service, h.config);
  assert.match(await asU1('pedir-palabra'), /No hay votantes habilitados/);
});

test('/pedir-palabra desde un vigilado con votantes publica la solicitud', async () => {
  const h = await createHarness();
  await h.discord.join('u1', 'v1');
  await h.discord.join('a', 'v1');
  await run(h, 'policia-iniciar', ADMIN, { target: target('u1') });
  const out = await runCommand({ name: 'pedir-palabra', guildId: 'G', userId: 'u1', permissions: NONE }, h.service, h.config);
  assert.match(out, /Solicitud publicada/);
  assert.match(
    await runCommand({ name: 'pedir-palabra', guildId: 'G', userId: 'u1', permissions: NONE }, h.service, h.config),
    /solicitud de palabra abierta/,
  );
});

test('hasPermissionLevel', () => {
  assert.equal(hasPermissionLevel(null, null), true);
  assert.equal(hasPermissionLevel(NONE, 'mod'), false);
  assert.equal(hasPermissionLevel(perms(PermissionFlagsBits.Administrator), 'admin'), true, 'Administrador implícito');
});

test('definición de slash commands: nombres, opciones y sin permiso global de administrador', () => {
  const cmds = buildCommandJSON();
  assert.deepEqual(
    cmds.map((c) => c.name),
    ['policia-iniciar', 'vigilar', 'dejar-vigilar', 'policia-finalizar', 'policia-estado', 'pedir-palabra'],
  );
  for (const name of ['policia-iniciar', 'vigilar', 'dejar-vigilar']) {
    const opt = cmds.find((c) => c.name === name).options[0];
    assert.deepEqual([opt.name, opt.type, opt.required], ['usuario', 6, true]);
  }
  for (const c of cmds) {
    const bits = c.default_member_permissions ? BigInt(c.default_member_permissions) : 0n;
    assert.equal(bits & PermissionFlagsBits.Administrator, 0n);
    assert.deepEqual(c.contexts, [0], 'solo en servidores');
  }
});

test('configuración: valida variables y aplica valores por defecto', () => {
  const ok = loadConfig({
    DISCORD_TOKEN: 'x'.repeat(30),
    CLIENT_ID: '123456789012345678',
    GUILD_ID: '223456789012345678',
    VOTING_CHANNEL_ID: '323456789012345678',
  });
  assert.equal(ok.speakDurationSeconds, 120);
  assert.equal(ok.dataDir, './data');

  assert.throws(() => loadConfig({}), /DISCORD_TOKEN[\s\S]*CLIENT_ID[\s\S]*GUILD_ID[\s\S]*VOTING_CHANNEL_ID/);
  assert.throws(
    () => loadConfig({ DISCORD_TOKEN: 't', CLIENT_ID: '1', GUILD_ID: '2', VOTING_CHANNEL_ID: '3' }),
    /ID de Discord válido/,
  );
  const base = { DISCORD_TOKEN: 't', CLIENT_ID: '123456789012345678', GUILD_ID: '223456789012345678', VOTING_CHANNEL_ID: '323456789012345678' };
  assert.throws(() => loadConfig({ ...base, SPEAK_DURATION_SECONDS: '0' }), /SPEAK_DURATION_SECONDS/);
  assert.equal(loadConfig({ ...base, SPEAK_DURATION_SECONDS: '45' }).speakDurationSeconds, 45);
  // registrar comandos no necesita el canal de votaciones
  assert.equal(loadConfig({ ...base, VOTING_CHANNEL_ID: '' }, { needRuntime: false }).votingChannelId, null);
});

test('el mensaje de error de configuración no expone el valor del token', () => {
  try {
    loadConfig({ DISCORD_TOKEN: 'SECRETO-SUPER-LARGO', CLIENT_ID: 'mal' });
  } catch (err) {
    assert.equal(err.message.includes('SECRETO'), false);
  }
});

test('el logger redacta los secretos', () => {
  const lines = [];
  const log = createLogger('info', ['SECRETO-SUPER-LARGO'], (l) => lines.push(l));
  log.info('token=SECRETO-SUPER-LARGO listo');
  log.error(new Error('falló con SECRETO-SUPER-LARGO'));
  log.debug('no se emite');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => !l.includes('SECRETO') && l.includes('[REDACTED]')));
});

test('mapeo de errores de la API de Discord', () => {
  assert.equal(mapError({ code: 40032, message: 'x' }).kind, 'NOT_IN_VOICE');
  assert.equal(mapError({ code: 50013, message: 'x' }).kind, 'MISSING_PERMISSIONS');
  assert.equal(mapError({ code: 10008, message: 'x' }).kind, 'NOT_FOUND');
  assert.equal(mapError(new Error('red')).kind, 'UNKNOWN');
});
