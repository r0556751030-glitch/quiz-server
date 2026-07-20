// server.js
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
const { setActiveGame, pendingResponses } = require('./game/gameState');

// ===== הגדרות בסיסיות =====
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

// ===== יצירת אפליקציית Express =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ימות שולח את הנתונים כ-form (application/x-www-form-urlencoded)
app.use(cookieParser()); // נדרש כדי לקרוא את cookie ההתחברות ב-middleware/auth.js

// ===== יצירת שרת HTTP ושילוב Socket.io =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io); // כדי שנוכל לגשת ל-io מתוך כל route (req.app.get('io'))

// ===== תיקון ל-Render: ברירת המחדל של Node (5 שניות) קצרה בהרבה מזמן ה-hold
// הארוך שלנו בין שאלות, וגורמת ל-Render לסגור חיבורים תלויים "מוקדם מדי" -
// מה שנראה בטעות כניתוק שחקן. מגדילים בהרבה, הרבה מעבר לכל המתנה סבירה באירוע. =====
server.keepAliveTimeout = 15 * 60 * 1000; // 15 דקות
server.headersTimeout = server.keepAliveTimeout + 5000; // חייב להיות גדול מ-keepAliveTimeout (Node דורש זאת)

// ===== חיבור למסד הנתונים MongoDB =====
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ התחברות ל-MongoDB הצליחה');

    // איפוס "רוחות רפאים": בכל הפעלה מחדש של השרת, כל ה-pendingResponses
    // שהיו בזיכרון נעלמים - כך שאף שיחה לא יכולה להיות "פעילה" באמת כרגע.
    // כל active:true ששרד מהרצה קודמת הוא בהכרח נתון תקוע, ולכן מאפסים אותו.
    try {
      const result = await Player.updateMany({ active: true }, { $set: { active: false } });
      if (result.modifiedCount) {
        console.log(`🧹 אופסו ${result.modifiedCount} חיבורים "פעילים" תקועים מהרצה קודמת`);
      }
    } catch (resetErr) {
      console.error('❌ שגיאה באיפוס חיבורים תקועים:', resetErr.message);
    }

    // טעינת המשחק הפעיל (אם יש) לתוך המטמון בזיכרון - נחוץ כי gameState מתאפס בכל עליית שרת
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

// ===== נתיבים =====
app.use('/yemot', yemotRoutes);   // כאן ימות שולח: /yemot/api
app.use('/admin', authRoutes);    // /admin/login, /admin/register, /admin/logout, /admin/me - לא דורש התחברות
app.use('/admin', adminRoutes);   // שאר פעולות השליטה החיה - דורשות התחברות + בעלות על המשחק הפעיל
app.use('/games', gamesRoutes);   // ניהול "המשחקים שלי" - יצירה/עריכה/מחיקה/הפעלה/הפסקה

// ===== קבצים סטטיים - כולל index.html (עמוד הבית), admin-login.html, games.html, admin.html =====
app.use(express.static('public'));

// ===== ניהול חיבורי Socket.io (לדשבורד המנהל) =====
io.on('connection', (socket) => {
  console.log(`🖥️ דשבורד מנהל התחבר: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🖥️ דשבורד מנהל התנתק: ${socket.id}`);
  });
});

// ===== הפעלת השרת =====
server.listen(PORT, () => {
  console.log(`🚀 השרת רץ על פורט ${PORT}`);
});

// ===== מנגנון ניקוי תקופתי - שכבת הגנה נוספת מעל אירוע ה-close =====
// בודק כל 10 שניות אם חיבור שמוחזק (hold) כבר מת בפועל בצד הרשת (socket נהרס),
// גם אם מסיבה כלשהי אירוע ה-close לא נורה. מסמן את השחקן כמנותק בכל מקרה כזה.
setInterval(async () => {
  for (const [callId, item] of pendingResponses.entries()) {
    if (item.res.writableEnded || item.res.req.destroyed || item.res.req.socket?.destroyed) {
      pendingResponses.delete(callId);
      await Player.findOneAndUpdate({ callId }, { active: false });
      io.emit('playerDisconnected', { callId });
    }
  }
}, 10000);

module.exports = { app, server, io };
