// 1. PARCHES DEL SISTEMA
const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }
const WebSocket = require('ws');
if (!global.WebSocket) { global.WebSocket = WebSocket; }

// 2. IMPORTS
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// 3. CONFIGURACIÓN
console.log("--- 🤖 INICIANDO BOT NOTARIA ---");
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERROR FATAL: Faltan variables de entorno.");
    process.exit(1);
}

// 4. CLIENTE SUPABASE (ROBUSTO)
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

// 6. LÓGICA WHATSAPP (BAILEYS)
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { console.log('👉 NUEVO QR GENERADO'); qrCodeData = qr; }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== 515) console.log(`❌ WA Cerrado. Código: ${statusCode}`);
            
            if (statusCode === 405) {
                console.log("⚠️ Error 405. Reinicio forzado.");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); 
            }
            if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ WA Conectado exitosamente');
            isConnected = true;
            qrCodeData = null;
        }
    });

    // --- AQUÍ ESTÁ LA MAGIA: ESCUCHAR MENSAJES ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            // Extraer texto de cualquier tipo de mensaje simple
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (text) {
                console.log(`📩 Mensaje de ${remoteJid}: ${text}`);
                await handleIncomingMessage(remoteJid, text);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// 7. PROCESAMIENTO DE MENSAJES DEL CLIENTE
async function handleIncomingMessage(jid, text) {
    const cleanText = text.trim();
    
    // A. Validación básica: ¿Parece una cédula? (Solo números, más de 5 dígitos)
    if (cleanText.length < 5 || !/^\d+$/.test(cleanText)) {
        await sock.sendMessage(jid, { 
            text: "👋 ¡Hola! Soy el asistente de turnos.\n\nPara avisarte cuando te llamen, por favor responde *únicamente con tu número de cédula* (sin puntos ni espacios)." 
        });
        return;
    }

    // B. Buscar turno en Supabase
    const cedula = cleanText;
    console.log(`🔎 Buscando turno para cédula: ${cedula}`);

    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Buscamos turnos 'en espera' de hoy asociados a esa cédula
        const { data: turnos, error } = await supabase
            .from('turnos')
            .select('id_turno, prefijo_turno, numero_turno, id_servicio, hora_solicitud, clientes!inner(numero_identificacion)')
            .eq('clientes.numero_identificacion', cedula)
            .eq('estado', 'en espera')
            .gte('hora_solicitud', today)
            .order('hora_solicitud', { ascending: false })
            .limit(1);

        if (error) {
            console.error("❌ Error DB:", error.message);
            return; 
        }

        if (!turnos || turnos.length === 0) {
            await sock.sendMessage(jid, { text: `❌ No encontré ningún turno *en espera* hoy para la cédula *${cedula}*.\n\nAsegúrate de haber solicitado tu turno en el Kiosco primero.` });
            return;
        }

        const turno = turnos[0];
        const codigoTurno = `${turno.prefijo_turno}-${turno.numero_turno}`;

        // C. Registrar suscripción en la tabla whatsapp_subscriptions
        const numeroLimpio = jid.replace('@s.whatsapp.net', '');
        const { error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .upsert({ 
                id_turno: turno.id_turno, 
                numero_whatsapp: numeroLimpio
                // id_cliente es opcional si la tabla lo permite, o puedes sacarlo de turno.clientes
            }, { onConflict: 'id_turno' });

        if (subError) {
            console.error("❌ Error al suscribir:", subError.message);
            await sock.sendMessage(jid, { text: "⚠️ Ocurrió un error al intentar suscribirte. Intenta de nuevo." });
            return;
        }

        // D. Calcular personas por delante
        const { count } = await supabase
            .from('turnos')
            .select('id_turno', { count: 'exact', head: true })
            .eq('estado', 'en espera')
            .eq('id_servicio', turno.id_servicio)
            .lt('hora_solicitud', turno.hora_solicitud);

        // E. Confirmar al usuario
        await sock.sendMessage(jid, { 
            text: `✅ *¡Turno Encontrado!*\n\n🎫 Tu turno: *${codigoTurno}*\n👥 Personas antes de ti: *${count || 0}*\n\n🔔 Te enviaré un mensaje por aquí apenas te llamen. ¡Puedes esperar tranquilo!` 
        });
        console.log(`✅ Suscripción exitosa para ${codigoTurno}`);

    } catch (e) {
        console.error("❌ Excepción en handleIncomingMessage:", e);
    }
}

// 8. LISTENER DE NOTIFICACIONES (DB -> WHATSAPP)
let isReconnectingDB = false;
let currentChannel = null;

async function setupSupabaseListener() {
    if (isReconnectingDB) return;
    isReconnectingDB = true;

    console.log("🎧 (DB) Configurando listener...");
    
    // Limpieza segura
    try { if (currentChannel) await supabase.removeChannel(currentChannel); } catch(e){}

    const channel = supabase.channel(`bot_notif_${Date.now()}`);
    currentChannel = channel;

    channel
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'turnos' }, async (payload) => {
            const newTurn = payload.new;
            const oldTurn = payload.old;

            // Detectar cambio a 'en atencion'
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
        // 1. Buscar suscripción
        const { data: sub } = await supabase.from('whatsapp_subscriptions').select('numero_whatsapp').eq('id_turno', turnData.id_turno).single();
        
        if (!sub) {
            console.log(`ℹ️ Turno ${turnData.id_turno} sin suscripción.`);
            return;
        }

        // 2. Buscar módulo
        const { data: mod } = await supabase.from('modulos').select('nombre_modulo').eq('id_modulo', turnData.id_modulo_atencion).single();
        const modName = mod ? mod.nombre_modulo : "un módulo";
        
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}* ahora mismo.`;
        
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ Notificación enviada a ${sub.numero_whatsapp}`);

    } catch (e) {
        console.error("Error notificando:", e.message);
    }
}

// ARRANQUE
app.listen(PORT, () => console.log(`🚀 Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();