const mongoose = require('mongoose');

const playerSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
  phone: { type: String, required: true, index: true }, // ApiPhone שהתקבל מימות
  callId: { type: String, required: true, unique: true }, // ApiCallId - ייחודי לכל שיחה
  score: { type: Number, default: 0 },
  connectedAt: { type: Date, default: Date.now },
  active: { type: Boolean, default: true } // הופך ל-false כשהשחקן מתנתק
});

module.exports = mongoose.model('Player', playerSchema);
