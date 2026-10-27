'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger mínimo. Redacta cualquier secreto registrado para que jamás llegue a consola.
 * @param {string} level
 * @param {string[]} [secrets]
 * @param {(line: string) => void} [sink]
 */
function createLogger(level = 'info', secrets = [], sink = null) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const clean = secrets.filter((s) => typeof s === 'string' && s.length >= 8);

  const redact = (text) => clean.reduce((acc, s) => acc.split(s).join('[REDACTED]'), text);

  const fmt = (arg) => {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  };

  const emit = (lvl, args) => {
    if (LEVELS[lvl] < threshold) return;
    const line = redact(`${new Date().toISOString()} [${lvl.toUpperCase()}] ${args.map(fmt).join(' ')}`);
    if (sink) return sink(line);
    (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
  };

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

module.exports = { createLogger };
