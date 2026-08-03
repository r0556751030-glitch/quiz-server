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
const { activateGame, CONFIG, getStaleCallIds, forget, getTotalConnectionCount } = require('./game/gameState');

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
            // שלב 4: כמה משחקים יכולים להיות isActive:true בו-זמנית - מפעילים state
            // טרי (idle) לכל אחד מהם מחדש אחרי restart של השרת (state בזיכרון אבד).
            const activeGames = await Game.find({ isActive: true });
            if (activeGames.length) {
                activeGames.forEach((g) => activateGame(g));
                console.log(`🎮 ${activeGames.length} משחקים פעילים: ${activeGames.map(g => g.name).join(', ')}`);
            } else {
                console.log('ℹ️ אין משחקים פעילים כרגע - יש להתחבר וליצור/להפעיל משחק דרך /games.html');
            }
        } catch (gameErr) {
            console.error('❌ שגיאה בטעינת המשחקים הפעילים:', gameErr.message);
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

    // שלב 4: הדשבורד מצטרף ל-room של המשחק הספציפי שהוא מנהל, כדי לא לקבל
    // עדכונים חיים ממשחקים אחרים שרצים בו-זמנית. נקרא מה-frontend מיד אחרי
    // שהוא יודע איזה gameId הוא מציג (מה-URL).
    socket.on('joinGame', (gameId) => {
        if (!gameId) return;
        socket.join(`game:${gameId}`);
    });

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
    const totalActive = getTotalConnectionCount();
    // מודפס רק כשיש חיבורים חיים - כדי לא להציף את הלוגים כשאין משחק פעיל בכלל
    if (totalActive > 0 || staleCallIds.length > 0) {
        console.log(`[SWEEP] totalActive=${totalActive} staleFound=${staleCallIds.length}`);
    }
    for (const callId of staleCallIds) {
        forget(callId);
        try {
            const player = await Player.findOneAndUpdate({ callId }, { active: false });
            if (player) {
                io.to(`game:${player.game}`).emit('playerDisconnected', { callId });
            }
            console.log(`[SWEEP] disconnected callId=${callId}`);
        } catch (err) {
            console.error('❌ שגיאה בניתוק שחקן תקוע:', err.message);
        }
    }
}, CONFIG.SWEEP_INTERVAL_MS);

// Keep-alive ping — מונע כיבוי של Render Free Tier
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
        fetch(process.env.RENDER_EXTERNAL_URL + '/admin/me')
            .catch(() => { }); // שגיאה בשקט
    }, 10 * 60 * 1000); // כל 10 דקות
}
module.exports = { app, server, io };