const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { CONFIG, touch, forget, answerFieldName, getGameState, findGameStateByCode } = require('../game/gameState');

function roomName(gameId) {
    return `game:${gameId}`;
}

function buildReadCommand(question, remainingSeconds) {
    const wait = Math.max(2, Math.round(remainingSeconds));
    const allowedKeys = question.options.map((_, i) => i + 1).join('');
    return `read=f-001=${answerFieldName(question)},,1,1,${wait},NO,yes,,,${allowedKeys},3,Ok,NOANSWER,,no`;
}

// short-poll: ימות יפנה שוב בעוד POLL_SECONDS שניות (ממתין לשאלה הבאה)
function buildPollCommand() {
    return `read=f-001=poll,,1,1,${CONFIG.POLL_SECONDS},NO,yes,,,,3,Ok,NOANSWER,,no`;
}

// שלב 4: מתקשר חדש (בלי Player עדיין) מתבקש להקיש קוד משחק בן 4 ספרות, כדי
// שהמערכת תדע לאיזה משחק (מתוך כמה שיכולים להיות חיים בו-זמנית) לנתב אותו.
// M1100.wav = "נא הקש סיסמה ובסיום הקש סולמית" - הקלטה קיימת בחשבון ימות.
// **הערה**: מבנה זה מועתק בדיוק מ-buildReadCommand/buildPollCommand הקיימים
// (שכבר עובדים ב-production) עם שינוי רק בפרמטרים הברורים (שם שדה, 4 ספרות
// בדיוק, כל 10 הספרות מותרות, קובץ הקול). לא אומת מול תיעוד ימות רשמי אם
// הקלט מסתיים אוטומטית אחרי 4 ספרות או ממתין ל-# כפי שההקלטה אומרת - יש
// לבדוק בשיחת אמת ולעדכן אם ההתנהגות בפועל שונה.
function buildCodeEntryCommand() {
    return `read=f-001=game_code,,4,4,${CONFIG.CODE_ENTRY_TIMEOUT_SECONDS},NO,yes,,,0123456789,3,M1100,NOANSWER,,no`;
}

async function markDisconnected(io, callId) {
    forget(callId);
    // מחפשים לפני forget איזה game היה שייך לשחקן הזה, כדי לשדר ל-room הנכון
    const player = await Player.findOneAndUpdate({ callId }, { active: false });
    if (player) {
        io.to(roomName(player.game)).emit('playerDisconnected', { callId });
    }
}

async function getContactName(gameId, phone) {
    const contact = await Contact.findOne({ game: gameId, phone });
    return contact ? contact.name : null;
}

router.post('/api', async (req, res) => {
    const startedAt = Date.now();
    const { ApiCallId: callId, ApiPhone: phone, hangup } = req.body;
    console.log(`[YEMOT-IN] callId=${callId || '?'} phone=${phone || '?'} hangup=${hangup || 'no'}`);

    // עוטף כל תשובה לימות בלוג אחיד - כדי לתאם זמני תגובה מול ניתוקים בזמן מבחן עומס
    function sendOut(label, body) {
        console.log(`[YEMOT-OUT] callId=${callId || '?'} label=${label} tookMs=${Date.now() - startedAt}`);
        return res.type('text/plain').send(body);
    }

    try {
        const io = req.app.get('io');

        if (!callId) {
            return sendOut('no-callid-error', 'id_list_message=t-שגיאה טכנית, אנא נסו שוב מאוחר יותר');
        }

        if (hangup === 'yes') {
            await markDisconnected(io, callId);
            return sendOut('hangup-ack', '');
        }

        // ===== מציאת שחקן קיים (כבר עבר את שלב הקוד ושייך למשחק ספציפי) =====
        let player = await Player.findOne({ callId });

        if (!player) {
            // מתקשר חדש - עדיין לא ידוע לאיזה משחק. מבקשים קוד משחק (שלב 4).
            const enteredCode = req.body.game_code;
            if (!enteredCode) {
                return sendOut('ask-code', buildCodeEntryCommand());
            }

            const gs = findGameStateByCode(enteredCode);
            if (!gs) {
                // קוד שגוי/לא תואם משחק חי - מבקשים שוב. הוחלט: בלי הגבלת ניסיונות.
                return sendOut('bad-code', buildCodeEntryCommand());
            }

            const gameId = gs.activeGame._id;
            touch(callId, gameId);

            // סגירת רשומות "פעילות" ישנות לאותו טלפון **באותו משחק** (טלפון לא
            // יכול להתקשר פעמיים בו-זמנית לאותו משחק)
            const staleActive = await Player.find({ game: gameId, phone, active: true, callId: { $ne: callId } });
            if (staleActive.length) {
                await Player.updateMany({ _id: { $in: staleActive.map(p => p._id) } }, { active: false });
                staleActive.forEach(p => { forget(p.callId); io.to(roomName(gameId)).emit('playerDisconnected', { callId: p.callId }); });
            }

            player = await Player.create({ game: gameId, phone, callId });
            const name = await getContactName(gameId, phone);
            io.to(roomName(gameId)).emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
            // ממשיכים מיד לפרוטוקול הרגיל (poll/read) עבור המשחק הזה, באותה בקשה עצמה
        } else if (!player.active) {
            // חוזר לפעילות אחרי ניתוק (למשל: ניתוק זמני ברשת, לא hangup אמיתי).
            touch(callId, player.game);
            player.active = true;
            await player.save();
            const name = await getContactName(player.game, phone);
            io.to(roomName(player.game)).emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
        } else {
            touch(callId, player.game);
        }

        const gameId = player.game;
        const gs = getGameState(gameId);
        if (!gs) {
            // המשחק שהשחקן הזה שייך אליו כבר לא חי (המנחה עצר אותו) - אין state
            // בזיכרון בשבילו. שונה מ"אין משחק פעיל כרגע" הישן (שהיה גלובלי) -
            // עכשיו זה ספציפי לשחקן הזה בלבד ולא משפיע על משחקים אחרים.
            return sendOut('game-no-longer-live', 'id_list_message=t-המשחק הסתיים, תודה שהשתתפתם');
        }

        // ===== קליטת תשובה לשאלה פתוחה =====
        // חשוב: בודקים רק את השדה הספציפי של השאלה הנוכחית (answerFieldName).
        // לא משתמשים ב-extractLooseDigit — כי ימות שומר שדות ישנים ב-session ומחזיר
        // אותם בפינגים עתידיים, מה שגרם לקליטת תשובות מהשאלה הקודמת כתשובות לשאלה הנוכחית
        // (הבאג של "צריך ללחוץ פעמיים משאלה 2 ואילך").
        let justAnswered = false;
        if (gs.status === 'open' && gs.currentQuestion) {
            const fieldName = answerFieldName(gs.currentQuestion);
            const answer = req.body[fieldName];

            if (answer !== undefined && answer !== '') {
                justAnswered = true;
                const isSurvey = !!gs.currentQuestion.isSurvey;

                // לשאלת סקר: אין "נכון/לא נכון", תמיד isCorrect=false, אין ניקוד
                const isCorrect = isSurvey
                    ? false
                    : answer === String(gs.currentQuestion.correctIndex + 1);

                // זמן תגובה נמדד מרגע תחילת הטיימר הגלוי (לא מ-gs.openedAt האמיתי,
                // שמקדים אותו ב-READING_SECONDS) - כדי שהניקוד/דירוג המהירות ישקפו
                // בדיוק את מה שהשחקן עצמו חווה וראה על המסך.
                const visualStartAt = gs.openedAt + CONFIG.READING_SECONDS * 1000;
                const responseTimeMs = Math.max(0, Date.now() - visualStartAt);

                try {
                    await Answer.create({
                        game: gameId,
                        player: player._id,
                        question: gs.currentQuestion._id,
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
                    io.to(roomName(gameId)).emit('playerAnswered', {
                        callId, phone, playerId: player._id,
                        questionId: gs.currentQuestion._id,
                        choice: answer, isCorrect, isSurvey,
                        responseTimeMs, name
                    });
                } catch (dupErr) {
                    // כבר נשלחה תשובה קודמת לאותה שאלה (unique index) — מתעלמים בשקט
                }
            }
        }

        // ===== מה להחזיר לימות =====
        if (gs.status === 'open' && gs.currentQuestion && !justAnswered) {
            const elapsedSec = (Date.now() - gs.openedAt) / 1000;
            // חלון אמיתי = ראש-התחלה (מכסה את הפיגור הטבעי של ימות) + חלון המענה הגלוי
            const totalWindowSec = CONFIG.READING_SECONDS + gs.currentQuestion.answerWindowSeconds;
            const remaining = totalWindowSec - elapsedSec;
            if (remaining > 1) {
                return sendOut('read-question', buildReadCommand(gs.currentQuestion, remaining));
            }
        }

        // אין שאלה פתוחה, השחקן כבר ענה, או שהזמן נגמר — poll קצר עד השאלה הבאה
        return sendOut('poll', buildPollCommand());

    } catch (err) {
        console.error('שגיאה בטיפול בבקשת ימות:', err);
        return sendOut('error', 'id_list_message=t-אירעה שגיאה, אנא נסו שוב');
    }
});

module.exports = router;
