const express = require('express');
const router = express.Router();
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, CONFIG } = require('../game/gameState');
const { requireAuth, requireLiveGameOwnership } = require('../middleware/auth');

let closeTimer = null;
let advanceTimer = null;
let visualTimer = null;

// requireAuth על הכול — כולל routes קריאת מידע
router.use(requireAuth);

// requireLiveGameOwnership רק על routes שליטה (open/start/pause/close/end).
// routes קריאת מידע (/status, /connected, /leaderboard וכו') לא מקבלים אותו —
// הם נקראים מיד בטעינת הדף ויש להם fallback כשאין משחק פעיל.
// העברת requireLiveGameOwnership גלובלית גרמה לכל הדשבורד לקרוס
// ברגע שאין משחק פעיל (Socket.io reconnect loop).

function getTotalWindowMs(question) {
    // כל משך הזמן האמיתי שבו ימות אמור להיות ב-read= עבור השאלה הזו:
    // חלון "ראש-התחלה" (מכסה את הפיגור הטבעי של ימות בין קבלת הפקודה
    // לתחילת ההאזנה בפועל) + חלון המענה הגלוי שהמנהל הגדיר.
    return (CONFIG.READING_SECONDS + question.answerWindowSeconds) * 1000;
}

// קובע/מאפס את שני הטיימרים של שאלה פתוחה, לפי state.openedAt הנוכחי:
// 1. visualTimer - מתי לשדר ללקוחות שהטיימר הגלוי מתחיל לרוץ (questionTimerStarted)
// 2. closeTimer - מתי לסגור את השאלה בפועל ולחשב תוצאות
// נקרא גם בפתיחה רגילה וגם ב-resume אחרי השהיה, כדי להמשיך בדיוק מאותה נקודה.
function armQuestionTimers(app, question) {
    const totalWindowMs = getTotalWindowMs(question);
    const visualStartAt = state.openedAt + CONFIG.READING_SECONDS * 1000;
    const closeAt = state.openedAt + totalWindowMs + 3000; // 3 שניות חסד לסגירה

    if (visualTimer) clearTimeout(visualTimer);
    const visualDelay = Math.max(0, visualStartAt - Date.now());
    visualTimer = setTimeout(() => {
        if (!state.currentQuestion || String(state.currentQuestion._id) !== String(question._id)) return;
        if (state.status !== 'open') return; // הושהה בינתיים - אל תפעיל טיימר גלוי
        app.get('io').emit('questionTimerStarted', {
            questionId: question._id,
            openedAt: visualStartAt,
            answerWindowSeconds: question.answerWindowSeconds
        });
    }, visualDelay);

    if (closeTimer) clearTimeout(closeTimer);
    const closeDelay = Math.max(0, closeAt - Date.now());
    const capturedOpenedAt = state.openedAt;
    closeTimer = setTimeout(async () => {
        if (
            state.currentQuestion &&
            String(state.currentQuestion._id) === String(question._id) &&
            state.status === 'open'
        ) {
            state.status = 'idle';
            app.get('io').emit('questionClosed', { questionId: question._id });
            await computeAndEmitResults(app, question, capturedOpenedAt);
            if (state.autoAdvance) {
                advanceTimer = setTimeout(() => advanceToNext(app, question), 6000);
            }
        }
    }, closeDelay);
}

// פתיחת שאלה: תשובות נקלטות מיידית (state.status='open' מהשנייה הראשונה) -
// זה נותן לימות "ראש-התחלה" להתגבר על הפיגור הטבעי שלו לפני שהוא מתחיל
// להאזין ללחיצות בפועל. הצופים רואים את השאלה, אבל הטיימר הגלוי מתעכב
// ב-READING_SECONDS - כך שעד שהם רואים אותו זז, ימות כבר קולט לחיצות בזמן אמת.
async function openQuestion(app, question) {
    if (visualTimer) clearTimeout(visualTimer);
    if (closeTimer) clearTimeout(closeTimer);

    state.status = 'open';
    state.currentQuestion = question;
    state.openedAt = Date.now();
    state.pausedRemainingMs = null;
    state.playersAtOpen = await Player.countDocuments({ active: true, game: question.game });

    app.get('io').emit('questionOpened', {
        question,
        autoAdvance: state.autoAdvance,
        readingSeconds: CONFIG.READING_SECONDS,
        answerWindowSeconds: question.answerWindowSeconds
    });

    armQuestionTimers(app, question);
}

async function computeAndEmitResults(app, question, openedAt) {
    const sinceDate = new Date(openedAt);
    const answers = await Answer.find({
        question: question._id,
        answeredAt: { $gte: sinceDate }
    });

    const counts = question.options.map(() => 0);
    answers.forEach((a) => {
        const idx = Number(a.choice) - 1;
        if (counts[idx] !== undefined) counts[idx]++;
    });

    const totalAnswered = answers.length;
    const noAnswerCount = Math.max(0, (state.playersAtOpen || 0) - totalAnswered);
    const percentages = counts.map((c) =>
        totalAnswered ? Math.round((c / totalAnswered) * 100) : 0
    );

    app.get('io').emit('questionResults', {
        questionId: question._id,
        isSurvey: !!question.isSurvey,
        counts, percentages, totalAnswered, noAnswerCount,
        correctIndex: question.isSurvey ? null : question.correctIndex
    });
}

async function advanceToNext(app, prevQuestion) {
    if (!state.autoAdvance) return;
    const next = await Question.findOne({
        game: prevQuestion.game,
        order: { $gt: prevQuestion.order }
    }).sort({ order: 1 });

    if (next) {
        await openQuestion(app, next);
    } else {
        state.autoAdvance = false;
        await finishGame(app, prevQuestion.game);
    }
}

async function buildFinalResults(gameId) {
    const playersAgg = await Player.aggregate([
        { $match: { game: gameId } },
        {
            $group: {
                _id: '$phone',
                score: { $sum: '$score' },
                active: { $max: { $cond: ['$active', 1, 0] } },
                playerIds: { $push: '$_id' }
            }
        }
    ]);

    const allPlayerIds = playersAgg.flatMap((p) => p.playerIds);
    const answerAgg = await Answer.aggregate([
        { $match: { game: gameId, player: { $in: allPlayerIds }, isCorrect: true } },
        { $lookup: { from: 'players', localField: 'player', foreignField: '_id', as: 'pl' } },
        { $unwind: '$pl' },
        {
            $group: {
                _id: '$pl.phone',
                correctAnswers: { $sum: 1 },
                correctTimeSum: { $sum: '$responseTimeMs' },
                correctTimeCount: { $sum: 1 }
            }
        }
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
            avgResponseTimeMs: a.correctTimeCount
                ? Math.round(a.correctTimeSum / a.correctTimeCount)
                : null
        };
    });

    const knownPhones = new Set(known.map((k) => k.phone));
    const manualOnly = contacts
        .filter((c) => !knownPhones.has(c.phone))
        .map((c) => ({
            phone: c.phone, name: c.name || null,
            score: 0, active: false, correctAnswers: 0, avgResponseTimeMs: null
        }));

    const combined = [...known, ...manualOnly].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.avgResponseTimeMs ?? Infinity) - (b.avgResponseTimeMs ?? Infinity);
    });

    return combined.map((p, i) => ({ rank: i + 1, ...p }));
}

async function finishGame(app, gameId) {
    const results = await buildFinalResults(gameId);
    app.get('io').emit('gameEnded', { results });
}

// ===== פעולות שליטה — דורשות משחק פעיל + בעלות =====

router.post('/open-question/:id', requireLiveGameOwnership, async (req, res) => {
    const question = await Question.findOne({ _id: req.params.id, game: req.gameId });
    if (!question) return res.status(404).json({ error: 'שאלה לא נמצאה' });
    if (advanceTimer) clearTimeout(advanceTimer);
    await openQuestion(req.app, question);
    res.json({ success: true, question });
});

router.post('/start-game', requireLiveGameOwnership, async (req, res) => {
    const first = await Question.findOne({ game: req.gameId }).sort({ order: 1 });
    if (!first) return res.status(400).json({ error: 'אין שאלות במאגר' });
    state.autoAdvance = true;
    if (advanceTimer) clearTimeout(advanceTimer);
    await openQuestion(req.app, first);
    res.json({ success: true });
});

// השהיה אמיתית: אם יש שאלה פתוחה כרגע, מקפיאים אותה בפועל - מפסיקים לקלוט
// תשובות (status הופך ל-'paused', לא 'open', ו-yemotRoutes.js בודק בדיוק
// את זה) ומבטלים את שני הטיימרים כדי שלא ייסגר/יתחיל טיימר גלוי באמצע ההשהיה.
router.post('/pause', requireLiveGameOwnership, (req, res) => {
    state.autoAdvance = false;
    if (advanceTimer) clearTimeout(advanceTimer);

    if (state.status === 'open' && state.currentQuestion) {
        if (closeTimer) clearTimeout(closeTimer);
        if (visualTimer) clearTimeout(visualTimer);

        const totalWindowMs = getTotalWindowMs(state.currentQuestion);
        const elapsedMs = Date.now() - state.openedAt;
        state.pausedRemainingMs = Math.max(0, totalWindowMs - elapsedMs);
        state.status = 'paused';
    }

    req.app.get('io').emit('gamePaused', {});
    res.json({ success: true });
});

// המשך: אם הייתה שאלה מושהית, ממשיכים אותה בדיוק מהנקודה שבה הושהתה
// (מזיזים את openedAt אחורה כך שהזמן שנותר יישאר זהה), במקום לפתוח שאלה חדשה.
router.post('/resume', requireLiveGameOwnership, async (req, res) => {
    state.autoAdvance = true;

    if (state.status === 'paused' && state.currentQuestion && state.pausedRemainingMs != null) {
        const question = state.currentQuestion;
        const totalWindowMs = getTotalWindowMs(question);
        state.openedAt = Date.now() - (totalWindowMs - state.pausedRemainingMs);
        state.pausedRemainingMs = null;
        state.status = 'open';
        armQuestionTimers(req.app, question);
    } else if (state.status !== 'open' && state.status !== 'paused') {
        const next = state.currentQuestion
            ? await Question.findOne({ game: req.gameId, order: { $gt: state.currentQuestion.order } }).sort({ order: 1 })
            : await Question.findOne({ game: req.gameId }).sort({ order: 1 });
        if (next) await openQuestion(req.app, next);
    }

    req.app.get('io').emit('gameResumed', {});
    res.json({ success: true });
});

router.post('/close-question', requireLiveGameOwnership, async (req, res) => {
    if (visualTimer) clearTimeout(visualTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (advanceTimer) clearTimeout(advanceTimer);
    const question = state.currentQuestion;
    const openedAt = state.openedAt;
    const wasAnswerable = state.status === 'open' || state.status === 'paused';
    state.status = 'idle';
    state.pausedRemainingMs = null;
    req.app.get('io').emit('questionClosed', { questionId: question?._id });
    if (question && wasAnswerable) await computeAndEmitResults(req.app, question, openedAt);
    res.json({ success: true });
});

router.post('/end-game', requireLiveGameOwnership, async (req, res) => {
    if (visualTimer) clearTimeout(visualTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (advanceTimer) clearTimeout(advanceTimer);
    const question = state.currentQuestion;
    const openedAt = state.openedAt;
    if (question && (state.status === 'open' || state.status === 'paused')) {
        state.status = 'idle';
        req.app.get('io').emit('questionClosed', { questionId: question._id });
        await computeAndEmitResults(req.app, question, openedAt);
    }
    state.autoAdvance = false;
    state.status = 'idle';
    state.currentQuestion = null;
    state.pausedRemainingMs = null;
    await finishGame(req.app, req.gameId);
    res.json({ success: true });
});

// ===== קריאת מידע — requireAuth בלבד, ללא requireLiveGameOwnership =====
// (עובדים גם כשאין משחק פעיל, מחזירים מידע ריק או null)

router.get('/status', (req, res) => {
    res.json({
        status: state.status,
        currentQuestion: state.currentQuestion,
        autoAdvance: state.autoAdvance,
        openedAt: state.openedAt,
        readingSeconds: CONFIG.READING_SECONDS,
        playersAtOpen: state.playersAtOpen,
        activeGame: state.activeGame
    });
});

router.get('/questions', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const questions = await Question.find({ game: state.activeGame._id }).sort({ order: 1 });
    res.json(questions);
});

router.post('/questions', requireLiveGameOwnership, async (req, res) => {
    try {
        const { text, options, answerWindowSeconds } = req.body;
        const isSurvey = !!req.body.isSurvey;
        const correctIndex = req.body.correctIndex != null ? Number(req.body.correctIndex) : null;

        if (!text || !Array.isArray(options) || options.length < 2 || options.length > 9) {
            return res.status(400).json({ error: 'יש למלא טקסט ובין 2 ל-9 אפשרויות' });
        }
        if (!isSurvey && (correctIndex === null || correctIndex < 0 || correctIndex >= options.length)) {
            return res.status(400).json({ error: 'יש לבחור תשובה נכונה תקינה' });
        }

        const count = await Question.countDocuments({ game: req.gameId });
        const question = await Question.create({
            game: req.gameId,
            text,
            options,
            correctIndex: isSurvey ? null : correctIndex,
            isSurvey,
            order: count + 1,
            answerWindowSeconds: Number(answerWindowSeconds) || 15
        });

        res.json({ success: true, question });
    } catch (err) {
        console.error('שגיאה ביצירת שאלה:', err);
        res.status(500).json({ error: 'שגיאה ביצירת השאלה' });
    }
});

router.delete('/questions/:id', requireLiveGameOwnership, async (req, res) => {
    await Question.findOneAndDelete({ _id: req.params.id, game: req.gameId });
    res.json({ success: true });
});

router.post('/questions/reorder', requireLiveGameOwnership, async (req, res) => {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'נתונים לא תקינים' });
    await Promise.all(orderedIds.map((id, idx) =>
        Question.findOneAndUpdate({ _id: id, game: req.gameId }, { order: idx + 1 })
    ));
    res.json({ success: true });
});

router.get('/leaderboard', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const gameId = state.activeGame._id;

    const players = await Player.aggregate([
        { $match: { game: gameId } },
        { $group: { _id: '$phone', score: { $sum: '$score' }, active: { $max: { $cond: ['$active', 1, 0] } } } },
        {
            $lookup: {
                from: 'contacts',
                let: { phone: '$_id' },
                pipeline: [{
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ['$phone', '$$phone'] },
                                { $eq: ['$game', gameId] }
                            ]
                        }
                    }
                }],
                as: 'contact'
            }
        },
        {
            $project: {
                phone: '$_id', score: 1,
                active: { $eq: ['$active', 1] },
                name: { $arrayElemAt: ['$contact.name', 0] },
                _id: 0
            }
        }
    ]);

    const knownPhones = new Set(players.map((p) => p.phone));
    const allContacts = await Contact.find({ game: gameId });
    const manualOnly = allContacts
        .filter((c) => !knownPhones.has(c.phone))
        .map((c) => ({ phone: c.phone, score: 0, active: false, name: c.name || null }));

    res.json([...players, ...manualOnly].sort((a, b) => b.score - a.score));
});

router.get('/leaderboard-speed', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const gameId = state.activeGame._id;

    const speed = await Answer.aggregate([
        { $match: { game: gameId, isCorrect: true, responseTimeMs: { $ne: null } } },
        { $lookup: { from: 'players', localField: 'player', foreignField: '_id', as: 'p' } },
        { $unwind: '$p' },
        { $group: { _id: '$p.phone', totalTimeMs: { $sum: '$responseTimeMs' }, correctCount: { $sum: 1 } } },
        {
            $lookup: {
                from: 'contacts',
                let: { phone: '$_id' },
                pipeline: [{
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ['$phone', '$$phone'] },
                                { $eq: ['$game', gameId] }
                            ]
                        }
                    }
                }],
                as: 'contact'
            }
        },
        {
            $project: {
                phone: '$_id', correctCount: 1,
                avgTimeMs: { $divide: ['$totalTimeMs', '$correctCount'] },
                name: { $arrayElemAt: ['$contact.name', 0] },
                _id: 0
            }
        },
        { $sort: { avgTimeMs: 1 } }
    ]);
    res.json(speed);
});

router.get('/connected', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const gameId = state.activeGame._id;

    const active = await Player.find({ active: true, game: gameId }).sort({ connectedAt: -1 });
    const latestByPhone = new Map();
    for (const p of active) {
        if (!latestByPhone.has(p.phone)) latestByPhone.set(p.phone, p);
    }
    const deduped = Array.from(latestByPhone.values());
    const phones = deduped.map((p) => p.phone);
    const contacts = await Contact.find({ game: gameId, phone: { $in: phones } });
    const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));
    res.json(deduped.map((p) => ({
        phone: p.phone, name: nameMap.get(p.phone) || null,
        connectedAt: p.connectedAt, callId: p.callId
    })));
});

router.get('/contacts', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const gameId = state.activeGame._id;

    const playerPhones = new Set(await Player.distinct('phone', { game: gameId }));
    const contacts = await Contact.find({ game: gameId });
    const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));
    const allPhones = new Set([...playerPhones, ...contacts.map((c) => c.phone)]);
    res.json(Array.from(allPhones).map((phone) => ({
        phone, name: nameMap.get(phone) || null, hasCalled: playerPhones.has(phone)
    })));
});

router.post('/contacts', requireLiveGameOwnership, async (req, res) => {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: 'חסר מספר טלפון' });
    await Contact.findOneAndUpdate({ game: req.gameId, phone }, { name: name || null }, { upsert: true });
    req.app.get('io').emit('contactUpdated', { phone, name: name || null });
    res.json({ success: true });
});

router.delete('/players/:phone', requireLiveGameOwnership, async (req, res) => {
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

router.get('/final-results', async (req, res) => {
    if (!state.activeGame) return res.json([]);
    const results = await buildFinalResults(state.activeGame._id);
    res.json(results);
});

module.exports = router;