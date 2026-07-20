const express = require('express');
const router = express.Router();
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, resolveAll, answerFieldName } = require('../game/gameState');
const { requireAuth, requireLiveGameOwnership } = require('../middleware/auth');

let closeTimer = null;   // סוגר את השאלה הנוכחית בתום הזמן
let advanceTimer = null; // מרווח נשימה קצר לפני מעבר אוטומטי לשאלה הבאה

// כל בקשה ל-/admin/* (מלבד login/register/logout/me שנמצאים ב-authRoutes) דורשת התחברות תקפה
router.use(requireAuth);

// ===================================================================
// מכאן והלאה - כל פעולה פועלת על המשחק שכרגע "חי" במערכת כולה,
// ומוודאת שהמשתמש המחובר הוא הבעלים שלו (או מנהל-על). ניהול המשחקים
// עצמם (יצירה/עריכה/מחיקה/הפעלה) עבר ל-/games (routes/gamesRoutes.js).
// ===================================================================
router.use(requireLiveGameOwnership);

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
    await finishGame(app, prevQuestion.game);
  }
}

// ===== בונה את תוצאות הסיום המלאות: ניקוד, תשובות נכונות, זמן תגובה ממוצע =====
// לכל שחקן, כולל שחקנים שנוספו ידנית ומעולם לא התקשרו (ניקוד 0).
async function buildFinalResults(gameId) {
  const playersAgg = await Player.aggregate([
    { $match: { game: gameId } },
    { $group: { _id: '$phone', score: { $sum: '$score' }, active: { $max: { $cond: ['$active', 1, 0] } }, playerIds: { $push: '$_id' } } }
  ]);

  const allPlayerIds = playersAgg.flatMap((p) => p.playerIds);
  const answerAgg = await Answer.aggregate([
    { $match: { game: gameId, player: { $in: allPlayerIds } } },
    { $lookup: { from: 'players', localField: 'player', foreignField: '_id', as: 'pl' } },
    { $unwind: '$pl' },
    { $group: {
        _id: '$pl.phone',
        correctAnswers: { $sum: { $cond: ['$isCorrect', 1, 0] } },
        correctTimeSum: { $sum: { $cond: ['$isCorrect', '$responseTimeMs', 0] } },
        correctTimeCount: { $sum: { $cond: ['$isCorrect', 1, 0] } }
    }}
  ]);
  const answerMap = new Map(answerAgg.map((a) => [a._id, a]));

  const contacts = await Contact.find({ game: gameId });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  const known = playersAgg.map((p) => {
    const a = answerMap.get(p._id) || { correctAnswers: 0, correctTimeCount: 0, correctTimeSum: 0 };
    return {
      phone: p._id,
      name: nameMap.get(p._id) || null,
      score: p.score,
      active: !!p.active,
      correctAnswers: a.correctAnswers,
      avgResponseTimeMs: a.correctTimeCount ? Math.round(a.correctTimeSum / a.correctTimeCount) : null
    };
  });

  const knownPhones = new Set(known.map((k) => k.phone));
  const manualOnly = contacts
    .filter((c) => !knownPhones.has(c.phone))
    .map((c) => ({ phone: c.phone, name: c.name || null, score: 0, active: false, correctAnswers: 0, avgResponseTimeMs: null }));

  const combined = [...known, ...manualOnly].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.avgResponseTimeMs ?? Infinity;
    const bt = b.avgResponseTimeMs ?? Infinity;
    return at - bt;
  });

  return combined.map((p, i) => ({ rank: i + 1, ...p }));
}

// ===== מסיימת את המשחק: עוצרת כל טיימר, מחשבת תוצאות סופיות, ומשדרת למסך =====
async function finishGame(app, gameId) {
  const results = await buildFinalResults(gameId);
  app.get('io').emit('gameEnded', { results });
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

// ===== סיום משחק ידני - כפתור "סיים משחק" =====
// עוצר כל טיימר פעיל, סוגר שאלה פתוחה אם יש כזו (עם התוצאות שלה), ואז משדר
// את מסך התוצאות הסופיות - בדיוק כמו סיום אוטומטי בתום רצף השאלות.
router.post('/end-game', async (req, res) => {
  if (closeTimer) clearTimeout(closeTimer);
  if (advanceTimer) clearTimeout(advanceTimer);

  const question = state.currentQuestion;
  if (question && state.status === 'open') {
    state.status = 'idle';
    req.app.get('io').emit('questionClosed', { questionId: question._id });
    await computeAndEmitResults(req.app, question);
  }

  state.autoAdvance = false;
  state.status = 'idle';
  state.currentQuestion = null;

  await finishGame(req.app, req.gameId);
  res.json({ success: true });
});

// ===== תוצאות סופיות מלאות (לוח מובילים מלא למנהל, אחרי סיום משחק) =====
router.get('/final-results', async (req, res) => {
  const results = await buildFinalResults(req.gameId);
  res.json(results);
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
    { $project: { phone: '$_id', score: 1, active: { $eq: ['$active', 1] }, name: { $arrayElemAt: ['$contact.name', 0] }, _id: 0 } }
  ]);

  // שחקנים שנוספו ידנית (יש להם Contact אבל מעולם לא באמת התקשרו) - מוצגים עם
  // ניקוד 0 וסימון "לא מחובר", לפי הדרישה שלא ייעלמו מהרשימה הרגילה.
  const knownPhones = new Set(players.map((p) => p.phone));
  const allContacts = await Contact.find({ game: req.gameId });
  const manualOnly = allContacts
    .filter((c) => !knownPhones.has(c.phone))
    .map((c) => ({ phone: c.phone, score: 0, active: false, name: c.name || null }));

  const combined = [...players, ...manualOnly].sort((a, b) => b.score - a.score);
  res.json(combined);
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

  // הגנה כפולה: גם אם משום מה נשארו כמה רשומות "פעילות" לאותו טלפון (למשל דאטה
  // ישן שנוצר לפני תיקון הבאג של ניתוקים כפולים) - מציגים רק את השיחה העדכנית ביותר.
  const latestByPhone = new Map();
  for (const p of active) {
    if (!latestByPhone.has(p.phone)) latestByPhone.set(p.phone, p);
  }
  const deduped = Array.from(latestByPhone.values());

  const phones = deduped.map((p) => p.phone);
  const contacts = await Contact.find({ game: req.gameId, phone: { $in: phones } });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  res.json(deduped.map((p) => ({ phone: p.phone, name: nameMap.get(p.phone) || null, connectedAt: p.connectedAt, callId: p.callId })));
});

// ===== ניהול כינויים =====

router.get('/contacts', async (req, res) => {
  const playerPhones = new Set(await Player.distinct('phone', { game: req.gameId }));
  const contacts = await Contact.find({ game: req.gameId });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  // איחוד: כל טלפון שהתקשר בפועל + כל טלפון שיש לו כינוי שמור (גם אם עוד לא התקשר),
  // כדי ששחקן שנוסף ידנית לא "ייעלם" מהרשימה ברגע שנוצר, לפני שהתקשר בפועל.
  const allPhones = new Set([...playerPhones, ...contacts.map((c) => c.phone)]);

  res.json(Array.from(allPhones).map((phone) => ({
    phone,
    name: nameMap.get(phone) || null,
    hasCalled: playerPhones.has(phone)
  })));
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
