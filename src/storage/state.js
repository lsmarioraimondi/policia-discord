'use strict';

/**
 * Estado persistente (versión 2): el modelo ya no tiene "patrulla". Una VIGILANCIA es un castigo
 * temporal por usuario; todas las vigilancias activas viven en `watches` y desaparecen al terminar.
 *
 * Formato de una vigilancia (`state.watches[id]`):
 *   id, userId, status ('active'), requestedBy, pollId (votación que la autorizó),
 *   startedAt, expiresAt, durationSeconds, streakCount,
 *   reconnects, awaitingReturn, isolationAttempted, isolationFailure,
 *   preMuted, botMuted, pendingOp, manualUnmute, uncertain, needsRemute, remuteAttempts  (gestión del mute)
 */
const STATE_VERSION = 2;

function emptyState() {
  return {
    version: STATE_VERSION,
    watches: {}, // { [watchId]: Watch } vigilancias activas (como máximo una por usuario)
    polls: {}, // { [pollId]: Poll } (solo votaciones abiertas)
    permits: {}, // { [userId]: Permit } (permisos de palabra vigentes)
    pendingReleases: {}, // { [userId]: { since } } mutes del bot aún sin liberar
    streak: { lastUserId: null, count: 0 }, // racha global de castigos consecutivos a la misma persona
    isolations: {}, // { [userId]: { startedAt, until, ... } } timeouts aplicados por el bot (seguimiento)
    migration: null, // { fromVersion, at, backup, notes, reported } si el estado se migró desde un formato anterior
  };
}

/** ¿Este JSON está en un formato anterior que se puede migrar? */
function needsMigration(raw) {
  return !!raw && typeof raw === 'object' && raw.version === 1;
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Migra el formato 1 (con "patrulla") al 2. Función pura: no toca disco ni Discord.
 * Reglas conservadoras (nada se descarta en silencio; el original queda respaldado por el almacén):
 *  - Vigilancias con castigo (v1.2): se conservan con id, inicio, vencimiento ABSOLUTO, racha y contadores.
 *  - Vigilancias sin castigo (v1.0/1.1, indefinidas): en el modelo nuevo no pueden existir. Se cierran y
 *    su mute propio, si lo había, pasa a "liberación pendiente" (se levanta cuando sea seguro).
 *  - Votaciones, permisos, liberaciones pendientes, racha y aislamientos se conservan tal cual.
 *  - Los datos de la patrulla (id, inicio, autor) y `lastPatrol` quedan resumidos en `migration`.
 */
function migrateV1(raw, now = Date.now()) {
  const state = emptyState();
  const notes = [];
  for (const key of ['polls', 'permits', 'pendingReleases', 'isolations']) {
    if (raw[key] !== undefined && !isObject(raw[key])) throw new Error(`campo "${key}" inválido`);
    state[key] = structuredClone(raw[key] ?? {}); // copia: el original no se modifica
  }
  if (isObject(raw.streak) && Number.isInteger(raw.streak.count)) state.streak = structuredClone(raw.streak);

  const patrol = raw.patrol ?? null;
  if (patrol !== null && (!isObject(patrol) || !isObject(patrol.watched))) throw new Error('campo "patrol" inválido');

  for (const [userId, w] of Object.entries(patrol?.watched ?? {})) {
    const p = w.punishment;
    const { punishment: _legacy, addedAt, addedBy, ...muteFields } = w;
    if (p && Number.isFinite(p.expiresAt) && typeof p.id === 'string') {
      state.watches[p.id] = {
        ...muteFields,
        id: p.id,
        userId,
        status: 'active',
        requestedBy: addedBy ?? null,
        pollId: null,
        startedAt: p.startedAt ?? addedAt ?? now,
        expiresAt: p.expiresAt,
        durationSeconds: p.durationSeconds,
        streakCount: p.streakCount ?? 1,
        reconnects: p.reconnects ?? 0,
        awaitingReturn: !!p.awaitingReturn,
        isolationAttempted: !!p.isolationAttempted,
        isolationFailure: p.isolationFailure ?? null,
      };
      notes.push({ kind: 'watch_kept', userId, expiresAt: p.expiresAt });
    } else {
      const owned = w.botMuted === true && w.preMuted !== true;
      if (owned && !state.pendingReleases[userId]) state.pendingReleases[userId] = { since: now };
      notes.push({ kind: 'legacy_watch_closed', userId, ownedMuteQueuedForRelease: owned });
    }
  }

  state.migration = {
    fromVersion: 1,
    at: now,
    backup: null, // lo completa el almacén con el nombre del respaldo
    reported: false,
    notes,
    legacyPatrol: patrol ? { id: patrol.id ?? null, startedAt: patrol.startedAt ?? null, startedBy: patrol.startedBy ?? null } : null,
    lastPatrol: structuredClone(raw.lastPatrol ?? null),
  };
  return state;
}

/** Valida (y migra si hace falta) un estado leído de disco. */
function validateState(raw) {
  if (!isObject(raw)) throw new Error('el estado no es un objeto');
  if (needsMigration(raw)) return migrateV1(raw);
  if (raw.version !== STATE_VERSION) throw new Error(`versión de estado no soportada: ${raw.version}`);
  const state = { ...emptyState(), ...raw };
  for (const key of ['watches', 'polls', 'permits', 'pendingReleases', 'isolations']) {
    if (!isObject(state[key])) throw new Error(`campo "${key}" inválido`);
  }
  if (!isObject(state.streak) || !Number.isInteger(state.streak.count)) {
    throw new Error('campo "streak" inválido');
  }
  return state;
}

module.exports = { STATE_VERSION, emptyState, validateState, needsMigration, migrateV1 };
