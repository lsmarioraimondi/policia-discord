'use strict';

const YES = '✅';
const NO = '❌';

/** Tipos de votación. Todos comparten padrón fijo, reacciones, mayoría y persistencia. */
const POLL_TYPES = Object.freeze({
  SPEAK_PERMISSION: 'SPEAK_PERMISSION', // un vigilado pide hablar
  START_PATROL: 'START_PATROL', // iniciar la patrulla vigilando a un usuario
  ADD_WATCH: 'ADD_WATCH', // sumar un usuario a la patrulla activa
  REMOVE_WATCH: 'REMOVE_WATCH', // dejar de vigilar a un usuario
  END_PATROL: 'END_PATROL', // finalizar la patrulla completa
});

/** Mayoría simple estricta: floor(n/2) + 1. */
function majority(voters) {
  return Math.floor(voters / 2) + 1;
}

/**
 * Padrón fijo: humanos presentes, sin repetidos (una persona = un voto aunque aparezca en
 * varios canales), sin bots y sin los ids excluidos (solicitante / afectado / vigilados).
 * @param {{id: string, bot?: boolean}[]} members
 * @param {string | Iterable<string>} exclude  un id o varios
 * @returns {{ roster: string[], participants: number }}
 *   participants = humanos conectados (incluye a los excluidos que estén entre ellos).
 */
function buildRoster(members, exclude) {
  const excluded = new Set(typeof exclude === 'string' ? [exclude] : (exclude ?? []));
  const humans = new Map();
  for (const m of members) if (!m.bot) humans.set(m.id, m);
  const roster = [...humans.keys()].filter((id) => !excluded.has(id));
  return { roster, participants: humans.size };
}

/**
 * Calcula el voto efectivo de cada integrante del padrón a partir de quién reaccionó con cada emoji.
 * Regla determinista: quien reacciona con ✅ y ❌ a la vez vota ❌ (en contra), la opción conservadora.
 * Las reacciones de personas fuera del padrón (incluido el propio bot) se ignoran.
 * @returns {{ votes: Record<string, 'yes'|'no'>, yes: number, no: number }}
 */
function tally(roster, yesUsers, noUsers) {
  const yesSet = new Set(yesUsers);
  const noSet = new Set(noUsers);
  const votes = {};
  let yes = 0;
  let no = 0;
  for (const id of roster) {
    if (noSet.has(id)) {
      votes[id] = 'no';
      no++;
    } else if (yesSet.has(id)) {
      votes[id] = 'yes';
      yes++;
    }
  }
  return { votes, yes, no };
}

/** 'approved' al alcanzar la mayoría; 'rejected' si ya es imposible alcanzarla; si no, 'open'. */
function decide(voters, needed, yes, no) {
  if (yes >= needed) return 'approved';
  if (voters - no < needed) return 'rejected';
  return 'open';
}

module.exports = { YES, NO, POLL_TYPES, majority, buildRoster, tally, decide };
