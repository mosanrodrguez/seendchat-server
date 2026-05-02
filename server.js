const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const TelegramBot = require('node-telegram-bot-api');
const { pool, initDatabase, run, get, all } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Telegram Bot
const TELEGRAM_TOKEN = '8532367420:AAHoPhSh0cyW11VSsWcjSo8nHK2LoGwPSZA';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));

let dbReady = false;
initDatabase().then(() => { dbReady = true; console.log('✅ DB lista'); });

app.use((req, res, next) => { if (!dbReady) return res.status(503).json({ error: 'Inicializando...' }); next(); });

function auth(req) { const token = req.headers.authorization?.replace('Bearer ', ''); if (!token) return null; return get('SELECT userId FROM tokens WHERE token = $1', [token]); }

// ==========================================
// BOT DE TELEGRAM
// ==========================================
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 ¡Bienvenido a SeendChat!\n\nComparte tu número de teléfono para recibir códigos de verificación.', {
        reply_markup: { keyboard: [[{ text: '📱 Compartir número', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
});

bot.on('contact', (msg) => {
    if (msg.contact) {
        const phone = msg.contact.phone_number.replace(/[^0-9]/g, '');
        const existing = get('SELECT * FROM verification_codes WHERE phoneNumber = $1', [phone]);
        if (existing) {
            run('UPDATE verification_codes SET telegramChatId = $1 WHERE phoneNumber = $2', [msg.chat.id.toString(), phone]);
        } else {
            run('INSERT INTO verification_codes (phoneNumber, code, telegramChatId, expiresAt) VALUES ($1, $2, $3, $4)', [phone, '', msg.chat.id.toString(), new Date().toISOString()]);
        }
        bot.sendMessage(msg.chat.id, `✅ Número ${phone} registrado. Recibirás los códigos aquí.`);
    }
});

// ==========================================
// AUTENTICACIÓN
// ==========================================
app.post('/api/request-code', (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'Número requerido' });
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        const existing = get('SELECT * FROM verification_codes WHERE phoneNumber = $1', [cleanPhone]);
        if (existing) {
            run('UPDATE verification_codes SET code = $1, expiresAt = $2, attempts = 0 WHERE phoneNumber = $3', [code, expiresAt, cleanPhone]);
        } else {
            run('INSERT INTO verification_codes (phoneNumber, code, expiresAt) VALUES ($1, $2, $3)', [cleanPhone, code, expiresAt]);
        }

        const vc = get('SELECT telegramChatId FROM verification_codes WHERE phoneNumber = $1', [cleanPhone]);
        if (vc && vc.telegramChatId) {
            bot.sendMessage(vc.telegramChatId, `🔐 Tu código de SeendChat es: ${code}\n\nNo compartas este código con nadie.`);
        }

        console.log(`📱 Código para ${cleanPhone}: ${code}`);
        res.json({ message: 'Código enviado', expiresIn: 600 });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify-code', (req, res) => {
    try {
        const { phoneNumber, code } = req.body;
        if (!phoneNumber || !code) return res.status(400).json({ error: 'Datos incompletos' });
        const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
        const vc = get('SELECT * FROM verification_codes WHERE phoneNumber = $1', [cleanPhone]);

        if (!vc) return res.status(404).json({ error: 'Código no solicitado' });
        if (new Date(vc.expiresAt) < new Date()) return res.status(410).json({ error: 'Código expirado' });
        if (vc.attempts >= 5) return res.status(429).json({ error: 'Demasiados intentos' });
        if (vc.code !== code) {
            run('UPDATE verification_codes SET attempts = attempts + 1 WHERE phoneNumber = $1', [cleanPhone]);
            return res.status(401).json({ error: 'Código incorrecto' });
        }

        let user = get('SELECT * FROM users WHERE phoneNumber = $1', [cleanPhone]);
        if (!user) {
            const id = uuidv4();
            run('INSERT INTO users (id, phoneNumber, status) VALUES ($1, $2, $3)', [id, cleanPhone, 'online']);
            user = get('SELECT * FROM users WHERE id = $1', [id]);
        } else {
            run("UPDATE users SET status = 'online' WHERE id = $1", [user.id]);
        }

        const token = uuidv4();
        run('INSERT INTO tokens (token, userId) VALUES ($1, $2)', [token, user.id]);
        run('DELETE FROM verification_codes WHERE phoneNumber = $1', [cleanPhone]);

        const priv = get('SELECT * FROM privacy_settings WHERE userId = $1', [user.id]);
        if (!priv) run('INSERT INTO privacy_settings (userId) VALUES ($1)', [user.id]);

        res.json({
            message: 'Verificado', token,
            user: { id: user.id, phoneNumber: user.phoneNumber, fullName: user.fullname || '', username: user.username || '', photoUrl: user.photoUrl, info: user.info || '¡Hola! Estoy usando Seend.', status: 'online' }
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// PERFIL
// ==========================================
app.post('/api/update-profile', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { fullName, username, info, photoUrl } = req.body;
    if (fullName) run('UPDATE users SET fullName = $1 WHERE id = $2', [fullName, td.userId]);
    if (username) run('UPDATE users SET username = $1 WHERE id = $2', [username, td.userId]);
    if (info) run('UPDATE users SET info = $1 WHERE id = $2', [info, td.userId]);
    if (photoUrl) run('UPDATE users SET photoUrl = $1 WHERE id = $2', [photoUrl, td.userId]);
    const user = get('SELECT * FROM users WHERE id = $1', [td.userId]);
    res.json({ message: 'Perfil actualizado', user });
});

// ==========================================
// USUARIOS
// ==========================================
app.get('/api/users', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const users = all('SELECT id, phoneNumber, fullName, username, photoUrl, info, status, lastSeen FROM users WHERE id != $1', [td.userId]);
    res.json(users);
});

app.get('/api/users/:id', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const user = get('SELECT id, phoneNumber, fullName, username, photoUrl, info, status, lastSeen FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
});

// ==========================================
// MENSAJES
// ==========================================
app.post('/api/messages', (req, res) => {
    try {
        const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
        const { receiverId, text, imageUrl, videoUrl, voiceUrl, fileUrl, fileName, fileSize, imageSize, voiceDuration, replyTo, replyText, isGroup, groupId } = req.body;
        if (!receiverId) return res.status(400).json({ error: 'Destinatario requerido' });
        const sender = get('SELECT fullName FROM users WHERE id = $1', [td.userId]);
        const messageId = uuidv4();
        const createdAt = new Date().toISOString();

        run('INSERT INTO messages (id, senderId, senderName, receiverId, text, imageUrl, videoUrl, voiceUrl, fileUrl, fileName, fileSize, imageSize, voiceDuration, replyTo, replyText, status, createdAt, isGroup, groupId) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
            [messageId, td.userId, sender.fullname, receiverId, text || null, imageUrl || null, videoUrl || null, voiceUrl || null, fileUrl || null, fileName || null, fileSize || null, imageSize || null, voiceDuration || null, replyTo || null, replyText || null, 'sent', createdAt, isGroup ? 1 : 0, groupId || null]);

        const message = { id: messageId, senderId: td.userId, senderName: sender.fullname, receiverId, text, imageUrl, videoUrl, voiceUrl, fileUrl, fileName, fileSize, imageSize, voiceDuration, replyTo, replyText, status: 'sent', createdAt, isGroup: !!isGroup, groupId };

        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.userId === receiverId) c.send(JSON.stringify({ type: 'new_message', message })); });

        res.status(201).json(message);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/messages/:userId', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const msgs = all('SELECT * FROM messages WHERE ((senderId = $1 AND receiverId = $2) OR (senderId = $2 AND receiverId = $1)) AND isGroup = 0 AND deletedForReceiver = 0 ORDER BY createdAt ASC', [td.userId, req.params.userId]);
    res.json(msgs);
});

app.post('/api/messages/read/:senderId', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });

    // 1. Marcar como leídos
    run("UPDATE messages SET status = 'read' WHERE senderId = $1 AND receiverId = $2 AND status != 'read'", [req.params.senderId, td.userId]);

    // 2. Notificar al remitente por WebSocket
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c.userId === req.params.senderId) {
            c.send(JSON.stringify({ type: 'messages_read', readerId: td.userId }));
        }
    });

    // 3. Eliminar mensajes de texto leídos (limpieza bajo demanda)
    run("DELETE FROM messages WHERE status = 'read' AND text IS NOT NULL AND imageUrl IS NULL AND videoUrl IS NULL AND voiceUrl IS NULL AND fileUrl IS NULL AND isGroup = 0");

    // 4. Eliminar códigos expirados
    run("DELETE FROM verification_codes WHERE expiresAt < NOW()");

    res.json({ message: 'Marcado como leído y limpieza ejecutada' });
});

// ==========================================
// CHATS
// ==========================================
app.get('/api/chats', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const userId = td.userId;

    const directChats = all(`
        SELECT DISTINCT
            CASE WHEN senderId = $1 THEN receiverId ELSE senderId END as chatId,
            u.fullName as displayName, u.photoUrl, u.status as isOnline,
            (SELECT text FROM messages WHERE ((senderId = $1 AND receiverId = chatId) OR (senderId = chatId AND receiverId = $1)) AND isGroup = 0 AND deletedForReceiver = 0 ORDER BY createdAt DESC LIMIT 1) as lastMessage,
            (SELECT createdAt FROM messages WHERE ((senderId = $1 AND receiverId = chatId) OR (senderId = chatId AND receiverId = $1)) AND isGroup = 0 AND deletedForReceiver = 0 ORDER BY createdAt DESC LIMIT 1) as lastMessageTime,
            (SELECT status FROM messages WHERE ((senderId = $1 AND receiverId = chatId) OR (senderId = chatId AND receiverId = $1)) AND isGroup = 0 AND deletedForReceiver = 0 ORDER BY createdAt DESC LIMIT 1) as lastStatus,
            (SELECT COUNT(*) FROM messages WHERE receiverId = $1 AND senderId = chatId AND status != 'read' AND isGroup = 0 AND deletedForReceiver = 0) as unreadCount
        FROM messages m
        JOIN users u ON u.id = CASE WHEN senderId = $1 THEN receiverId ELSE senderId END
        WHERE (senderId = $1 OR receiverId = $1) AND isGroup = 0 AND deletedForReceiver = 0
    `, [userId]);

    const groups = all(`
        SELECT g.id as chatId, g.name as displayName, g.photoUrl,
            (SELECT text FROM messages WHERE groupId = g.id AND deletedForAll = 0 ORDER BY createdAt DESC LIMIT 1) as lastMessage,
            (SELECT senderName FROM messages WHERE groupId = g.id AND deletedForAll = 0 ORDER BY createdAt DESC LIMIT 1) as lastSenderName,
            (SELECT createdAt FROM messages WHERE groupId = g.id AND deletedForAll = 0 ORDER BY createdAt DESC LIMIT 1) as lastMessageTime,
            (SELECT COUNT(*) FROM messages WHERE groupId = g.id AND createdAt > COALESCE((SELECT MAX(createdAt) FROM messages WHERE groupId = g.id AND senderId = $1 AND status = 'read'), '1970-01-01')) as unreadCount
        FROM groups_table g
        JOIN group_members gm ON g.id = gm.groupId
        WHERE gm.userId = $1
    `, [userId]);

    const result = [
        ...directChats.map(c => ({ ...c, type: 'direct' })),
        ...groups.map(g => ({ ...g, type: 'group' }))
    ];

    result.sort((a, b) => (b.lastMessageTime || '').localeCompare(a.lastMessageTime || ''));
    res.json(result);
});

// ==========================================
// GRUPOS
// ==========================================
app.post('/api/groups', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { name, description, photoUrl } = req.body;
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const id = uuidv4();
    const inviteLink = uuidv4().substring(0, 12);

    run('INSERT INTO groups_table (id, name, description, photoUrl, inviteLink, createdBy) VALUES ($1,$2,$3,$4,$5,$6)', [id, name, description || '', photoUrl || null, inviteLink, td.userId]);
    run('INSERT INTO group_members (groupId, userId, role) VALUES ($1,$2,$3)', [id, td.userId, 'owner']);
    run('INSERT INTO group_permissions (groupId) VALUES ($1)', [id]);

    const sysId = uuidv4();
    const ownerName = get('SELECT fullName FROM users WHERE id = $1', [td.userId]);
    run('INSERT INTO messages (id, senderId, senderName, receiverId, text, status, createdAt, isGroup, groupId, isSystemMessage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [sysId, td.userId, ownerName.fullname, id, 'Grupo creado', 'sent', new Date().toISOString(), 1, id, 1]);

    // Añadir miembros iniciales
    const { members } = req.body;
    if (members && Array.isArray(members)) {
        for (const memberId of members) {
            if (memberId !== td.userId) {
                const isBanned = get('SELECT * FROM banned_users WHERE groupId = $1 AND userId = $2', [id, memberId]);
                if (!isBanned) {
                    run('INSERT INTO group_members (groupId, userId, role) VALUES ($1,$2,$3)', [id, memberId, 'member']);
                    const memberName = get('SELECT fullName FROM users WHERE id = $1', [memberId]);
                    const joinSysId = uuidv4();
                    run('INSERT INTO messages (id, senderId, senderName, receiverId, text, status, createdAt, isGroup, groupId, isSystemMessage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
                        [joinSysId, memberId, memberName.fullname, id, `${memberName.fullname} se unió al grupo`, 'sent', new Date().toISOString(), 1, id, 1]);
                }
            }
        }
    }

    res.status(201).json({ id, name, description, inviteLink });
});

app.get('/api/groups/:id', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const group = get('SELECT * FROM groups_table WHERE id = $1', [req.params.id]);
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });

    const members = all('SELECT gm.*, u.fullName, u.photoUrl, u.info FROM group_members gm JOIN users u ON gm.userId = u.id WHERE gm.groupId = $1 ORDER BY gm.role, gm.joinedAt', [req.params.id]);
    const permissions = get('SELECT * FROM group_permissions WHERE groupId = $1', [req.params.id]);
    const banned = all('SELECT bu.*, u.fullName, u.photoUrl, u.info FROM banned_users bu JOIN users u ON bu.userId = u.id WHERE bu.groupId = $1', [req.params.id]);

    res.json({ group, members, permissions, banned });
});

app.put('/api/groups/:id', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { name, description, photoUrl } = req.body;
    if (name) run('UPDATE groups_table SET name = $1 WHERE id = $2', [name, req.params.id]);
    if (description) run('UPDATE groups_table SET description = $1 WHERE id = $2', [description, req.params.id]);
    if (photoUrl) run('UPDATE groups_table SET photoUrl = $1 WHERE id = $2', [photoUrl, req.params.id]);
    res.json({ message: 'Grupo actualizado' });
});

app.delete('/api/groups/:id', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    run('DELETE FROM messages WHERE groupId = $1', [req.params.id]);
    run('DELETE FROM group_members WHERE groupId = $1', [req.params.id]);
    run('DELETE FROM group_permissions WHERE groupId = $1', [req.params.id]);
    run('DELETE FROM banned_users WHERE groupId = $1', [req.params.id]);
    run('DELETE FROM groups_table WHERE id = $1', [req.params.id]);
    res.json({ message: 'Grupo eliminado' });
});

app.post('/api/groups/:id/members', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId requerido' });

    const isBanned = get('SELECT * FROM banned_users WHERE groupId = $1 AND userId = $2', [req.params.id, userId]);
    if (isBanned) return res.status(403).json({ error: 'Usuario baneado' });

    const existing = get('SELECT * FROM group_members WHERE groupId = $1 AND userId = $2', [req.params.id, userId]);
    if (existing) return res.status(400).json({ error: 'Ya es miembro' });

    run('INSERT INTO group_members (groupId, userId, role) VALUES ($1,$2,$3)', [req.params.id, userId, 'member']);

    const sysId = uuidv4();
    const userName = get('SELECT fullName FROM users WHERE id = $1', [userId]);
    run('INSERT INTO messages (id, senderId, senderName, receiverId, text, status, createdAt, isGroup, groupId, isSystemMessage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [sysId, userId, userName.fullname, req.params.id, `${userName.fullname} se unió al grupo`, 'sent', new Date().toISOString(), 1, req.params.id, 1]);

    res.json({ message: 'Añadido al grupo' });
});

app.delete('/api/groups/:id/members/:userId', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const userName = get('SELECT fullName FROM users WHERE id = $1', [req.params.userId]);
    run('DELETE FROM group_members WHERE groupId = $1 AND userId = $2', [req.params.id, req.params.userId]);

    const sysId = uuidv4();
    run('INSERT INTO messages (id, senderId, senderName, receiverId, text, status, createdAt, isGroup, groupId, isSystemMessage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [sysId, req.params.userId, userName.fullname, req.params.id, `${userName.fullname} salió del grupo`, 'sent', new Date().toISOString(), 1, req.params.id, 1]);

    res.json({ message: 'Eliminado del grupo' });
});

app.put('/api/groups/:id/permissions', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { sendMessages, sendMedia, addMembers, editInfo, adminSendMessages, adminSendMedia, adminAddMembers, adminEditInfo } = req.body;
    run('UPDATE group_permissions SET sendMessages = $1, sendMedia = $2, addMembers = $3, editInfo = $4, adminSendMessages = $5, adminSendMedia = $6, adminAddMembers = $7, adminEditInfo = $8 WHERE groupId = $9',
        [sendMessages ?? 1, sendMedia ?? 1, addMembers ?? 0, editInfo ?? 0, adminSendMessages ?? 1, adminSendMedia ?? 1, adminAddMembers ?? 1, adminEditInfo ?? 1, req.params.id]);
    res.json({ message: 'Permisos actualizados' });
});

app.post('/api/groups/:id/ban', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId requerido' });

    const userName = get('SELECT fullName FROM users WHERE id = $1', [userId]);
    run('INSERT INTO banned_users (groupId, userId) VALUES ($1,$2)', [req.params.id, userId]);
    run('DELETE FROM group_members WHERE groupId = $1 AND userId = $2', [req.params.id, userId]);

    const sysId = uuidv4();
    run('INSERT INTO messages (id, senderId, senderName, receiverId, text, status, createdAt, isGroup, groupId, isSystemMessage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [sysId, userId, userName.fullname, req.params.id, `${userName.fullname} fue baneado del grupo`, 'sent', new Date().toISOString(), 1, req.params.id, 1]);

    res.json({ message: 'Usuario baneado' });
});

app.delete('/api/groups/:id/ban/:userId', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    run('DELETE FROM banned_users WHERE groupId = $1 AND userId = $2', [req.params.id, req.params.userId]);
    res.json({ message: 'Usuario desbaneado' });
});

// ==========================================
// PRIVACIDAD
// ==========================================
app.get('/api/privacy', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    let privacy = get('SELECT * FROM privacy_settings WHERE userId = $1', [td.userId]);
    if (!privacy) {
        run('INSERT INTO privacy_settings (userId) VALUES ($1)', [td.userId]);
        privacy = { userId: td.userId, photo: 'Todos', phone: 'Mis contactos', info: 'Todos', username: 'Todos', lastSeen: 'Todos', online: 'Todos', addToGroups: 'Todos', findByUsername: 'Todos' };
    }
    res.json(privacy);
});

app.put('/api/privacy', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { photo, phone, info, username, lastSeen, online, addToGroups, findByUsername } = req.body;
    run('UPDATE privacy_settings SET photo = $1, phone = $2, info = $3, username = $4, lastSeen = $5, online = $6, addToGroups = $7, findByUsername = $8 WHERE userId = $9',
        [photo || 'Todos', phone || 'Mis contactos', info || 'Todos', username || 'Todos', lastSeen || 'Todos', online || 'Todos', addToGroups || 'Todos', findByUsername || 'Todos', td.userId]);
    res.json({ message: 'Privacidad actualizada' });
});

// ==========================================
// BLOQUEADOS
// ==========================================
app.post('/api/block', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const { blockedUserId } = req.body;
    run('INSERT INTO blocked_users (userId, blockedUserId) VALUES ($1,$2)', [td.userId, blockedUserId]);
    res.json({ message: 'Usuario bloqueado' });
});

app.delete('/api/block/:userId', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    run('DELETE FROM blocked_users WHERE userId = $1 AND blockedUserId = $2', [td.userId, req.params.userId]);
    res.json({ message: 'Usuario desbloqueado' });
});

app.get('/api/blocked', (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    const blocked = all('SELECT bu.*, u.fullName, u.photoUrl, u.info FROM blocked_users bu JOIN users u ON bu.blockedUserId = u.id WHERE bu.userId = $1', [td.userId]);
    res.json(blocked);
});

// ==========================================
// UPLOAD
// ==========================================
app.post('/api/upload', upload.single('file'), (req, res) => {
    const td = auth(req); if (!td) return res.status(401).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'Archivo requerido' });
    const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ url, size: req.file.size, filename: req.file.originalname });
});

// ==========================================
// QR
// ==========================================
app.get('/api/groups/:id/qr', async (req, res) => {
    const group = get('SELECT * FROM groups_table WHERE id = $1', [req.params.id]);
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
    try {
        const qrDataUrl = await QRCode.toDataURL(`https://chat.seend.com/group/${req.params.id}`);
        res.json({ qr: qrDataUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// RAÍZ
// ==========================================
app.get('/', (req, res) => {
    res.json({ name: 'SeendChat API', version: '3.0.0', status: 'online' });
});

// ==========================================
// WEBSOCKET
// ==========================================
const server = app.listen(PORT, () => console.log(`✅ Servidor SeendChat en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const p = JSON.parse(data.toString());

            if (p.type === 'auth') {
                const td = get('SELECT userId FROM tokens WHERE token = $1', [p.token]);
                if (td) {
                    ws.userId = td.userId;
                    run("UPDATE users SET status = 'online' WHERE id = $1", [td.userId]);
                    ws.send(JSON.stringify({ type: 'auth_ok', userId: td.userId }));
                }
            }

            if (p.type === 'message' && ws.userId) {
                const sender = get('SELECT fullName FROM users WHERE id = $1', [ws.userId]);
                const mid = uuidv4();
                const now = new Date().toISOString();
                run('INSERT INTO messages (id, senderId, senderName, receiverId, text, imageUrl, videoUrl, voiceUrl, fileUrl, fileName, fileSize, imageSize, voiceDuration, replyTo, replyText, status, createdAt, isGroup, groupId) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
                    [mid, ws.userId, sender.fullname, p.receiverId, p.text || null, p.imageUrl || null, p.videoUrl || null, p.voiceUrl || null, p.fileUrl || null, p.fileName || null, p.fileSize || null, p.imageSize || null, p.voiceDuration || null, p.replyTo || null, p.replyText || null, 'sent', now, p.isGroup ? 1 : 0, p.groupId || null]);
                const msg = { id: mid, senderId: ws.userId, senderName: sender.fullname, receiverId: p.receiverId, text: p.text, imageUrl: p.imageUrl, videoUrl: p.videoUrl, voiceUrl: p.voiceUrl, fileUrl: p.fileUrl, fileName: p.fileName, fileSize: p.fileSize, imageSize: p.imageSize, voiceDuration: p.voiceDuration, replyTo: p.replyTo, replyText: p.replyText, status: 'sent', createdAt: now, isGroup: !!p.isGroup, groupId: p.groupId };
                wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.userId === p.receiverId) c.send(JSON.stringify({ type: 'new_message', message: msg })); });
                ws.send(JSON.stringify({ type: 'message_sent', message: msg }));
            }

            if (p.type === 'typing' && ws.userId) {
                wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.userId === p.receiverId) c.send(JSON.stringify({ type: 'typing', userId: ws.userId, isTyping: p.isTyping })); });
            }
        } catch (e) { console.error('WS Error:', e.message); }
    });
    ws.on('close', () => {
        if (ws.userId) run("UPDATE users SET status = 'offline', lastSeen = NOW() WHERE id = $1", [ws.userId]);
    });
});

console.log('🚀 SeendChat Server listo');
