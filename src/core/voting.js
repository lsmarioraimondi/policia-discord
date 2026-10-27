'use strict';

const YES = '✅';
const NO = '❌';

/** Mayoría simple estricta: floor(n/2) + 1. */
function majority(voters) {
  return Math.floor(voters / 2) + 1;
}

/**
 * Padrón fijo: humanos presentes en el canal, sin repetidos, sin bots y sin el solicitante.
 * @param {{id: string, bot?: boolean}[]} members
 * @returns {{ roster: string[], participants: number }}
 *   participants = humanos conectados (incluye al solicitante).
 */
function buildRoster(members, requesterId) {
  const humans = new Map();
  for (const m of members) if (!m.bot) humans.set(m.id, m);
  const roster = [...humans.keys()].filter((id) => id !== requesterId);
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

module.exports = { YES, NO, majority, buildRoster, tally, decide };
