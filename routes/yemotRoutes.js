const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, CONFIG, touch, forget, answerFieldName } = require('../game/gameState');

function buildReadCommand(question, remainingSeconds) {
    const wait = Math.max(2, Math.round(remainingSeconds));
    const allowedKeys = question.options.map((_, i) => i + 1).join('');
    return `read=f-001=${answerFieldName(question)},,1,1,${wait},NO,yes,,,${allowedKeys},3,Ok,NOANSWER,,no`;
}

// short-poll: ימות יפנה שוב בעוד POLL_SECONDS שניות (ממתין לשאלה הבאה)
function buildPollCommand() {
    return `read=f-001=poll,,1,1,${CONFIG.POLL_SECONDS},NO,yes,,,,3,Ok,NOANSWER,,no`;
}

async function markDisconnected(io, callId) {
    forget(callId);
    await Player.updateOne({ callId }, { active: false });
    io.emit('playerDisconnected', { callId });
}

async function getContactName(gameId, phone) {
    const contact = await Contact.findOne({ game: gameId, phone });
    return contact ? contact.name : null;
}

router.post('/api', async (req, res) => {
    try {
        const { ApiCallId: callId, ApiPhone: phone, hangup } = req.body;
        const io = req.app.get('io');

        if (!callId) {
            return res.type('text/plain').send('id_list_message=t-שגיאה טכנית, אנא נסו שוב מאוחר יותר');
        }

        if (hangup === 'yes') {
            await markDisconnected(io, callId);
            return res.type('text/plain').send('');
        }

        touch(callId); // כל בקשה חיה = פינג

        if (!state.activeGame) {
            return res.type('text/plain').send('id_list_message=t-אין משחק פעיל כרגע, אנא נסו שוב מאוחר יותר');
        }
        const gameId = state.activeGame._id;

        // ===== מציאה/יצירה של שחקן =====
        let player = await Player.findOne({ callId });
        if (!player) {
            // סגירת רשומות "פעילות" ישנות לאותו טלפון (טלפון לא יכול להתקשר פעמיים בו-זמנית)
            const staleActive = await Player.find({ game: gameId, phone, active: true, callId: { $ne: callId } });
            if (staleActive.length) {
                await Player.updateMany({ _id: { $in: staleActive.map(p => p._id) } }, { active: false });
                staleActive.forEach(p => { forget(p.callId); io.emit('playerDisconnected', { callId: p.callId }); });
            }
            player = await Player.create({ game: gameId, phone, callId });
            const name = await getContactName(gameId, phone);
            io.emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
        } else if (!player.active) {
            player.active = true;
            await player.save();
        }

        // ===== קליטת תשובה לשאלה פתוחה =====
        // חשוב: בודקים רק את השדה הספציפי של השאלה הנוכחית (answerFieldName).
        // לא משתמשים ב-extractLooseDigit — כי ימות שומר שדות ישנים ב-session ומחזיר
        // אותם בפינגים עתידיים, מה שגרם לקליטת תשובות מהשאלה הקודמת כתשובות לשאלה הנוכחית
        // (הבאג של "צריך ללחוץ פעמיים משאלה 2 ואילך").
        let justAnswered = false;
        if (state.status === 'open' && state.currentQuestion) {
            const fieldName = answerFieldName(state.currentQuestion);
            const answer = req.body[fieldName];

            if (answer !== undefined && answer !== '') {
                justAnswered = true;
                const isSurvey = !!state.currentQuestion.isSurvey;

                // לשאלת סקר: אין "נכון/לא נכון", תמיד isCorrect=false, אין ניקוד
                const isCorrect = isSurvey
                    ? false
                    : answer === String(state.currentQuestion.correctIndex + 1);

                const responseTimeMs = Date.now() - state.openedAt;

                try {
                    await Answer.create({
                        game: gameId,
                        player: player._id,
                        question: state.currentQuestion._id,
                        choice: answer,
                        isCorrect,
                        responseTimeMs
                    });

                    // ניקוד: רק בשאלות ידע (לא סקר)
                    if (!isSurvey && isCorrect) {
                        player.score += 10;
                        await player.save();
                    }

                    const name = await getContactName(gameId, phone);
                    io.emit('playerAnswered', {
                        callId, phone, playerId: player._id,
                        questionId: state.currentQuestion._id,
                        choice: answer, isCorrect, isSurvey,
                        responseTimeMs, name
                    });
                } catch (dupErr) {
                    // כבר נשלחה תשובה קודמת לאותה שאלה (unique index) — מתעלמים בשקט
                }
            }
        }

        // ===== מה להחזיר לימות =====
        if (state.status === 'open' && state.currentQuestion && !justAnswered) {
            const elapsedSec = (Date.now() - state.openedAt) / 1000;
            const remaining = state.currentQuestion.answerWindowSeconds - elapsedSec;
            if (remaining > 1) {
                return res.type('text/plain').send(buildReadCommand(state.currentQuestion, remaining));
            }
        }

        // אין שאלה פתוחה, השחקן כבר ענה, או שהזמן נגמר — poll קצר עד השאלה הבאה
        return res.type('text/plain').send(buildPollCommand());

    } catch (err) {
        console.error('שגיאה בטיפול בבקשת ימות:', err);
        res.type('text/plain').send('id_list_message=t-אירעה שגיאה, אנא נסו שוב');
    }
});

module.exports = router;