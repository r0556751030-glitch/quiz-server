const express = require('express');
const router = express.Router();
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, resolveAll, answerFieldName } = require('../game/gameState');

let closeTimer = null;   // סוגר את השאלה הנוכחית בתום הזמן
let advanceTimer = null; // מרווח נשימה קצר לפני מעבר אוטומטי לשאלה הבאה

// פותח שאלה בפועל - פונקציה משותפת שמשמשת גם פתיחה ידנית וגם רצף אוטומטי
async function openQuestion(app, question) {
  state.status = 'open';
  state.currentQuestion = question;
  state.openedAt = Date.now();
  state.playersAtOpen = await Player.countDocuments({ active: true });

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

// מחשב אחוזי תשובות לכל אפשרות ושולח לתצוגה - נקרא בכל סגירת שאלה (ידנית או אוטומטית)
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
    questionId: question._id,
    counts,
    percentages,
    totalAnswered,
    noAnswerCount,
    correctIndex: question.correctIndex
  });
}

function scheduleAutoClose(app, question) {
  if (closeTimer) clearTimeout(closeTimer);
  const ms = (question.answerWindowSeconds + 3) * 1000; // 3 שניות מרווח ביטחון לאיחור רשת

  closeTimer = setTimeout(async () => {
    if (state.currentQuestion && String(state.currentQuestion._id) === String(question._id) && state.status === 'open') {
      state.status = 'idle';
      app.get('io').emit('questionClosed', { questionId: question._id });
      await computeAndEmitResults(app, question);

      if (state.autoAdvance) {
        advanceTimer = setTimeout(() => advanceToNext(app, question), 6000); // זמן לצפייה בתוצאות לפני המעבר
      }
    }
  }, ms);
}

async function advanceToNext(app, prevQuestion) {
  if (!state.autoAdvance) return; // ייתכן שהמנהל השהה בינתיים
  const next = await Question.findOne({ order: { $gt: prevQuestion.order } }).sort({ order: 1 });
  if (next) {
    await openQuestion(app, next);
  } else {
    state.autoAdvance = false;
    app.get('io').emit('gameFinished', {});
  }
}

// ===== פתיחה ידנית של שאלה ספציפית (תמיד עובד, גם באמצע רצף אוטומטי) =====
router.post('/open-question/:id', async (req, res) => {
  const question = await Question.findById(req.params.id);
  if (!question) return res.status(404).json({ error: 'שאלה לא נמצאה' });

  if (advanceTimer) clearTimeout(advanceTimer);
  await openQuestion(req.app, question);
  res.json({ success: true, question });
});

// ===== התחלת משחק ברצף אוטומטי (מהשאלה הראשונה) =====
router.post('/start-game', async (req, res) => {
  const first = await Question.findOne().sort({ order: 1 });
  if (!first) return res.status(400).json({ error: 'אין שאלות במאגר' });

  state.autoAdvance = true;
  if (advanceTimer) clearTimeout(advanceTimer);
  await openQuestion(req.app, first);
  res.json({ success: true });
});

// ===== השהיית הרצף האוטומטי (השאלה הנוכחית ממשיכה לרוץ, רק לא עוברים אוטומטית להבאה) =====
router.post('/pause', (req, res) => {
  state.autoAdvance = false;
  if (advanceTimer) clearTimeout(advanceTimer);
  req.app.get('io').emit('gamePaused', {});
  res.json({ success: true });
});

// ===== המשך הרצף האוטומטי =====
router.post('/resume', async (req, res) => {
  state.autoAdvance = true;
  if (state.status !== 'open') {
    const next = state.currentQuestion
      ? await Question.findOne({ order: { $gt: state.currentQuestion.order } }).sort({ order: 1 })
      : await Question.findOne().sort({ order: 1 });
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
  // ממזגים לפי מספר טלפון - שורה אחת לכל מספר, סכום ניקוד מכל השיחות, סטטוס לפי חיבור נוכחי
  const players = await Player.aggregate([
    { $group: {
        _id: '$phone',
        score: { $sum: '$score' },
        active: { $max: { $cond: ['$active', 1, 0] } }
    }},
    { $lookup: { from: 'contacts', localField: '_id', foreignField: 'phone', as: 'contact' } },
    { $project: {
        phone: '$_id',
        score: 1,
        active: { $eq: ['$active', 1] },
        name: { $arrayElemAt: ['$contact.name', 0] },
        _id: 0
    }},
    { $sort: { score: -1 } }
  ]);
  res.json(players);
});

// ===== לוח מובילים לפי מהירות (זמן ממוצע לתשובה נכונה, מהיר יותר = גבוה יותר) =====
router.get('/leaderboard-speed', async (req, res) => {
  const speed = await Answer.aggregate([
    { $match: { isCorrect: true, responseTimeMs: { $ne: null } } },
    { $lookup: { from: 'players', localField: 'player', foreignField: '_id', as: 'p' } },
    { $unwind: '$p' },
    { $group: {
        _id: '$p.phone',
        totalTimeMs: { $sum: '$responseTimeMs' },
        correctCount: { $sum: 1 }
    }},
    { $lookup: { from: 'contacts', localField: '_id', foreignField: 'phone', as: 'contact' } },
    { $project: {
        phone: '$_id',
        correctCount: 1,
        avgTimeMs: { $divide: ['$totalTimeMs', '$correctCount'] },
        name: { $arrayElemAt: ['$contact.name', 0] },
        _id: 0
    }},
    { $sort: { avgTimeMs: 1 } }
  ]);
  res.json(speed);
});

// ===== רשימת שחקנים מחוברים כרגע =====
router.get('/connected', async (req, res) => {
  const active = await Player.find({ active: true }).sort({ connectedAt: -1 });
  const phones = active.map((p) => p.phone);
  const contacts = await Contact.find({ phone: { $in: phones } });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  const result = active.map((p) => ({
    phone: p.phone,
    name: nameMap.get(p.phone) || null,
    connectedAt: p.connectedAt,
    callId: p.callId
  }));
  res.json(result);
});

// ===== ניהול כינויים/שמות לשחקנים =====

// כל המספרים שאי פעם התקשרו, עם השם המשויך אם קיים - למסך "ניהול שחקנים"
router.get('/contacts', async (req, res) => {
  const phones = await Player.distinct('phone');
  const contacts = await Contact.find({ phone: { $in: phones } });
  const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));

  const result = phones.map((phone) => ({ phone, name: nameMap.get(phone) || null }));
  res.json(result);
});

// קביעה/עדכון של שם עבור מספר טלפון
router.post('/contacts', async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'חסר מספר טלפון' });

  await Contact.findOneAndUpdate({ phone }, { name: name || null }, { upsert: true });
  req.app.get('io').emit('contactUpdated', { phone, name: name || null });
  res.json({ success: true });
});

// ===== ניהול שאלות =====

router.get('/questions', async (req, res) => {
  const questions = await Question.find().sort({ order: 1 });
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

    const count = await Question.countDocuments();
    const question = await Question.create({
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
  await Question.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// משנה את סדר השאלות - מקבל מערך מזהים בסדר הרצוי, וממספר מחדש 1,2,3...
router.post('/questions/reorder', async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'נתונים לא תקינים' });

  await Promise.all(orderedIds.map((id, idx) => Question.findByIdAndUpdate(id, { order: idx + 1 })));
  res.json({ success: true });
});

// ===== סטטוס נוכחי (לרענון דשבורד שנפתח מחדש) =====
router.get('/status', (req, res) => {
  res.json({
    status: state.status,
    currentQuestion: state.currentQuestion,
    autoAdvance: state.autoAdvance,
    openedAt: state.openedAt,
    playersAtOpen: state.playersAtOpen
  });
});

module.exports = router;
