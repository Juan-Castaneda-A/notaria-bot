const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
// Importamos WS explícitamente
const WebSocket = require('ws'); 

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Error Fatal: Faltan variables de entorno (URL o KEY).");
    process.exit(1);
}

const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

// --- WEB SERVER ---
app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1 style="color:green; font-family:sans-serif;">✅ Bot Conectado y Operativo</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`<div style="text-align:center; font-family:sans-serif;"><h1>Escanea el QR</h1><img src="${img}" /><br><p>Recarga la página si caduca.</p></div>`);
    }
    res.send('<h1 style="font-family:sans-serif;">Iniciando... espera 10 segundos y recarga.</h1>');
});

app.get('/test', async (req, res) => {
    const phone = req.query.phone;
    if (!phone || !sock) return res.send("Error: Bot desconectado o falta teléfono");
    try {
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: "🔔 Test de conexión exitoso." });
        res.send(`Mensaje enviado a ${phone}`);
    } catch (e) {
        res.send(`Error: ${e.message}`);
    }
});

// --- SUPABASE CLIENT (CONFIGURACIÓN ROBUSTA) ---
// Aquí está el cambio clave: Inyectamos el constructor de WebSocket
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
        persistSession: false,
        autoRefreshToken: false,
    },
    realtime: {
        // ¡ESTA LÍNEA ARREGLA EL CHANNEL_ERROR!
        // Le pasamos la librería 'ws' directamente a Supabase
        headers: { apikey: SUPABASE_KEY }, // Refuerzo de seguridad
        params: { eventsPerSecond: 10 },
        websocket: WebSocket 
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
        
        if (qr) {
            console.log('👉 NUEVO QR GENERADO (Ve a la web para escanear)');
            qrCodeData = qr;
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            // Ignoramos el 515 (reinicio técnico)
            if (statusCode !== 515) console.log(`❌ WhatsApp desconectado. Código: ${statusCode}`);

            if (statusCode === 405) {
                console.log("⚠️ Error 405 (Sesión inválida). Reiniciando limpio...");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1);
            }
            
            if (statusCode !== DisconnectReason.loggedOut) {
                // Reconexión con delay para no saturar
                setTimeout(connectToWhatsApp, 3000);
            } else {
                isConnected = false;
            }
        } else if (connection === 'open') {
            console.log('✅ ¡WhatsApp Conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// --- LÓGICA DB LISTENER ---
let listenerActive = false;

async function setupSupabaseListener() {
    if (listenerActive) return; // Evitar duplicados
    listenerActive = true;

    console.log("🎧 Configurando listener de base de datos...");

    // Limpieza preventiva
    await supabase.removeAllChannels();

    const channel = supabase.channel('bot_turnos_v4');

    channel
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                const newTurn = payload.new;
                const oldTurn = payload.old;

                // Filtro estricto: Solo cambios de 'en espera' a 'en atencion'
                if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                    console.log(`🔔 DETECTADO LLAMADO: Turno ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                    await notifyUser(newTurn);
                }
            }
        )
        .subscribe((status, err) => {
            console.log(`🔌 Estado Supabase: ${status}`);
            
            if (status === 'CHANNEL_ERROR') {
                console.error("❌ Error crítico de canal. Verifique credenciales.", err);
                // No reintentamos en bucle rápido para no saturar logs
                listenerActive = false;
                setTimeout(setupSupabaseListener, 10000);
            }
            
            if (status === 'TIMED_OUT' || status === 'CLOSED') {
                console.log("⚠️ Conexión perdida. Reintentando...");
                listenerActive = false;
                setTimeout(setupSupabaseListener, 5000);
            }
        });
}

async function notifyUser(turnData) {
    if (!isConnected || !sock) {
        console.log("⚠️ No se envió mensaje: WhatsApp desconectado.");
        return;
    }
    try {
        // 1. Buscar suscripción
        const { data: sub, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .single();

        if (error || !sub) return; // No hay suscripción, no hacemos nada

        // 2. Buscar nombre del módulo
        const { data: mod } = await supabase
            .from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const modName = mod ? mod.nombre_modulo : "un módulo";
        const turnoTexto = `${turnData.prefijo_turno}-${String(turnData.numero_turno).padStart(3, '0')}`;
        
        // 3. Enviar mensaje
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const mensaje = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnoTexto}* ha sido llamado.\n➡️ Dirígete al *${modName}*.`;
        
        await sock.sendMessage(jid, { text: mensaje });
        console.log(`✅ Mensaje enviado a ${sub.numero_whatsapp}`);

    } catch (e) {
        console.error("Error procesando notificación:", e.message);
    }
}

// --- ARRANQUE ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();