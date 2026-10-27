'use strict';

const STATE_VERSION = 1;

function emptyState() {
  return {
    version: STATE_VERSION,
    patrol: null, // { id, guildId, startedAt, startedBy, watched: { [userId]: WatchedRecord } }
    polls: {}, // { [pollId]: Poll } (solo votaciones abiertas)
    permits: {}, // { [userId]: Permit } (permisos vigentes)
    pendingReleases: {}, // { [userId]: { since, reason } } mutes del bot aún sin liberar
    lastPatrol: null, // { id, startedAt, endedAt, endedBy }
  };
}

function validateState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('el estado no es un objeto');
  if (raw.version !== STATE_VERSION) throw new Error(`versión de estado no soportada: ${raw.version}`);
  const base = emptyState();
  const state = { ...base, ...raw };
  for (const key of ['polls', 'permits', 'pendingReleases']) {
    if (!state[key] || typeof state[key] !== 'object') throw new Error(`campo "${key}" inválido`);
  }
  if (state.patrol !== null && (typeof state.patrol !== 'object' || typeof state.patrol.watched !== 'object')) {
    throw new Error('campo "patrol" inválido');
  }
  return state;
}

module.exports = { STATE_VERSION, emptyState, validateState };
