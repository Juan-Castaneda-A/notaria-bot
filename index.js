// --- PARCHE DE CRIPTOGRAFÍA ---
const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }
// -----------------------------

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Error: Faltan variables de entorno.");
    process.exit(1);
}

const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

// --- SERVIDOR WEB ---
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
    if (!phone || !sock) return res.send("Error: Sin teléfono o bot desconectado");
    try {
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: "🔔 Prueba de vida exitosa." });
        res.send(`Mensaje enviado a ${phone}`);
    } catch (e) {
        res.send(`Error: ${e.message}`);
    }
});

// --- WHATSAPP ---
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
            console.log(`❌ WhatsApp Cerrado. Código: ${statusCode}`);
            
            if (statusCode === 405) {
                console.log("⚠️ Error 405. Limpiando sesión...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); // Reinicio total
            }
            
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ WhatsApp Conectado');
            isConnected = true;
            qrCodeData = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// --- SUPABASE LISTENER (CORREGIDO) ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

let activeChannel = null; // Variable global para rastrear el canal activo
let isReconnecting = false; // Semáforo para evitar bucles

async function setupSupabaseListener() {
    // 1. LIMPIEZA PREVIA (Aquí es seguro hacerlo)
    if (activeChannel) {
        console.log("🧹 Limpiando canal anterior...");
        try { await supabase.removeChannel(activeChannel); } catch(e) {}
        activeChannel = null;
    }

    console.log("🎧 Iniciando escucha de base de datos...");
    
    // Usamos un nombre único para evitar conflictos de caché
    const channelName = `bot_turnos_${Date.now()}`;
    
    const channel = supabase.channel(channelName)
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                // Lógica de notificación
                const newTurn = payload.new;
                const oldTurn = payload.old;
                if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                    console.log(`🔔 Turno llamado: ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                    await notifyUser(newTurn);
                }
            }
        )
        .subscribe((status) => {
            console.log(`🔌 Estado Supabase (${channelName}): ${status}`);

            // 2. LÓGICA ANTI-BUCLE
            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                if (isReconnecting) return; // Ya estamos intentando, no hacer nada
                
                isReconnecting = true;
                console.log("⚠️ Conexión DB perdida. Reintentando en 10 segundos...");
                
                // NO llamamos a removeChannel aquí. Dejamos que el canal muera solo.
                // Solo programamos el siguiente intento.
                setTimeout(() => {
                    isReconnecting = false;
                    setupSupabaseListener();
                }, 10000);
            }
        });

    activeChannel = channel;
}

async function notifyUser(turnData) {
    if (!isConnected || !sock) return;
    try {
        const { data: sub } = await supabase.from('whatsapp_subscriptions').select('numero_whatsapp').eq('id_turno', turnData.id_turno).single();
        if (!sub) return;

        const { data: mod } = await supabase.from('modulos').select('nombre_modulo').eq('id_modulo', turnData.id_modulo_atencion).single();
        const modName = mod ? mod.nombre_modulo : "un módulo";
        
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}*.`;
        
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ Enviado a ${sub.numero_whatsapp}`);
    } catch (e) {
        console.error("Error enviando:", e.message);
    }
}

// --- START ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();