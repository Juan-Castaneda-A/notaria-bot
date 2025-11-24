// 1. PARCHES DEL SISTEMA (CRÍTICOS PARA RENDER)
const crypto = require('crypto');
if (!global.crypto) { global.crypto = crypto; }

const WebSocket = require('ws');
// Forzamos que sea global para que cualquier librería interna lo encuentre
if (!global.WebSocket) { global.WebSocket = WebSocket; }

// 2. IMPORTS
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// 3. VERIFICACIÓN DE ENTORNO (LOGS DETALLADOS)
console.log("--- 🕵️ INICIANDO DIAGNÓSTICO DE ARRANQUE ---");
const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

console.log(`1. Puerto: ${PORT}`);
console.log(`2. URL Supabase definida: ${!!SUPABASE_URL}`);
if (SUPABASE_URL) console.log(`   > Valor: ${SUPABASE_URL}`);

console.log(`3. Key Supabase definida: ${!!SUPABASE_KEY}`);
if (SUPABASE_KEY) {
    console.log(`   > Longitud: ${SUPABASE_KEY.length} caracteres`);
    console.log(`   > Inicio: ${SUPABASE_KEY.substring(0, 10)}...`);
    console.log(`   > ¿Es service_role?: ${!SUPABASE_KEY.includes('anon')}`); // Check rápido
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ ERROR FATAL: Faltan variables de entorno.");
    process.exit(1);
}

// 4. CONFIGURACIÓN SUPABASE
// Usamos una configuración simplificada pero explícita para Node.js
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { 
        persistSession: false,
        autoRefreshToken: false
    },
    realtime: {
        // Inyección explícita del WebSocket
        websocket: WebSocket,
        headers: { 'apikey': SUPABASE_KEY },
        params: { eventsPerSecond: 10 },
        // Aumentamos tiempos para redes lentas
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
    if (isConnected) return res.send('<h1 style="color:green">✅ Bot Conectado</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`<div style="text-align:center"><h1>Escanea el QR</h1><img src="${img}" /></div>`);
    }
    res.send('<h1>Cargando...</h1>');
});

app.get('/test', async (req, res) => {
    const phone = req.query.phone;
    console.log(`🧪 Test solicitado para: ${phone}`);
    if (!phone || !sock) return res.send("Error: Bot no listo");
    try {
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: "🔔 Test OK" });
        res.send("Enviado");
    } catch (e) {
        res.send(`Error: ${e.message}`);
    }
});

// 6. WHATSAPP (BAILEYS)
async function connectToWhatsApp() {
    console.log("🔄 (WA) Iniciando socket...");
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
            if (statusCode !== 515) console.log(`❌ (WA) Cerrado. Código: ${statusCode}`);
            
            if (statusCode === 405) {
                console.log("⚠️ (WA) Error 405. Reinicio forzado.");
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); 
            }
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ (WA) ¡Conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

// 7. LISTENER SUPABASE (EL DETECTIVE)
let isReconnecting = false;

async function setupSupabaseListener() {
    if (isReconnecting) {
        console.log("🚫 (DB) Intento de reconexión bloqueado (ya hay uno en curso).");
        return;
    }
    isReconnecting = true;

    console.log("🧹 (DB) Limpiando canales previos...");
    await supabase.removeAllChannels();

    console.log("🎧 (DB) Creando nuevo canal y suscribiendo...");
    const channel = supabase.channel('bot_debug_room');

    channel
        .on('postgres_changes', { event: '*', schema: 'public', table: 'turnos' }, (payload) => {
            // LOG SI LLEGA CUALQUIER COSA
            console.log("🔥 (DB) ¡EVENTO RECIBIDO!");
            console.log(`   > Tipo: ${payload.eventType}`);
            console.log(`   > Turno ID: ${payload.new?.id_turno}`);
            
            if (payload.eventType === 'UPDATE' && payload.new.estado === 'en atencion') {
                console.log("🔔 (DB) ¡Es un llamado! Procesando...");
                notifyUser(payload.new);
            }
        })
        .subscribe((status, err) => {
            // LOG DETALLADO DEL ESTADO
            console.log(`🔌 (DB) Estado cambió a: ${status}`);
            
            if (err) {
                console.error("❌ (DB) ERROR CRÍTICO EN SUSCRIPCIÓN:");
                console.error(err); // Imprimimos el objeto de error completo
            }

            if (status === 'SUBSCRIBED') {
                console.log("✅ (DB) ¡Conexión establecida y escuchando!");
                isReconnecting = false; // Liberamos el bloqueo
            }

            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                console.log("⚠️ (DB) Conexión perdida/fallida. Reintentando en 10s...");
                // No liberamos isReconnecting aquí, esperamos al timeout
                setTimeout(() => {
                    isReconnecting = false; // Ahora sí permitimos otro intento
                    setupSupabaseListener();
                }, 10000);
            }
        });
}

async function notifyUser(turnData) {
    if (!isConnected || !sock) {
        console.log("⚠️ (Bot) No se envió mensaje: WhatsApp desconectado.");
        return;
    }
    console.log(`🔍 (Bot) Buscando suscripción para Turno ${turnData.id_turno}...`);
    
    try {
        const { data: sub, error } = await supabase
            .from('whatsapp_subscriptions')
            .select('numero_whatsapp')
            .eq('id_turno', turnData.id_turno)
            .maybeSingle(); // Usamos maybeSingle para evitar error si no hay fila

        if (error) {
            console.error("❌ (Bot) Error Supabase al buscar suscripción:", error.message);
            return;
        }
        if (!sub) {
            console.log("ℹ️ (Bot) No hay suscripción para este turno.");
            return;
        }

        const { data: mod } = await supabase
            .from('modulos')
            .select('nombre_modulo')
            .eq('id_modulo', turnData.id_modulo_atencion)
            .single();
        
        const modName = mod ? mod.nombre_modulo : "un módulo";
        const jid = sub.numero_whatsapp.replace(/\D/g, '') + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}*.`;
        
        console.log(`📤 (Bot) Enviando mensaje a ${sub.numero_whatsapp}...`);
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ (Bot) ¡Mensaje enviado!`);

    } catch (e) {
        console.error("❌ (Bot) Excepción en notifyUser:", e);
    }
}

// ARRANQUE
app.listen(PORT, () => console.log(`🚀 Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();