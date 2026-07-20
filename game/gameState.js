/**
 * ניהול מצב המשחק החי בזיכרון
 */

const state = {
    status: 'idle',
    currentQuestion: null,
    openedAt: null,
    autoAdvance: false,
    playersAtOpen: 0,
    activeGame: null,
};

const pendingResponses = new Map();
const lastSeen = new Map(); // מעקב זמן פעילות אחרון עבור כל callId

function touch(callId) {
    if (callId) {
        lastSeen.set(callId, Date.now());
    }
}

function holdResponse(callId, phone, res, onClientHangup) {
    // מניעת זליגת זיכרון: סגירת Response ישן אם התקבלה בקשה חדשה לאותו callId
    const existing = pendingResponses.get(callId);
    if (existing && !existing.res.writableEnded) {
        try { existing.res.end(); } catch (_) { }
    }

    pendingResponses.set(callId, { res, phone });

    const cleanup = () => {
        const current = pendingResponses.get(callId);
        if (current && current.res === res) {
            pendingResponses.delete(callId);
            if (onClientHangup) onClientHangup(callId);
        }
    };

    res.req.once('close', cleanup);
    res.req.once('aborted', cleanup);
}

function resolveResponse(callId, textBody) {
    const pending = pendingResponses.get(callId);
    if (pending) {
        if (!pending.res.writableEnded) {
            pending.res.type('text/plain').send(textBody);
        }
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

function setActiveGame(game) {
    state.activeGame = game ? { _id: game._id, name: game.name, slug: game.slug } : null;
    state.status = 'idle';
    state.currentQuestion = null;
    state.openedAt = null;
    state.autoAdvance = false;
    state.playersAtOpen = 0;
}

module.exports = {
    state,
    pendingResponses,
    lastSeen,
    touch,
    holdResponse,
    resolveResponse,
    resolveAll,
    answerFieldName,
    setActiveGame
};