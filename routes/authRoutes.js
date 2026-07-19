const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Game = require('../models/Game');
const { JWT_SECRET, COOKIE_NAME, THIRTY_DAYS_MS } = require('../game/authConfig');

router.post('/login', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'חסרה סיסמה' });

  // ===== סיסמת-על - פותחת גישה לכל המשחקים ולניהול-על =====
  const superPassword = process.env.SUPER_ADMIN_PASSWORD;
  if (superPassword && password === superPassword) {
    const token = jwt.sign({ role: 'super' }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: THIRTY_DAYS_MS, sameSite: 'lax' });
    const activeGame = await Game.findOne({ isActive: true });
    return res.json({ success: true, role: 'super', gameName: activeGame ? activeGame.name : null });
  }

  // ===== סיסמת משחק ספציפי - נבדקת מול המשחק הפעיל כרגע בלבד =====
  const activeGame = await Game.findOne({ isActive: true });
  if (!activeGame) return res.status(404).json({ error: 'אין משחק פעיל כרגע' });

  const match = await bcrypt.compare(password, activeGame.passwordHash);
  if (!match) return res.status(401).json({ error: 'סיסמה שגויה' });

  const token = jwt.sign({ role: 'game', gameId: activeGame._id }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, { httpOnly: true, maxAge: THIRTY_DAYS_MS, sameSite: 'lax' });
  res.json({ success: true, role: 'game', gameName: activeGame.name });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// בדיקת session תקף (בעת טעינת/רענון העמוד)
router.get('/me', async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json({ authenticated: false });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role === 'super') {
      const activeGame = await Game.findOne({ isActive: true });
      return res.json({ authenticated: true, role: 'super', gameName: activeGame ? activeGame.name : null });
    }
    const game = await Game.findById(payload.gameId);
    if (!game || !game.isActive) return res.json({ authenticated: false });
    res.json({ authenticated: true, role: 'game', gameName: game.name });
  } catch {
    res.json({ authenticated: false });
  }
});

module.exports = router;
