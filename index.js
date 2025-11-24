const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Usa la SERVICE_ROLE aquí

// --- SERVIDOR WEB (Para el QR) ---
const app = express();
let qrCodeData = null; // Aquí guardaremos el QR actual
let sock = null;
let isConnected = false;

app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1>✅ Bot de WhatsApp Conectado y Listo</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`
            <h1>Escanea este QR con el WhatsApp de la Notaría</h1>
            <img src="${img}" />
            <p>Recarga la página si expira.</p>
        `);
    }
    res.send('<h1>Cargando... espera unos segundos y recarga.</h1>');
});

// --- LÓGICA WHATSAPP ---
async function connectToWhatsApp() {
    // Guardamos la sesión en una carpeta local (Nota: En Render Free esto se borra al reiniciar, hay que re-escanear)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // También sale en los logs de Render
        auth: state,
        browser: ["Notaria Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('NUEVO QR GENERADO');
            qrCodeData = qr; // Guardamos para mostrar en la web
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. Reconectando...', shouldReconnect);
            isConnected = false;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ ¡WhatsApp Conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- LÓGICA SUPABASE (LISTENER) ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function setupSupabaseListener() {
    console.log("🎧 Escuchando cambios en la tabla turnos...");
    
    const channel = supabase.channel('bot_whatsapp_listener')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                const newTurn = payload.new;
                const oldTurn = payload.old;

                // Solo nos interesa si el turno pasa a 'en atencion'
                if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                    console.log(`🔔 Turno llamado: ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                    await notifyUser(newTurn);
                }
            }
        )
        .subscribe();
}

async function notifyUser(turnData) {
    if (!sock || !isConnected) {
        console.log("❌ No se pudo enviar mensaje: Bot desconectado.");
        return;
    }

    try {
        // 1. Buscamos si hay una suscripción para este turno
        const { data: sub, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .single();

        if (error || !sub) return; // Nadie suscrito

        // 2. Buscamos info del módulo
        const { data: mod } = await supabase
            .from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const moduloNombre = mod ? mod.nombre_modulo : "un módulo";
        const turnoTexto = `${turnData.prefijo_turno}-${String(turnData.numero_turno).padStart(3, '0')}`;

        // 3. Enviamos el mensaje
        const numero = sub.numero_whatsapp.replace('+', '') + '@s.whatsapp.net';
        const mensaje = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnoTexto}* está siendo llamado.\n➡️ Dirígete al *${moduloNombre}* ahora mismo.`;

        await sock.sendMessage(numero, { text: mensaje });
        console.log(`✅ Mensaje enviado a ${sub.numero_whatsapp}`);

    } catch (e) {
        console.error("Error enviando notificación:", e);
    }
}

// --- ARRANCAR ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();