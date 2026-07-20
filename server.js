// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const yemotRoutes = require('./routes/yemotRoutes');
const adminRoutes = require('./routes/adminRoutes');
const authRoutes = require('./routes/authRoutes');
const Player = require('./models/Player');
const Game = require('./models/Game');

const { setActiveGame, pendingResponses, lastSeen } = require('./game/gameState');

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

if (!process.env.SUPER_ADMIN_PASSWORD) console.warn('⚠️ לא הוגדר SUPER_ADMIN_PASSWORD');
if (!process.env.JWT_SECRET) console.warn('⚠️ לא הוגדר JWT_SECRET');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.set('io', io);

mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ התחברות ל-MongoDB הצליחה');

        try {
            const result = await Player.updateMany({ active: true }, { $set: { active: false } });
            if (result.modifiedCount) console.log(`🧹 אופסו ${result.modifiedCount} חיבורים "פעילים" תקועים`);
        } catch (resetErr) {
            console.error('❌ שגיאה באיפוס חיבורים תקועים:', resetErr.message);
        }

        try {
            const activeGame = await Game.findOne({ isActive: true });
            if (activeGame) {
                setActiveGame(activeGame);
                console.log(`🎮 משחק פעיל: ${activeGame.name}`);
            }
        } catch (gameErr) {
            console.error('❌ שגיאה בטעינת המשחק הפעיל:', gameErr.message);
        }
    })
    .catch((err) => {
        console.error('❌ שגיאה בהתחברות ל-MongoDB:', err.message);
        process.exit(1);
    });

mongoose.connection.on('disconnected', () => console.warn('⚠️ החיבור ל-MongoDB נותק'));

app.use('/yemot', yemotRoutes);
app.use('/admin', authRoutes);
app.use('/admin', adminRoutes);
app.use(express.static('public'));

app.get('/', (req, res) => res.send('שרת חידון הקליקרים פועל 🚀'));

io.on('connection', (socket) => {
    console.log(`🖥️ דשבורד מנהל התחבר: ${socket.id}`);
    socket.on('disconnect', () => console.log(`🖥️ דשבורד מנהל התנתק: ${socket.id}`));
});

// סריקה תקופתית מבוססת זמן (Time-based sweep)
const STALE_MS = 30000; // 30 שניות ללא פנייה = השיחה התנתקה
setInterval(async () => {
    const now = Date.now();
    for (const [callId, ts] of lastSeen.entries()) {
        if (now - ts > STALE_MS) {
            lastSeen.delete(callId);
            pendingResponses.delete(callId);

            try {
                const p = await Player.findOneAndUpdate({ callId, active: true }, { active: false });
                if (p) {
                    io.emit('playerDisconnected', { callId });
                }
            } catch (err) {
                console.error('שגיאה בעדכון שחקן מנותק בסריקת הזמן:', err);
            }
        }
    }
}, 5000);

server.listen(PORT, () => console.log(`🚀 השרת רץ על פורט ${PORT}`));

module.exports = { app, server, io };