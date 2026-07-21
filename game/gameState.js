/**
 * מצב המשחק החי בזיכרון. ארכיטקטורת short-polling: ימות מקבל תשובה מיידית
 * תמיד (אין hold). חיות שחקן נמדדת לפי lastSeen; server.js סורק כל
 * SWEEP_INTERVAL_MS ומנתק מי שלא פינג מעבר ל-STALE_TIMEOUT_MS.
 */

const CONFIG = {
    POLL_SECONDS: 4,         // wait שנשלח לימות כשאין שאלה פתוחה (לובי)
    STALE_TIMEOUT_MS: 12000, // בלי פינג מעבר לזה = מנותק בפועל
    SWEEP_INTERVAL_MS: 4000  // תדירות סריקת הניתוקים
};

const state = {
    status: 'idle',
    currentQuestion: null,
    openedAt: null,
    autoAdvance: false,
    playersAtOpen: 0,
    activeGame: null,
};

const lastSeen = new Map(); // callId -> Date.now() של הפינג האחרון

function touch(callId) {
    lastSeen.set(callId, Date.now());
}

function forget(callId) {
    lastSeen.delete(callId);
}

function getStaleCallIds() {
    const now = Date.now();
    const stale = [];
    for (const [callId, ts] of lastSeen.entries()) {
        if (now - ts > CONFIG.STALE_TIMEOUT_MS) stale.push(callId);
    }
    return stale;
}

// no-op לתאימות לאחור: adminRoutes.js קורא לזה ב-openQuestion. אין יותר תשובות
// תלויות להשלים - כל שחקן יקבל את השאלה הפתוחה בפינג הקצר הבא שלו ממילא.
function resolveAll() { }

function answerFieldName(question) {
    return `ans_${question._id}`;
}

function setActiveGame(game) {
    state.activeGame = game ? { _id: game._id, name: game.name, slug: game.slug, owner: game.owner } : null;
    state.status = 'idle';
    state.currentQuestion = null;
    state.openedAt = null;
    state.autoAdvance = false;
    state.playersAtOpen = 0;
}

module.exports = {
    state, CONFIG, touch, forget, getStaleCallIds, resolveAll, answerFieldName, setActiveGame
};