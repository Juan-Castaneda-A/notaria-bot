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
        printQRInTerminal: false, // Quitamos esto para evitar el warning
        auth: state,
        // Usamos la configuración estándar de Linux, es la más estable para Render
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: false, // IMPORTANTE: Esto evita timeouts al escanear
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        retryRequestDelayMs: 2000, // Reintentar rápido si falla
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // Si hay QR, lo guardamos para mostrarlo en la web
        if (qr) { 
            console.log('👉 NUEVO QR GENERADO (Ve a la web para escanear)'); 
            qrCodeData = qr; 
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`❌ WA Cerrado. Código: ${statusCode}`);

            // Manejo específico de errores
            if (statusCode === 401) {
                console.log("⛔ ERROR 401: Credenciales rechazadas. Limpiando DB...");
                // Opcional: Podrías automatizar el truncado aquí, pero mejor hazlo manual por seguridad ahora
                isConnected = false;
            } else if (shouldReconnect) {
                console.log("🔄 Reconectando...");
                // Sin delay o con delay muy corto para no perder el hilo
                connectToWhatsApp(); 
            } else {
                console.log("⛔ Sesión cerrada definitivamente.");
                isConnected = false;
            }

        } else if (connection === 'open') {
            console.log('✅ WA Conectado exitosamente');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const rawJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (text) {
                const realJid = jidNormalizedUser(rawJid);
                console.log(`📩 Mensaje de ${realJid}: ${text}`);
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