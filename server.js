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
const { setActiveGame } = require('./game/gameState');

// ===== הגדרות בסיסיות =====
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

if (!process.env.SUPER_ADMIN_PASSWORD) {
  console.warn('⚠️ לא הוגדר SUPER_ADMIN_PASSWORD ב-.env - התחברות כמנהל-על לא תעבוד');
}
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ לא הוגדר JWT_SECRET ב-.env - נעשה שימוש בברירת מחדל לא בטוחה');
}

// ===== יצירת אפליקציית Express =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ימות שולח את הנתונים כ-form (application/x-www-form-urlencoded)
app.use(cookieParser());

// ===== יצירת שרת HTTP ושילוב Socket.io =====
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
app.set('io', io); // כדי שנוכל לגשת ל-io מתוך כל route (req.app.get('io'))

// ===== חיבור למסד הנתונים MongoDB =====
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ התחברות ל-MongoDB הצליחה');

    // איפוס "רוחות רפאים": בכל הפעלה מחדש של השרת, כל ה-pendingResponses
    // שהיו בזיכרון נעלמים - כך שאף שיחה לא יכולה להיות "פעילה" באמת כרגע.
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
        console.log('ℹ️ אין משחק פעיל כרגע - יש להתחבר עם סיסמת-על וליצור אחד');
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
app.use('/admin', authRoutes);    // /admin/login, /admin/logout, /admin/me - לפני adminRoutes (לא דורש התחברות)
app.use('/admin', adminRoutes);   // שאר פעולות הניהול - דורשות התחברות
app.use(express.static('public')); // מגיש את דשבורד הניהול: /admin.html

app.get('/', (req, res) => {
  res.send('שרת חידון הקליקרים פועל 🚀');
});

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

module.exports = { app, server, io };
