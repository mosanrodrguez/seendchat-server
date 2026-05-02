const { Pool } = require('pg');

// PEGA AQUÍ TU INTERNAL DATABASE URL DE RENDER
const DATABASE_URL = 'postgresql://seendchat_server_user:9CExt9NG131eQ7BBj8hmjw181NRyLDxR@dpg-d7r014vavr4c73f8gd90-a/seendchat_server';

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                phoneNumber TEXT UNIQUE NOT NULL,
                username TEXT UNIQUE,
                fullName TEXT,
                info TEXT DEFAULT '¡Hola! Estoy usando Seend.',
                photoUrl TEXT,
                status TEXT DEFAULT 'offline',
                lastSeen TIMESTAMP,
                createdAt TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS privacy_settings (
                userId TEXT PRIMARY KEY REFERENCES users(id),
                photo TEXT DEFAULT 'Todos',
                phone TEXT DEFAULT 'Mis contactos',
                info TEXT DEFAULT 'Todos',
                username TEXT DEFAULT 'Todos',
                lastSeen TEXT DEFAULT 'Todos',
                online TEXT DEFAULT 'Todos',
                addToGroups TEXT DEFAULT 'Todos',
                findByUsername TEXT DEFAULT 'Todos'
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY,
                userId TEXT NOT NULL REFERENCES users(id),
                createdAt TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS verification_codes (
                phoneNumber TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                telegramChatId TEXT,
                expiresAt TIMESTAMP NOT NULL,
                attempts INTEGER DEFAULT 0
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                senderId TEXT NOT NULL,
                senderName TEXT NOT NULL,
                receiverId TEXT NOT NULL,
                text TEXT,
                imageUrl TEXT,
                videoUrl TEXT,
                voiceUrl TEXT,
                fileUrl TEXT,
                fileName TEXT,
                fileSize BIGINT,
                imageSize BIGINT,
                voiceDuration INTEGER,
                replyTo TEXT,
                replyText TEXT,
                status TEXT DEFAULT 'sent',
                createdAt TIMESTAMP DEFAULT NOW(),
                isGroup INTEGER DEFAULT 0,
                groupId TEXT,
                isSystemMessage INTEGER DEFAULT 0,
                deletedForReceiver INTEGER DEFAULT 0,
                deletedForAll INTEGER DEFAULT 0
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS groups_table (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                photoUrl TEXT,
                inviteLink TEXT,
                createdBy TEXT NOT NULL REFERENCES users(id),
                createdAt TIMESTAMP DEFAULT NOW()
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS group_members (
                groupId TEXT NOT NULL REFERENCES groups_table(id),
                userId TEXT NOT NULL REFERENCES users(id),
                role TEXT DEFAULT 'member',
                joinedAt TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (groupId, userId)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS group_permissions (
                groupId TEXT PRIMARY KEY REFERENCES groups_table(id),
                sendMessages INTEGER DEFAULT 1,
                sendMedia INTEGER DEFAULT 1,
                addMembers INTEGER DEFAULT 0,
                editInfo INTEGER DEFAULT 0,
                adminSendMessages INTEGER DEFAULT 1,
                adminSendMedia INTEGER DEFAULT 1,
                adminAddMembers INTEGER DEFAULT 1,
                adminEditInfo INTEGER DEFAULT 1
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS banned_users (
                groupId TEXT NOT NULL REFERENCES groups_table(id),
                userId TEXT NOT NULL REFERENCES users(id),
                bannedAt TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (groupId, userId)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS blocked_users (
                userId TEXT NOT NULL REFERENCES users(id),
                blockedUserId TEXT NOT NULL REFERENCES users(id),
                blockedAt TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (userId, blockedUserId)
            )
        `);

        console.log('✅ PostgreSQL inicializado');
    } finally {
        client.release();
    }
}

async function run(query, params = []) {
    const client = await pool.connect();
    try { await client.query(query, params); }
    finally { client.release(); }
}

async function get(query, params = []) {
    const client = await pool.connect();
    try { const result = await client.query(query, params); return result.rows[0] || null; }
    finally { client.release(); }
}

async function all(query, params = []) {
    const client = await pool.connect();
    try { const result = await client.query(query, params); return result.rows; }
    finally { client.release(); }
}

module.exports = { pool, initDatabase, run, get, all };
