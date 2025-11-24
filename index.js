// --- PARCHE DE CRIPTOGRAFÍA ---
const crypto = require('crypto');
if (!global.crypto) {
    global.crypto = crypto;
}
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
    console.error("❌ Faltan variables de entorno");
    process.exit(1);
}

// --- SERVIDOR WEB ---
const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1 style="color:green">✅ Bot de WhatsApp Conectado y Listo</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`
            <div style="text-align:center; font-family:sans-serif;">
                <h1>Escanea este QR con el WhatsApp de la Notaría</h1>
                <img src="${img}" style="width:300px;" />
                <p>Si expira, recarga la página.</p>
            </div>
        `);
    }
    res.send('<h1 style="text-align:center; font-family:sans-serif;">Cargando... espera 10 segundos y recarga.</h1>');
});

app.get('/test', async (req, res) => {
    const phone = req.query.phone;
    if (!phone || !sock) return res.send("Error: Falta teléfono o bot desconectado");
    try {
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: "🔔 ¡Hola! Prueba de conexión exitosa." });
        res.send(`✅ Mensaje enviado a ${phone}`);
    } catch (e) {
        res.send(`❌ Error: ${e.message}`);
    }
});

// --- LÓGICA WHATSAPP ---
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
            console.log(`❌ Cerrado. Código: ${statusCode}`);
            if (statusCode === 405) {
                console.log("⚠️ Error 405. Reiniciando...");
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                process.exit(1); // Muerte súbita para reiniciar limpio
            }
            // Reconexión normal
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

// --- LISTENER SUPABASE ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false } // Optimización para backend
});

async function setupSupabaseListener() {
    console.log("🎧 Iniciando escucha de base de datos...");

    const channel = supabase.channel('bot_listener_v2');

    channel
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                console.log(`📨 Cambio detectado en turno ${payload.new.id_turno} (Estado: ${payload.new.estado})`);
                
                const newTurn = payload.new;
                const oldTurn = payload.old;

                // Verificamos si el estado cambió a 'en atencion'
                if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                    console.log(`🔔 ¡TURNO LLAMADO! -> ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                    await notifyUser(newTurn);
                }
            }
        )
        .subscribe((status) => {
            console.log(`🔌 Estado Supabase: ${status}`);

            // --- LÓGICA DE RECONEXIÓN ---
            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.log("⚠️ Conexión con base de datos perdida. Reintentando en 5 segundos...");
                // Quitamos el canal actual y probamos de nuevo
                supabase.removeChannel(channel);
                setTimeout(setupSupabaseListener, 5000);
            }
            // ---------------------------
        });
}

async function notifyUser(turnData) {
    if (!isConnected) { console.log("⚠️ Bot desconectado, no se puede enviar."); return; }
    
    try {
        // Buscar suscripción
        const { data: sub } = await supabase.from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .single();

        if (!sub) {
            console.log(`ℹ️ El turno ${turnData.id_turno} no tiene suscripción de WhatsApp.`);
            return;
        }

        // Buscar módulo
        const { data: mod } = await supabase.from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const modName = mod ? mod.nombre_modulo : "un módulo";
        const numero = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        
        await sock.sendMessage(numero, { 
            text: `🚨 *¡ES TU TURNO!* 🚨\n\nDirígete al *${modName}* ahora mismo.` 
        });
        console.log(`✅ Notificación enviada a ${sub.numero_whatsapp}`);
        
    } catch (e) {
        console.error("Error lógica notificación:", e);
    }
}

// --- START ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();