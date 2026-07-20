const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Question = require('../models/Question');
const Contact = require('../models/Contact');
const Game = require('../models/Game');
const { state, holdResponse, pendingResponses, answerFieldName } = require('../game/gameState');

/**
 * הנתיב הראשי לקבלת פניות ממערכת ימות המשיח
 * POST / GET /yemot/api
 */
router.all('/api', async (req, res) => {
    try {
        const params = { ...req.query, ...req.body };
        const { ApiCallId, ApiPhone } = params;

        if (!ApiCallId) {
            return res.type('text/plain').send('id_list_message=t-שגיאה: לא התקבל מזהה שיחה');
        }

        const io = req.app.get('io');

        // 1. זיהוי וטיפול מיידי באירוע ניתוק (Hangup)
        const isHangup = params.hangup === 'yes' ||
            params.hangup === '1' ||
            params.ApiStatus === 'hangup';

        if (isHangup) {
            if (ApiCallId) {
                await Player.findOneAndUpdate({ callId: ApiCallId }, { active: false });
                pendingResponses.delete(ApiCallId);
                if (io) {
                    io.emit('playerDisconnected', { callId: ApiCallId });
                }
            }
            return res.type('text/plain').send('id_list_message=');
        }

        // 2. בדיקה האם קיים משחק פעיל
        if (!state.activeGame) {
            return res.type('text/plain').send('id_list_message=t-אין משחק פעיל כרגע.&goto=/');
        }

        const gameId = state.activeGame._id;

        // 3. רישום / עדכון סטטוס השחקן
        let player = await Player.findOne({ callId: ApiCallId });
        if (!player) {
            player = await Player.create({
                game: gameId,
                phone: ApiPhone || '0000000000',
                callId: ApiCallId,
                active: true,
                connectedAt: new Date()
            });

            if (io) {
                io.emit('playerConnected', player);
            }
        } else if (!player.active) {
            player.active = true;
            await player.save();
            if (io) {
                io.emit('playerConnected', player);
            }
        }

        // 4. במידה ויש שאלה פתוחה - בדיקה והקלטת תשובה
        if (state.status === 'open' && state.currentQuestion) {
            const q = state.currentQuestion;
            const fieldName = answerFieldName(q);
            const userChoice = params[fieldName] || params.val;

            if (userChoice !== undefined && userChoice !== '') {
                const choiceIndex = parseInt(userChoice, 10) - 1; // המרה ממקש 1-9 לאינדקס 0-based
                const isCorrect = choiceIndex === q.correctIndex;
                const responseTimeMs = Date.now() - state.openedAt;

                // שמירת/עדכון התשובה במסד הנתונים
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

                // העברת השיחה להמתנה עד השאלה הבאה
                res.setHeader('X-Accel-Buffering', 'no');
                res.setHeader('Cache-Control', 'no-cache, no-transform');

                holdResponse(ApiCallId, player.phone, res, async (disconnectedCallId) => {
                    await Player.findOneAndUpdate({ callId: disconnectedCallId }, { active: false });
                    if (io) io.emit('playerDisconnected', { callId: disconnectedCallId });
                });

                return;
            }

            // אם טרם התקבלה תשובה - שליחת פקודת קליטת מקשים (read) לימות המשיח
            const numOptions = q.options ? q.options.length : 4;
            const responseText = `read=t-אנא בחר את התשובה הנכונה.1,${fieldName},${q.answerWindowSeconds || 15},1,${numOptions},#,#,no,no,no,no`;
            return res.type('text/plain').send(responseText);
        }

        // 5. במידה ואין שאלה פתוחה כרגע - החזקת השיחה פתוחה (Hold)
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Cache-Control', 'no-cache, no-transform');

        holdResponse(ApiCallId, player.phone, res, async (disconnectedCallId) => {
            await Player.findOneAndUpdate({ callId: disconnectedCallId }, { active: false });
            if (io) io.emit('playerDisconnected', { callId: disconnectedCallId });
        });

    } catch (err) {
        console.error('Error handling Yemot request:', err);
        res.type('text/plain').send('id_list_message=t-אירעה שגיאה במערכת');
    }
});

module.exports = router;