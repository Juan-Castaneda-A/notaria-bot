const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const PORT = process.env.PORT || 10000; // Render usa el puerto 10000 a veces
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
            // Ignoramos el error 515 (Restart Required), es normal
            if (statusCode !== 515) {
                console.log(`❌ WhatsApp Cerrado. Código: ${statusCode}`);
            }
            
            if (statusCode === 405) {
                console.log("⚠️ Error 405. Limpiando sesión...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); 
            }
            
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ ¡WhatsApp Conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// --- SUPABASE (VERSIÓN BLINDADA) ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

let isReconnectingDB = false;

async function setupSupabaseListener() {
    // 1. Limpieza "Nuclear": Borrar TODOS los canales previos para evitar fantasmas
    try {
        await supabase.removeAllChannels();
        console.log("🧹 Canales previos limpiados.");
    } catch (e) {
        console.error("Error limpiando canales:", e);
    }

    isReconnectingDB = false; // Reiniciamos la bandera
    console.log("🎧 Iniciando escucha de base de datos...");

    const channel = supabase.channel('bot_turnos_v3');

    channel
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
            console.log(`🔌 Estado Supabase: ${status}`);

            if (status === 'SUBSCRIBED') {
                isReconnectingDB = false; // ¡Conexión exitosa!
            }

            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                if (isReconnectingDB) return; // Si ya estamos arreglándolo, no hacer nada (evita bucle)
                
                console.log("⚠️ Conexión DB inestable. Reiniciando listener en 10s...");
                isReconnectingDB = true;
                
                // No llamamos a removeChannel aquí. Dejamos que muera solo y creamos uno nuevo después.
                setTimeout(setupSupabaseListener, 10000);
            }
        });
}

async function notifyUser(turnData) {
    if (!isConnected || !sock) {
        console.log("⚠️ Intento de notificación fallido: WhatsApp desconectado.");
        return;
    }
    try {
        const { data: sub } = await supabase.from('whatsapp_subscriptions').select('numero_whatsapp').eq('id_turno', turnData.id_turno).single();
        if (!sub) return;

        const { data: mod } = await supabase.from('modulos').select('nombre_modulo').eq('id_modulo', turnData.id_modulo_atencion).single();
        const modName = mod ? mod.nombre_modulo : "un módulo";
        
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}*.`;
        
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ Notificación enviada a ${sub.numero_whatsapp}`);
    } catch (e) {
        console.error("Error enviando:", e.message);
    }
}

// --- START ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();