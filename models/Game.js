const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }, // הסיסמה של המשחק - מוצפנת, אף פעם לא נשמרת כטקסט גלוי
  isActive: { type: Boolean, default: false }      // רק משחק אחד יכול להיות פעיל בו-זמנית
}, { timestamps: true });

module.exports = mongoose.model('Game', gameSchema);
