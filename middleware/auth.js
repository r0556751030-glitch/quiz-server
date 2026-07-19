const jwt = require('jsonwebtoken');
const Game = require('../models/Game');
const { JWT_SECRET, COOKIE_NAME } = require('../game/authConfig');

// דורש שיהיה cookie התחברות תקף (בכל בקשה ל-/admin/* חוץ מ-login/logout/me)
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET); // { role: 'super' } או { role: 'game', gameId }
    next();
  } catch {
    res.status(401).json({ error: 'ההתחברות פגה, יש להתחבר מחדש' });
  }
}

// דורש שהמתחבר יהיה בעל סיסמת-על (לניהול משחקים - יצירה/הפעלה/מחיקה)
function requireSuper(req, res, next) {
  if (req.auth?.role !== 'super') return res.status(403).json({ error: 'פעולה זו מוגבלת למנהל-על' });
  next();
}

// קובע לאיזה game._id לשייך את הבקשה: super תמיד רואה את המשחק הפעיל כרגע,
// game מוגבל למשחק הספציפי שהתחבר אליו (ונבדק שהוא עדיין פעיל).
async function resolveGameId(req, res, next) {
  try {
    if (req.auth.role === 'super') {
      const active = await Game.findOne({ isActive: true });
      if (!active) return res.status(404).json({ error: 'אין משחק פעיל כרגע - יש ליצור/להפעיל משחק' });
      req.gameId = active._id;
    } else {
      const game = await Game.findById(req.auth.gameId);
      if (!game || !game.isActive) return res.status(409).json({ error: 'המשחק שהתחברת אליו כבר אינו פעיל' });
      req.gameId = game._id;
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'שגיאה בזיהוי המשחק' });
  }
}

module.exports = { requireAuth, requireSuper, resolveGameId };
