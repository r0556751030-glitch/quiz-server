const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema({
  text: { type: String, required: true },        // טקסט השאלה - מוצג רק במסך המנהל
  options: { type: [String], required: true },    // רשימת האפשרויות (2-9 אפשרויות)
  correctIndex: { type: Number, required: true }, // אינדקס 0-based של התשובה הנכונה
  order: { type: Number, required: true },        // סדר הופעה במשחק
  answerWindowSeconds: { type: Number, default: 15 } // זמן מענה בשניות
}, { timestamps: true });

module.exports = mongoose.model('Question', questionSchema);
