const express = require('express');
const router = express.Router();
const Game = require('../models/Game');
const User = require('../models/User');
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { activateGame, deactivateGame } = require('../game/gameState');
const { requireAuth, requireAdmin, requireGameOwnership } = require('../middleware/auth');

function slugify(text) {
  return (text || '').trim().toLowerCase()
    .replace(/[^\u0590-\u05FFa-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `game-${Date.now()}`;
}

// קוד מספרי בן 4 ספרות שהמתקשר מקיש בשלוחה כדי להצטרף למשחק הספציפי (שלב 4).
// ייחודי גלובלית - נבדק מול ה-DB ומגריל מחדש עד שנמצא קוד פנוי.
async function generateUniqueCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999, לא מתחיל באפס
    if (!(await Game.findOne({ code }))) return code;
  }
  throw new Error('לא הצלחנו להגריל קוד משחק פנוי - כנראה שכל טווח הקודים תפוס');
}

router.use(requireAuth);

// ===== רשימת המשחקים - "שלי" למשתמש רגיל, "כולם" למנהל-על =====
router.get('/', async (req, res) => {
  const filter = req.auth.role === 'admin' ? {} : { owner: req.auth.userId };
  const games = await Game.find(filter).sort({ createdAt: -1 }).populate('owner', 'username');
  res.json(games.map((g) => ({
    _id: g._id,
    name: g.name,
    slug: g.slug,
    code: g.code,
    isActive: g.isActive,
    createdAt: g.createdAt,
    ownerUsername: g.owner ? g.owner.username : null
  })));
});

// ===== יצירת משחק חדש - תמיד שייך למשתמש המחובר =====
router.post('/', async (req, res) => {
  if (req.auth.role === 'admin') {
    return res.status(400).json({ error: 'למנהל-על אין חשבון משחקים אישי - יש להתחבר כמשתמש רגיל כדי ליצור משחק' });
  }

  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'יש למלא שם משחק' });

  let slug = slugify(name);
  let suffix = 1;
  while (await Game.findOne({ slug })) slug = `${slugify(name)}-${suffix++}`;

  const code = await generateUniqueCode();
  const game = await Game.create({ name: name.trim(), slug, code, owner: req.auth.userId });
  res.json({ success: true, game });
});

// ===== עריכת שם משחק =====
router.patch('/:gameId', requireGameOwnership, async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) req.game.name = name.trim();
  await req.game.save();
  res.json({ success: true });
});

// ===== מחיקת משחק (אי אפשר למחוק משחק שכרגע חי) =====
router.delete('/:gameId', requireGameOwnership, async (req, res) => {
  if (req.game.isActive) {
    return res.status(400).json({ error: 'אי אפשר למחוק משחק שפעיל (חי) כרגע - יש לעצור אותו קודם' });
  }
  await Promise.all([
    Question.deleteMany({ game: req.game._id }),
    Player.deleteMany({ game: req.game._id }),
    Answer.deleteMany({ game: req.game._id }),
    Contact.deleteMany({ game: req.game._id }),
    Game.findByIdAndDelete(req.game._id)
  ]);
  res.json({ success: true });
});

// ===== הפעלת המשחק הזה כ"חי" - שלב 4: כמה משחקים יכולים להיות חיים בו-זמנית =====
// כל הפעלה (גם של אותו משחק שכבר רץ בעבר) = "סשן" חדש: מוחקים שחקנים ותשובות
// כדי שהלוח יתחיל נקי (ניקוד 0, בלי זמני תגובה ישנים). כינויים (Contact) נשארים,
// כי הם שייכים לאנשים ולא לסשן ספציפי. תוך כדי משחק רץ (השהיה/המשך/מעבר שאלות)
// אין כאן שום מחיקה - שם הניקוד כמובן נשמר כרגיל.
// נקרא מה-frontend רגע לפני "הפעל", כדי להציג אזהרה עם מספרים אמיתיים אם כבר
// יש Player/Answer קיימים למשחק הזה מסשן קודם - activate מוחק אותם במכוון.
router.get('/:gameId/activate-preview', requireGameOwnership, async (req, res) => {
  const [playerCount, answerCount] = await Promise.all([
    Player.countDocuments({ game: req.game._id }),
    Answer.countDocuments({ game: req.game._id })
  ]);
  res.json({ playerCount, answerCount });
});

router.post('/:gameId/activate', requireGameOwnership, async (req, res) => {
  // הוסר: Game.updateMany({...}, {isActive:false}) - זה היה האילוץ "רק משחק אחד
  // חי בכל המערכת". עכשיו כמה משחקים יכולים להיות isActive:true בו-זמנית.
  req.game.isActive = true;
  await req.game.save();

  await Promise.all([
    Player.deleteMany({ game: req.game._id }),
    Answer.deleteMany({ game: req.game._id })
  ]);

  activateGame(req.game);

  // TODO(שלב 4 - המשך): io.emit גלובלי כאן שגוי עכשיו כשכמה משחקים חיים בו-זמנית -
  // זה ישדר "gameSwitched" לכל הדשבורדים, כולל של משחקים אחרים שלא קשורים בכלל.
  // צריך socket room ייעודי למשחק הזה (game:<gameId>) - עדיין לא מחובר, ממתין
  // לעדכון admin.js/admin.html בצעד הבא. בינתיים לא משדרים בכלל, כדי לא לשבור
  // דשבורדים של משחקים אחרים.
  res.json({ success: true });
});

// ===== עצירת המשחק החי (הופך אותו ל"לא פעיל", בלי למחוק כלום) =====
router.post('/:gameId/deactivate', requireGameOwnership, async (req, res) => {
  req.game.isActive = false;
  await req.game.save();

  deactivateGame(req.game._id);
  // TODO(שלב 4 - המשך): כנ"ל - צריך לשדר 'gameEnded'/סגירה רק ל-room של המשחק הזה,
  // לא גלובלית לכולם. ממתין לחיבור socket rooms.
  res.json({ success: true });
});

// ===== מנהל-על בלבד: רשימת כל המשתמשים בפלטפורמה =====
router.get('/admin/users', requireAdmin, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  const counts = await Game.aggregate([{ $group: { _id: '$owner', count: { $sum: 1 } } }]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));

  res.json(users.map((u) => ({
    _id: u._id,
    username: u.username,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
    gameCount: countMap.get(String(u._id)) || 0
  })));
});

module.exports = router;
