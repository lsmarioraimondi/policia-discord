'use strict';

const SNOWFLAKE = /^\d{17,20}$/;

/** Reconexiones completas (salida + regreso) durante un castigo que disparan el aislamiento. */
const ISOLATION_RECONNECT_LIMIT = 2;

function parseSnowflake(env, name, errors) {
  const value = (env[name] ?? '').trim();
  if (!SNOWFLAKE.test(value)) {
    errors.push(`${name} falta o no es un ID de Discord válido (17-20 dígitos).`);
    return null;
  }
  return value;
}

/**
 * Lee y valida la configuración desde variables de entorno.
 * @param {object} env  normalmente process.env
 * @param {{ needVotingChannel?: boolean, needRuntime?: boolean }} [opts]
 *   needRuntime=false: solo exige lo necesario para registrar comandos.
 */
function loadConfig(env, opts = {}) {
  const { needRuntime = true } = opts;
  const errors = [];

  const token = (env.DISCORD_TOKEN ?? '').trim();
  if (!token) errors.push('DISCORD_TOKEN falta.');

  const clientId = parseSnowflake(env, 'CLIENT_ID', errors);
  const guildId = parseSnowflake(env, 'GUILD_ID', errors);
  const votingChannelId = needRuntime ? parseSnowflake(env, 'VOTING_CHANNEL_ID', errors) : null;

  let speakDurationSeconds = 120;
  if ((env.SPEAK_DURATION_SECONDS ?? '').trim() !== '') {
    speakDurationSeconds = Number(env.SPEAK_DURATION_SECONDS);
    if (!Number.isInteger(speakDurationSeconds) || speakDurationSeconds < 5 || speakDurationSeconds > 3600) {
      errors.push('SPEAK_DURATION_SECONDS debe ser un entero entre 5 y 3600.');
    }
  }

  const intVar = (name, def, min, max) => {
    const raw = (env[name] ?? '').trim();
    if (raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${name} debe ser un entero entre ${min} y ${max}.`);
      return def;
    }
    return n;
  };
  // Castigos temporales: duración inicial, tope de la duración exponencial y aislamiento (timeout de Discord).
  const basePunishmentSeconds = intVar('BASE_PUNISHMENT_SECONDS', 120, 5, 2_592_000);
  const maxPunishmentSeconds = intVar('MAX_PUNISHMENT_SECONDS', 86_400, 5, 2_592_000);
  if (maxPunishmentSeconds < basePunishmentSeconds) {
    errors.push('MAX_PUNISHMENT_SECONDS no puede ser menor que BASE_PUNISHMENT_SECONDS.');
  }
  const isolationDurationSeconds = intVar('ISOLATION_DURATION_SECONDS', 300, 10, 2_419_200); // Discord: máx. 28 días

  const logLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    errors.push('LOG_LEVEL debe ser debug, info, warn o error.');
  }

  if (errors.length) {
    const err = new Error(`Configuración inválida:\n - ${errors.join('\n - ')}`);
    err.code = 'INVALID_CONFIG';
    throw err;
  }

  return {
    token,
    clientId,
    guildId,
    votingChannelId,
    speakDurationSeconds,
    basePunishmentSeconds,
    maxPunishmentSeconds,
    isolationDurationSeconds,
    isolationReconnectLimit: ISOLATION_RECONNECT_LIMIT,
    dataDir: (env.DATA_DIR ?? '').trim() || './data',
    logLevel,
  };
}

module.exports = { loadConfig, ISOLATION_RECONNECT_LIMIT };
