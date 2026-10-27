'use strict';

const { YES, NO } = require('./core/voting');

const user = (id) => `<@${id}>`;
const channel = (id) => `<#${id}>`;
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

function duration(seconds) {
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? 'minuto' : 'minutos'}`;
  }
  return `${seconds} segundos`;
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

const messages = {
  user,
  channel,
  ts,
  duration,
  describeMute,

  patrolStarted: (patrol, targetId, result) =>
    `🚔 **PATRULLA INICIADA** por ${user(patrol.startedBy)}\n` +
    `👀 Primer vigilado: ${user(targetId)} — ${describeMute(result)}\n` +
    `Los vigilados no pueden hablar por voz salvo que el canal lo apruebe con \`/pedir-palabra\`.`,

  watchAdded: (targetId, by, result) =>
    `👀 ${user(targetId)} ahora está vigilado (agregado por ${user(by)}) — ${describeMute(result)}`,

  watchRemoved: (targetId, by, releaseStatus) =>
    `🟢 ${user(targetId)} dejó de estar vigilado (por ${user(by)}). ${releaseText(releaseStatus)}`,

  patrolEnded: (by, summary) => {
    const lines = [`🏁 **PATRULLA FINALIZADA** por ${user(by)}`];
    lines.push(`Vigilados liberados de la vigilancia: ${summary.watchedCount}`);
    if (summary.pollsCancelled) lines.push(`Votaciones canceladas: ${summary.pollsCancelled}`);
    if (summary.permitsCancelled) lines.push(`Permisos cancelados: ${summary.permitsCancelled}`);
    if (summary.released) lines.push(`🔊 Silencios del bot levantados: ${summary.released}`);
    if (summary.deferred.length) {
      lines.push(
        `⏳ Pendientes (no están en voz; se levantarán cuando se conecten): ${summary.deferred.map(user).join(', ')}`,
      );
    }
    if (summary.failed.length) {
      lines.push(
        `⚠️ No pude levantar el silencio de ${summary.failed.map(user).join(', ')}. ` +
          'Un moderador debe quitarlo manualmente si persiste.',
      );
    }
    if (summary.skipped.length) {
      lines.push(
        `🛡️ No toqué el silencio de ${summary.skipped.map(user).join(', ')} (no lo aplicó el bot o es incierto).`,
      );
    }
    lines.push('El bot ya no silenciará a nadie automáticamente.');
    return lines.join('\n');
  },

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
    const meta = ADMIN_POLL[poll.type];
    const subject =
      poll.type === 'END_PATROL'
        ? `\n👀 Vigilados: ${poll.watchedIds.map(user).join(', ')}` + `\n🔊 Canales: ${poll.channelIds.map(channel).join(', ')}`
        : `\n👤 Usuario afectado: ${user(poll.targetId)}` + `\n🔊 Canal: ${channel(poll.channelId)}`;
    return (
      `🚨 **POLICÍA DISCORD — ${meta.title}**` +
      `\n🛡️ Solicitada por: ${user(poll.requesterId)}` +
      subject +
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
    `🚨 **POLICÍA DISCORD — ${ADMIN_POLL[poll.type].title}**\n` +
    `✅ **Aprobada** (${yesVotes(poll)}/${poll.roster.length} a favor). ${outcome}`,

  pollRejected: (poll) =>
    isAdminPoll(poll)
      ? `🚨 **POLICÍA DISCORD — ${ADMIN_POLL[poll.type].title}**\n❌ **Rechazada.** ${ADMIN_POLL[poll.type].rejected(poll)}`
      : `🚨 **POLICÍA DISCORD — PERMISO RECHAZADO**\n` +
        `❌ La mayoría no autorizó a ${user(poll.requesterId)} a hablar. Podrá volver a pedir la palabra.`,

  pollCancelled: (poll, reason) =>
    `🚨 **POLICÍA DISCORD — VOTACIÓN CANCELADA**\n` +
    (isAdminPoll(poll)
      ? `⚪ ${ADMIN_POLL[poll.type].label} cancelada: ${reason}.`
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
    (info.patrolActive ? 'La patrulla sigue activa y los vigilados se recuperaron. ' : '') +
    (info.pollsCancelled.length
      ? `Se cancelaron por seguridad ${info.pollsCancelled.length} votación(es) interrumpida(s): ${info.pollsCancelled
          .map(describePoll)
          .join(', ')}. Pueden volver a solicitarlas.`
      : '') +
    (info.permitsRestored ? ` Permisos vigentes retomados: ${info.permitsRestored}.` : ''),

  remuteFailed: (userId, reason) =>
    `⚠️ No pude volver a silenciar a ${user(userId)}: ${reason}. Requiere intervención manual de un moderador.`,

  pollMessageDeleted: (poll) => `⚪ Se borró el mensaje de votación (${describePoll(poll)}); la solicitud quedó cancelada.`,
};

const yesVotes = (poll) => Object.values(poll.votes).filter((v) => v === 'yes').length;
const isAdminPoll = (poll) => !!poll.type && poll.type !== 'SPEAK_PERMISSION';

/** Textos de las votaciones administrativas (SPEAK_PERMISSION tiene los suyos en pollBody & co.). */
const ADMIN_POLL = {
  START_PATROL: {
    title: 'VOTACIÓN: INICIAR PATRULLA',
    label: 'Votación para iniciar la patrulla',
    short: (p) => `iniciar patrulla vigilando a ${user(p.targetId)}`,
    question: (p) => `¿Autorizan iniciar una patrulla y vigilar a ${user(p.targetId)}?`,
    rejected: () => 'No se inicia la patrulla.',
  },
  ADD_WATCH: {
    title: 'VOTACIÓN: VIGILAR USUARIO',
    label: 'Votación para vigilar',
    short: (p) => `vigilar a ${user(p.targetId)}`,
    question: (p) => `¿Autorizan a vigilar a ${user(p.targetId)}?`,
    rejected: (p) => `${user(p.targetId)} no se incorpora a la patrulla.`,
  },
  REMOVE_WATCH: {
    title: 'VOTACIÓN: DEJAR DE VIGILAR',
    label: 'Votación para dejar de vigilar',
    short: (p) => `dejar de vigilar a ${user(p.targetId)}`,
    question: (p) => `¿Autorizan a dejar de vigilar a ${user(p.targetId)}?`,
    rejected: (p) => `${user(p.targetId)} sigue vigilado, sin cambios.`,
  },
  END_PATROL: {
    title: 'VOTACIÓN: FINALIZAR PATRULLA',
    label: 'Votación para finalizar la patrulla',
    short: () => 'finalizar la patrulla',
    question: () => '¿Autorizan a finalizar la patrulla y dejar de vigilar a todos?',
    rejected: () => 'La patrulla y sus vigilancias continúan.',
  },
};

/** Descripción corta de una votación (para avisos y estado). */
function describePoll(poll) {
  return isAdminPoll(poll) ? ADMIN_POLL[poll.type].short(poll) : `palabra de ${user(poll.targetId ?? poll.requesterId)}`;
}
messages.describePoll = describePoll;
messages.isAdminPoll = isAdminPoll;


function formatStatus(st) {
  if (!st.active) {
    const lines = ['💤 **No hay una patrulla activa.** El bot no está vigilando a nadie.'];
    if (st.lastPatrol) {
      lines.push(`Última patrulla: ${ts(st.lastPatrol.startedAt, 'f')} → ${ts(st.lastPatrol.endedAt, 'f')}, finalizada por ${user(st.lastPatrol.endedBy)}.`);
    }
    if (st.polls?.length) {
      lines.push(`🗳️ **Votaciones pendientes (${st.polls.length}):**`);
      for (const p of st.polls) lines.push(pollLine(p));
    }
    appendPending(lines, st);
    return lines.join('\n');
  }
  const lines = [
    `🚔 **Patrulla activa** desde ${ts(st.patrol.startedAt, 'f')} (${ts(st.patrol.startedAt)}), iniciada por ${user(st.patrol.startedBy)}`,
    `👀 **Vigilados (${st.watched.length}):**`,
  ];
  for (const w of st.watched) {
    const where = w.inVoice ? `🔊 ${w.channelName}` : '⚪ fuera de voz';
    const mute = !w.inVoice ? '' : w.serverMute ? ' · 🔇 silenciado' : ' · 🟢 sin silencio';
    const notes = [];
    if (w.permitExpiresAt) notes.push(`⏳ permiso hasta ${ts(w.permitExpiresAt)}`);
    if (w.pollId) notes.push('🗳️ votación abierta');
    if (w.preMuted) notes.push('🛡️ ya estaba silenciado por un moderador (el bot no lo levanta)');
    if (w.manualUnmute) notes.push('✋ des-silenciado manualmente (se respeta hasta que se reconecte)');
    if (w.uncertain) notes.push('❓ estado de mute incierto tras un reinicio: revisar manualmente');
    if (w.needsRemute) notes.push('⚠️ pendiente de re-silenciar');
    lines.push(`• ${user(w.userId)} — ${where}${mute}${notes.length ? '\n   ' + notes.join(' · ') : ''}`);
  }
  if (!st.watched.length) lines.push('• (ninguno)');
  lines.push(`🗳️ **Votaciones pendientes (${st.polls.length}):**`);
  for (const p of st.polls) lines.push(pollLine(p));
  if (!st.polls.length) lines.push('• (ninguna)');
  lines.push(`🎤 **Permisos vigentes (${st.permits.length}):**`);
  for (const p of st.permits) lines.push(`• ${user(p.userId)} vence ${ts(p.expiresAt)} (${ts(p.expiresAt, 'T')})`);
  if (!st.permits.length) lines.push('• (ninguno)');
  appendPending(lines, st);
  return lines.join('\n');
}

function pollLine(p) {
  const what = p.type && p.type !== 'SPEAK_PERMISSION' ? `[${p.type}] ${describePoll(p)}` : `[SPEAK_PERMISSION] palabra de ${user(p.targetId)}`;
  const where = p.channelId ? ` en ${channel(p.channelId)}` : '';
  return `• ${what}${where}: ${p.yes}✅ ${p.no}❌ de ${p.voters} votantes (necesarios: ${p.needed})`;
}

function appendPending(lines, st) {
  if (st.pendingReleases?.length) {
    lines.push(
      `🛡️ **Silencios del bot pendientes de liberar** (se levantan cuando el usuario se conecte): ${st.pendingReleases.map((p) => user(p.userId)).join(', ')}`,
    );
  }
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

const replies = {
  PATROL_ACTIVE: 'Ya hay una patrulla activa. Finalizala con `/policia-finalizar` antes de iniciar otra.',
  NO_PATROL: 'No hay una patrulla activa.',
  ALREADY_WATCHED: 'Ese usuario ya está vigilado.',
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
    'No hay votantes habilitados (se necesitan otras personas, no bots, en el canal correspondiente). No se puede iniciar la votación ni se aprueba nada automáticamente.',
  TARGET_NOT_IN_VOICE:
    'Ese usuario no está conectado a un canal de voz: no hay un padrón de votantes, así que no se puede votar su vigilancia.',
  POLL_PENDING:
    'Ya hay una votación pendiente para esto o que lo contradice (mirá el canal de votaciones). Esperá su resultado o borrá su mensaje para cancelarla.',
  END_PENDING: 'Hay una votación pendiente para finalizar la patrulla. Esperá su resultado o borrá su mensaje para cancelarla.',
  ADMIN_POLLS_PENDING:
    'Hay votaciones pendientes de vigilar/dejar de vigilar que contradicen finalizar la patrulla. Esperá su resultado o borrá sus mensajes para cancelarlas.',
  SEND_FAILED: 'No pude publicar la votación en el canal configurado (¿faltan permisos del bot?). No se creó la solicitud.',
  NO_PERMISSION: 'No tenés permisos para usar este comando.',
  WRONG_GUILD: 'Este bot solo funciona en su servidor configurado.',
  INTERNAL: 'Ocurrió un error interno. Revisá los logs del bot.',
};

messages.formatStatus = formatStatus;

module.exports = { messages, replies, formatStatus };
