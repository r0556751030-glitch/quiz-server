/**
 * ניהול מצב המשחק החי בזיכרון (לא ב-Mongo, כי זה מצב ריצה זמני).
 *
 * pendingResponses: מיפוי callId -> אובייקט response של Express שממתין.
 * כשמשתמש מתקשר ואין שאלה פתוחה, אנחנו לא עונים לו מיד -
 * שומרים את ה-res בצד ואת השיחה נשארת פתוחה (עם מוזיקת המתנה בימות).
 * ברגע שהמנהל פותח שאלה, עוברים על כל הממתינים ועונים להם בבת אחת.
 */

const state = {
  status: 'idle',        // idle | open
  currentQuestion: null,  // מסמך Question המלא של השאלה הפתוחה כרגע
  openedAt: null,          // Date.now() של רגע פתיחת השאלה
  autoAdvance: false,      // האם המשחק רץ ברצף אוטומטי כרגע
  playersAtOpen: 0,        // כמות שחקנים מחוברים ברגע פתיחת השאלה - לחישוב אחוז "לא ענה" בתוצאות
};

const pendingResponses = new Map();

function holdResponse(callId, phone, res, onClientHangup) {
  pendingResponses.set(callId, { res, phone });

  // ===== גילוי ניתוק אמיתי בזמן המתנה =====
  // כשהשיחה מוחזקת (hold) וה-caller מנתק, ימות לרוב לא שולחת בקשת HTTP
  // נפרדת עם hangup=yes (כי מבחינתה היא עדיין "ממתינה לנו" על הבקשה שהוחזקה).
  // מה שכן קורה בוודאות: חיבור ה-TCP הגולמי נסגר. מאזינים לזה ישירות
  // כדי לתפוס גם את המקרה הזה, ולא רק hangup=yes מפורש.
  const cleanup = () => {
    const current = pendingResponses.get(callId);
    // בודקים שזו עדיין אותה בקשה שהוחזקה (לא בקשה חדשה שכבר החליפה אותה)
    if (current && current.res === res) {
      pendingResponses.delete(callId);
      if (onClientHangup) onClientHangup(callId);
    }
  };
  res.req.once('close', cleanup);
}

function resolveResponse(callId, textBody) {
  const pending = pendingResponses.get(callId);
  if (pending) {
    pending.res.type('text/plain').send(textBody);
    pendingResponses.delete(callId);
  }
}

function resolveAll(textBody) {
  for (const callId of Array.from(pendingResponses.keys())) {
    resolveResponse(callId, textBody);
  }
}

/**
 * שם המשתנה שנשלח לימות בפקודת ה-read עבור שאלה נתונה.
 *
 * חשוב: השם חייב להיות שונה מ-שאלה לשאלה (לא קבוע כמו "answer" כמו שהיה).
 * הסיבה: כשמשתמשים באותו שם משתנה פעמיים באותה שיחה, קיים סיכוי גבוה
 * שימות "זוכרת" את הערך שנאסף בפעם הקודמת ומחזירה אותו מיידית בלי
 * לחכות בכלל ללחיצה חדשה - זה בדיוק מה שגרם לתופעה של "רק השאלה
 * הראשונה נקלטת" (לשאלות הבאות היה חוזר בטעות הניקוד/הבחירה הישנים).
 */
function answerFieldName(question) {
  return `ans_${question._id}`;
}

module.exports = { state, pendingResponses, holdResponse, resolveResponse, resolveAll, answerFieldName };
