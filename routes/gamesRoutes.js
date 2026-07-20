const express = require('express');
const router = express.Router();
const Game = require('../models/Game');
const User = require('../models/User');
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, setActiveGame } = require('../game/gameState');
const { requireAuth, requireAdmin, requireGameOwnership } = require('../middleware/auth');

function slugify(text) {
  return (text || '').trim().toLowerCase()
    .replace(/[^\u0590-\u05FFa-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `game-${Date.now()}`;
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

  const game = await Game.create({ name: name.trim(), slug, owner: req.auth.userId });
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

// ===== הפעלת המשחק הזה כ"חי" - רק משחק אחד יכול להיות חי בו-זמנית בכל המערכת =====
router.post('/:gameId/activate', requireGameOwnership, async (req, res) => {
  await Game.updateMany({ _id: { $ne: req.game._id } }, { isActive: false });
  req.game.isActive = true;
  await req.game.save();
  setActiveGame(req.game);

  req.app.get('io').emit('gameSwitched', { gameId: req.game._id, gameName: req.game.name });
  res.json({ success: true });
});

// ===== עצירת המשחק החי (הופך אותו ל"לא פעיל", בלי למחוק כלום) =====
router.post('/:gameId/deactivate', requireGameOwnership, async (req, res) => {
  req.game.isActive = false;
  await req.game.save();

  if (state.activeGame && String(state.activeGame._id) === String(req.game._id)) {
    setActiveGame(null);
    req.app.get('io').emit('gameSwitched', { gameId: null, gameName: null });
  }
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
