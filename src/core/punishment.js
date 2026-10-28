'use strict';

/**
 * Reglas puras de los castigos temporales (sin estado ni Discord), para poder probarlas aisladas.
 *
 * Racha global: `streak = { lastUserId, count }`.
 *  - Si el castigo aprobado es para la MISMA persona que recibió el castigo aprobado inmediatamente
 *    anterior (en todo el servidor), `count` aumenta en 1 y la duración se duplica.
 *  - Si es para otra persona, la racha vuelve a 1 con esa persona.
 * No depende del número histórico de castigos por usuario: solo del orden global.
 * Rechazos, solicitudes pendientes, permisos de palabra, vencimientos, desconexiones, aislamientos,
 * fines anticipados y reinicios NO modifican la racha; solo un castigo aprobado la modifica.
 */

/** Exponente máximo antes del tope: evita desbordes numéricos con rachas enormes. */
const MAX_EXPONENT = 30;

/**
 * Duración (segundos) del castigo número `count` de una racha: base * 2^(count-1), con tope.
 * @param {number} count  1 = primer castigo de la racha
 */
function computeDuration(count, baseSeconds, maxSeconds) {
  const exponent = Math.min(Math.max(count - 1, 0), MAX_EXPONENT);
  return Math.min(baseSeconds * 2 ** exponent, maxSeconds);
}

/**
 * Castigo que correspondería (o corresponde) aplicar a `userId` dado el estado actual de la racha.
 * No modifica nada.
 * @returns {{ count: number, durationSeconds: number }}
 */
function nextPunishment(streak, userId, { basePunishmentSeconds, maxPunishmentSeconds }) {
  const count = streak && streak.lastUserId === userId ? streak.count + 1 : 1;
  return { count, durationSeconds: computeDuration(count, basePunishmentSeconds, maxPunishmentSeconds) };
}

/** Racha resultante de aprobar un castigo a `userId`. */
function advanceStreak(streak, userId) {
  return { lastUserId: userId, count: streak && streak.lastUserId === userId ? streak.count + 1 : 1 };
}

const ORDINALS = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];

/** "tercer", "décimo", "12.º"... para frases como "es su tercer castigo consecutivo". */
function ordinal(n) {
  return ORDINALS[n] || `${n}.º`;
}

module.exports = { computeDuration, nextPunishment, advanceStreak, ordinal, MAX_EXPONENT };
