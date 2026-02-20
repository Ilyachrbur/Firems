const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');

// Создаем папки
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./database')) fs.mkdirSync('./database');

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Инициализация БД
const db = new sqlite3.Database('./database/firemess.db');

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        fullname TEXT,
        email TEXT,
        password TEXT,
        avatar TEXT,
        online BOOLEAN DEFAULT 0,
        last_seen DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        sender_id TEXT,
        receiver_id TEXT,
        text TEXT,
        image TEXT,
        file TEXT,
        time DATETIME,
        read BOOLEAN DEFAULT 0,
        edited BOOLEAN DEFAULT 0,
        deleted BOOLEAN DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        type TEXT,
        name TEXT,
        avatar TEXT,
        created_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT,
        user_id TEXT,
        joined_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        content TEXT,
        type TEXT,
        created_at DATETIME,
        expires_at DATETIME
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        message_id TEXT,
        user_id TEXT,
        reaction TEXT,
        created_at DATETIME
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        user_id TEXT,
        contact_id TEXT,
        added_at DATETIME,
        UNIQUE(user_id, contact_id)
    )`);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище активных соединений
const clients = new Map(); // userId -> WebSocket
const users = new Map(); // userId -> userData
const chats = new Map(); // chatId -> chatData

// WebSocket обработчик
wss.on('connection', (ws, req) => {
    let currentUser = null;
    
    console.log('Новое WebSocket соединение');

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('Получено сообщение:', message.type);

            switch(message.type) {
                case 'auth':
                    await handleAuth(ws, message);
                    break;
                case 'message':
                    await handleMessage(ws, message);
                    break;
                case 'typing':
                    handleTyping(message);
                    break;
                case 'read':
                    await handleRead(message);
                    break;
                case 'call':
                    await handleCall(ws, message);
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
                case 'file':
                    await handleFile(message);
                    break;
                default:
                    console.log('Неизвестный тип сообщения:', message.type);
            }
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
        }
    });

    ws.on('close', () => {
        if (currentUser) {
            clients.delete(currentUser.id);
            users.set(currentUser.id, { ...currentUser, online: false, last_seen: new Date() });
            
            // Обновляем статус в БД
            db.run('UPDATE users SET online = 0, last_seen = ? WHERE id = ?', [new Date().toISOString(), currentUser.id]);
            
            // Уведомляем всех о выходе пользователя
            broadcast({
                type: 'user_offline',
                userId: currentUser.id,
                username: currentUser.username,
                last_seen: new Date()
            }, currentUser.id);
        }
    });

    async function handleAuth(ws, message) {
        const { userId, username, fullname, email } = message;
        
        // Сохраняем пользователя в БД
        db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
            if (!user) {
                // Новый пользователь
                db.run('INSERT INTO users (id, username, fullname, email, online, last_seen) VALUES (?, ?, ?, ?, 1, ?)',
                    [userId, username, fullname, email, new Date().toISOString()]);
            } else {
                // Обновляем существующего
                db.run('UPDATE users SET online = 1, last_seen = ? WHERE id = ?', [new Date().toISOString(), userId]);
            }
        });

        currentUser = { id: userId, username, fullname, email, online: true };
        clients.set(userId, ws);
        users.set(userId, currentUser);

        // Отправляем подтверждение
        ws.send(JSON.stringify({
            type: 'auth_success',
            userId: userId,
            users: Array.from(users.values())
        }));

        // Уведомляем всех о новом пользователе
        broadcast({
            type: 'user_online',
            userId: userId,
            username: username,
            fullname: fullname
        }, userId);
    }

    async function handleMessage(ws, message) {
        const { chatId, text, receiverId, image, file } = message;
        const messageId = uuidv4();
        const time = new Date();

        // Сохраняем сообщение в БД
        db.run(`INSERT INTO messages (id, chat_id, sender_id, receiver_id, text, image, file, time) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [messageId, chatId, currentUser.id, receiverId, text, image, file, time.toISOString()]);

        const messageData = {
            type: 'new_message',
            id: messageId,
            chatId: chatId,
            senderId: currentUser.id,
            senderName: currentUser.username,
            senderFullname: currentUser.fullname,
            text: text,
            image: image,
            file: file,
            time: time,
            read: false
        };

        // Отправляем получателю
        if (receiverId && clients.has(receiverId)) {
            clients.get(receiverId).send(JSON.stringify(messageData));
        }

        // Отправляем обратно отправителю для подтверждения
        ws.send(JSON.stringify({ ...messageData, type: 'message_sent' }));
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
        const { messageId, chatId } = message;
        
        db.run('UPDATE messages SET read = 1 WHERE id = ?', [messageId]);
        
        // Уведомляем отправителя о прочтении
        db.get('SELECT sender_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row && clients.has(row.sender_id)) {
                clients.get(row.sender_id).send(JSON.stringify({
                    type: 'message_read',
                    messageId: messageId,
                    chatId: chatId,
                    userId: currentUser.id
                }));
            }
        });
    }

    async function handleCall(ws, message) {
        const { receiverId, type, callType } = message; // type: 'offer', 'answer', 'candidate', 'end'
        const callId = uuidv4();

        switch(type) {
            case 'offer':
                const offer = {
                    type: 'call_offer',
                    callId: callId,
                    callerId: currentUser.id,
                    callerName: currentUser.username,
                    callerFullname: currentUser.fullname,
                    callType: callType // 'audio' или 'video'
                };
                
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify(offer));
                    
                    // Сохраняем в БД
                    db.run(`INSERT INTO calls (id, caller_id, receiver_id, type, status, start_time) 
                            VALUES (?, ?, ?, ?, ?, ?)`,
                        [callId, currentUser.id, receiverId, callType, 'started', new Date().toISOString()]);
                }
                break;

            case 'answer':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_answer',
                        callId: message.callId,
                        answer: message.answer
                    }));
                }
                break;

            case 'candidate':
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_candidate',
                        callId: message.callId,
                        candidate: message.candidate
                    }));
                }
                break;

            case 'end':
                const endTime = new Date();
                // Обновляем запись звонка
                db.run(`UPDATE calls SET status = ?, end_time = ? WHERE id = ?`, 
                    ['ended', endTime.toISOString(), message.callId]);
                
                if (clients.has(receiverId)) {
                    clients.get(receiverId).send(JSON.stringify({
                        type: 'call_ended',
                        callId: message.callId
                    }));
                }
                break;
        }
    }

    async function handleStory(message) {
        const { content, type } = message; // type: 'text', 'image', 'video'
        const storyId = uuidv4();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 часа

        db.run(`INSERT INTO stories (id, user_id, content, type, created_at, expires_at) 
                VALUES (?, ?, ?, ?, ?, ?)`,
            [storyId, currentUser.id, content, type, now.toISOString(), expiresAt.toISOString()]);

        // Рассылаем всем подписчикам
        broadcast({
            type: 'new_story',
            id: storyId,
            userId: currentUser.id,
            username: currentUser.username,
            fullname: currentUser.fullname,
            content: content,
            type: type,
            time: now
        });
    }

    async function handleReaction(message) {
        const { messageId, reaction } = message;
        const now = new Date();

        // Сохраняем реакцию
        db.run(`INSERT OR REPLACE INTO reactions (message_id, user_id, reaction, created_at) 
                VALUES (?, ?, ?, ?)`,
            [messageId, currentUser.id, reaction, now.toISOString()]);

        // Уведомляем автора сообщения
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

        // Уведомляем участников чата
        db.get('SELECT sender_id, receiver_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                if (clients.has(row.receiver_id)) {
                    clients.get(row.receiver_id).send(JSON.stringify({
                        type: 'message_edited',
                        messageId: messageId,
                        newText: newText
                    }));
                }
            }
        });
    }

    async function handleDelete(message) {
        const { messageId } = message;

        db.run('UPDATE messages SET deleted = 1 WHERE id = ?', [messageId]);

        db.get('SELECT sender_id, receiver_id FROM messages WHERE id = ?', [messageId], (err, row) => {
            if (row) {
                if (clients.has(row.receiver_id)) {
                    clients.get(row.receiver_id).send(JSON.stringify({
                        type: 'message_deleted',
                        messageId: messageId
                    }));
                }
            }
        });
    }

    function handleFile(message) {
        const { receiverId, fileData, fileName, fileSize } = message;
        
        if (clients.has(receiverId)) {
            clients.get(receiverId).send(JSON.stringify({
                type: 'file_transfer',
                senderId: currentUser.id,
                senderName: currentUser.username,
                fileData: fileData,
                fileName: fileName,
                fileSize: fileSize,
                time: new Date()
            }));
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

// HTTP endpoints для REST API
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Загрузка файлов
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (req.file) {
        res.json({
            success: true,
            filename: req.file.filename,
            path: `/uploads/${req.file.filename}`
        });
    } else {
        res.status(400).json({ error: 'No file uploaded' });
    }
});

// Получение истории сообщений
app.get('/api/messages/:chatId', (req, res) => {
    const { chatId } = req.params;
    
    db.all(`SELECT m.*, u.username, u.fullname 
            FROM messages m 
            JOIN users u ON m.sender_id = u.id 
            WHERE m.chat_id = ? 
            ORDER BY m.time ASC`, [chatId], (err, messages) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(messages);
        }
    });
});

// Получение списка пользователей
app.get('/api/users', (req, res) => {
    db.all('SELECT id, username, fullname, email, online, last_seen FROM users', (err, users) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(users);
        }
    });
});

// Получение списка чатов пользователя
app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(`SELECT c.*, 
            (SELECT m.text FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message,
            (SELECT m.time FROM messages m WHERE m.chat_id = c.id ORDER BY m.time DESC LIMIT 1) as last_message_time
            FROM chats c
            JOIN chat_members cm ON c.id = cm.chat_id
            WHERE cm.user_id = ?
            ORDER BY last_message_time DESC`, [userId], (err, chats) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(chats);
        }
    });
});

// Создание чата
app.post('/api/chats/create', (req, res) => {
    const { type, name, members } = req.body;
    const chatId = uuidv4();
    const now = new Date();

    db.run('INSERT INTO chats (id, type, name, created_at) VALUES (?, ?, ?, ?)',
        [chatId, type, name || null, now.toISOString()], (err) => {
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

// Получение stories
app.get('/api/stories', (req, res) => {
    db.all(`SELECT s.*, u.username, u.fullname 
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at > datetime('now')
            ORDER BY s.created_at DESC`, (err, stories) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(stories);
        }
    });
});

// Добавление контакта
app.post('/api/contacts/add', (req, res) => {
    const { userId, contactId } = req.body;
    const now = new Date();

    db.run('INSERT OR IGNORE INTO contacts (user_id, contact_id, added_at) VALUES (?, ?, ?)',
        [userId, contactId, now.toISOString()], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true });
        }
    });
});

// Получение контактов пользователя
app.get('/api/contacts/:userId', (req, res) => {
    const { userId } = req.params;
    
    db.all(`SELECT u.* FROM users u
            JOIN contacts c ON u.id = c.contact_id
            WHERE c.user_id = ?`, [userId], (err, contacts) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(contacts);
        }
    });
});

// Статика для загруженных файлов
app.use('/uploads', express.static('uploads'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🔥 FireMess сервер запущен на http://localhost:${PORT}`);
    console.log(`📱 WebSocket сервер запущен на ws://localhost:${PORT}`);
});
