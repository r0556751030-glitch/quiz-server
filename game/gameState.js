/**
 * ניהול מצב המשחק החי בזיכרון (לא ב-Mongo, כי זה מצב ריצה זמני).
 * תמיד רק משחק אחד פעיל בפועל - activeGame הוא מטמון קליל של המשחק הפעיל,
 * כדי לא לפגוע ב-DB בכל פינג בודד שמגיע מימות (שיכולים להיות רבים מאוד).
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
  activeGame: null,        // { _id, name, slug } של המשחק הפעיל, או null אם אין משחק פעיל כלל
};

const pendingResponses = new Map();

function holdResponse(callId, phone, res, onClientHangup) {
    pendingResponses.set(callId, { res, phone });

    const cleanup = () => {
        const current = pendingResponses.get(callId);
        if (current && current.res === res) {
            pendingResponses.delete(callId);
            if (onClientHangup) {
                onClientHangup(callId);
            }
        }
    };

    // הקשבה מיידית לסגירה או ביטול הבקשה מצד הלקוח/הפרוקסי
    res.req.once('close', cleanup);
    res.req.once('aborted', cleanup);
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

function answerFieldName(question) {
  return `ans_${question._id}`;
}

// נקרא בעליית שרת ובכל החלפת משחק פעיל - תמיד מאפס את מצב המשחק החי
// כדי שלא "יידלף" מצב (שאלה פתוחה, ניקוד רגעי) מהמשחק הקודם למשחק החדש.
function setActiveGame(game) {
  state.activeGame = game ? { _id: game._id, name: game.name, slug: game.slug } : null;
  state.status = 'idle';
  state.currentQuestion = null;
  state.openedAt = null;
  state.autoAdvance = false;
  state.playersAtOpen = 0;
}

module.exports = {
  state, pendingResponses, holdResponse, resolveResponse, resolveAll,
  answerFieldName, setActiveGame
};
