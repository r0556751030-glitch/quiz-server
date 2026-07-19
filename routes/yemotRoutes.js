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

// שולף את השם/כינוי המשויך למספר טלפון, אם קיים (לתצוגה במסך במקום מספר גולמי)
async function getContactName(phone) {
  const contact = await Contact.findOne({ phone });
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

    // ===== מציאה/יצירה של השחקן (לפי callId הייחודי לשיחה) =====
    let player = await Player.findOne({ callId });
    if (!player) {
      player = await Player.create({ phone, callId });
      const name = await getContactName(phone);
      io.emit('playerConnected', { callId, phone, playerId: player._id, score: player.score, name });
    } else if (!player.active) {
      // שיחה חוזרת עם אותו callId שסומנה כמנותקת (למשל ע"י הבאג הישן) - מחזירים אותה לפעילה
      player.active = true;
      await player.save();
    }

    // ===== אם זו תשובה לשאלה פתוחה =====
    // בודקים ספציפית את שם השדה הייחודי של השאלה הפתוחה כרגע (ולא שדה קבוע בשם "answer"),
    // כדי לא לקבל בטעות ערך "זכור" משאלה קודמת.
    let justAnswered = false;
    if (state.status === 'open' && state.currentQuestion) {
      const fieldName = answerFieldName(state.currentQuestion);
      const answer = req.body[fieldName];

      if (answer !== undefined) {
        justAnswered = true; // ברגע שענה על השאלה הנוכחית, לא נשלח לו אותה שוב - נעביר אותו להמתנה
        const isCorrect = answer === String(state.currentQuestion.correctIndex + 1);
        const responseTimeMs = Date.now() - state.openedAt;

        try {
          await Answer.create({
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
          const name = await getContactName(phone);
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
    // רק אם השאלה פתוחה, וזו לא תגובת-תשובה שהרגע טיפלנו בה (אחרת נשלח לו את אותה שאלה שוב בטעות)
    if (state.status === 'open' && state.currentQuestion && !justAnswered) {
      const elapsedSec = (Date.now() - state.openedAt) / 1000;
      const remaining = state.currentQuestion.answerWindowSeconds - elapsedSec;
      return res.type('text/plain').send(buildReadCommand(state.currentQuestion, remaining));
    }

    // אין שאלה פתוחה כרגע, או שהשחקן כבר ענה על הנוכחית - משאירים את השיחה פתוחה וממתינים לשאלה הבאה.
    // מעבירים callback שיסמן את השחקן כמנותק אם החיבור נסגר בזמן שהוא מוחזק כאן (ראו gameState.js).
    holdResponse(callId, phone, res, (disconnectedCallId) => markDisconnected(io, disconnectedCallId));
  } catch (err) {
    console.error('שגיאה בטיפול בבקשת ימות:', err);
    res.type('text/plain').send('id_list_message=t-אירעה שגיאה, אנא נסו שוב');
  }
});

module.exports = router;
