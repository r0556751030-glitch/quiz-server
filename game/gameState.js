/**
 * מצב המשחק החי בזיכרון. ארכיטקטורת short-polling: ימות מקבל תשובה מיידית
 * תמיד (אין hold). חיות שחקן נמדדת לפי lastSeen; server.js סורק כל
 * SWEEP_INTERVAL_MS ומנתק מי שלא פינג מעבר ל-STALE_TIMEOUT_MS.
 */

const CONFIG = {
    POLL_SECONDS: 1,                     // ← היה 4, גרם לעיכוב של עד 4 שניות בקליטת תשובה
    IDLE_STALE_TIMEOUT_MS: 12000,
    OPEN_QUESTION_STALE_BUFFER_MS: 8000,
    SWEEP_INTERVAL_MS: 4000
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
// שחקן ששותק (בלי ללחוץ) לאורך כל חלון התשובה של שאלה פתוחה זה תקין, לא ניתוק -
// הטלפון שלו נמצא לגיטימית בתוך read= ארוך (עד answerWindowSeconds) בלי לפנות
// לשרת. הסף חייב לכסות את חלון השאלה האחרונה שנפתחה, לא רק את מרווח ה-poll.
function getStaleThresholdMs() {
    const openWindowMs = state.currentQuestion ? state.currentQuestion.answerWindowSeconds * 1000 : 0;
    return Math.max(CONFIG.IDLE_STALE_TIMEOUT_MS, openWindowMs + CONFIG.OPEN_QUESTION_STALE_BUFFER_MS);
}

function getStaleCallIds() {
    const now = Date.now();
    const threshold = getStaleThresholdMs();
    const stale = [];
    for (const [callId, ts] of lastSeen.entries()) {
        if (now - ts > threshold) stale.push(callId);
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