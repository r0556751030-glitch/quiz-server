const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const Game = require('../models/Game');
const { state, resolveAll, answerFieldName, setActiveGame } = require('../game/gameState');
const { requireAuth, requireSuper, resolveGameId } = require('../middleware/auth');

let closeTimer = null;   // סוגר את השאלה הנוכחית בתום הזמן
let advanceTimer = null; // מרווח נשימה קצר לפני מעבר אוטומטי לשאלה הבאה

function slugify(text) {
  return (text || '').trim().toLowerCase()
    .replace(/[^\u0590-\u05FFa-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `game-${Date.now()}`;
}

// כל בקשה ל-/admin/* (מלבד login/logout/me שנמצאים ב-authRoutes) דורשת התחברות תקפה
router.use(requireAuth);

// ===================================================================
// ניהול משחקים - מוגבל לסיסמת-על בלבד
// ===================================================================

router.get('/games', requireSuper, async (req, res) => {
  const games = await Game.find().sort({ createdAt: -1 });
  res.json(games.map((g) => ({ _id: g._id, name: g.name, slug: g.slug, isActive: g.isActive, createdAt: g.createdAt })));
});

router.post('/games', requireSuper, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'יש למלא שם וסיסמה' });

    let slug = slugify(name);
    let suffix = 1;
    while (await Game.findOne({ slug })) slug = `${slugify(name)}-${suffix++}`;

    const passwordHash = await bcrypt.hash(password, 10);
    const hasActive = !!(await Game.findOne({ isActive: true }));
    const game = await Game.create({ name, slug, passwordHash, isActive: !hasActive });

    // אם זה המשחק הראשון שנוצר אי פעם - הוא הופך פעיל אוטומטית
    if (!hasActive) setActiveGame(game);

    res.json({ success: true, game: { _id: game._id, name: game.name, slug: game.slug, isActive: game.isActive } });
  } catch (err) {
    console.error('שגיאה ביצירת משחק:', err);
    res.status(500).json({ error: 'שגיאה ביצירת המשחק' });
  }
});

router.post('/games/:id/activate', requireSuper, async (req, res) => {
  const game = await Game.findById(req.params.id);
  if (!game) return res.status(404).json({ error: 'משחק לא נמצא' });

  // מפסיקים כל טיימר פעיל של המשחק הקודם לפני המעבר
  if (closeTimer) clearTimeout(closeTimer);
  if (advanceTimer) clearTimeout(advanceTimer);

  await Game.updateMany({ _id: { $ne: game._id } }, { isActive: false });
  game.isActive = true;
  await game.save();
  setActiveGame(game); // מאפס את מצב המשחק החי (שאלה פתוחה וכו')

  req.app.get('io').emit('gameSwitched', { gameId: game._id, gameName: game.name });
  res.json({ success: true });
});

router.delete('/games/:id', requireSuper, async (req, res) => {
  const game = await Game.findById(req.params.id);
  if (!game) return res.status(404).json({ error: 'משחק לא נמצא' });
  if (game.isActive) return res.status(400).json({ error: 'אי אפשר למחוק משחק פעיל - יש להפעיל משחק אחר קודם' });

  await Promise.all([
    Question.deleteMany({ game: game._id }),
    Player.deleteMany({ game: game._id }),
    Answer.deleteMany({ game: game._id }),
    Contact.deleteMany({ game: game._id }),
    Game.findByIdAndDelete(game._id)
  ]);
  res.json({ success: true });
});

// ===================================================================
// מכאן והלאה - כל פעולה מוגבלת למשחק הפעיל הנוכחי (super רואה את הפעיל,
// game מוגבל לזה שהתחבר אליו)
// ===================================================================
router.use(resolveGameId);

async function openQuestion(app, question) {
  state.status = 'open';
  state.currentQuestion = question;
  state.openedAt = Date.now();
  state.playersAtOpen = await Player.countDocuments({ active: true, game: question.game });

  const allowedKeys = question.options.map((_, i) => i + 1).join('');
  const command = `read=f-001=${answerFieldName(question)},,1,1,${question.answerWindowSeconds},NO,yes,,,${allowedKeys},3,Ok,NOANSWER,,no`;

  resolveAll(command);
  scheduleAutoClose(app, question);
  app.get('io').emit('questionOpened', {
    question,
    autoAdvance: state.autoAdvance,
    openedAt: state.openedAt,
    answerWindowSeconds: question.answerWindowSeconds
  });
}

async function computeAndEmitResults(app, question) {
  const answers = await Answer.find({ question: question._id });
  const counts = question.options.map(() => 0);

  answers.forEach((a) => {
    const idx = Number(a.choice) - 1;
    if (counts[idx] !== undefined) counts[idx]++;
  });

  const totalAnswered = answers.length;
  const noAnswerCount = Math.max(0, (state.playersAtOpen || 0) - totalAnswered);
  const percentages = counts.map((c) => (totalAnswered ? Math.round((c / totalAnswered) * 100) : 0));

  app.get('io').emit('questionResults', {
    questionId: question._id, counts, percentages, totalAnswered, noAnswerCount, correctIndex: question.correctIndex
  });
}

function scheduleAutoClose(app, question) {
  if (closeTimer) clearTimeout(closeTimer);
  const ms = (question.answerWindowSeconds + 3) * 1000;

  closeTimer = setTimeout(async () => {
    if (state.currentQuestion && String(state.currentQuestion._id) === String(question._id) && state.status === 'open') {
      state.status = 'idle';
      app.get('io').emit('questionClosed', { questionId: question._id });
      await computeAndEmitResults(app, question);

      if (state.autoAdvance) {
        advanceTimer = setTimeout(() => advanceToNext(app, question), 6000);
      }
    }
  }, ms);
}

async function advanceToNext(app, prevQuestion) {
  if (!state.autoAdvance) return;
  const next = await Question.findOne({ game: prevQuestion.game, order: { $gt: prevQuestion.order } }).sort({ order: 1 });
  if (next) {
    await openQuestion(app, next);
  } else {
    state.autoAdvance = false;
    app.get('io').emit('gameFinished', {});
  }
}

router.post('/open-question/:id', async (req, res) => {
  const question = await Question.findOne({ _id: req.params.id, game: req.gameId });
  if (!question) return res.status(404).json({ error: 'שאלה לא נמצאה' });

  if (advanceTimer) clearTimeout(advanceTimer);
  await openQuestion(req.app, question);
  res.json({ success: true, question });
});

router.post('/start-game', async (req, res) => {
  const first = await Question.findOne({ game: req.gameId }).sort({ order: 1 });
  if (!first) return res.status(400).json({ error: 'אין שאלות במאגר' });

  state.autoAdvance = true;
  if (advanceTimer) clearTimeout(advanceTimer);
  await openQuestion(req.app, first);
  res.json({ success: true });
});

router.post('/pause', (req, res) => {
  state.autoAdvance = false;
  if (advanceTimer) clearTimeout(advanceTimer);
  req.app.get('io').emit('gamePaused', {});
  res.json({ success: true });
});

router.post('/resume', async (req, res) => {
  state.autoAdvance = true;
  if (state.status !== 'open') {
    const next = state.currentQuestion
      ? await Question.findOne({ game: req.gameId, order: { $gt: state.currentQuestion.order } }).sort({ order: 1 })
      : await Question.findOne({ game: req.gameId }).sort({ order: 1 });
    if (next) await openQuestion(req.app, next);
  }
  req.app.get('io').emit('gameResumed', {});
  res.json({ success: true });
});

router.post('/close-question', async (req, res) => {
  if (closeTimer) clearTimeout(closeTimer);
  if (advanceTimer) clearTimeout(advanceTimer);
  const question = state.currentQuestion;
  state.status = 'idle';
  req.app.get('io').emit('questionClosed', { questionId: question?._id });
  if (question) await computeAndEmitResults(req.app, question);
  res.json({ success: true });
});

// ===== לוח מובילים לפי ניקוד =====
router.get('/leaderboard', async (req, res) => {
  const players = await Player.aggregate([
    { $match: { game: req.gameId } },
    { $group: { _id: '$phone', score: { $sum: '$score' }, active: { $max: { $cond: ['$active', 1, 0] } } } },
    { $lookup: {
        from: 'contacts',
        let: { phone: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$phone', '$$phone'] }, { $eq: ['$game', req.gameId] }] } } }],
        as: 'contact'
    }},
    { $project: { phone: '$_id', score: 1, active: { $eq: ['$active', 1] }, name: { $arrayElemAt: ['$contact.name', 0] }, _id: 0 } },
    { $sort: { score: -1 } }
  ]);
  res.json(players);
});

// ===== לוח מובילים לפי מהירות =====
router.get('/leaderboard-speed', async (req, res) => {
  const speed = await Answer.aggregate([
    { $match: { game: req.gameId, isCorrect: true, responseTimeMs: { $ne: null } } },
    { $lookup: { from: 'players', localField: 'player', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    { $group: { _id: '$p.phone', totalTimeMs: { $sum: '$responseTimeMs' }, correctCount: { $sum: 1 } } },
    { $lookup: {
        from: 'contacts',
        let: { phone: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$phone', '$$phone'] }, { $eq: ['$game', req.gameId] }] } } }],
        as: 'contact'
    }},
    { $project: { phone: '$_id', correctCount: 1, avgTimeMs: { $divide: ['$totalTimeMs', '$correctCount'] }, name: { $arrayElemAt: ['$contact.name', 0] }, _id: 0 } },
    { $sort: { avgTimeMs: 1 } }
  ]);
  res.json(speed);
});

// ===== רשימת שחקנים מחוברים כרגע =====
router.get('/connected', async (req, res) => {
  const active = await Player.find({ active: true, game: req.gameId }).sort({ connectedAt: -1 });
  const phones = active.map((p) => p.phone);
  const contacts = await Contact.find({ game: req.gameId, phone: { $in: phones } });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  res.json(active.map((p) => ({ phone: p.phone, name: nameMap.get(p.phone) || null, connectedAt: p.connectedAt, callId: p.callId })));
});

// ===== ניהול כינויים =====

router.get('/contacts', async (req, res) => {
  const phones = await Player.distinct('phone', { game: req.gameId });
  const contacts = await Contact.find({ game: req.gameId, phone: { $in: phones } });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));
  res.json(phones.map((phone) => ({ phone, name: nameMap.get(phone) || null })));
});

router.post('/contacts', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'חסר מספר טלפון' });

  await Contact.findOneAndUpdate({ game: req.gameId, phone }, { name: name || null }, { upsert: true });
  req.app.get('io').emit('contactUpdated', { phone, name: name || null });
  res.json({ success: true });
});

// ===== מחיקת שחקן (חדש) =====
// מוחק לגמרי שחקן מהמשחק הנוכחי: כל מסמכי ה-Player שלו (כל השיחות שביצע),
// כל התשובות שלו, והכינוי שלו - לא ניתן לשחזור.
router.delete('/players/:phone', async (req, res) => {
  const { phone } = req.params;
  const players = await Player.find({ game: req.gameId, phone });
  const playerIds = players.map((p) => p._id);

  await Promise.all([
    Answer.deleteMany({ game: req.gameId, player: { $in: playerIds } }),
    Player.deleteMany({ game: req.gameId, phone }),
    Contact.deleteOne({ game: req.gameId, phone })
  ]);

  req.app.get('io').emit('playerDeleted', { phone });
  res.json({ success: true });
});

// ===== ניהול שאלות =====

router.get('/questions', async (req, res) => {
  const questions = await Question.find({ game: req.gameId }).sort({ order: 1 });
  res.json(questions);
});

router.post('/questions', async (req, res) => {
  try {
    const { text, options, correctIndex, answerWindowSeconds } = req.body;

    if (!text || !Array.isArray(options) || options.length < 2 || options.length > 6) {
      return res.status(400).json({ error: 'יש למלא טקסט ובין 2 ל-6 אפשרויות' });
    }
    if (correctIndex === undefined || correctIndex < 0 || correctIndex >= options.length) {
      return res.status(400).json({ error: 'יש לבחור תשובה נכונה תקינה' });
    }

    const count = await Question.countDocuments({ game: req.gameId });
    const question = await Question.create({
      game: req.gameId,
      text,
      options,
      correctIndex: Number(correctIndex),
      order: count + 1,
      answerWindowSeconds: Number(answerWindowSeconds) || 15
    });

    res.json({ success: true, question });
  } catch (err) {
    console.error('שגיאה ביצירת שאלה:', err);
    res.status(500).json({ error: 'שגיאה ביצירת השאלה' });
  }
});

router.delete('/questions/:id', async (req, res) => {
  await Question.findOneAndDelete({ _id: req.params.id, game: req.gameId });
  res.json({ success: true });
});

router.post('/questions/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'נתונים לא תקינים' });

  await Promise.all(orderedIds.map((id, idx) => Question.findOneAndUpdate({ _id: id, game: req.gameId }, { order: idx + 1 })));
  res.json({ success: true });
});

// ===== סטטוס נוכחי (לרענון דשבורד שנפתח מחדש) =====
router.get('/status', (req, res) => {
  res.json({
    status: state.status,
    currentQuestion: state.currentQuestion,
    autoAdvance: state.autoAdvance,
    openedAt: state.openedAt,
    playersAtOpen: state.playersAtOpen,
    activeGame: state.activeGame
  });
});

module.exports = router;
