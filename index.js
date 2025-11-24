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

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("❌ Faltan variables de entorno.");
    process.exit(1);
}

const app = express();
let qrCodeData = null;
let sock = null;
let isConnected = false;

// --- SERVIDOR WEB (QR) ---
app.get('/', async (req, res) => {
    if (isConnected) return res.send('<h1 style="color:green">✅ Bot Conectado y Escuchando</h1>');
    if (qrCodeData) {
        const img = await QRCode.toDataURL(qrCodeData);
        return res.send(`<div style="text-align:center"><h1>Escanea el QR</h1><img src="${img}" /></div>`);
    }
    res.send('<h1>Cargando...</h1>');
});

// --- CONEXIÓN A SUPABASE ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

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
            if (statusCode !== 515) console.log(`❌ Cerrado. Código: ${statusCode}`);
            
            if (statusCode === 405) {
                try { fs.rmSync('auth_info_baileys', { recursive: true, force: true }); } catch(e){}
                process.exit(1); 
            }
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
            else isConnected = false;

        } else if (connection === 'open') {
            console.log('✅ WhatsApp Conectado');
            isConnected = true;
            qrCodeData = null;
        }
    });

    // --- ESCUCHAR MENSAJES ENTRANTES (NUEVO) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue; // Ignorar mis propios mensajes

            const remoteJid = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            
            if (!text) continue;
            
            console.log(`📩 Mensaje recibido de ${remoteJid}: ${text}`);
            await handleIncomingMessage(remoteJid, text);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// --- PROCESAR MENSAJE DEL CLIENTE ---
async function handleIncomingMessage(jid, text) {
    const cleanText = text.trim();
    
    // 1. Si saluda o no parece una cédula, pedimos la cédula
    // (Asumimos que una cédula tiene al menos 5 dígitos numéricos)
    if (cleanText.length < 5 || !/^\d+$/.test(cleanText)) {
        await sock.sendMessage(jid, { 
            text: "👋 ¡Hola! Soy el asistente virtual de la Notaría.\n\nPara avisarte cuando sea tu turno, por favor responde *únicamente con tu número de cédula* (sin puntos ni espacios)." 
        });
        return;
    }

    // 2. Si parece una cédula, buscamos en la base de datos
    const cedula = cleanText;
    console.log(`🔎 Buscando turno para cédula: ${cedula}`);

    try {
        // Buscamos un turno 'en espera' para esta cédula, creado HOY
        const today = new Date().toISOString().split('T')[0];
        
        // Hacemos JOIN con la tabla clientes
        const { data: turnos, error } = await supabase
            .from('turnos')
            .select('id_turno, prefijo_turno, numero_turno, id_servicio, hora_solicitud, clientes!inner(numero_identificacion)')
            .eq('clientes.numero_identificacion', cedula)
            .eq('estado', 'en espera')
            .gte('hora_solicitud', today)
            .order('hora_solicitud', { ascending: false })
            .limit(1);

        if (error) {
            console.error("Error Supabase:", error);
            await sock.sendMessage(jid, { text: "⚠️ Hubo un error consultando el sistema. Intenta de nuevo." });
            return;
        }

        if (!turnos || turnos.length === 0) {
            await sock.sendMessage(jid, { text: `❌ No encontré ningún turno activo hoy para la cédula *${cedula}*.\n\nAsegúrate de haber solicitado tu turno en el Kiosco primero.` });
            return;
        }

        const turno = turnos[0];
        const codigoTurno = `${turno.prefijo_turno}-${turno.numero_turno}`;

        // 3. REGISTRAR SUSCRIPCIÓN
        const { error: subError } = await supabase
            .from('whatsapp_subscriptions')
            .upsert({ 
                id_turno: turno.id_turno, 
                numero_whatsapp: jid.replace('@s.whatsapp.net', ''), // Guardamos solo el número
                // id_cliente se podría guardar si lo tuviéramos a mano en el select, pero con id_turno basta
            }, { onConflict: 'id_turno' });

        if (subError) {
            console.error("Error suscripción:", subError);
        }

        // 4. CALCULAR GENTE POR DELANTE
        const { count } = await supabase
            .from('turnos')
            .select('id_turno', { count: 'exact', head: true })
            .eq('estado', 'en espera')
            .eq('id_servicio', turno.id_servicio)
            .lt('hora_solicitud', turno.hora_solicitud);

        await sock.sendMessage(jid, { 
            text: `✅ *¡Turno Encontrado!*\n\n🎫 Tu turno: *${codigoTurno}*\n👥 Personas antes de ti: *${count}*\n\n🔔 Te enviaré un mensaje por aquí apenas te llamen. ¡Puedes esperar tranquilo!` 
        });

    } catch (e) {
        console.error("Error general:", e);
    }
}

// --- ESCUCHAR CAMBIOS EN LA DB (PARA AVISAR) ---
let isReconnectingDB = false;

async function setupSupabaseListener() {
    try { await supabase.removeAllChannels(); } catch(e){}
    isReconnectingDB = false;
    console.log("🎧 Iniciando escucha de base de datos...");

    const channel = supabase.channel('bot_notifications_' + Date.now())
        .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'turnos' },
            async (payload) => {
                const newTurn = payload.new;
                const oldTurn = payload.old;

                // Si pasa a 'en atencion', AVISAR
                if (oldTurn.estado === 'en espera' && newTurn.estado === 'en atencion') {
                    console.log(`🔔 Turno llamado: ${newTurn.prefijo_turno}-${newTurn.numero_turno}`);
                    await notifyUserCall(newTurn);
                }
            }
        )
        .subscribe((status) => {
            console.log(`🔌 Estado Supabase: ${status}`);
            if (status === 'TIMED_OUT' || status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                if (isReconnectingDB) return;
                isReconnectingDB = true;
                console.log("⚠️ Reconectando DB en 10s...");
                setTimeout(setupSupabaseListener, 10000);
            }
        });
}

async function notifyUserCall(turnData) {
    if (!isConnected || !sock) return;
    try {
        // Buscar suscripción
        const { data: sub } = await supabase.from('whatsapp_subscriptions').select('numero_whatsapp').eq('id_turno', turnData.id_turno).single();
        if (!sub) return;

        // Buscar módulo
        const { data: mod } = await supabase.from('modulos').select('nombre_modulo').eq('id_modulo', turnData.id_modulo_atencion).single();
        const modName = mod ? mod.nombre_modulo : "un módulo";
        
        const jid = sub.numero_whatsapp + '@s.whatsapp.net';
        const texto = `🚨 *¡ES TU TURNO!* 🚨\n\nEl turno *${turnData.prefijo_turno}-${turnData.numero_turno}* ha sido llamado.\n➡️ Dirígete al *${modName}* ahora mismo.`;
        
        await sock.sendMessage(jid, { text: texto });
        console.log(`✅ Notificación enviada a ${sub.numero_whatsapp}`);
    } catch (e) {
        console.error("Error enviando:", e.message);
    }
}

// --- ARRANQUE ---
app.listen(PORT, () => console.log(`Servidor Web listo en puerto ${PORT}`));
connectToWhatsApp();
setupSupabaseListener();