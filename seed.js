// seed.js - הרצה חד-פעמית ליצירת שאלת בדיקה
// הרצה: node seed.js

const mongoose = require('mongoose');
require('dotenv').config();
const Question = require('./models/Question');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/clicker-db';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ מחובר למסד הנתונים');

  // מוחק שאלות קודמות (לנוחות בזמן פיתוח - אפשר להוריד את זה בהמשך)
  await Question.deleteMany({});

  const question = await Question.create({
    text: 'מה בירת ישראל?',
    options: ['תל אביב', 'ירושלים', 'חיפה', 'באר שבע'],
    correctIndex: 1, // "ירושלים" - אינדקס 1 (0-based)
    order: 1,
    answerWindowSeconds: 20
  });

  console.log('✅ נוצרה שאלת בדיקה בהצלחה!');
  console.log('מזהה השאלה (questionId):', question._id.toString());
  console.log('👆 העתיקי את המזהה הזה - נצטרך אותו בבדיקה הבאה');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('❌ שגיאה:', err.message);
  process.exit(1);
});
