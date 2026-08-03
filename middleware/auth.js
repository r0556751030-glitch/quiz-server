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
// שלב 4: כמה משחקים יכולים להיות "חיים" בו-זמנית, אז אין יותר "המשחק החי היחיד
// הגלובלי". ה-frontend חייב לציין gameId מפורש בכל בקשה (header x-game-id, או
// query/body כגיבוי) - זה נבדק כאן מול בעלות, ונקבע req.gameId + req.gameDoc.
// שים לב: זה לא בודק אם המשחק "חי" כרגע בזיכרון - זה בכוונה (routes קריאת מידע
// עובדים גם על משחק לא-חי). adminRoutes.js מוסיף בדיקת-חיות משלו (requireLiveState)
// לפעולות שליטה בפועל.
async function requireGameContext(req, res, next) {
  const gameId = req.headers['x-game-id'] || req.query.gameId || (req.body && req.body.gameId);
  if (!gameId) return res.status(400).json({ error: 'חסר מזהה משחק (gameId)' });

  try {
    const game = await Game.findById(gameId);
    if (!game) return res.status(404).json({ error: 'משחק לא נמצא' });
    if (req.auth.role !== 'admin' && String(game.owner) !== String(req.auth.userId)) {
      return res.status(403).json({ error: 'המשחק הזה שייך למשתמש אחר' });
    }
    req.gameId = String(game._id);
    req.gameDoc = game;
    next();
  } catch (err) {
    if (err.name === 'CastError') {
      // gameId לא תקין (למשל "null" כמחרוזת - קורה אם ה-frontend לא באמת קיבל
      // gameId ושלח את זה כברירת מחדל). ככל הנראה קאש דפדפן ישן/gameId חסר.
      console.error(`⚠️ requireGameContext: gameId לא תקין: "${gameId}"`);
      return res.status(400).json({ error: 'מזהה משחק לא תקין - נסה לרענן את הדף (Ctrl+Shift+R)' });
    }
    console.error('❌ שגיאה ב-requireGameContext:', err.message);
    res.status(500).json({ error: 'שגיאה בטעינת המשחק' });
  }
}

module.exports = { requireAuth, requireAdmin, requireGameOwnership, requireGameContext };
