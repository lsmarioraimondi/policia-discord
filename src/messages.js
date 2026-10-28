'use strict';

const { YES, NO } = require('./core/voting');
const { ordinal } = require('./core/punishment');

const user = (id) => `<@${id}>`;
const channel = (id) => `<#${id}>`;
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** "2 minutos", "90 segundos", "1 hora y 4 minutos". */
function duration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (h) parts.push(`${h} ${h === 1 ? 'hora' : 'horas'}`);
  if (m) parts.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`);
  if (s || !parts.length) parts.push(`${s} ${s === 1 ? 'segundo' : 'segundos'}`);
  return parts.join(' y ');
}

const streakText = (n) => (n >= 2 ? `${ordinal(n)} castigo consecutivo` : 'primer castigo de la racha');

/** Línea con los datos de una vigilancia (castigo) ya aplicada. */
function punishmentInfo(w) {
  return `⏳ Castigo de ${duration(w.durationSeconds)} (${streakText(w.streakCount)}), vence ${ts(w.expiresAt, 'T')} (${ts(w.expiresAt)}).`;
}

const muteNote = {
  muted: 'silenciado',
  permit: 'tiene un permiso vigente',
  offline: 'no está en voz: se lo silenciará al conectarse',
  manual_unmute: 'un moderador lo des-silenció manualmente; se respeta hasta que se reconecte',
  foreign_mute: 'ya estaba silenciado por otra causa (moderador); el bot no lo considera propio',
  error: 'no se pudo silenciar',
};

function describeMute(result) {
  const base = muteNote[result?.status] ?? result?.status ?? '';
  return result?.status === 'error' && result.error ? `${base}: ${result.error}` : base;
}

function releaseText(status) {
  switch (status) {
    case 'released':
      return 'Se le levantó el silencio que había aplicado el bot.';
    case 'deferred':
      return 'Tenía un silencio del bot: se levantará cuando se conecte a voz.';
    case 'error':
      return '⚠️ No se pudo levantar su silencio; un moderador debe quitarlo manualmente.';
    default:
      return 'No se modificó su estado de silencio.';
  }
}

const yesVotes = (poll) => Object.values(poll.votes).filter((v) => v === 'yes').length;
const isAdminPoll = (poll) => !!poll.type && poll.type !== 'SPEAK_PERMISSION';

const proposedStreak = (p) =>
  p.proposedCount >= 2
    ? `Es su ${ordinal(p.proposedCount)} castigo consecutivo.`
    : 'Es su primer castigo de la racha (sin reincidencia consecutiva).';

/** Textos de las votaciones administrativas (SPEAK_PERMISSION tiene los suyos en pollBody & co.). */
const ADMIN_POLL = {
  START_WATCH: {
    title: 'VOTACIÓN: INICIAR VIGILANCIA',
    label: 'Votación para vigilar',
    short: (p) => `vigilar a ${user(p.targetId)}`,
    question: (p) =>
      p.proposedSeconds
        ? `¿Aprueban castigar a ${user(p.targetId)} durante ${duration(p.proposedSeconds)}? ${proposedStreak(p)}`
        : `¿Autorizan a vigilar a ${user(p.targetId)}?`,
    rejected: (p) => `${user(p.targetId)} no queda vigilado.`,
  },
  END_WATCH: {
    title: 'VOTACIÓN: TERMINAR VIGILANCIA',
    label: 'Votación para dejar de vigilar',
    short: (p) => `dejar de vigilar a ${user(p.targetId)}`,
    question: (p) => `¿Autorizan a terminar anticipadamente el castigo de ${user(p.targetId)}?`,
    rejected: (p) => `${user(p.targetId)} sigue vigilado, sin cambios.`,
  },
};

/** Votaciones de formatos anteriores (solo se ven al cancelarlas durante una migración). */
const LEGACY_POLL = {
  title: 'VOTACIÓN',
  label: 'Votación de un formato anterior',
  short: () => 'votación de un formato anterior',
  question: () => '',
  rejected: () => '',
};
const adminMeta = (poll) => ADMIN_POLL[poll.type] ?? LEGACY_POLL;

/** Descripción corta de una votación (para avisos y estado). */
function describePoll(poll) {
  return isAdminPoll(poll) ? adminMeta(poll).short(poll) : `palabra de ${user(poll.targetId ?? poll.requesterId)}`;
}

const messages = {
  user,
  channel,
  ts,
  duration,
  describeMute,
  describePoll,
  isAdminPoll,

  /** Una vigilancia (castigo temporal) comenzó tras una votación aprobada. */
  watchStarted: (watch, by, result) =>
    `👀 **VIGILANCIA INICIADA** — ${user(watch.userId)} (solicitada por ${user(by)}) — ${describeMute(result)}\n` +
    `${punishmentInfo(watch)}\n` +
    `Mientras dure no puede hablar por voz salvo que el canal lo apruebe con \`/pedir-palabra\`.`,

  /** Resultado de una votación de castigo: duración finalmente aplicada (y aviso si difiere de la propuesta). */
  punishmentOutcome: (poll, watch) =>
    `${punishmentInfo(watch)}` +
    (poll.proposedSeconds && poll.proposedSeconds !== watch.durationSeconds
      ? ` (se había propuesto ${duration(poll.proposedSeconds)}; la racha cambió antes de aprobarse.)`
      : ''),

  /** Fin natural de la vigilancia: venció su tiempo. */
  watchServed: (userId, watch, releaseStatus) =>
    `⏱️ ${user(userId)} cumplió su castigo de ${duration(watch.durationSeconds)} y deja de estar vigilado. ${releaseText(releaseStatus)}`,

  /** Fin anticipado aprobado por votación. */
  watchEndedEarly: (targetId, by, releaseStatus) =>
    `🟢 ${user(targetId)} dejó de estar vigilado (fin anticipado solicitado por ${user(by)}). ${releaseText(releaseStatus)}`,

  isolationApplied: (userId, watch, isolation) =>
    `🚫 **AISLAMIENTO** — ${user(userId)} se desconectó y volvió ${watch.reconnects} veces durante su castigo. ` +
    `Se le aplicó un timeout de ${duration(isolation.durationSeconds)} (hasta ${ts(isolation.until, 'T')}). ` +
    `Su castigo original termina aquí (no se suman minutos) y la racha de reincidencia se conserva.`,

  isolationFailed: (userId, watch, reason) =>
    `⚠️ ${user(userId)} alcanzó ${watch.reconnects} reconexiones durante su castigo, pero no pude aplicarle el aislamiento: ${reason}. ` +
    `La vigilancia original continúa hasta ${ts(watch.expiresAt, 'T')} (${ts(watch.expiresAt)}).`,

  pollBody: (poll, speakSeconds) => {
    if (!isAdminPoll(poll)) {
      return (
        `🚨 **POLICÍA DISCORD — PERMISO PARA HABLAR**` +
        `\n👤 Solicitante: ${user(poll.requesterId)}` +
        `\n🔊 Canal: ${channel(poll.channelId)}` +
        `\n👥 Participantes: ${poll.participants}` +
        `\n🗳️ Votantes habilitados: ${poll.roster.length}` +
        `\n✅ Votos necesarios para aprobar: ${poll.needed}` +
        `\n¿Autorizan a ${user(poll.requesterId)} a hablar durante ${duration(speakSeconds)}?` +
        `\n${YES} A favor\n${NO} En contra`
      );
    }
    const meta = adminMeta(poll);
    return (
      `🚨 **POLICÍA DISCORD — ${meta.title}**` +
      `\n🛡️ Solicitada por: ${user(poll.requesterId)}` +
      `\n👤 Usuario afectado: ${user(poll.targetId)}` +
      `\n🔊 Canal: ${channel(poll.channelId)}` +
      `\n🗳️ Votantes habilitados: ${poll.roster.length}` +
      `\n✅ Votos necesarios para aprobar: ${poll.needed}` +
      `\n${meta.question(poll)}` +
      `\n${YES} A favor\n${NO} En contra`
    );
  },

  pollApproved: (poll, permit) =>
    `🚨 **POLICÍA DISCORD — PERMISO CONCEDIDO**\n` +
    `✅ ${user(poll.requesterId)} puede hablar hasta ${ts(permit.expiresAt, 'T')} (${ts(permit.expiresAt)}).\n` +
    `Votos a favor: ${yesVotes(poll)}/${poll.roster.length}`,

  /** Resultado de una votación administrativa aprobada y ejecutada. */
  adminApproved: (poll, outcome) =>
    `🚨 **POLICÍA DISCORD — ${adminMeta(poll).title}**\n` +
    `✅ **Aprobada** (${yesVotes(poll)}/${poll.roster.length} a favor). ${outcome}`,

  pollRejected: (poll) =>
    isAdminPoll(poll)
      ? `🚨 **POLICÍA DISCORD — ${adminMeta(poll).title}**\n❌ **Rechazada.** ${adminMeta(poll).rejected(poll)}`
      : `🚨 **POLICÍA DISCORD — PERMISO RECHAZADO**\n` +
        `❌ La mayoría no autorizó a ${user(poll.requesterId)} a hablar. Podrá volver a pedir la palabra.`,

  pollCancelled: (poll, reason) =>
    `🚨 **POLICÍA DISCORD — VOTACIÓN CANCELADA**\n` +
    (isAdminPoll(poll)
      ? `⚪ ${adminMeta(poll).label} cancelada: ${reason}.`
      : `⚪ Solicitud de ${user(poll.requesterId)} cancelada: ${reason}.`),

  pollFailed: (poll, reason) =>
    `🚨 **POLICÍA DISCORD — PERMISO NO CONCEDIDO**\n` +
    `⚠️ La votación de ${user(poll.requesterId)} fue aprobada pero no se pudo levantar el silencio: ${reason}.`,

  permitExpired: (permit) =>
    `🚨 **POLICÍA DISCORD — PERMISO VENCIDO**\n🔇 El permiso de ${user(permit.userId)} terminó.`,

  permitCancelled: (permit, reason) =>
    `🚨 **POLICÍA DISCORD — PERMISO CANCELADO**\n🔇 El permiso de ${user(permit.userId)} se canceló: ${reason}.`,

  recovery: (info) =>
    `🔄 **Policía Discord se reinició.** ` +
    (info.watchesActive ? `Vigilancias activas recuperadas: ${info.watchesActive}. ` : '') +
    (info.pollsCancelled.length
      ? `Se cancelaron por seguridad ${info.pollsCancelled.length} votación(es) interrumpida(s): ${info.pollsCancelled
          .map(describePoll)
          .join(', ')}. Pueden volver a solicitarlas.`
      : '') +
    (info.permitsRestored ? ` Permisos vigentes retomados: ${info.permitsRestored}.` : '') +
    (info.watchesServed ? ` Castigos vencidos durante el apagado: ${info.watchesServed}.` : '') +
    (info.migration ? `\n${migrationNotice(info.migration)}` : ''),

  remuteFailed: (userId, reason) =>
    `⚠️ No pude volver a silenciar a ${user(userId)}: ${reason}. Requiere intervención manual de un moderador.`,

  pollMessageDeleted: (poll) => `⚪ Se borró el mensaje de votación (${describePoll(poll)}); la solicitud quedó cancelada.`,
};

function migrationNotice(m) {
  const kept = m.notes.filter((n) => n.kind === 'watch_kept').length;
  const closed = m.notes.filter((n) => n.kind === 'legacy_watch_closed');
  return (
    `ℹ️ Se actualizó el formato de datos: ya no existe la patrulla general, ahora cada vigilancia es un castigo temporal. ` +
    `Vigilancias conservadas con su vencimiento original: ${kept}.` +
    (closed.length
      ? ` Vigilancias antiguas sin vencimiento cerradas: ${closed.map((n) => user(n.userId)).join(', ')} (si el bot los había silenciado, el silencio quedó pendiente de liberar).`
      : '') +
    (m.backup ? ` Respaldo del estado anterior: \`${m.backup}\`.` : '')
  );
}

function formatStatus(st) {
  const lines = [];
  if (!st.watches.length) {
    lines.push('💤 **No hay vigilancias activas.** El bot no está vigilando a nadie. Para castigar a alguien usá `/vigilar`.');
  } else {
    lines.push(`👀 **Vigilancias activas (${st.watches.length}):**`);
    for (const w of st.watches) {
      const where = w.inVoice ? `🔊 ${w.channelName}` : '⚪ fuera de voz';
      const mute = !w.inVoice ? '' : w.serverMute ? ' · 🔇 silenciado' : ' · 🟢 sin silencio';
      const notes = [
        `⏳ castigo de ${duration(w.durationSeconds)} (${streakText(w.streakCount)}), vence ${ts(w.expiresAt)} (${ts(w.expiresAt, 'T')})`,
        `🔁 reconexiones ${w.reconnects}/${st.isolationReconnectLimit}${w.awaitingReturn ? ' (salió: su regreso cuenta)' : ''}`,
      ];
      if (w.isolationFailure) notes.push(`⚠️ aislamiento no aplicado: ${w.isolationFailure}`);
      if (w.permitExpiresAt) notes.push(`🎤 permiso de palabra hasta ${ts(w.permitExpiresAt)}`);
      if (w.pollId) notes.push('🗳️ pidió la palabra (votación abierta)');
      if (w.preMuted) notes.push('🛡️ ya estaba silenciado por un moderador (el bot no lo levanta)');
      if (w.manualUnmute) notes.push('✋ des-silenciado manualmente (se respeta hasta que se reconecte)');
      if (w.uncertain) notes.push('❓ estado de mute incierto tras un reinicio: revisar manualmente');
      if (w.needsRemute) notes.push('⚠️ pendiente de re-silenciar');
      lines.push(`• ${user(w.userId)} — ${where}${mute}\n   ${notes.join(' · ')}`);
    }
  }
  lines.push(`🗳️ **Votaciones pendientes (${st.polls.length}):**`);
  for (const p of st.polls) lines.push(pollLine(p));
  if (!st.polls.length) lines.push('• (ninguna)');
  if (st.watches.length || st.permits.length) {
    lines.push(`🎤 **Permisos de palabra vigentes (${st.permits.length}):**`);
    for (const p of st.permits) lines.push(`• ${user(p.userId)} vence ${ts(p.expiresAt)} (${ts(p.expiresAt, 'T')})`);
    if (!st.permits.length) lines.push('• (ninguno)');
  }
  appendStreak(lines, st);
  appendPending(lines, st);
  return lines.join('\n');
}

function pollLine(p) {
  const what = p.type && p.type !== 'SPEAK_PERMISSION' ? `[${p.type}] ${describePoll(p)}` : `[SPEAK_PERMISSION] palabra de ${user(p.targetId)}`;
  const where = p.channelId ? ` en ${channel(p.channelId)}` : '';
  return `• ${what}${where}: ${p.yes}✅ ${p.no}❌ de ${p.voters} votantes (necesarios: ${p.needed})`;
}

function appendStreak(lines, st) {
  if (st.streak?.lastUserId) {
    lines.push(
      `🔁 **Racha:** último castigo a ${user(st.streak.lastUserId)} (${st.streak.count} consecutivo${st.streak.count === 1 ? '' : 's'}). ` +
        'Se mantiene entre vigilancias y reinicios.',
    );
  }
  if (st.isolations?.length) {
    lines.push(`🚫 **Aislamientos vigentes:** ${st.isolations.map((i) => `${user(i.userId)} hasta ${ts(i.until)}`).join(', ')}`);
  }
}

function appendPending(lines, st) {
  if (st.pendingReleases?.length) {
    lines.push(
      `🛡️ **Silencios del bot pendientes de liberar** (se levantan cuando el usuario se conecte): ${st.pendingReleases.map((p) => user(p.userId)).join(', ')}`,
    );
  }
}

const replies = {
  ALREADY_WATCHED: 'Ese usuario ya está cumpliendo una vigilancia (castigo) vigente.',
  NOT_WATCHED: 'Ese usuario no está vigilado.',
  TARGET_IS_BOT: 'No se puede vigilar a un bot.',
  NOT_IN_GUILD: 'Ese usuario no es miembro de este servidor.',
  NOT_WATCHED_SELF: 'No estás siendo vigilado, no necesitás pedir la palabra.',
  NOT_IN_VOICE: 'Tenés que estar conectado a un canal de voz para pedir la palabra.',
  ALREADY_REQUESTED: 'Ya tenés una solicitud de palabra abierta. Esperá el resultado.',
  HAS_PERMIT: 'Ya tenés un permiso para hablar vigente (o pendiente de vencer).',
  PREMUTED:
    'Estás silenciado por un moderador (no por el bot). Por seguridad el bot no levanta ese silencio por votación.',
  MANUAL_UNMUTE: 'Un moderador te des-silenció manualmente; no necesitás pedir la palabra por ahora.',
  NO_VOTERS:
    'No hay votantes habilitados (se necesitan otras personas, no bots, en el canal del usuario). No se puede iniciar la votación ni se aprueba nada automáticamente.',
  TARGET_NOT_IN_VOICE:
    'Ese usuario no está conectado a un canal de voz: no hay un padrón de votantes, así que no se puede votar.',
  POLL_PENDING:
    'Ya hay una votación pendiente para este usuario (mirá el canal de votaciones). Esperá su resultado o borrá su mensaje para cancelarla.',
  SEND_FAILED: 'No pude publicar la votación en el canal configurado (¿faltan permisos del bot?). No se creó la solicitud.',
  NO_PERMISSION: 'No tenés permisos para usar este comando.',
  WRONG_GUILD: 'Este bot solo funciona en su servidor configurado.',
  INTERNAL: 'Ocurrió un error interno. Revisá los logs del bot.',
};

messages.formatStatus = formatStatus;

module.exports = { messages, replies, formatStatus };
