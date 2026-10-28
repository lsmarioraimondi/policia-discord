'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { emptyState, validateState, needsMigration } = require('./state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Persistencia local en un único archivo JSON con escritura atómica
 * (archivo temporal + rename). Se eligió JSON en lugar de SQLite porque el estado
 * es pequeño (pocas vigilancias y votaciones), no agrega dependencias ni módulos
 * experimentales y es legible/recuperable a mano.
 *
 * Además toma un lock de proceso (pid) para impedir dos instancias del bot a la vez.
 */
class JsonStore {
  constructor(dir, { fileName = 'state.json' } = {}) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, fileName);
    this.lockFile = path.join(this.dir, 'bot.lock');
    this._queue = Promise.resolve();
    this._hasLock = false;
  }

  acquireLock() {
    fsSync.mkdirSync(this.dir, { recursive: true });
    const tryCreate = () => {
      fsSync.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx' });
      this._hasLock = true;
    };
    try {
      tryCreate();
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fsSync.readFileSync(this.lockFile, 'utf8'));
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = e.code === 'EPERM';
        }
      }
      if (alive) {
        throw new Error(`Ya hay otra instancia del bot en ejecución (pid ${pid}). Detenela antes de iniciar otra.`);
      }
      fsSync.rmSync(this.lockFile, { force: true });
      tryCreate();
    }
  }

  releaseLock() {
    if (!this._hasLock) return;
    try {
      fsSync.rmSync(this.lockFile, { force: true });
    } catch {
      /* nada que hacer */
    }
    this._hasLock = false;
  }

  /** Carga el estado. Si el archivo está corrupto lanza error: nunca se descarta en silencio. */
  async load() {
    let text;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyState();
      throw err;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw this._corrupt(err);
    }
    // Formato anterior: antes de migrar se hace una copia de respaldo del archivo ORIGINAL. Si no se puede
    // respaldar, no se migra (el error se propaga y el bot no arranca) para no perder datos.
    let backupName = null;
    if (needsMigration(raw)) {
      backupName = `${path.basename(this.file)}.v${raw.version}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.copyFile(this.file, path.join(this.dir, backupName));
    }
    try {
      const state = validateState(raw);
      if (backupName && state.migration) state.migration.backup = backupName;
      return state;
    } catch (err) {
      throw this._corrupt(err);
    }
  }

  _corrupt(err) {
    const e = new Error(
      `El archivo de estado ${this.file} está corrupto o es incompatible (${err.message}). ` +
        'Revisalo manualmente: si lo borrás se pierde el rastro de mutes aplicados por el bot (ver docs/OPERACION.md, "Recuperar silencios").',
    );
    e.code = 'CORRUPT_STATE';
    return e;
  }

  /** Guarda de forma atómica. Las escrituras se serializan. */
  save(state) {
    const snapshot = JSON.stringify(state, null, 2);
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      // En Windows (sobre todo en carpetas sincronizadas) rename puede fallar de forma transitoria.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(tmp, this.file);
          return;
        } catch (err) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
          await sleep(50 * (attempt + 1));
        }
      }
    };
    const result = this._queue.then(run);
    this._queue = result.catch(() => {});
    return result;
  }
}

/** Almacén en memoria para tests. Guarda copias para detectar mutaciones no persistidas. */
class MemoryStore {
  constructor(initial = null) {
    this.data = initial ? JSON.stringify(initial) : null;
    this.saves = 0;
    this.failNextSave = false;
  }

  async load() {
    return this.data ? validateState(JSON.parse(this.data)) : emptyState();
  }

  async save(state) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('fallo de disco simulado');
    }
    this.data = JSON.stringify(state);
    this.saves++;
  }

  snapshot() {
    return this.data ? JSON.parse(this.data) : emptyState();
  }
}

module.exports = { JsonStore, MemoryStore };
