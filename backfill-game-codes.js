// backfill-game-codes.js - הרצה חד-פעמית: ממלא קוד מספרי בן 4 ספרות לכל משחק
// קיים ב-DB שאין לו עדיין (חייב לרוץ לפני deploy של הסכימה החדשה ב-Game.js,
// כי היא דורשת code ייחודי - ובלי הסקריפט הזה בניית ה-unique index תיכשל אם
// יש יותר ממשחק אחד קיים בלי code).
//
// הרצה: node backfill-game-codes.js
//
// עובד ישירות מול ה-collection הגולמי (לא דרך ה-Model) כדי שיעבוד גם אם
// עדיין לא פרסת את הסכימה החדשה של Game.js.

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

async function generateUniqueCode(collection) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const code = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999
        const clash = await collection.findOne({ code });
        if (!clash) return code;
    }
    throw new Error('לא הצלחנו להגריל קוד פנוי - טווח הקודים כמעט תפוס (לא אמור לקרות ב-20 לקוחות)');
}

async function run() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ מחובר למסד הנתונים');

    const collection = mongoose.connection.collection('games');
    const missing = await collection.find({ code: { $exists: false } }).toArray();

    if (!missing.length) {
        console.log('ℹ️ אין משחקים בלי code - שום דבר לא צריך לזוז.');
    } else {
        console.log(`נמצאו ${missing.length} משחקים בלי code. ממלא...`);
        for (const game of missing) {
            const code = await generateUniqueCode(collection);
            await collection.updateOne({ _id: game._id }, { $set: { code } });
            console.log(`  - "${game.name || game._id}" → code=${code}`);
        }
        console.log('✅ הושלם.');
    }

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('❌ שגיאה:', err.message);
    process.exit(1);
});
