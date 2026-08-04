/**
 * מצב המשחקים החיים בזיכרון - שלב 4: כמה משחקים יכולים להיות חיים בו-זמנית,
 * כל אחד עם ה-state, הטיימרים וה-lastSeen שלו. ארכיטקטורת short-polling נשארת
 * זהה: ימות מקבל תשובה מיידית תמיד (אין hold).
 *
 * שינוי מהגרסה הקודמת (singleton): אין יותר `state` יחיד גלובלי. כל צרכן (routes)
 * מקבל gameState ספציפי דרך getGameState(gameId) אחרי שהוא כבר יודע לאיזה משחק
 * הוא פונה (מ-req.gameId, שנקבע ב-middleware לפי :gameId שבנתיב או לפי Player קיים).
 */

const CONFIG = {
    POLL_SECONDS: 1,                     // ← היה 4, גרם לעיכוב של עד 4 שניות בקליטת תשובה
    READING_SECONDS: 4,                  // זמן "קריאת השאלה" לפני שהטיימר מתחיל ותשובות נקלטות
    IDLE_STALE_TIMEOUT_MS: 12000,
    OPEN_QUESTION_STALE_BUFFER_MS: 8000,
    SWEEP_INTERVAL_MS: 4000,
    CODE_ENTRY_TIMEOUT_SECONDS: 20,      // זמן המתנה להקשת קוד המשחק (שלב 4) - ערך זמני, לכייל אחרי בדיקה אמיתית
    FREE_TRIAL_MAX_PLAYERS: 2             // ⚠️ שונה זמנית מ-3 ל-2 לצורך בדיקה עם 3 טלפונים בלבד (5.8.2026) -
                                          // יש להחזיר ל-3 כשהבדיקה מסתיימת! (רק את הספרה כאן, שום דבר אחר)
                                          // אלא אם לבעל המשחק יש paidUntil עתידי (גישה מורחבת ששולמה)
};

// gameId (string) -> { activeGame, status, currentQuestion, openedAt, pausedRemainingMs,
//                       autoAdvance, playersAtOpen, timers:{closeTimer,advanceTimer,visualTimer} }
const games = new Map();

// callId -> { ts, gameId } - פינג אחרון לכל שיחה + לאיזה משחק היא שייכת (לחישוב סף stale
// נכון לפי השאלה הפתוחה של אותו משחק, ולניקוי lastSeen כשמשחק מושבת)
const lastSeen = new Map();

function freshGameState(game) {
    return {
        activeGame: { _id: game._id, name: game.name, slug: game.slug, code: game.code, owner: game.owner },
        status: 'idle',           // 'idle' | 'displayed' | 'open' | 'paused'
        currentQuestion: null,
        openedAt: null,           // T0 האמיתי - מהרגע הזה יֶמות כבר יכול לקלוט תשובות (ראש-התחלה)
        pausedRemainingMs: null,  // כשמושהה: כמה מ"ס נותרו מתוך כל החלון (קריאה+מענה) ברגע ההשהיה
        autoAdvance: false,
        playersAtOpen: 0,
        timers: { closeTimer: null, advanceTimer: null, visualTimer: null }
    };
}

// מפעיל משחק (הופך אותו ל"חי") - יוצר לו state נקי משלו. אם המשחק כבר היה חי
// (למשל: restart של השרת בזמן שהיה אמור להיות פעיל), דורס את ה-state הישן שלו -
// אותה סמנטיקה כמו קודם (סשן נקי בכל הפעלה, המחיקה של Player/Answer קורית ב-routes).
function activateGame(game) {
    const gameId = String(game._id);
    const existing = games.get(gameId);
    if (existing) clearAllTimers(existing);
    const fresh = freshGameState(game);
    games.set(gameId, fresh);
    return fresh;
}

function clearAllTimers(gs) {
    if (gs.timers.closeTimer) clearTimeout(gs.timers.closeTimer);
    if (gs.timers.advanceTimer) clearTimeout(gs.timers.advanceTimer);
    if (gs.timers.visualTimer) clearTimeout(gs.timers.visualTimer);
}

// משבית משחק (deactivate) - מנקה טיימרים, מסיר מה-Map, ומשכח כל lastSeen ששייך אליו
function deactivateGame(gameId) {
    gameId = String(gameId);
    const gs = games.get(gameId);
    if (gs) clearAllTimers(gs);
    games.delete(gameId);
    for (const [callId, entry] of lastSeen.entries()) {
        if (entry.gameId === gameId) lastSeen.delete(callId);
    }
}

function getGameState(gameId) {
    if (!gameId) return null;
    return games.get(String(gameId)) || null;
}

// מוצא את ה-state של המשחק החי שהקוד המספרי שלו תואם - נקרא מ-yemotRoutes.js
// כשמתקשר חדש מקיש קוד משחק, לפני שיש לו עדיין Player.
function findGameStateByCode(code) {
    for (const gs of games.values()) {
        if (gs.activeGame && gs.activeGame.code === code) return gs;
    }
    return null;
}

function touch(callId, gameId) {
    lastSeen.set(callId, { ts: Date.now(), gameId: String(gameId) });
}

function forget(callId) {
    lastSeen.delete(callId);
}

// שחקן ששותק (בלי ללחוץ) לאורך כל חלון התשובה של שאלה פתוחה זה תקין, לא ניתוק -
// הטלפון שלו נמצא לגיטימית בתוך read= ארוך (עד answerWindowSeconds) בלי לפנות
// לשרת. הסף חייב לכסות את חלון השאלה האחרונה שנפתחה **באותו משחק**, לא רק את
// מרווח ה-poll הגלובלי.
function getStaleThresholdMs(gameState) {
    const openWindowMs = gameState && gameState.currentQuestion
        ? gameState.currentQuestion.answerWindowSeconds * 1000
        : 0;
    return Math.max(CONFIG.IDLE_STALE_TIMEOUT_MS, openWindowMs + CONFIG.OPEN_QUESTION_STALE_BUFFER_MS);
}

function getStaleCallIds() {
    const now = Date.now();
    const stale = [];
    for (const [callId, entry] of lastSeen.entries()) {
        const gs = getGameState(entry.gameId);
        const threshold = getStaleThresholdMs(gs);
        if (now - entry.ts > threshold) stale.push(callId);
    }
    return stale;
}

// מספר החיבורים ש"חיים" כרגע לפי lastSeen, למשחק ספציפי (לא Player.active ב-DB) -
// נועד ללוגי אבחון מבחן עומס.
function getActiveConnectionCount(gameId) {
    gameId = String(gameId);
    let count = 0;
    for (const entry of lastSeen.values()) {
        if (entry.gameId === gameId) count++;
    }
    return count;
}

// סה"כ חיבורים חיים בכל המשחקים יחד (לא מפורק לפי משחק) - ללוג heartbeat פשוט.
function getTotalConnectionCount() {
    return lastSeen.size;
}

// no-op לתאימות לאחור: adminRoutes.js קורא לזה ב-openQuestion. אין יותר תשובות
// תלויות להשלים - כל שחקן יקבל את השאלה הפתוחה בפינג הקצר הבא שלו ממילא.
function resolveAll() { }

function answerFieldName(question) {
    return `ans_${question._id}`;
}

module.exports = {
    CONFIG,
    activateGame, deactivateGame, getGameState, findGameStateByCode,
    touch, forget, getStaleCallIds, getActiveConnectionCount, getTotalConnectionCount, getStaleThresholdMs,
    resolveAll, answerFieldName
};
