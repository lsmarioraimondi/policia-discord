'use strict';

const SNOWFLAKE = /^\d{17,20}$/;

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
    dataDir: (env.DATA_DIR ?? '').trim() || './data',
    logLevel,
  };
}

module.exports = { loadConfig };
