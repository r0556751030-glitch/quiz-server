const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
  player: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  question: { type: mongoose.Schema.Types.ObjectId, ref: 'Question', required: true },
  choice: { type: String },
  isCorrect: { type: Boolean, default: false },
  responseTimeMs: { type: Number, default: null },
  answeredAt: { type: Date, default: Date.now }
});

answerSchema.index({ player: 1, question: 1 }, { unique: true });

module.exports = mongoose.model('Answer', answerSchema);
