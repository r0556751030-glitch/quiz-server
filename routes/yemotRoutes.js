const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const Game = require('../models/Game');
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
//
// **גרסה זו קולטת ספרה אחת בכל פעם** (min=1,max=1) - בדיוק אותה תבנית מוכחת
// שכבר קולטת תשובות לשאלות ב-production (ראו buildReadCommand). הניסיון
// הקודם (בקשת 4 ספרות בבת אחת, ,,4,4,...) קיבל "בחירה לא חוקית" מימות בבדיקה
// אמיתית - לא היה ברור למה, ובלי תיעוד רשמי של ימות העדפנו לחזור לתבנית
// המוכחת במקום לנחש עוד פרמטרים.
//
// שם השדה משתנה בכל ניסיון (code1_<attempt>, code2_<attempt> וכו') - כי ימות
// שומר ערכי שדה ישנים ומחזיר אותם שוב בבקשות עתידיות (בדיוק כמו הבאג הידוע
// עם ans_<questionId>). בלי זה, קוד שגוי בניסיון 1 היה "מזהם" עם הספרות
// הישנות שלו את הניסיון הבא באותם שמות שדה.
const codeEntryAttempt = new Map(); // callId -> מספר הניסיון הנוכחי (מתחיל מ-1)

function buildCodeDigitCommand(fieldName, withIntro) {
    // M1100.wav = "נא הקש סיסמה ובסיום הקש סולמית" - מושמע רק בספרה הראשונה
    // של כל ניסיון (withIntro=true). בשאר הספרות באותו ניסיון, "Ok" (כמו
    // בתבניות הקיימות) - כדי לא להשמיע את כל ההודעה מחדש על כל ספרה.
    const voiceFile = withIntro ? 'M1100' : 'Ok';
    return `read=f-001=${fieldName},,1,1,${CONFIG.CODE_ENTRY_TIMEOUT_SECONDS},NO,yes,,,0123456789,3,${voiceFile},NOANSWER,,no`;
}

async function markDisconnected(io, callId) {
    forget(callId);
    codeEntryAttempt.delete(callId);
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
            // מתקשר חדש - עדיין לא ידוע לאיזה משחק. מבקשים קוד משחק, ספרה אחת
            // בכל פעם (שלב 4). attempt קובע את שמות השדות של הניסיון הנוכחי.
            const attempt = codeEntryAttempt.get(callId) || 1;
            const f1 = `code1_${attempt}`, f2 = `code2_${attempt}`, f3 = `code3_${attempt}`, f4 = `code4_${attempt}`;
            const c1 = req.body[f1], c2 = req.body[f2], c3 = req.body[f3], c4 = req.body[f4];

            if (!c1) return sendOut(`ask-code-1-a${attempt}`, buildCodeDigitCommand(f1, true));
            if (!c2) return sendOut(`ask-code-2-a${attempt}`, buildCodeDigitCommand(f2, false));
            if (!c3) return sendOut(`ask-code-3-a${attempt}`, buildCodeDigitCommand(f3, false));
            if (!c4) return sendOut(`ask-code-4-a${attempt}`, buildCodeDigitCommand(f4, false));

            const enteredCode = `${c1}${c2}${c3}${c4}`;
            const gs = findGameStateByCode(enteredCode);
            if (!gs) {
                // קוד שגוי/לא תואם משחק חי - מתחילים ניסיון חדש עם שמות שדה
                // חדשים (בלי הגבלת ניסיונות, כפי שהוחלט).
                const nextAttempt = attempt + 1;
                codeEntryAttempt.set(callId, nextAttempt);
                return sendOut('bad-code-retry', buildCodeDigitCommand(`code1_${nextAttempt}`, true));
            }
            codeEntryAttempt.delete(callId); // הצלחה - אין יותר צורך לעקוב אחרי ניסיונות

            const gameId = gs.activeGame._id;
            touch(callId, gameId);

            // סגירת רשומות "פעילות" ישנות לאותו טלפון **באותו משחק** (טלפון לא
            // יכול להתקשר פעמיים בו-זמנית לאותו משחק)
            const staleActive = await Player.find({ game: gameId, phone, active: true, callId: { $ne: callId } });
            if (staleActive.length) {
                await Player.updateMany({ _id: { $in: staleActive.map(p => p._id) } }, { active: false });
                staleActive.forEach(p => { forget(p.callId); io.to(roomName(gameId)).emit('playerDisconnected', { callId: p.callId }); });
            }

            // שלב 5: מגבלת ניסיון חינמי - עד FREE_TRIAL_MAX_PLAYERS משתתפים בו-זמנית
            // לכל משחק, אלא אם למשחק הזה ספציפית יש paidUntil עתידי (תשלום הוא
            // per-game, לא per-user), או שהמשחק הופעל ע"י מנהל-על (adminActivated -
            // מנהל-על תמיד מפעיל בגישה מלאה, בלי תשלום). נטען טרי מה-DB בכל בדיקה
            // ולא מה-snapshot בזיכרון, כי תשלום יכול להתאשר (callback אסינכרוני)
            // אחרי שהמשחק כבר הופעל. נבדק רק בהצטרפות שחקן **חדש** - שחקן שכבר
            // משתתף וממשיך/מתחבר-מחדש לא נספר שוב (מטופל ב-`else if (!player.active)` למטה).
            const activeCount = await Player.countDocuments({ game: gameId, active: true });
            if (activeCount >= CONFIG.FREE_TRIAL_MAX_PLAYERS) {
                const game = await Game.findById(gameId).select('paidUntil adminActivated');
                const hasExtendedAccess = !!(game && ((game.paidUntil && game.paidUntil > new Date()) || game.adminActivated));
                if (!hasExtendedAccess) {
                    forget(callId);
                    return sendOut('trial-limit-reached', `id_list_message=t-המשחק הגיע למגבלת ${CONFIG.FREE_TRIAL_MAX_PLAYERS} משתתפים בגרסת הניסיון, אנא נסו שוב מאוחר יותר`);
                }
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
