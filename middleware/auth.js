const jwt = require('jsonwebtoken');
const Game = require('../models/Game');
const { JWT_SECRET, COOKIE_NAME } = require('../game/authConfig');

// דורש שיהיה cookie התחברות תקף - לכל בקשה ל-/admin/* ו-/games/*
// (חוץ מ-/admin/login|register|logout|me שלא דורשים התחברות)
function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET); // { role:'admin' } או { role:'user', userId, username }
    next();
  } catch {
    res.status(401).json({ error: 'ההתחברות פגה, יש להתחבר מחדש' });
  }
}

// דורש שהמתחבר יהיה מנהל-על (רואה/מנהל את כל המשתמשים והמשחקים בפלטפורמה)
function requireAdmin(req, res, next) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'פעולה זו מוגבלת למנהל המערכת' });
  next();
}

// טוען משחק ספציפי לפי :gameId שבנתיב, ומוודא שהמשתמש המחובר הוא הבעלים שלו (או מנהל-על).
// משמש לניהול "המשחקים שלי" (יצירה/עריכה/מחיקה/הפעלה) - לא קשור בהכרח למשחק ה"חי" כרגע.
async function requireGameOwnership(req, res, next) {
  try {
    const game = await Game.findById(req.params.gameId);
    if (!game) return res.status(404).json({ error: 'משחק לא נמצא' });
    if (req.auth.role !== 'admin' && String(game.owner) !== String(req.auth.userId)) {
      return res.status(403).json({ error: 'אין לך הרשאה למשחק הזה' });
    }
    req.game = game;
    next();
  } catch (err) {
    res.status(500).json({ error: 'שגיאה בטעינת המשחק' });
  }
}

// לפעולות שליטה חיות (open-question / start / pause / leaderboard / connected וכו') -
// אלה תמיד פועלות רק על המשחק שכרגע "חי" במערכת כולה (state.activeGame), ומוודאות
// שהמשתמש המחובר הוא הבעלים שלו (או מנהל-על). קובע req.gameId להמשך השרשרת.
function requireLiveGameOwnership(req, res, next) {
  const { state } = require('../game/gameState');
  if (!state.activeGame) return res.status(404).json({ error: 'אין משחק פעיל כרגע - יש להפעיל משחק מתוך "המשחקים שלי"' });
  if (req.auth.role !== 'admin' && String(state.activeGame.owner) !== String(req.auth.userId)) {
    return res.status(403).json({ error: 'המשחק הפעיל כרגע שייך למשתמש אחר' });
  }
  req.gameId = state.activeGame._id;
  next();
}

module.exports = { requireAuth, requireAdmin, requireGameOwnership, requireLiveGameOwnership };
