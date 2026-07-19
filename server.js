// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
require('dotenv').config();

const yemotRoutes = require('./routes/yemotRoutes');
const adminRoutes = require('./routes/adminRoutes');
const Player = require('./models/Player');

// ===== הגדרות בסיסיות =====
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

// ===== יצירת אפליקציית Express =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ימות שולח את הנתונים כ-form (application/x-www-form-urlencoded)

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
    // כל active:true ששרד מהרצה קודמת הוא בהכרח נתון תקוע, ולכן מאפסים אותו.
    try {
      const result = await Player.updateMany({ active: true }, { $set: { active: false } });
      if (result.modifiedCount) {
        console.log(`🧹 אופסו ${result.modifiedCount} חיבורים "פעילים" תקועים מהרצה קודמת`);
      }
    } catch (resetErr) {
      console.error('❌ שגיאה באיפוס חיבורים תקועים:', resetErr.message);
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
app.use('/admin', adminRoutes);   // כאן דשבורד המנהל קורא: /admin/open-question/:id וכו'
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
