const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  isAdmin: { type: Boolean, default: false } // מנהל-על - רואה ומנהל את כל המשתמשים והמשחקים
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
