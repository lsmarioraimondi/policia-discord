'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events, PermissionsBitField, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { registerHandlers } = require('../src/discord/handlers');
const { DiscordAdapter } = require('../src/discord/adapter');
const { createLogger } = require('../src/logger');

const config = { guildId: 'G', votingChannelId: 'VC' };
const logger = createLogger('error', [], () => {});
const tick = () => new Promise((r) => setImmediate(r));

function fakeService() {
  const calls = [];
  const rec = (name) => async (arg) => {
    calls.push([name, arg]);
    return {};
  };
  return {
    calls,
    onVoiceStateUpdate: rec('voice'),
    onReactionChange: rec('reaction'),
    onMessageDeleted: rec('deleted'),
    startPatrol: async (a) => (calls.push(['start', a]), { ok: true, mute: { status: 'muted' } }),
  };
}

test('los eventos de discord.js llegan al núcleo con los datos normalizados', async () => {
  const client = new EventEmitter();
  const service = fakeService();
  registerHandlers({ client, service, config, logger });

  client.emit(
    Events.VoiceStateUpdate,
    { channelId: 'a', serverMute: false },
    { id: 'u1', guild: { id: 'G' }, channelId: 'b', serverMute: true },
  );
  client.emit(Events.VoiceStateUpdate, { channelId: null }, { id: 'u1', guild: { id: 'OTRO' }, channelId: 'b' });
  client.emit(Events.MessageReactionAdd, { message: { id: 'm1', channelId: 'VC' } }, { bot: false });
  client.emit(Events.MessageReactionRemove, { message: { id: 'm2', channelId: 'VC' } }, { bot: false });
  client.emit(Events.MessageReactionAdd, { message: { id: 'm3', channelId: 'VC' } }, { bot: true }); // el propio bot
  client.emit(Events.MessageReactionAdd, { message: { id: 'm4', channelId: 'otro' } }, { bot: false });
  client.emit(Events.MessageDelete, { id: 'm5', channelId: 'VC' });
  client.emit(Events.MessageDelete, { id: 'm6', channelId: 'otro' });
  await tick();

  assert.deepEqual(service.calls, [
    ['voice', { userId: 'u1', oldChannelId: 'a', newChannelId: 'b', oldMute: false, newMute: true }],
    ['reaction', 'm1'],
    ['reaction', 'm2'],
    ['deleted', 'm5'],
  ]);
});

test('un slash command se difiere, se ejecuta y responde de forma efímera', async () => {
  const client = new EventEmitter();
  const service = fakeService();
  registerHandlers({ client, service, config, logger });
  const log = [];
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'policia-iniciar',
    guildId: 'G',
    user: { id: 'mod' },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    options: {
      getUser: () => ({ id: 'u1', bot: false }),
      getMember: () => ({ id: 'u1' }),
    },
    deferReply: async (o) => log.push(['defer', o]),
    editReply: async (o) => log.push(['edit', o]),
    reply: async (o) => log.push(['reply', o]),
  };
  client.emit(Events.InteractionCreate, interaction);
  await tick();
  await tick();
  assert.deepEqual(log[0], ['defer', { flags: MessageFlags.Ephemeral }]);
  assert.match(log[1][1].content, /Patrulla iniciada/);
  assert.deepEqual(service.calls[0], ['start', { by: 'mod', targetId: 'u1', targetIsBot: false }]);
});

test('un error interno responde un mensaje genérico (sin filtrar detalles)', async () => {
  const client = new EventEmitter();
  const service = { startPatrol: async () => { throw new Error('detalle interno secreto'); } };
  registerHandlers({ client, service, config, logger });
  const log = [];
  client.emit(Events.InteractionCreate, {
    isChatInputCommand: () => true,
    commandName: 'policia-iniciar',
    guildId: 'G',
    user: { id: 'mod' },
    memberPermissions: new PermissionsBitField([PermissionFlagsBits.ManageGuild]),
    options: { getUser: () => ({ id: 'u1', bot: false }), getMember: () => ({}) },
    deferReply: async () => {},
    editReply: async (o) => log.push(o),
  });
  await tick();
  await tick();
  assert.match(log[0].content, /error interno/);
  assert.equal(log[0].content.includes('secreto'), false);
});

test('adaptador: estado de voz, miembros del canal y mute contra una API simulada', async () => {
  const edits = [];
  const states = new Map([
    ['u1', { id: 'u1', channelId: 'v1', serverMute: true, member: { user: { bot: false } } }],
    ['b1', { id: 'b1', channelId: 'v1', serverMute: false, member: { user: { bot: true } } }],
    ['u2', { id: 'u2', channelId: 'v1', serverMute: false, member: undefined }],
    ['u3', { id: 'u3', channelId: null, serverMute: false }],
  ]);
  const guild = {
    voiceStates: { cache: states },
    members: {
      fetch: async () => ({ user: { bot: false } }),
      edit: async (id, data) => {
        if (id === 'nope') throw Object.assign(new Error('Target user is not connected to voice.'), { code: 40032 });
        edits.push([id, data]);
      },
    },
  };
  const client = { guilds: { cache: new Map([['G', guild]]) }, channels: { cache: new Map([['v1', { name: 'General' }]]) } };
  const adapter = new DiscordAdapter(client, config);

  assert.deepEqual(adapter.getVoiceState('u1'), { channelId: 'v1', serverMute: true });
  assert.equal(adapter.getVoiceState('u3'), null);
  assert.equal(adapter.getVoiceState('zzz'), null);
  assert.deepEqual(await adapter.getVoiceChannelMembers('v1'), [
    { id: 'u1', bot: false },
    { id: 'b1', bot: true },
    { id: 'u2', bot: false },
  ]);
  assert.equal(adapter.getChannelName('v1'), 'General');

  await adapter.setMute('u1', false, 'motivo');
  assert.deepEqual(edits, [['u1', { mute: false, reason: 'motivo' }]]);
  await assert.rejects(() => adapter.setMute('nope', true), (e) => e.kind === 'NOT_IN_VOICE');
});
