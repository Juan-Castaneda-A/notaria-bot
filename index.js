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
    console.error("❌ Error: Faltan las variables de entorno SUPABASE_URL o SUPABASE_KEY");
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

// --- LÓGICA WHATSAPP ---
async function connectToWhatsApp() {
    // Usamos una carpeta para guardar sesión
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Desactivado para limpiar logs
        auth: state,
        // Usamos una firma de navegador más robusta
        browser: Browsers.ubuntu("Chrome"), 
        connectTimeoutMs: 60000,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('👉 NUEVO QR GENERADO. Ve a la URL para escanear.');
            qrCodeData = qr;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`❌ Conexión cerrada. Código: ${statusCode}`);

            // CORRECCIÓN: Si es error 405, la sesión está corrupta. Borramos y reiniciamos.
            if (statusCode === 405) {
                console.log("⚠️ Error 405 detectado. Credenciales corruptas. Reiniciando sesión limpia...");
                try {
                    fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                } catch (e) {
                    console.error("No se pudo borrar carpeta auth:", e);
                }
                // Esperamos un poco más antes de reintentar para no saturar
                setTimeout(connectToWhatsApp, 3000);
                return;
            }

            isConnected = false;
            if (shouldReconnect) {
                console.log('🔄 Reconectando...');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('⛔ Desconectado permanentemente. Se requiere nuevo escaneo.');
                // Borramos credenciales para permitir nuevo escaneo
                fs.rmSync('auth_info_baileys', { recursive: true, force: true });
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ ¡WhatsApp Conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- LISTENER SUPABASE ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function setupSupabaseListener() {
    console.log("🎧 Escuchando cambios en la tabla turnos...");
    
    supabase.channel('bot_whatsapp_listener')
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                const newTurn = payload.new;
                const oldTurn = payload.old;

                // Solo si pasa de 'en espera' a 'en atencion'
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
        console.log("⚠️ No se pudo enviar mensaje: Bot desconectado.");
        return;
    }

    try {
        // 1. Buscar suscripción
        const { data: sub, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .single();

        if (error || !sub) return; // Nadie suscrito

        // 2. Buscar nombre del módulo
        const { data: mod } = await supabase
            .from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const moduloNombre = mod ? mod.nombre_modulo : "un módulo";
        const turnoTexto = `${turnData.prefijo_turno}-${String(turnData.numero_turno).padStart(3, '0')}`;

        // 3. Enviar
        // Aseguramos formato internacional (ej: 57300...) -> 57300...@s.whatsapp.net
        const numeroLimpio = sub.numero_whatsapp.replace(/\D/g, ''); 
        const jid = numeroLimpio + '@s.whatsapp.net';
        
        const mensaje = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnoTexto}* está siendo llamado.\n➡️ Dirígete al *${moduloNombre}* ahora mismo.`;

        await sock.sendMessage(jid, { text: mensaje });
        console.log(`✅ Notificación enviada a ${numeroLimpio}`);

    } catch (e) {
        console.error("Error enviando notificación:", e);
    }
}

// --- START ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();