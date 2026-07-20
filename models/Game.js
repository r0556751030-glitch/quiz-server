const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // בעל המשחק - הגישה נשלטת דרך ההתחברות שלו, אין יותר סיסמה נפרדת למשחק
  isActive: { type: Boolean, default: false } // רק משחק אחד יכול להיות פעיל (חי) בכל המערכת בו-זמנית
}, { timestamps: true });

module.exports = mongoose.model('Game', gameSchema);
