const mongoose = require('mongoose');

// שיוך שם/כינוי למספר טלפון, בתוך משחק ספציפי - אותו טלפון יכול לשחק
// במשחקים שונים עם כינויים שונים, לכן ה-unique הוא על הצירוף game+phone, לא phone לבד.
const contactSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true },
  phone: { type: String, required: true },
  name: { type: String, default: null }
});

contactSchema.index({ game: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Contact', contactSchema);
