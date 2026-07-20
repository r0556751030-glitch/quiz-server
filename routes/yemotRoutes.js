const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const { state, holdResponse, pendingResponses, answerFieldName, touch, lastSeen } = require('../game/gameState');

router.all('/api', async (req, res) => {
    try {
        const params = { ...req.query, ...req.body };
        const { ApiCallId, ApiPhone } = params;

        if (!ApiCallId) {
            return res.type('text/plain').send('id_list_message=t-שגיאה: לא התקבל מזהה שיחה');
        }

        const io = req.app.get('io');

        // 1. עדכון נוכחות לפי זמן - מופעל בכל פנייה מול ימות המשיח
        touch(ApiCallId);

        // 2. זיהוי ניתוק מפורש
        const isHangup = params.hangup === 'yes' || params.hangup === '1' || params.ApiStatus === 'hangup';
        if (isHangup) {
            await Player.findOneAndUpdate({ callId: ApiCallId }, { active: false });
            pendingResponses.delete(ApiCallId);
            lastSeen.delete(ApiCallId);
            if (io) io.emit('playerDisconnected', { callId: ApiCallId });
            return res.type('text/plain').send('id_list_message=');
        }

        if (!state.activeGame) {
            return res.type('text/plain').send('id_list_message=t-אין משחק פעיל כרגע.&goto=/');
        }

        const gameId = state.activeGame._id;
        const cleanPhone = ApiPhone || '0000000000';

        // 3. יצירת/עדכון שחקן תוך מחיקת רוחות רפאים (Ghosts) של אותה שיחה
        let player = await Player.findOne({ callId: ApiCallId });
        if (!player) {
            // ביטול רשומות פעילות ישנות של אותו מספר טלפון
            await Player.updateMany({ phone: cleanPhone, active: true }, { active: false });

            player = await Player.create({
                game: gameId,
                phone: cleanPhone,
                callId: ApiCallId,
                active: true,
                connectedAt: new Date()
            });

            if (io) io.emit('playerConnected', player);
        } else if (!player.active) {
            player.active = true;
            await player.save();
            if (io) io.emit('playerConnected', player);
        }

        // 4. במידה ויש שאלה פתוחה
        if (state.status === 'open' && state.currentQuestion) {
            const q = state.currentQuestion;
            const fieldName = answerFieldName(q);
            const userChoice = params[fieldName] || params.val;

            if (userChoice !== undefined && userChoice !== '') {
                const choiceIndex = parseInt(userChoice, 10) - 1;
                const isCorrect = choiceIndex === q.correctIndex;
                const responseTimeMs = Date.now() - state.openedAt;

                await Answer.findOneAndUpdate(
                    { player: player._id, question: q._id },
                    {
                        game: gameId,
                        player: player._id,
                        question: q._id,
                        choice: userChoice,
                        isCorrect,
                        responseTimeMs,
                        answeredAt: new Date()
                    },
                    { upsert: true, new: true }
                );

                if (isCorrect) {
                    player.score = (player.score || 0) + 10;
                    await player.save();
                }

                if (io) {
                    io.emit('answerReceived', {
                        playerId: player._id,
                        questionId: q._id,
                        isCorrect,
                        score: player.score
                    });
                }

                res.setHeader('X-Accel-Buffering', 'no');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                holdResponse(ApiCallId, player.phone, res);
                return;
            }

            const numOptions = q.options ? q.options.length : 4;
            const responseText = `read=t-אנא בחר את התשובה הנכונה.1,${fieldName},${q.answerWindowSeconds || 15},1,${numOptions},#,#,no,no,no,no`;
            return res.type('text/plain').send(responseText);
        }

        // 5. במצב בהמתנה (Hold)
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        holdResponse(ApiCallId, player.phone, res);

    } catch (err) {
        console.error('Error handling Yemot request:', err);
        res.type('text/plain').send('id_list_message=t-אירעה שגיאה במערכת');
    }
});

module.exports = router;