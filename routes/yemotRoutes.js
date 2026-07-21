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

// אין שאלה פתוחה כרגע (או שכבר ענינו על הנוכחית) - חוזרים מיד עם wait קצר
// כדי שימות יפנה שוב בעוד רגע (short-polling, במקום hold על ה-response).
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
// המקש הראשון עלול להגיע תחת שם שדה "ישן" (poll, או שאלה קודמת) - כי הטלפון
// עדיין היה בתוך read= קודם ברגע שהשאלה נפתחה/התחלפה. מקבלים אותו כתשובה תקפה
// כל עוד הוא מספר אפשרות חוקי עבור השאלה הפתוחה כרגע.
function extractLooseDigit(body) {
    for (const key of Object.keys(body)) {
        if ((key === 'poll' || key.startsWith('ans_')) && body[key] !== undefined && body[key] !== '') {
            return body[key];
        }
    }
    return undefined;
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

        touch(callId); // כל בקשה חיה = פינג, מתעדכן לפני כל בדיקה אחרת

        if (!state.activeGame) {
            return res.type('text/plain').send('id_list_message=t-אין משחק פעיל כרגע, אנא נסו שוב מאוחר יותר');
        }
        const gameId = state.activeGame._id;

        let player = await Player.findOne({ callId });
        if (!player) {
            const staleActive = await Player.find({ game: gameId, phone, active: true, callId: { $ne: callId } });
            if (staleActive.length) {
                await Player.updateMany(
                    { _id: { $in: staleActive.map((p) => p._id) } },
                    { active: false }
                );
                staleActive.forEach((p) => { forget(p.callId); io.emit('playerDisconnected', { callId: p.callId }); });
            }

            player = await Player.create({ game: gameId, phone, callId });
            const name = await getContactName(gameId, phone);
            io.emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
        } else if (!player.active) {
            player.active = true;
            await player.save();
        }


        let justAnswered = false;
        if (state.status === 'open' && state.currentQuestion) {
            const fieldName = answerFieldName(state.currentQuestion);
            let answer = req.body[fieldName];

            if (answer === undefined) {
                const loose = extractLooseDigit(req.body);
                if (loose !== undefined && Number(loose) >= 1 && Number(loose) <= state.currentQuestion.options.length) {
                    answer = loose;
                }
            }

            if (answer !== undefined) {
                justAnswered = true;
                const isCorrect = answer === String(state.currentQuestion.correctIndex + 1);
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
                    if (isCorrect) {
                        player.score += 10;
                        await player.save();
                    }
                    const name = await getContactName(gameId, phone);
                    io.emit('playerAnswered', {
                        callId, phone, playerId: player._id,
                        questionId: state.currentQuestion._id, choice: answer, isCorrect,
                        responseTimeMs, name
                    });
                } catch (dupErr) {
                    // כבר נשלחה תשובה קודמת לאותה שאלה - מתעלמים בשקט
                }
            }
        }

        if (state.status === 'open' && state.currentQuestion && !justAnswered) {
            const elapsedSec = (Date.now() - state.openedAt) / 1000;
            const remaining = state.currentQuestion.answerWindowSeconds - elapsedSec;
            return res.type('text/plain').send(buildReadCommand(state.currentQuestion, remaining));
        }

        return res.type('text/plain').send(buildPollCommand());
    } catch (err) {
        console.error('שגיאה בטיפול בבקשת ימות:', err);
        res.type('text/plain').send('id_list_message=t-אירעה שגיאה, אנא נסו שוב');
    }
});

module.exports = router;