const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { JWT_SECRET, COOKIE_NAME, THIRTY_DAYS_MS } = require('../game/authConfig');

function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: THIRTY_DAYS_MS, sameSite: 'lax' });
}

// ===== הרשמה - יצירת חשבון משתמש רגיל חדש =====
router.post('/register', async (req, res) => {
  try {
    const username = (req.body.username || '').toLowerCase().trim();
    const { password } = req.body;

    if (!username || !password) return res.status(400).json({ error: 'יש למלא שם משתמש וסיסמה' });
    if (username.length < 3) return res.status(400).json({ error: 'שם משתמש חייב להכיל לפחות 3 תווים' });
    if (password.length < 6) return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 6 תווים' });

    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: 'שם המשתמש הזה כבר תפוס' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, passwordHash });

    setAuthCookie(res, { role: 'user', userId: user._id, username: user.username });
    res.json({ success: true, role: 'user', username: user.username });
  } catch (err) {
    console.error('שגיאה בהרשמה:', err);
    res.status(500).json({ error: 'שגיאה בהרשמה' });
  }
});

// ===== כניסה =====
// שני מסלולים: כניסת משתמש רגיל (username+password), וכניסת מנהל-על (רק סיסמת-מאסטר, בלי username)
router.post('/login', async (req, res) => {
  try {
    const username = (req.body.username || '').toLowerCase().trim();
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'חסרה סיסמה' });

    // ===== כניסת מנהל-על - סיסמת-מאסטר, בלי שם משתמש =====
    const superPassword = process.env.SUPER_ADMIN_PASSWORD;
    if (!username && superPassword && password === superPassword) {
      setAuthCookie(res, { role: 'admin' });
      return res.json({ success: true, role: 'admin' });
    }

    if (!username) return res.status(400).json({ error: 'חסר שם משתמש' });

    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });

    setAuthCookie(res, { role: 'user', userId: user._id, username: user.username });
    res.json({ success: true, role: 'user', username: user.username });
  } catch (err) {
    console.error('שגיאה בכניסה:', err);
    res.status(500).json({ error: 'שגיאה בכניסה' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// בדיקת session תקף (בעת טעינת/רענון עמוד)
router.get('/me', async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json({ authenticated: false });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'admin') return res.json({ authenticated: true, role: 'admin' });
    res.json({ authenticated: true, role: 'user', userId: payload.userId, username: payload.username });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;
