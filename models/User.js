const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  isAdmin: { type: Boolean, default: false }, // מנהל-על - רואה ומנהל את כל המשתמשים והמשחקים
  // שלב 5: אם עתידי (בעתיד ביחס לרגע הבדיקה) - למשתמש יש גישה מורחבת (בלי מגבלת
  // 3 המשתתפים בניסיון החינמי) לכל המשחקים שלו. מתעדכן ע"י routes/paymentRoutes.js
  // אחרי אימות תשלום מוצלח מול נדרים פלוס (CallBack מאומת, לא תגובת לקוח).
  paidUntil: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
