const mongoose = require('mongoose');

// שלב 5: מעקב אחר עסקאות תשלום מול נדרים פלוס. נוצר (status: pending) ברגע
// שהמשתמש לוחץ "רכוש גישה מורחבת" ואנחנו יוצרים עסקה בצד שרת מול
// DebitIframe.aspx?Action=CreateTransaction. הופך ל-approved רק אחרי אימות
// שרתי אמיתי דרך ה-CallBack (routes/paymentRoutes.js) - לעולם לא לפי תגובת
// הלקוח בלבד (ראו תיעוד נדרים פלוס: "אישור שרתי בלבד").
const paymentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // שלב 5 (עדכון): התשלום פותח גישה מלאה למשחק הספציפי הזה בלבד, לא לכל
  // המשחקים של המשתמש. נשמר גם user (מי שילם, לצורך תמיכה/מעקב) וגם game
  // (על מה בדיוק פתח גישה).
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
  // מזהה ייחודי שלנו (לא של נדרים) - נשלח כ-Param1 ביצירת העסקה, וחוזר אלינו
  // ב-CallBack. זו הדרך שבה מצליבים את העדכון שמגיע מנדרים מול הרשומה אצלנו.
  paramId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  nedarimTransactionId: { type: String, default: null }, // ה-ID שמוחזר מ-CreateTransaction
  status: { type: String, enum: ['pending', 'approved', 'error'], default: 'pending' },
  approvedAt: { type: Date, default: null },
  // תיעוד שרתי (לא רק צ'קבוקס בדפדפן) של אישור תנאי השימוש/מדיניות הפרטיות -
  // ראיה לכך שהאישור אכן ניתן ברגע יצירת העסקה, לצורך גיבוי משפטי.
  agreedToTermsAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
