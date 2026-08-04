const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  // קוד מספרי בן 4 ספרות - זה מה שהמתקשר מקיש בשלוחה כדי להצטרף למשחק הספציפי
  // הזה (שלב 4: כמה משחקים יכולים להיות חיים בו-זמנית, אותה שלוחה משותפת).
  // ייחודי גלובלית (לא רק בין משחקים פעילים) - פשוט יותר, ואין סיכון שקוד ישן
  // ממשחק לא-פעיל "יתפוס" בטעות שיחה שמיועדת למשחק אחר.
  code: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // בעל המשחק - הגישה נשלטת דרך ההתחברות שלו, אין יותר סיסמה נפרדת למשחק
  isActive: { type: Boolean, default: false }, // כמה משחקים יכולים להיות פעילים (חיים) בו-זמנית - ניתוב לפי code
  // שלב 5: גישה מלאה בתשלום - per-game (לא per-user/per-account כפי שהיה בהתחלה).
  // מתעדכן ע"י routes/paymentRoutes.js אחרי אימות תשלום מוצלח מול נדרים פלוס
  // (CallBack מאומת בלבד, לא תגובת לקוח).
  paidUntil: { type: Date, default: null },
  // שלב 5: true אם ההפעלה (activate) האחרונה של המשחק בוצעה ע"י מנהל-על -
  // מנהל-על תמיד מפעיל בגישה מלאה (בלי מגבלת 3 משתתפים) ובלי תשלום. מתעדכן
  // מחדש בכל activate() לפי מי שביצע אותו (routes/gamesRoutes.js).
  adminActivated: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Game', gameSchema);
