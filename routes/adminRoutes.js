const express = require('express');
const router = express.Router();
const Question = require('../models/Question');
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { getGameState, CONFIG } = require('../game/gameState');
const { requireAuth, requireGameContext } = require('../middleware/auth');

function roomName(gameId) {
    return `game:${gameId}`;
}

// requireAuth + requireGameContext על הכול: כל בקשה ל-/admin/* חייבת לציין
// gameId ספציפי (שלב 4 - כמה משחקים יכולים להיות חיים בו-זמנית, אין יותר
// "המשחק החי היחיד" גלובלית). requireGameContext בודק בעלות/הרשאה ומגדיר
// req.gameId + req.gameDoc - גם אם המשחק הזה לא "חי" כרגע בזיכרון (למשל
// טעינת רשימת שאלות לפני שמפעילים את המשחק).
router.use(requireAuth);
router.use(requireGameContext);

// לפעולות שליטה (open/start/pause/close/end) שדורשות שהמשחק הזה יהיה חי כרגע
// בזיכרון (gs). routes קריאת מידע בלבד לא מקבלים את זה - הם עובדים גם על משחק
// לא-חי (מציגים נתונים היסטוריים/ריקים).
function requireLiveState(req, res, next) {
    const gs = getGameState(req.gameId);
    if (!gs) return res.status(404).json({ error: 'המשחק הזה לא חי כרגע - יש להפעיל אותו מתוך "המשחקים שלי"' });
    req.gameState = gs;
    next();
}

function getTotalWindowMs(question) {
    return (CONFIG.READING_SECONDS + question.answerWindowSeconds) * 1000;
}

function armQuestionTimers(io, gs, question) {
    const gameId = gs.activeGame._id;
    const totalWindowMs = getTotalWindowMs(question);
    const visualStartAt = gs.openedAt + CONFIG.READING_SECONDS * 1000;
    const closeAt = gs.openedAt + totalWindowMs + 3000;

    if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);
    const visualDelay = Math.max(0, visualStartAt - Date.now());
    gs.timers.visualTimer = setTimeout(() => {
        if (!gs.currentQuestion || String(gs.currentQuestion._id) !== String(question._id)) return;
        if (gs.status !== 'open') return;
        io.to(roomName(gameId)).emit('questionTimerStarted', {
            questionId: question._id,
            openedAt: visualStartAt,
            answerWindowSeconds: question.answerWindowSeconds
        });
    }, visualDelay);

    if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);
    const closeDelay = Math.max(0, closeAt - Date.now());
    const capturedOpenedAt = gs.openedAt;
    gs.timers.closeTimer = setTimeout(async () => {
        if (
            gs.currentQuestion &&
            String(gs.currentQuestion._id) === String(question._id) &&
            gs.status === 'open'
        ) {
            gs.status = 'idle';
            io.to(roomName(gameId)).emit('questionClosed', { questionId: question._id });
            await computeAndEmitResults(io, gs, question, capturedOpenedAt);
        }
    }, closeDelay);
}

async function getNavAvailability(gameId, question) {
    if (!question) return { hasNext: false, hasPrev: false };
    const [next, prev] = await Promise.all([
        Question.findOne({ game: gameId, order: { $gt: question.order } }),
        Question.findOne({ game: gameId, order: { $lt: question.order } })
    ]);
    return { hasNext: !!next, hasPrev: !!prev };
}

async function openQuestion(io, gs, question) {
    if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);
    if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);

    gs.status = 'displayed';
    gs.currentQuestion = question;
    gs.openedAt = null;
    gs.pausedRemainingMs = null;

    const gameId = gs.activeGame._id;
    const nav = await getNavAvailability(gameId, question);
    io.to(roomName(gameId)).emit('questionOpened', {
        question,
        autoAdvance: gs.autoAdvance,
        ...nav
    });
}

async function beginAnswering(io, gs) {
    const question = gs.currentQuestion;
    if (!question || gs.status !== 'displayed') return false;

    gs.status = 'open';
    gs.openedAt = Date.now();
    gs.pausedRemainingMs = null;
    gs.playersAtOpen = await Player.countDocuments({ active: true, game: question.game });

    const gameId = gs.activeGame._id;
    io.to(roomName(gameId)).emit('answeringBegan', {
        questionId: question._id,
        readingSeconds: CONFIG.READING_SECONDS,
        answerWindowSeconds: question.answerWindowSeconds
    });

    armQuestionTimers(io, gs, question);
    return true;
}

async function computeAndEmitResults(io, gs, question, openedAt) {
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
    const noAnswerCount = Math.max(0, (gs.playersAtOpen || 0) - totalAnswered);
    const percentages = counts.map((c) =>
        totalAnswered ? Math.round((c / totalAnswered) * 100) : 0
    );

    io.to(roomName(gs.activeGame._id)).emit('questionResults', {
        questionId: question._id,
        isSurvey: !!question.isSurvey,
        counts, percentages, totalAnswered, noAnswerCount,
        correctIndex: question.isSurvey ? null : question.correctIndex
    });
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

async function finishGame(io, gameId) {
    const results = await buildFinalResults(gameId);
    io.to(roomName(gameId)).emit('gameEnded', { results });
}

// ===== פעולות שליטה — דורשות שהמשחק הזה יהיה חי כרגע (requireLiveState) =====

router.post('/open-question/:id', requireLiveState, async (req, res) => {
    const question = await Question.findOne({ _id: req.params.id, game: req.gameId });
    if (!question) return res.status(404).json({ error: 'שאלה לא נמצאה' });
    await openQuestion(req.app.get('io'), req.gameState, question);
    res.json({ success: true, question });
});

router.post('/next-question', requireLiveState, async (req, res) => {
    const gs = req.gameState;
    const current = gs.currentQuestion;
    const query = current
        ? { game: req.gameId, order: { $gt: current.order } }
        : { game: req.gameId };
    const next = await Question.findOne(query).sort({ order: 1 });
    if (!next) return res.status(400).json({ error: 'זו כבר השאלה האחרונה' });
    await openQuestion(req.app.get('io'), gs, next);
    res.json({ success: true, question: next });
});

router.post('/prev-question', requireLiveState, async (req, res) => {
    const gs = req.gameState;
    const current = gs.currentQuestion;
    if (!current) return res.status(400).json({ error: 'אין שאלה נוכחית' });
    const prev = await Question.findOne({ game: req.gameId, order: { $lt: current.order } }).sort({ order: -1 });
    if (!prev) return res.status(400).json({ error: 'זו כבר השאלה הראשונה' });
    await openQuestion(req.app.get('io'), gs, prev);
    res.json({ success: true, question: prev });
});

router.get('/start-game-preview', requireLiveState, async (req, res) => {
    const [playerCount, answerCount] = await Promise.all([
        Player.countDocuments({ game: req.gameId }),
        Answer.countDocuments({ game: req.gameId })
    ]);
    res.json({ playerCount, answerCount });
});

router.post('/start-game', requireLiveState, async (req, res) => {
    const first = await Question.findOne({ game: req.gameId }).sort({ order: 1 });
    if (!first) return res.status(400).json({ error: 'אין שאלות במאגר' });

    await Promise.all([
        Player.deleteMany({ game: req.gameId }),
        Answer.deleteMany({ game: req.gameId })
    ]);

    req.gameState.autoAdvance = true;
    await openQuestion(req.app.get('io'), req.gameState, first);
    res.json({ success: true });
});

router.post('/begin-answering', requireLiveState, async (req, res) => {
    const ok = await beginAnswering(req.app.get('io'), req.gameState);
    if (!ok) return res.status(400).json({ error: 'אין שאלה מוצגת שממתינה לפתיחת מענה' });
    res.json({ success: true });
});

router.post('/pause', requireLiveState, (req, res) => {
    const gs = req.gameState;
    gs.autoAdvance = false;

    if (gs.status === 'open' && gs.currentQuestion) {
        if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);
        if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);

        const totalWindowMs = getTotalWindowMs(gs.currentQuestion);
        const elapsedMs = Date.now() - gs.openedAt;
        gs.pausedRemainingMs = Math.max(0, totalWindowMs - elapsedMs);
        gs.status = 'paused';
    }

    req.app.get('io').to(roomName(req.gameId)).emit('gamePaused', {});
    res.json({ success: true });
});

router.post('/resume', requireLiveState, async (req, res) => {
    const gs = req.gameState;
    const io = req.app.get('io');
    gs.autoAdvance = true;

    if (gs.status === 'paused' && gs.currentQuestion && gs.pausedRemainingMs != null) {
        const question = gs.currentQuestion;
        const totalWindowMs = getTotalWindowMs(question);
        gs.openedAt = Date.now() - (totalWindowMs - gs.pausedRemainingMs);
        gs.pausedRemainingMs = null;
        gs.status = 'open';
        armQuestionTimers(io, gs, question);
    } else if (gs.status !== 'open' && gs.status !== 'paused' && gs.status !== 'displayed') {
        const next = gs.currentQuestion
            ? await Question.findOne({ game: req.gameId, order: { $gt: gs.currentQuestion.order } }).sort({ order: 1 })
            : await Question.findOne({ game: req.gameId }).sort({ order: 1 });
        if (next) await openQuestion(io, gs, next);
    }

    io.to(roomName(req.gameId)).emit('gameResumed', {});
    res.json({ success: true });
});

router.post('/close-question', requireLiveState, async (req, res) => {
    const gs = req.gameState;
    const io = req.app.get('io');
    if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);
    if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);
    const question = gs.currentQuestion;
    const openedAt = gs.openedAt;
    const wasAnswerable = gs.status === 'open' || gs.status === 'paused';
    gs.status = 'idle';
    gs.pausedRemainingMs = null;
    io.to(roomName(req.gameId)).emit('questionClosed', { questionId: question?._id });
    if (question && wasAnswerable) await computeAndEmitResults(io, gs, question, openedAt);
    res.json({ success: true });
});

router.post('/end-game', requireLiveState, async (req, res) => {
    const gs = req.gameState;
    const io = req.app.get('io');
    if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);
    if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);
    const question = gs.currentQuestion;
    const openedAt = gs.openedAt;
    if (question && (gs.status === 'open' || gs.status === 'paused')) {
        gs.status = 'idle';
        io.to(roomName(req.gameId)).emit('questionClosed', { questionId: question._id });
        await computeAndEmitResults(io, gs, question, openedAt);
    }
    gs.autoAdvance = false;
    gs.status = 'idle';
    gs.currentQuestion = null;
    gs.pausedRemainingMs = null;
    await finishGame(io, req.gameId);
    res.json({ success: true });
});

// ===== קריאת מידע — requireGameContext בלבד (כבר הוגדר גלובלית למעלה) =====

router.get('/status', async (req, res) => {
    const gs = getGameState(req.gameId);
    if (!gs) {
        return res.json({
            status: 'idle', currentQuestion: null, autoAdvance: false, openedAt: null,
            readingSeconds: CONFIG.READING_SECONDS, playersAtOpen: 0, activeGame: null,
            hasNext: false, hasPrev: false
        });
    }
    const nav = await getNavAvailability(req.gameId, gs.currentQuestion);
    res.json({
        status: gs.status,
        currentQuestion: gs.currentQuestion,
        autoAdvance: gs.autoAdvance,
        openedAt: gs.openedAt,
        readingSeconds: CONFIG.READING_SECONDS,
        playersAtOpen: gs.playersAtOpen,
        activeGame: gs.activeGame,
        ...nav
    });
});

router.get('/questions', async (req, res) => {
    const questions = await Question.find({ game: req.gameId }).sort({ order: 1 });
    res.json(questions);
});

router.post('/questions', requireLiveState, async (req, res) => {
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

router.patch('/questions/:id', requireLiveState, async (req, res) => {
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

        const question = await Question.findOneAndUpdate(
            { _id: req.params.id, game: req.gameId },
            {
                text,
                options,
                correctIndex: isSurvey ? null : correctIndex,
                isSurvey,
                answerWindowSeconds: Number(answerWindowSeconds) || 15
            },
            { new: true }
        );

        if (!question) return res.status(404).json({ error: 'שאלה לא נמצאה' });

        res.json({ success: true, question });
    } catch (err) {
        console.error('שגיאה בעריכת שאלה:', err);
        res.status(500).json({ error: 'שגיאה בעריכת השאלה' });
    }
});

router.delete('/questions/:id', requireLiveState, async (req, res) => {
    await Question.findOneAndDelete({ _id: req.params.id, game: req.gameId });
    res.json({ success: true });
});

router.post('/questions/reorder', requireLiveState, async (req, res) => {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'נתונים לא תקינים' });
    await Promise.all(orderedIds.map((id, idx) =>
        Question.findOneAndUpdate({ _id: id, game: req.gameId }, { order: idx + 1 })
    ));
    res.json({ success: true });
});

router.get('/leaderboard', async (req, res) => {
    const gameId = req.gameId;

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
    const gameId = req.gameId;

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
    const gameId = req.gameId;

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
    const gameId = req.gameId;

    const playerPhones = new Set(await Player.distinct('phone', { game: gameId }));
    const contacts = await Contact.find({ game: gameId });
    const nameMap = new Map(contacts.map((c) => [c.phone, c.name]));
    const allPhones = new Set([...playerPhones, ...contacts.map((c) => c.phone)]);
    res.json(Array.from(allPhones).map((phone) => ({
        phone, name: nameMap.get(phone) || null, hasCalled: playerPhones.has(phone)
    })));
});

router.post('/contacts', requireLiveState, async (req, res) => {
    try {
        const { phone, name } = req.body;
        if (!phone) return res.status(400).json({ error: 'חסר מספר טלפון' });

        try {
            await Contact.findOneAndUpdate(
                { game: req.gameId, phone },
                { game: req.gameId, phone, name: name || null },
                { upsert: true }
            );
        } catch (innerErr) {
            if (innerErr.code === 11000) {
                const existing = await Contact.findOne({ game: req.gameId, phone });
                if (existing) {
                    existing.name = name || null;
                    await existing.save();
                } else {
                    console.error(`[CONTACTS] duplicate-key על phone=${phone} game=${req.gameId} בלי קונטקט קיים למשחק הזה - קרוב לוודאי אינדקס ישן ב-DB (unique על phone לבד)`);
                    return res.status(409).json({
                        error: 'לא ניתן לשמור איש קשר זה כרגע - קיים סיכוך באינדקס בסיס הנתונים (טלפון זה כנראה רשום למשחק אחר). יש לפנות למפתח לתיקון האינדקס.'
                    });
                }
            } else {
                throw innerErr;
            }
        }

        req.app.get('io').to(roomName(req.gameId)).emit('contactUpdated', { phone, name: name || null });
        res.json({ success: true });
    } catch (err) {
        console.error('שגיאה בהוספת איש קשר:', err);
        res.status(500).json({ error: 'שגיאת שרת: ' + err.message });
    }
});

router.delete('/players/:phone', requireLiveState, async (req, res) => {
    const { phone } = req.params;
    const players = await Player.find({ game: req.gameId, phone });
    const playerIds = players.map((p) => p._id);
    await Promise.all([
        Answer.deleteMany({ game: req.gameId, player: { $in: playerIds } }),
        Player.deleteMany({ game: req.gameId, phone }),
        Contact.deleteOne({ game: req.gameId, phone })
    ]);
    req.app.get('io').to(roomName(req.gameId)).emit('playerDeleted', { phone });
    res.json({ success: true });
});

router.get('/final-results', async (req, res) => {
    const results = await buildFinalResults(req.gameId);
    res.json(results);
});

module.exports = router;
