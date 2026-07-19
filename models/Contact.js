const mongoose = require('mongoose');

// שיוך שם/כינוי למספר טלפון - נפרד מ-Player כי Player נוצר מחדש בכל שיחה
// (אותו מספר יכול להתקשר כמה פעמים וליצור כמה מסמכי Player).
// כך השם נשמר פעם אחת לכל מספר, ולא צריך לעדכן שורות ישנות.
const contactSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  name: { type: String, default: null }
});

module.exports = mongoose.model('Contact', contactSchema);
