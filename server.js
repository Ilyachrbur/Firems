const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');

// Создаем необходимые папки
const uploadsDir = path.join(__dirname, 'uploads');
const databaseDir = path.join(__dirname, 'database');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(databaseDir)) fs.mkdirSync(databaseDir);

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.random().toString(36).substr(2, 9) + '-' + file.originalname;
        cb(null, uniqueName);
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB максимум
});

// Инициализация БД
const db = new sqlite3.Database(path.join(databaseDir, 'firemess.db'));

// Создание таблиц
db.serialize(() => {
    // Пользователи
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        fullname TEXT,
        email TEXT,
        avatar TEXT,
        online BOOLEAN DEFAULT 0,
        last_seen DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Сообщения
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        sender_id TEXT,
        text TEXT,
        image TEXT,
        file TEXT,
        file_name TEXT,
        file_size INTEGER,
        time DATETIME,
        read BOOLEAN DEFAULT 0,
        edited BOOLEAN DEFAULT 0,
        deleted BOOLEAN DEFAULT 0
    )`);

    // Чаты
    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'private',
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Участники чатов
    db.run(`CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT,
        user_id TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id)
    )`);

    // Stories
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    )`);

    // Реакции
    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT,
        user_id TEXT,
        reaction TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id, reaction)
    )`);

    // Контакты
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        user_id TEXT,
        contact_id TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, contact_id)
    )`);

    // Звонки
    db.run(`CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        caller_id TEXT,
        receiver_id TEXT,
        type TEXT,
        status TEXT,
        start_time DATETIME,
        end_time DATETIME,
        duration INTEGER
    )`);

    // Создаем общего чата если его нет
    db.get("SELECT id FROM chats WHERE id = 'general'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO chats (id, name, type) VALUES ('general', '🔥 Общий чат', 'group')");
            
            // Добавляем тестовые сообщения
            const testMessages = [
                { id: uuidv4(), text: 'Добро пожаловать в FireMess! 🔥', time: new Date(Date.now() - 86400000) },
                { id: uuidv4(), text: 'Здесь собраны лучшие функции Telegram и Instagram', time: new Date(Date.now() - 82800000) },
                { id: uuidv4(), text: 'Отправляйте сообщения, фото, стикеры', time: new Date(Date.now() - 79200000) },
                { id: uuidv4(), text: 'Добавляйте stories и реагируйте на сообщения', time: new Date(Date.now() - 75600000) }
            ];
            
            testMessages.forEach(msg => {
                db.run(`INSERT INTO messages (id, chat_id, sender_id, text, time) VALUES (?, 'general', 'system', ?, ?)`,
                    [msg.id, msg.text, msg.time.toISOString()]);
            });
        }
    });
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Статические файлы
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(uploadsDir));

// Хранилище активных соединений
const clients = new Map(); // userId -> WebSocket

// WebSocket обработчик
wss.on('connection', (ws, req) => {
    console.log('🔌 Новое WebSocket соединение');
    let currentUser = null;

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('📨 Получено сообщение:', message.type);

            switch(message.type) {
                case 'auth':
                    await handleAuth(ws, message);
                    break;
                case 'message':
                    await handleMessage(message);
                    break;
                case 'typing':
                    handleTyping(message);
                    break;
                case 'read':
                    await handleRead(message);
                    break;
                case 'story':
                    await handleStory(message);
                    break;
                case 'reaction':
                    await handleReaction(message);
                    break;
                case 'edit':
                    await handleEdit(message);
                    break;
                case 'delete':
                    await handleDelete(message);
                    break;
                case 'call':
                    await handleCall(message);
                    break;
                default:
                    console.log('❓ Неизвестный тип сообщения:', message.type);
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            console.log(`🔴 Пользователь отключился: ${currentUser.username}`);
            clients.delete(currentUser.id);
            
            // Обновляем статус в БД
            db.run('UPDATE users SET online = 0, last_seen = ? WHERE id = ?', 
                [new Date().toISOString(), currentUser.id]);
            
            // Уведомляем всех
            broadcast({
                type: 'user_offline',
                userId: currentUser.id,
                username: currentUser.username,
                fullname: currentUser.fullname,
                last_seen: new Date()
            });
        }
    });

    async function handleAuth(ws, message) {
        const { userId, username, fullname, email } = message;
        
        // Сохраняем пользователя
        db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
            if (!user) {
                db.run(`INSERT INTO users (id, username, fullname, email, online, last_seen) 
                        VALUES (?, ?, ?, ?, 1, ?)`,
                    [userId, username, fullname || username, email || '', new Date().toISOString()]);
            } else {
                db.run('UPDATE users SET online = 1, last_seen = ? WHERE id = ?', 
                    [new Date().toISOString(), userId]);
            }
        });

        currentUser = { id: userId, username, fullname: fullname || username, email };
        clients.set(userId, ws);

        // Получаем список всех пользователей
        db.all('SELECT id, username, fullname, email, online, last_seen FROM users', (err, users) => {
            ws.send(JSON.stringify({
                type: 'auth_success',
                userId: userId,
                users: users || []
            }));
        });

        // Уведомляем всех
        broadcast({
            type: 'user_online',
            userId: userId,
            username: username,
            fullname: fullname || username
        }, userId);

        console.log(`✅ Пользователь авторизован: ${username}`);
    }

    async function handleMessage(message) {
        const { chatId, text, receiverId, image, file, fileName, fileSize } = message;
        const messageId = uuidv4();
        const time = new Date();

        // Сохраняем сообщение
        db.run(`INSERT INTO messages (id, chat_id, sender_id, text, image, file, file_name, file_size, time) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [messageId, chatId, currentUser.id, text, image, file, fileName, fileSize, time.toISOString()]);

        // Получаем информацию об отправителе
        db.get('SELECT username, fullname FROM users WHERE id = ?', [currentUser.id], (err, sender) => {
            const messageData = {
                type: 'new_message',
                id: messageId,
                chatId: chatId,
                senderId: currentUser.id,
                senderName: currentUser.username,
                senderFullname: sender?.fullname || currentUser.username,
                text: text,
                image: image,
                file: file,
                fileName: fileName,
                fileSize: fileSize,
                time: time,
                read: false
            };

            // Отправляем всем участникам чата
            db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId], (err, members) => {
                members?.forEach(member => {
                    if (clients.has(member.user_id) && member.user_id !== currentUser.id) {
                        clients.get(member.user_id).send(JSON.stringify(messageData));
                    }
                });
            });

            // Отправляем подтверждение отправителю
            if (clients.has(currentUser.id)) {
                clients.get(currentUser.id).send(JSON.stringify({
                    ...messageData,
                    type: 'message_sent'
                }));
            }
        });
    }

    function handleTyping(message) {
        const { chatId, receiverId, isTyping } = message;
        
        if (receiverId && clients.has(receiverId)) {
            clients.get(receiverId).send(JSON.stringify({
                type: 'typing',
                chatId: chatId,
                userId: currentUser.id,
                username: currentUser.username,
                isTyping: isTyping
            }));
        }
    }

    async function handleRead(message) {
        const { messageId } = message;
        
        db.run('UPDATE messages SET read = 1 WHERE id = ?', [messageId]);
        
        db.get('SELECT sender_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row && clients.has(row.sender_id)) {
                clients.get(row.sender_id).send(JSON.stringify({
                    type: 'message_read',
                    messageId: messageId,
                    readerId: currentUser.id
                }));
            }
        });
    }

    async function handleStory(message) {
        const { content, type } = message;
        const storyId = uuidv4();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        db.run(`INSERT INTO stories (id, user_id, content, type, created_at, expires_at) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [storyId, currentUser.id, content, type || 'text', now.toISOString(), expiresAt.toISOString()]);

        // Получаем информацию о пользователе
        db.get('SELECT username, fullname FROM users WHERE id = ?', [currentUser.id], (err, user) => {
            broadcast({
                type: 'new_story',
                id: storyId,
                userId: currentUser.id,
                username: user?.username || currentUser.username,
                fullname: user?.fullname || currentUser.fullname,
                content: content,
                type: type || 'text',
                time: now
            });
        });
    }

    async function handleReaction(message) {
        const { messageId, reaction } = message;

        db.run(`INSERT OR REPLACE INTO reactions (message_id, user_id, reaction) 
                VALUES (?, ?, ?)`,
            [messageId, currentUser.id, reaction]);

        db.get('SELECT sender_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row && clients.has(row.sender_id)) {
                clients.get(row.sender_id).send(JSON.stringify({
                    type: 'new_reaction',
                    messageId: messageId,
                    userId: currentUser.id,
                    username: currentUser.username,
                    reaction: reaction
                }));
            }
        });
    }

    async function handleEdit(message) {
        const { messageId, newText } = message;

        db.run('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', [newText, messageId]);

        db.get('SELECT sender_id, chat_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                // Уведомляем участников чата
                db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [row.chat_id], (err, members) => {
                    members?.forEach(member => {
                        if (clients.has(member.user_id) && member.user_id !== currentUser.id) {
                            clients.get(member.user_id).send(JSON.stringify({
                                type: 'message_edited',
                                messageId: messageId,
                                newText: newText
                            }));
                        }
                    });
                });
            }
        });
    }

    async function handleDelete(message) {
        const { messageId } = message;

        db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [messageId]);

        db.get('SELECT sender_id, chat_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [row.chat_id], (err, members) => {
                    members?.forEach(member => {
                        if (clients.has(member.user_id)) {
                            clients.get(member.user_id).send(JSON.stringify({
                                type: 'message_deleted',
                                messageId: messageId
                            }));
                        }
                    });
                });
            }
        });
    }

    async function handleCall(message) {
        const { receiverId, callType, type, callId, answer, candidate } = message;

        switch(type) {
            case 'offer':
                const newCallId = uuidv4();
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_offer',
                        callId: newCallId,
                        callerId: currentUser.id,
                        callerName: currentUser.username,
                        callerFullname: currentUser.fullname,
                        callType: callType
                    }));
                    
                    db.run(`INSERT INTO calls (id, caller_id, receiver_id, type, status, start_time) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [newCallId, currentUser.id, receiverId, callType, 'started', new Date().toISOString()]);
                }
                break;

            case 'answer':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_answer',
                        callId: callId,
                        answer: answer
                    }));
                }
                break;

            case 'candidate':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_candidate',
                        callId: callId,
                        candidate: candidate
                    }));
                }
                break;

            case 'end':
                const endTime = new Date();
                db.run(`UPDATE calls SET status = ?, end_time = ? WHERE id = ?`, 
                    ['ended', endTime.toISOString(), callId]);
                
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_ended',
                        callId: callId
                    }));
                }
                break;
        }
    }

    function broadcast(data, excludeUserId = null) {
        clients.forEach((client, userId) => {
            if (userId !== excludeUserId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
});

// REST API эндпоинты
app.get('/api/users', (req, res) => {
    db.all('SELECT id, username, fullname, email, online, last_seen FROM users', (err, users) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(users);
        }
    });
});

app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(`SELECT c.*, 
            (SELECT m.text FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message,
            (SELECT m.time FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message_time
            FROM chats c
            LEFT JOIN chat_members cm ON c.id = cm.chat_id
            WHERE c.id = 'general' OR cm.user_id = ?
            GROUP BY c.id
            ORDER BY last_message_time DESC`, [userId], (err, chats) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(chats || []);
        }
    });
});

app.get('/api/messages/:chatId', (req, res) => {
    const { chatId } = req.params;
    
    db.all(`SELECT m.*, u.username, u.fullname 
            FROM messages m 
            LEFT JOIN users u ON m.sender_id = u.id 
            WHERE m.chat_id = ? AND m.deleted = 0
            ORDER BY m.time ASC`, [chatId], (err, messages) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(messages || []);
        }
    });
});

app.post('/api/chats/create', (req, res) => {
    const { type, name, members } = req.body;
    const chatId = uuidv4();
    const now = new Date();

    db.run('INSERT INTO chats (id, name, type, created_at) VALUES (?, ?, ?, ?)',
        [chatId, name || null, type || 'private', now.toISOString()], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            // Добавляем участников
            const stmt = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
            members.forEach(memberId => {
                stmt.run(chatId, memberId, now.toISOString());
            });
            stmt.finalize();

            res.json({ success: true, chatId: chatId });
        }
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({
            success: true,
            filename: req.file.filename,
            path: fileUrl,
            size: req.file.        chat_id TEXT,
        sender_id TEXT,
        text TEXT,
        image TEXT,
        file TEXT,
        file_name TEXT,
        file_size INTEGER,
        time DATETIME,
        read BOOLEAN DEFAULT 0,
        edited BOOLEAN DEFAULT 0,
        deleted BOOLEAN DEFAULT 0
    )`);

    // Чаты
    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        type TEXT DEFAULT 'private',
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Участники чатов
    db.run(`CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT,
        user_id TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (chat_id, user_id)
    )`);

    // Stories
    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        type TEXT DEFAULT 'text',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
    )`);

    // Реакции
    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT,
        user_id TEXT,
        reaction TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user_id, reaction)
    )`);

    // Контакты
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        user_id TEXT,
        contact_id TEXT,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, contact_id)
    )`);

    // Звонки
    db.run(`CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        caller_id TEXT,
        receiver_id TEXT,
        type TEXT,
        status TEXT,
        start_time DATETIME,
        end_time DATETIME,
        duration INTEGER
    )`);

    // Создаем общего чата если его нет
    db.get("SELECT id FROM chats WHERE id = 'general'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO chats (id, name, type) VALUES ('general', '🔥 Общий чат', 'group')");
            
            // Добавляем тестовые сообщения
            const testMessages = [
                { id: uuidv4(), text: 'Добро пожаловать в FireMess! 🔥', time: new Date(Date.now() - 86400000) },
                { id: uuidv4(), text: 'Здесь собраны лучшие функции Telegram и Instagram', time: new Date(Date.now() - 82800000) },
                { id: uuidv4(), text: 'Отправляйте сообщения, фото, стикеры', time: new Date(Date.now() - 79200000) },
                { id: uuidv4(), text: 'Добавляйте stories и реагируйте на сообщения', time: new Date(Date.now() - 75600000) }
            ];
            
            testMessages.forEach(msg => {
                db.run(`INSERT INTO messages (id, chat_id, sender_id, text, time) VALUES (?, 'general', 'system', ?, ?)`,
                    [msg.id, msg.text, msg.time.toISOString()]);
            });
        }
    });
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Статические файлы
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(uploadsDir));

// Хранилище активных соединений
const clients = new Map(); // userId -> WebSocket

// WebSocket обработчик
wss.on('connection', (ws, req) => {
    console.log('🔌 Новое WebSocket соединение');
    let currentUser = null;

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('📨 Получено сообщение:', message.type);

            switch(message.type) {
                case 'auth':
                    await handleAuth(ws, message);
                    break;
                case 'message':
                    await handleMessage(message);
                    break;
                case 'typing':
                    handleTyping(message);
                    break;
                case 'read':
                    await handleRead(message);
                    break;
                case 'story':
                    await handleStory(message);
                    break;
                case 'reaction':
                    await handleReaction(message);
                    break;
                case 'edit':
                    await handleEdit(message);
                    break;
                case 'delete':
                    await handleDelete(message);
                    break;
                case 'call':
                    await handleCall(message);
                    break;
                default:
                    console.log('❓ Неизвестный тип сообщения:', message.type);
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            console.log(`🔴 Пользователь отключился: ${currentUser.username}`);
            clients.delete(currentUser.id);
            
            // Обновляем статус в БД
            db.run('UPDATE users SET online = 0, last_seen = ? WHERE id = ?', 
                [new Date().toISOString(), currentUser.id]);
            
            // Уведомляем всех
            broadcast({
                type: 'user_offline',
                userId: currentUser.id,
                username: currentUser.username,
                fullname: currentUser.fullname,
                last_seen: new Date()
            });
        }
    });

    async function handleAuth(ws, message) {
        const { userId, username, fullname, email } = message;
        
        // Сохраняем пользователя
        db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
            if (!user) {
                db.run(`INSERT INTO users (id, username, fullname, email, online, last_seen) 
                        VALUES (?, ?, ?, ?, 1, ?)`,
                    [userId, username, fullname || username, email || '', new Date().toISOString()]);
            } else {
                db.run('UPDATE users SET online = 1, last_seen = ? WHERE id = ?', 
                    [new Date().toISOString(), userId]);
            }
        });

        currentUser = { id: userId, username, fullname: fullname || username, email };
        clients.set(userId, ws);

        // Получаем список всех пользователей
        db.all('SELECT id, username, fullname, email, online, last_seen FROM users', (err, users) => {
            ws.send(JSON.stringify({
                type: 'auth_success',
                userId: userId,
                users: users || []
            }));
        });

        // Уведомляем всех
        broadcast({
            type: 'user_online',
            userId: userId,
            username: username,
            fullname: fullname || username
        }, userId);

        console.log(`✅ Пользователь авторизован: ${username}`);
    }

    async function handleMessage(message) {
        const { chatId, text, receiverId, image, file, fileName, fileSize } = message;
        const messageId = uuidv4();
        const time = new Date();

        // Сохраняем сообщение
        db.run(`INSERT INTO messages (id, chat_id, sender_id, text, image, file, file_name, file_size, time) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [messageId, chatId, currentUser.id, text, image, file, fileName, fileSize, time.toISOString()]);

        // Получаем информацию об отправителе
        db.get('SELECT username, fullname FROM users WHERE id = ?', [currentUser.id], (err, sender) => {
            const messageData = {
                type: 'new_message',
                id: messageId,
                chatId: chatId,
                senderId: currentUser.id,
                senderName: currentUser.username,
                senderFullname: sender?.fullname || currentUser.username,
                text: text,
                image: image,
                file: file,
                fileName: fileName,
                fileSize: fileSize,
                time: time,
                read: false
            };

            // Отправляем всем участникам чата
            db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId], (err, members) => {
                members?.forEach(member => {
                    if (clients.has(member.user_id) && member.user_id !== currentUser.id) {
                        clients.get(member.user_id).send(JSON.stringify(messageData));
                    }
                });
            });

            // Отправляем подтверждение отправителю
            if (clients.has(currentUser.id)) {
                clients.get(currentUser.id).send(JSON.stringify({
                    ...messageData,
                    type: 'message_sent'
                }));
            }
        });
    }

    function handleTyping(message) {
        const { chatId, receiverId, isTyping } = message;
        
        if (receiverId && clients.has(receiverId)) {
            clients.get(receiverId).send(JSON.stringify({
                type: 'typing',
                chatId: chatId,
                userId: currentUser.id,
                username: currentUser.username,
                isTyping: isTyping
            }));
        }
    }

    async function handleRead(message) {
        const { messageId } = message;
        
        db.run('UPDATE messages SET read = 1 WHERE id = ?', [messageId]);
        
        db.get('SELECT sender_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row && clients.has(row.sender_id)) {
                clients.get(row.sender_id).send(JSON.stringify({
                    type: 'message_read',
                    messageId: messageId,
                    readerId: currentUser.id
                }));
            }
        });
    }

    async function handleStory(message) {
        const { content, type } = message;
        const storyId = uuidv4();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        db.run(`INSERT INTO stories (id, user_id, content, type, created_at, expires_at) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [storyId, currentUser.id, content, type || 'text', now.toISOString(), expiresAt.toISOString()]);

        // Получаем информацию о пользователе
        db.get('SELECT username, fullname FROM users WHERE id = ?', [currentUser.id], (err, user) => {
            broadcast({
                type: 'new_story',
                id: storyId,
                userId: currentUser.id,
                username: user?.username || currentUser.username,
                fullname: user?.fullname || currentUser.fullname,
                content: content,
                type: type || 'text',
                time: now
            });
        });
    }

    async function handleReaction(message) {
        const { messageId, reaction } = message;

        db.run(`INSERT OR REPLACE INTO reactions (message_id, user_id, reaction) 
                VALUES (?, ?, ?)`,
            [messageId, currentUser.id, reaction]);

        db.get('SELECT sender_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row && clients.has(row.sender_id)) {
                clients.get(row.sender_id).send(JSON.stringify({
                    type: 'new_reaction',
                    messageId: messageId,
                    userId: currentUser.id,
                    username: currentUser.username,
                    reaction: reaction
                }));
            }
        });
    }

    async function handleEdit(message) {
        const { messageId, newText } = message;

        db.run('UPDATE messages SET text = ?, edited = 1 WHERE id = ?', [newText, messageId]);

        db.get('SELECT sender_id, chat_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                // Уведомляем участников чата
                db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [row.chat_id], (err, members) => {
                    members?.forEach(member => {
                        if (clients.has(member.user_id) && member.user_id !== currentUser.id) {
                            clients.get(member.user_id).send(JSON.stringify({
                                type: 'message_edited',
                                messageId: messageId,
                                newText: newText
                            }));
                        }
                    });
                });
            }
        });
    }

    async function handleDelete(message) {
        const { messageId } = message;

        db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [messageId]);

        db.get('SELECT sender_id, chat_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [row.chat_id], (err, members) => {
                    members?.forEach(member => {
                        if (clients.has(member.user_id)) {
                            clients.get(member.user_id).send(JSON.stringify({
                                type: 'message_deleted',
                                messageId: messageId
                            }));
                        }
                    });
                });
            }
        });
    }

    async function handleCall(message) {
        const { receiverId, callType, type, callId, answer, candidate } = message;

        switch(type) {
            case 'offer':
                const newCallId = uuidv4();
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_offer',
                        callId: newCallId,
                        callerId: currentUser.id,
                        callerName: currentUser.username,
                        callerFullname: currentUser.fullname,
                        callType: callType
                    }));
                    
                    db.run(`INSERT INTO calls (id, caller_id, receiver_id, type, status, start_time) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [newCallId, currentUser.id, receiverId, callType, 'started', new Date().toISOString()]);
                }
                break;

            case 'answer':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_answer',
                        callId: callId,
                        answer: answer
                    }));
                }
                break;

            case 'candidate':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_candidate',
                        callId: callId,
                        candidate: candidate
                    }));
                }
                break;

            case 'end':
                const endTime = new Date();
                db.run(`UPDATE calls SET status = ?, end_time = ? WHERE id = ?`, 
                    ['ended', endTime.toISOString(), callId]);
                
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_ended',
                        callId: callId
                    }));
                }
                break;
        }
    }

    function broadcast(data, excludeUserId = null) {
        clients.forEach((client, userId) => {
            if (userId !== excludeUserId && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
});

// REST API эндпоинты
app.get('/api/users', (req, res) => {
    db.all('SELECT id, username, fullname, email, online, last_seen FROM users', (err, users) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(users);
        }
    });
});

app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(`SELECT c.*, 
            (SELECT m.text FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message,
            (SELECT m.time FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message_time
            FROM chats c
            LEFT JOIN chat_members cm ON c.id = cm.chat_id
            WHERE c.id = 'general' OR cm.user_id = ?
            GROUP BY c.id
            ORDER BY last_message_time DESC`, [userId], (err, chats) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(chats || []);
        }
    });
});

app.get('/api/messages/:chatId', (req, res) => {
    const { chatId } = req.params;
    
    db.all(`SELECT m.*, u.username, u.fullname 
            FROM messages m 
            LEFT JOIN users u ON m.sender_id = u.id 
            WHERE m.chat_id = ? AND m.deleted = 0
            ORDER BY m.time ASC`, [chatId], (err, messages) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(messages || []);
        }
    });
});

app.post('/api/chats/create', (req, res) => {
    const { type, name, members } = req.body;
    const chatId = uuidv4();
    const now = new Date();

    db.run('INSERT INTO chats (id, name, type, created_at) VALUES (?, ?, ?, ?)',
        [chatId, name || null, type || 'private', now.toISOString()], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            // Добавляем участников
            const stmt = db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)');
            members.forEach(memberId => {
                stmt.run(chatId, memberId, now.toISOString());
            });
            stmt.finalize();

            res.json({ success: true, chatId: chatId });
        }
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({
            success: true,
            filename: req.file.filename,
            path: fileUrl,
            size: req.file.size
        });
    } else {
        res.status(400).json({ error: 'No file uploaded' });
    }
});

app.get('/api/stories', (req, res) => {
    db.all(`SELECT s.*, u.username, u.fullname 
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at > datetime('now')
            ORDER BY s.created_at DESC`, (err, stories) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(stories || []);
        }
    });
});

// Для всех остальных запросов отдаем index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🔥 FireMess сервер запущен!`);
    console.log(`📱 Локальный адрес: http://localhost:${PORT}`);
    console.log(`🌐 Для Render.com: https://firemess.onrender.com`);
    console.log(`📡 WebSocket: ws://localhost:${PORT} (или wss:// для Render)`);
    console.log(`\n✅ Все готово к работе!\n`);
});
