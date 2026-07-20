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
