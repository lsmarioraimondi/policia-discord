'use strict';

/**
 * Error normalizado de una operación contra Discord. `kind`:
 *  - NOT_IN_VOICE         el usuario no está conectado a voz (Discord 40032)
 *  - MISSING_PERMISSIONS  al bot le falta MuteMembers o su rol es insuficiente (50013 / 50001)
 *  - NOT_FOUND            mensaje/usuario/canal inexistente (10003, 10007, 10008, 10013)
 *  - UNKNOWN              cualquier otro
 */
class DiscordOpError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'DiscordOpError';
    this.kind = kind;
    this.cause = cause;
  }
}

function errorText(err) {
  switch (err?.kind) {
    case 'NOT_IN_VOICE':
      return 'el usuario no está conectado a un canal de voz';
    case 'MISSING_PERMISSIONS':
      return 'el bot no tiene permiso para silenciar miembros (falta "Silenciar miembros" o su rol está por debajo del usuario)';
    case 'NOT_FOUND':
      return 'Discord no encontró el recurso (usuario, canal o mensaje)';
    default:
      return `error de Discord: ${err?.message ?? 'desconocido'}`;
  }
}

module.exports = { DiscordOpError, errorText };
