const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }

const WebSocket = require('ws');
if (!global.WebSocket) { global.WebSocket = WebSocket; }

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log("--- INICIANDO BOT ---");
console.log(`URL Supabase: ${SUPABASE_URL}`);
console.log(`Key (primeros 10): ${SUPABASE_KEY ? SUPABASE_KEY.substring(0, 10) + '...' : 'NO DEFINIDA'}`);

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Faltan variables de entorno.");
    process.exit(1);
}

const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

// --- WEB ---
app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1 style="color:green">✅ Bot Conectado</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`<div style="text-align:center"><h1>Escanea el QR</h1><img src="${img}" /><p>Recarga si expira</p></div>`);
    }
    res.send('<h1>Cargando... recarga en 10s</h1>');
});

app.get('/test', async (req, res) => {
    const phone = req.query.phone;
    console.log(`🧪 Petición de prueba recibida para: ${phone}`);
    if (!phone || !sock) return res.send("Error: Sin teléfono o bot desconectado");
    try {
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: "🔔 Prueba de vida exitosa." });
        console.log(`✅ Mensaje de prueba enviado a ${phone}`);
        res.send(`Mensaje enviado a ${phone}`);
    } catch (e) {
        console.error(`❌ Error en prueba: ${e.message}`);
        res.send(`Error: ${e.message}`);
    }
});

// --- WHATSAPP ---
async function connectToWhatsApp() {
    console.log("🔄 Iniciando conexión con WhatsApp...");
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
            if (statusCode !== 515) console.log(`❌ WhatsApp Cerrado. Código: ${statusCode}`);
            
            if (statusCode === 405) {
                console.log("⚠️ Error 405. Limpiando sesión...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); 
            }
            
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ WhatsApp Conectado exitosamente');
            isConnected = true;
            qrCodeData = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// --- SUPABASE (LOGGING EXTREMO) ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: {
        params: { eventsPerSecond: 10 },
        timeout: 30000
    }
});

async function setupSupabaseListener() {
    try {
        await supabase.removeAllChannels();
        console.log("🧹 Canales previos limpiados.");
    } catch (e) { console.error("Error limpiando:", e); }

    console.log("🎧 Intentando suscribirse a Supabase...");

    const channel = supabase.channel('debug_room');

    channel
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
            // --- AQUÍ ESTÁ EL LOG QUE QUEREMOS VER ---
            console.log("🔥 ¡ALGO PASÓ EN LA DB!");
            console.log("TABLA:", payload.table);
            console.log("EVENTO:", payload.eventType);
            console.log("DATOS:", JSON.stringify(payload.new));
            
            if (payload.table === 'turnos' && payload.eventType === 'UPDATE') {
                 handleTurnoUpdate(payload.new, payload.old);
            }
        })
        .subscribe((status, err) => {
            console.log(`🔌 Estado Supabase: ${status}`);
            if (err) console.error("❌ Error de suscripción:", err);
        });
}

async function handleTurnoUpdate(newTurn, oldTurn) {
    console.log(`🔎 Analizando turno ${newTurn.id_turno}: ${oldTurn?.estado || '?'} -> ${newTurn.estado}`);
    
    if (newTurn.estado === 'en atencion') {
        console.log("🔔 ¡CONDICIÓN CUMPLIDA! Buscando suscripción...");
        await notifyUser(newTurn);
    } else {
        console.log("😴 No es un cambio a 'en atencion', ignorando.");
    }
}

async function notifyUser(turnData) {
    if (!isConnected || !sock) {
        console.log("⚠️ WhatsApp desconectado, no se puede enviar.");
        return;
    }
    console.log(`🔍 Buscando teléfono para turno ID: ${turnData.id_turno}`);
    
    try {
        const { data: sub, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .single();

        if (error) {
            console.error("❌ Error buscando suscripción:", error.message);
            return;
        }
        if (!sub) {
            console.log("ℹ️ No se encontró suscripción para este turno.");
            return;
        }

        console.log(`📞 Encontrado: ${sub.numero_whatsapp}. Buscando módulo...`);

        const { data: mod } = await supabase
            .from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const modName = mod ? mod.nombre_modulo : "un módulo";
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}*.`;
        
        console.log(`📤 Enviando mensaje a WhatsApp...`);
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ ¡Mensaje enviado con éxito!`);

    } catch (e) {
        console.error("❌ Excepción en notifyUser:", e);
    }
}

app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();