'use strict';

/**
 * Cola de exclusión mutua. Todas las operaciones que modifican el estado de la patrulla
 * pasan por acá, de modo que comandos, eventos de voz y reacciones concurrentes se
 * ejecutan de a uno y en orden de llegada.
 */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(fn);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

module.exports = { Mutex };
