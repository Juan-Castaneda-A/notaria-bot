// 1. PARCHES DEL SISTEMA
const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }
const WebSocket = require('ws');
if (!global.WebSocket) { global.WebSocket = WebSocket; }

// 2. IMPORTS
// --- AÑADIDO: jidNormalizedUser ---
const {
    default: makeWASocket,
    DisconnectReason,
    Browsers,
    jidNormalizedUser,
    BufferJSON,
    initAuthCreds,
    isJidBroadcast
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// 3. CONFIGURACIÓN
console.log("--- 🤖 INICIANDO BOT NOTARIA (FIXED) ---");
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERROR FATAL: Faltan variables de entorno.");
    process.exit(1);
}

// 4. CLIENTE SUPABASE
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: {
        websocket: WebSocket,
        headers: { 'apikey': SUPABASE_KEY },
        params: { eventsPerSecond: 10 },
        timeout: 60000,
        heartbeatIntervalMs: 15000
    }
});

// 5. SERVIDOR WEB
const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1 style="color:green; font-family:sans-serif;">✅ Bot Conectado y Escuchando</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`<div style="text-align:center; font-family:sans-serif;"><h1>Escanea el QR</h1><img src="${img}" /></div>`);
    }
    res.send('<h1>Cargando...</h1>');
});

// --- FUNCIÓN HELPER: AUTENTICACIÓN SUPABASE ---
async function useSupabaseAuthState(supabase) {
    // Lógica para leer/escribir credenciales en la tabla 'wa_auth'
    const writeData = async (data, key) => {
        try {
            // Convertimos el objeto a string, manejando los Buffers de Baileys
            const value = JSON.stringify(data, BufferJSON.replacer);
            if (key) {
                await supabase.from('wa_auth').upsert({ key, value });
            }
        } catch (error) {
            console.error('Error guardando auth:', error);
        }
    };

    const readData = async (key) => {
        try {
            const { data } = await supabase.from('wa_auth').select('value').eq('key', key).single();
            if (data?.value) {
                return JSON.parse(data.value, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (key) => {
        try {
            await supabase.from('wa_auth').delete().eq('key', key);
        } catch (error) { }
    };

    // Cargar credenciales iniciales
    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// 6. LÓGICA WHATSAPP
async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState(supabase);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Pon esto en TRUE para ver si genera QR en los logs de Render
        auth: state,
        // CAMBIO 1: Usar un navegador personalizado ayuda a evitar desconexiones
        browser: ["NotariaBot", "Chrome", "1.0.0"], 
        // CAMBIO 2: Aumentar timeouts para conexiones lentas
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: undefined, // Dejar que espere indefinidamente si es necesario
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 5000, // Esperar 5s antes de reintentar peticiones fallidas
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log('👉 NUEVO QR GENERADO'); qrCodeData = qr; }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ WA Cerrado. Código: ${statusCode}, Reconectar: ${shouldReconnect}`);

            // Si es un error 408 (Timeout) o conexión perdida, reconectamos
            if (shouldReconnect) {
                // IMPORTANTE: Destruir el socket anterior si existe para evitar duplicados
                try { sock.end(); } catch(e) {} 
                sock = null; 
                
                console.log("🔄 Reconectando en 5 segundos...");
                setTimeout(connectToWhatsApp, 5000); // 5 segundos de espera real
            } else {
                console.log("⛔ Sesión cerrada definitivamente (Logout). Borra la tabla wa_auth y reinicia.");
                isConnected = false;
                // Opcional: Limpiar la tabla wa_auth automáticamente si hay logout
                // supabase.from('wa_auth').delete().neq('key', 'nothing'); 
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const rawJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (text) {
                // --- CORRECCIÓN 1: NORMALIZAR EL ID ---
                // Esto convierte '12345@lid' en '57300...@s.whatsapp.net'
                const realJid = jidNormalizedUser(rawJid);

                console.log(`📩 Mensaje de ${realJid} (Raw: ${rawJid}): ${text}`);
                await handleIncomingMessage(realJid, text);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// 7. PROCESAMIENTO DE MENSAJES
async function handleIncomingMessage(jid, text) {
    const cleanText = text.trim();

    if (cleanText.length < 5 || !/^\d+$/.test(cleanText)) {
        await sock.sendMessage(jid, {
            text: "👋 ¡Hola! Soy el asistente de turnos.\n\nPara avisarte cuando te llamen, por favor responde *únicamente con tu número de cédula* (sin puntos ni espacios)."
        });
        return;
    }

    const cedula = cleanText;
    console.log(`🔎 Buscando turno para cédula: ${cedula}`);

    try {
        const today = new Date().toISOString().split('T')[0];

        const { data: turnos, error } = await supabase
            .from('turnos')
            .select('id_turno, prefijo_turno, numero_turno, id_servicio, hora_solicitud, clientes!inner(numero_identificacion)')
            .eq('clientes.numero_identificacion', cedula)
            .eq('estado', 'en espera')
            .gte('hora_solicitud', today)
            .order('hora_solicitud', { ascending: false })
            .limit(1);

        if (error || !turnos || turnos.length === 0) {
            await sock.sendMessage(jid, { text: `❌ No encontré ningún turno *en espera* hoy para la cédula *${cedula}*.\n\nAsegúrate de haber solicitado tu turno en el Kiosco primero.` });
            return;
        }

        const turno = turnos[0];
        const codigoTurno = `${turno.prefijo_turno}-${turno.numero_turno}`;

        // --- CORRECCIÓN 2: GUARDAR EL JID COMPLETO REAL ---
        // Guardamos '57300...@s.whatsapp.net' directamente en la base de datos
        const { error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .upsert({
                id_turno: turno.id_turno,
                numero_whatsapp: jid // <-- Guardamos el JID normalizado
            }, { onConflict: 'id_turno' });

        if (subError) {
            console.error("❌ Error al suscribir:", subError.message);
            return;
        }

        const { count } = await supabase
            .from('turnos')
            .select('id_turno', { count: 'exact', head: true })
            .eq('estado', 'en espera')
            .eq('id_servicio', turno.id_servicio)
            .lt('hora_solicitud', turno.hora_solicitud);

        await sock.sendMessage(jid, {
            text: `✅ *¡Turno Encontrado!*\n\n🎫 Tu turno: *${codigoTurno}*\n👥 Personas antes de ti: *${count || 0}*\n\n🔔 Te enviaré un mensaje por aquí apenas te llamen. ¡Puedes esperar tranquilo!`
        });
        console.log(`✅ Suscripción exitosa para ${codigoTurno}`);

    } catch (e) {
        console.error("❌ Excepción en handleIncomingMessage:", e);
    }
}

// 8. LISTENER DE NOTIFICACIONES
let isReconnectingDB = false;
let currentChannel = null;

async function setupSupabaseListener() {
    if (isReconnectingDB) return;
    isReconnectingDB = true;

    console.log("🎧 (DB) Configurando listener...");
    try { if (currentChannel) await supabase.removeChannel(currentChannel); } catch (e) { }

    const channel = supabase.channel(`bot_notif_${Date.now()}`);
    currentChannel = channel;

    channel
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'turnos' }, async (payload) => {
            const newTurn = payload.new;
            const oldTurn = payload.old;

            if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                console.log(`🔔 LLAMADO DETECTADO: ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                await notifyUserCall(newTurn);
            }
        })
        .subscribe((status, err) => {
            console.log(`🔌 (DB) Estado: ${status}`);
            if (status === 'SUBSCRIBED') {
                console.log("✅ (DB) ¡Escuchando cambios!");
                isReconnectingDB = false;
            }
            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.log("⚠️ (DB) Conexión inestable. Reintentando en 10s...");
                setTimeout(() => {
                    isReconnectingDB = false;
                    setupSupabaseListener();
                }, 10000);
            }
        });
}

async function notifyUserCall(turnData) {
    if (!isConnected || !sock) return;
    try {
        const { data: sub } = await supabase.from('whatsapp_subscriptions').select('numero_whatsapp').eq('id_turno', turnData.id_turno).single();
        if (!sub) return;

        const { data: mod } = await supabase.from('modulos').select('nombre_modulo').eq('id_modulo', turnData.id_modulo_atencion).single();
        const modName = mod ? mod.nombre_modulo : "un módulo";

        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}* ahora mismo.`;

        // --- CORRECCIÓN 3: USAR EL NÚMERO TAL CUAL ---
        // Ya viene con el formato correcto desde la base de datos
        await sock.sendMessage(sub.numero_whatsapp, { text: texto });
        console.log(`✅ Notificación enviada a ${sub.numero_whatsapp}`);

    } catch (e) {
        console.error("Error notificando:", e.message);
    }
}

// Endpoint para mantener vivo el servicio
app.get('/ping', (req, res) => {
    res.send('pong 🏓');
});

// ARRANQUE
app.listen(PORT, () => console.log(`🚀 Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();