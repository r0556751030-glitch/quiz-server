const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const yemotRoutes = require('./routes/yemotRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const gamesRoutes = require('./routes/gamesRoutes');

const Player = require('./models/Player');
const Game = require('./models/Game');
const { setActiveGame, CONFIG, getStaleCallIds, forget } = require('./game/gameState');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io);

// אין יותר hold על ה-response (short-polling) - כל בקשה נענית תוך שניות
// בודדות, לכן אין צורך ב-keepAliveTimeout ארוך כמו בארכיטקטורה הקודמת.

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ התחברות ל-MongoDB הצליחה');

        try {
            const result = await Player.updateMany({ active: true }, { $set: { active: false } });
            if (result.modifiedCount) {
                console.log(`🧹 אופסו ${result.modifiedCount} חיבורים "פעילים" תקועים מהרצה קודמת`);
            }
        } catch (resetErr) {
            console.error('❌ שגיאה באיפוס חיבורים תקועים:', resetErr.message);
        }

        try {
            const activeGame = await Game.findOne({ isActive: true });
            if (activeGame) {
                setActiveGame(activeGame);
                console.log(`🎮 משחק פעיל: ${activeGame.name}`);
            } else {
                console.log('ℹ️ אין משחק פעיל כרגע - יש להתחבר וליצור/להפעיל משחק דרך /games.html');
            }
        } catch (gameErr) {
            console.error('❌ שגיאה בטעינת המשחק הפעיל:', gameErr.message);
        }
    })
    .catch((err) => {
        console.error('❌ שגיאה בהתחברות ל-MongoDB:', err.message);
        process.exit(1);
    });

mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ החיבור ל-MongoDB נותק');
});

app.use('/yemot', yemotRoutes);
app.use('/admin', authRoutes);
app.use('/admin', adminRoutes);
app.use('/games', gamesRoutes);

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(`🖥️ דשבורד מנהל התחבר: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`🖥️ דשבורד מנהל התנתק: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 השרת רץ על פורט ${PORT}`);
});

// ===== סריקת ניתוקים תקופתית - מבוססת lastSeen בלבד (short-polling) =====
setInterval(async () => {
    const staleCallIds = getStaleCallIds();
    for (const callId of staleCallIds) {
        forget(callId);
        try {
            await Player.findOneAndUpdate({ callId }, { active: false });
            io.emit('playerDisconnected', { callId });
        } catch (err) {
            console.error('❌ שגיאה בניתוק שחקן תקוע:', err.message);
        }
    }
}, CONFIG.SWEEP_INTERVAL_MS);

module.exports = { app, server, io };