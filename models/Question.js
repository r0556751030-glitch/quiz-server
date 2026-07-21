const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
  text: { type: String, required: true },
  options: { type: [String], required: true },        // 2–9 אפשרויות
  correctIndex: { type: Number, default: null },       // null עבור שאלות סקר
  isSurvey: { type: Boolean, default: false },         // true = שאלת סקר: ללא ניקוד, ללא תשובה נכונה, רק אחוזים
  order: { type: Number, required: true },
  answerWindowSeconds: { type: Number, default: 15 }
}, { timestamps: true });

module.exports = mongoose.model('Question', questionSchema);