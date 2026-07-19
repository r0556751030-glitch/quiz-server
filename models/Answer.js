const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  player: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  choice: { type: String }, // המספר שנלחץ (כמחרוזת), או 'NOANSWER' אם לא ענה בזמן
  isCorrect: { type: Boolean, default: false },
  responseTimeMs: { type: Number, default: null }, // זמן מרגע פתיחת השאלה ועד התשובה - לצורך לוח מובילים לפי מהירות
  answeredAt: { type: Date, default: Date.now }
});

// מונע מצב של שתי תשובות מאותו שחקן לאותה שאלה
answerSchema.index({ player: 1, question: 1 }, { unique: true });

module.exports = mongoose.model('Answer', answerSchema);
