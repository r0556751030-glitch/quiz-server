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
  isActive: { type: Boolean, default: false } // כמה משחקים יכולים להיות פעילים (חיים) בו-זמנית - ניתוב לפי code
}, { timestamps: true });

module.exports = mongoose.model('Game', gameSchema);
