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
  .catch ((err) => {
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
// מנגנון ניקוי תקופתי לבדיקת חיבורים תקועים כל 10 שניות
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
