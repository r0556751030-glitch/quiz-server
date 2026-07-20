const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Answer = require('../models/Answer');
const Contact = require('../models/Contact');
const { state, holdResponse, answerFieldName } = require('../game/gameState');

// בונה את מחרוזת ה-read שנשלחת לימות
// משתמש בקובץ שמע שקט (f-001) כדי לא להשמיע כלום ולעקוף את מנוע ה-TTS
// שם המשתנה (answerFieldName) שונה בכל שאלה - ראו הסבר ב-gameState.js
function buildReadCommand(question, remainingSeconds) {
  const wait = Math.max(2, Math.round(remainingSeconds));
  const allowedKeys = question.options.map((_, i) => i + 1).join(''); // לדוגמה "1234"
  return `read=f-001=${answerFieldName(question)},,1,1,${wait},NO,yes,,,${allowedKeys},3,Ok,NOANSWER,,no`;
}

async function markDisconnected(io, callId) {
  await Player.updateOne({ callId }, { active: false });
  io.emit('playerDisconnected', { callId });
}

// שולף את השם/כינוי המשויך למספר טלפון בתוך המשחק הנתון, אם קיים
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

    // ===== ניתוק שיחה (מפורש, מגיע מ-ימות) =====
    if (hangup === 'yes') {
      await markDisconnected(io, callId);
      return res.type('text/plain').send('');
    }

    // ===== אין משחק פעיל כרגע - אי אפשר לשבץ את השיחה לשום מקום =====
    if (!state.activeGame) {
      return res.type('text/plain').send('id_list_message=t-אין משחק פעיל כרגע, אנא נסו שוב מאוחר יותר');
    }
    const gameId = state.activeGame._id;

    // ===== מציאה/יצירה של השחקן (לפי callId הייחודי לשיחה) =====
    let player = await Player.findOne({ callId });
    if (!player) {
      // לפני יצירת שחקן חדש: אם יש כבר רשומות "פעילות" אחרות לאותו טלפון+משחק -
      // מדובר בהכרח בשיחות ישנות שמתו בלי שהצלחנו לזהות את הניתוק שלהן
      // (טלפון פיזי לא יכול להתקשר פעמיים בו-זמנית לאותו מספר). סוגרים אותן עכשיו,
      // כדי שהמונה/הרשימה של "מחוברים כרגע" לא יציגו כפילויות לאותו מספר.
      const staleActive = await Player.find({ game: gameId, phone, active: true, callId: { $ne: callId } });
      if (staleActive.length) {
        await Player.updateMany(
          { _id: { $in: staleActive.map((p) => p._id) } },
          { active: false }
        );
        staleActive.forEach((p) => io.emit('playerDisconnected', { callId: p.callId }));
      }

      player = await Player.create({ game: gameId, phone, callId });
      const name = await getContactName(gameId, phone);
      io.emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
    } else if (!player.active) {
      // שיחה חוזרת עם אותו callId שסומנה כמנותקת - מחזירים אותה לפעילה
      player.active = true;
      await player.save();
    }

    // ===== אם זו תשובה לשאלה פתוחה =====
    let justAnswered = false;
    if (state.status === 'open' && state.currentQuestion) {
      const fieldName = answerFieldName(state.currentQuestion);
      const answer = req.body[fieldName];

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
          // כבר נשלחה תשובה קודמת לאותה שאלה (unique index) - מתעלמים בשקט
        }
      }
    }

    // ===== החלטה מה להשיב כרגע =====
    if (state.status === 'open' && state.currentQuestion && !justAnswered) {
      const elapsedSec = (Date.now() - state.openedAt) / 1000;
      const remaining = state.currentQuestion.answerWindowSeconds - elapsedSec;
      return res.type('text/plain').send(buildReadCommand(state.currentQuestion, remaining));
    }

    holdResponse(callId, phone, res, (disconnectedCallId) => markDisconnected(io, disconnectedCallId));
  } catch (err) {
    console.error('שגיאה בטיפול בבקשת ימות:', err);
    res.type('text/plain').send('id_list_message=t-אירעה שגיאה, אנא נסו שוב');
  }
});

module.exports = router;
