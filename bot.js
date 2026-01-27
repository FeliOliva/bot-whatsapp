// bot.js (CommonJS) — Baileys ESM con import dinámico
// Node 18+ (ideal 20+). Dependencias: @whiskeysockets/baileys, @hapi/boom, pino, node-schedule, qrcode-terminal

// --- Polyfill WebCrypto (por si el entorno no lo expone) ---
const nodeCrypto = require("crypto");
if (!globalThis.crypto) globalThis.crypto = nodeCrypto.webcrypto;

// --- Imports CommonJS ---
const schedule = require("node-schedule");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

// --- Config ---
const AUTH_DIR = "auth_info"; // credenciales persistentes
// ⚠️ JID del contacto AUTORIZADO (NO el número del bot). Formato: "<cód_pais><número>@s.whatsapp.net"
const CHAT_ID_AUT = "5493462538580@s.whatsapp.net";

const TZ = process.env.TZ || "America/Argentina/Cordoba";
const HORA_RECORDATORIO = "30 23 * * *"; // 23:30 todos los días

// Cadencia del ciclo de recordatorios
const REMINDER_EVERY_MIN = 10;     // cada 10 minutos
const REMINDER_MAX_ATTEMPTS = 48; // tope (4 horas). Podés subir/bajar o usar Infinity

// Horario de funcionamiento
const HORA_INICIO = { hour: 23, minute: 30 }; // 23:30
const HORA_FIN = { hour: 2, minute: 30 };     // 02:30

// Mensajes
const MSG_CONFIRMACION = "bueno carlo, te amo ❤️";
const MSG_RECORDATORIO = "💊 Acordate la pastilla Carlooo!!!";
const MSG_FIN_HORARIO = "Bueno carlo sino quere no la tome 😡";
const MSG_FUERA_HORARIO = "No estoy laburando en este momento carlo🤖🧰";

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Estado global
let sock = null;
let saveCreds = null;
let scheduledJob = null;
let scheduledStopJob = null; // Job para detener a las 02:30
let lastQR = null;

// Estado del ciclo de recordatorios
let awaitingAck = false;
let reminderTimer = null;
let reminderAttempts = 0;

// --- Helpers: verificación de horario ---
function isWithinOperatingHours() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentTime = hour * 60 + minute;

  // Horario: 23:30 (1410 minutos) hasta 02:30 (150 minutos del día siguiente)
  const startTime = HORA_INICIO.hour * 60 + HORA_INICIO.minute; // 1410
  const endTime = HORA_FIN.hour * 60 + HORA_FIN.minute; // 150

  // Si estamos después de las 23:30 (hasta medianoche) o antes de las 02:30
  return currentTime >= startTime || currentTime < endTime;
}

// --- Helpers: ciclo de recordatorios ---
async function startReminderCycle() {
  // limpiar intervalos previos si los hubiera
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  awaitingAck = true;
  reminderAttempts = 0;

  try {
    await sock.sendMessage(CHAT_ID_AUT, { text: MSG_RECORDATORIO });
    logger.info("📤 (Inicial) Recordatorio enviado.");
  } catch (err) {
    logger.error({ err }, "Error enviando recordatorio inicial");
  }

  reminderTimer = setInterval(async () => {
    try {
      // Verificar si el ciclo ya fue detenido por el usuario
      if (!awaitingAck) {
        clearInterval(reminderTimer);
        reminderTimer = null;
        return;
      }

      // Verificar si aún estamos dentro del horario permitido
      if (!isWithinOperatingHours()) {
        logger.warn("⏹️ Fuera del horario permitido; deteniendo ciclo.");
        await stopReminderCycleWithMessage("horario");
        return;
      }
      if (reminderAttempts >= REMINDER_MAX_ATTEMPTS) {
        logger.warn("⏹️ Tope de recordatorios alcanzado; deteniendo ciclo por hoy.");
        clearInterval(reminderTimer);
        reminderTimer = null;
        awaitingAck = false;
        return;
      }
      reminderAttempts++;
      await sock.sendMessage(CHAT_ID_AUT, { text: MSG_RECORDATORIO });
      logger.info(`📤 Recordatorio #${reminderAttempts} enviado.`);
    } catch (err) {
      logger.error({ err }, "Error enviando recordatorio periódico");
    }
  }, REMINDER_EVERY_MIN * 60 * 1000);
}

function stopReminderCycle(reason = "ack") {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
  awaitingAck = false;
  logger.info(`⏹️ Ciclo de recordatorios detenido (${reason}).`);
}

async function stopReminderCycleWithMessage(reason = "ack") {
  // Solo enviar mensaje si el ciclo estaba activo
  const wasActive = awaitingAck;
  stopReminderCycle(reason);
  if (sock && reason === "horario" && wasActive) {
    try {
      await sock.sendMessage(CHAT_ID_AUT, { text: MSG_FIN_HORARIO });
      logger.info("📤 Mensaje de fin de horario enviado.");
    } catch (err) {
      logger.error({ err }, "Error enviando mensaje de fin de horario");
    }
  }
}

// --- Programación diaria (arranca el ciclo a las 23:30, lo detiene a las 02:30) ---
function programarRecordatorio() {
  if (scheduledJob) {
    try { scheduledJob.cancel(); } catch { }
    scheduledJob = null;
  }

  if (scheduledStopJob) {
    try { scheduledStopJob.cancel(); } catch { }
    scheduledStopJob = null;
  }

  // Job para iniciar a las 23:30
  scheduledJob = schedule.scheduleJob(HORA_RECORDATORIO, async () => {
    if (!sock) {
      logger.warn("No hay socket activo al programar; reintentando en 10s...");
      setTimeout(() => programarRecordatorio(), 10_000);
      return;
    }
    await startReminderCycle();
  });

  // Job para detener a las 02:30
  const stopSchedule = `${HORA_FIN.minute} ${HORA_FIN.hour} * * *`;
  scheduledStopJob = schedule.scheduleJob(stopSchedule, async () => {
    if (!sock) {
      logger.warn("No hay socket activo al intentar detener ciclo.");
      return;
    }
    logger.info("⏰ Hora de detener ciclo (02:30) alcanzada.");
    // Solo enviar mensaje si el ciclo sigue activo (usuario no cortó con "listo")
    if (awaitingAck) {
      await stopReminderCycleWithMessage("horario");
    } else {
      // El ciclo ya fue detenido por el usuario, solo limpiar sin enviar mensaje
      stopReminderCycle("horario");
      logger.info("⏹️ Ciclo ya estaba detenido por el usuario; no se envía mensaje de fin de horario.");
    }
  });

  logger.info(`⏰ Ciclo diario programado: inicio ${HORA_RECORDATORIO}, fin ${stopSchedule} TZ=${TZ}`);
}

// --- Arranque / Reconexión ---
async function start() {
  // ⬇️ Import dinámico de Baileys (ESM) dentro de CommonJS
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    areJidsSameUser,
    isJidBroadcast,
    isJidGroup,
    isLidUser,
    jidNormalizedUser,
  } = await import("@whiskeysockets/baileys");

  // --- Helpers: normalización de JID (PN vs LID) ---
  async function resolveUserJid(rawJid) {
    if (!rawJid) return "";
    const normalized = jidNormalizedUser(rawJid);
    if (!sock?.signalRepository?.lidMapping) return normalized;
    if (isLidUser(normalized)) {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(normalized);
      return pn ? jidNormalizedUser(pn) : normalized;
    }
    return normalized;
  }

  function getAuthorJid(msg) {
    const remoteJid = msg?.key?.remoteJid;
    if (!remoteJid) return "";
    if (isJidGroup(remoteJid)) {
      return msg.key?.participant || "";
    }
    return remoteJid;
  }

  const { state, saveCreds: saveCredsFn } = await useMultiFileAuthState(AUTH_DIR);
  saveCreds = saveCredsFn;

  // Fuerza versión WA más reciente (evita registration failure/405)
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Usando versión WA: ${version.join(".")} (latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: state,
    // printQRInTerminal está deprecado; mostramos el QR abajo con qrcode-terminal
    browser: ["Ubuntu", "Chrome", "22.04"],
    logger,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    syncFullHistory: false,
  });

  // Guardar credenciales cuando cambian
  sock.ev.on("creds.update", saveCreds);

  // Estado de conexión
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Mostrar QR (se renueva; evitamos repetir el mismo)
    if (qr && qr !== lastQR) {
      lastQR = qr;
      logger.info("📲 Escaneá este QR para vincular (se actualiza periódicamente):");
      try {
        qrcode.generate(qr, { small: true });
      } catch (e) {
        logger.error({ e }, "No se pudo renderizar el QR");
        logger.info("QR (texto): " + qr);
      }
    }

    if (connection === "open") {
      logger.info("✅ Bot conectado a WhatsApp");
      lastQR = null;
      programarRecordatorio();
    }

    if (connection === "close") {
      const status = new Boom(lastDisconnect?.error)?.output?.statusCode;
      logger.warn({ reason: status }, "⚠️ Conexión cerrada");

      // Si la sesión está inválida, vas a necesitar borrar auth_info y re-vincular
      if (status === DisconnectReason.loggedOut || status === 405 || status === 499) {
        logger.error("❌ Sesión inválida/rota. Borrá 'auth_info' y re-vinculá con QR.");
      }
      setTimeout(start, 3000);
    }
  });

  // Mensajes entrantes (FILTRO ESTRICTO + ACK para cortar ciclo)
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      if (!messages?.length) return;
      const msg = messages[0];

      // 1) Ignorar mensajes sin contenido útil o de status
      if (!msg.message || isJidBroadcast(msg.key?.remoteJid)) return;

      // 2) Ignorar mensajes enviados por el propio bot
      if (msg.key?.fromMe) return;

      const chatId = msg.key.remoteJid;
      if (isJidGroup(chatId)) return;

      // 3) Responder SOLO si viene del contacto autorizado y no es grupo
      const authorJid = await resolveUserJid(getAuthorJid(msg));
      const authJid = jidNormalizedUser(CHAT_ID_AUT);
      if (!areJidsSameUser(authorJid, authJid)) return;

      // 3.1) Ignorar mensajes propios aunque lleguen sin fromMe
      const selfJid = sock?.user?.id ? await resolveUserJid(sock.user.id) : "";
      if (selfJid && areJidsSameUser(authorJid, selfJid)) return;

      console.log("MSG FROM:", msg.key.remoteJid);
      console.log("TEXT RAW:", msg.message);

      // 4) Extraer texto
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
        "";

      // 5) Coincidencia con "listo" (palabra completa, case-insensitive)
      const listo = typeof text === "string" && /\blisto\b/i.test(text);

      if (listo) {
        // Solo responder si estamos dentro del horario permitido
        if (!isWithinOperatingHours()) {
          logger.info("📵 Mensaje 'Listo' recibido fuera del horario permitido; ignorando.");
          await sock.sendMessage(chatId, { text: MSG_FUERA_HORARIO });
          return;
        }
        stopReminderCycle("ack");
        await sock.sendMessage(chatId, { text: MSG_CONFIRMACION });
      }
    } catch (err) {
      logger.error({ err }, "Error procesando messages.upsert");
    }
  });

  // Cierre limpio al recibir señales (PM2, etc.)
  const cleanup = async (signal) => {
    try {
      logger.info(`Recibí ${signal}, cerrando socket...`);
      if (scheduledJob) scheduledJob.cancel();
      if (scheduledStopJob) scheduledStopJob.cancel();
      stopReminderCycle("signal");
      if (sock) {
        await sock.ws.close();
        sock = null;
      }
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

// Iniciar
start().catch((err) => {
  console.error("Fallo al iniciar el bot:", err);
  process.exit(1);
});

