const socket = io();
const activeCallIds = new Set();
let questionsCache = [];
let countdownInterval = null;
let currentRole = null;
let appInitialized = false;
let editingQuestionId = null; // מזהה השאלה שנמצאת כרגע בעריכה, או null במצב "הוספת שאלה"

// שלב 4: כמה משחקים יכולים להיות חיים בו-זמנית - הדשבורד הזה שולט תמיד על
// משחק ספציפי אחד, שמזוהה מה-URL (games.html מעביר admin.html?gameId=...).
// בלי gameId אין למסך הזה שום הקשר לעבוד איתו - חוזרים לרשימת המשחקים.
const GAME_ID = new URLSearchParams(location.search).get('gameId');
if (!GAME_ID) {
  alert('לא צוין משחק לניהול - חוזרים לרשימת המשחקים.');
  location.href = '/games.html';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

// ===================================================================
// התחברות
// ===================================================================

async function checkAuth() {
  const res = await fetch('/admin/me', { cache: 'no-store' });
  const data = await res.json();
  // אחרי
if (data.authenticated) onAuthenticated(data.role, data.email);
  else location.href = '/';
}

function onAuthenticated(role, username) {
  currentRole = role;
  initApp();
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST' });
  location.href = '/';
});

// שולח gameId בכל בקשה ל-/admin/* דרך header ייעודי (x-game-id) - זה מה ש-
// requireGameContext ב-auth.js קורא. נקודת-חיבור אחת (authFetch), כדי שלא
// צריך להוסיף את זה בכל אחת מעשרות קריאות ה-fetch בקובץ הזה בנפרד.
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), 'x-game-id': GAME_ID };
  const res = await fetch(url, { cache: 'no-store', ...options, headers });
  if (res.status === 401) location.href = '/';
  return res;
}

function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  updateNavButtons(false, false);
  loadQuestions();
  loadStatus();
}

checkAuth();

// ===================================================================
// מונה מחוברים
// ===================================================================
let lastJoinedTimer = null;
socket.on('playerConnected', (p) => {
  activeCallIds.add(p.callId);
  updateConnectedCount();
  refreshConnectionsPanelIfVisible();
  const lastJoined = document.getElementById('lastJoined');
  document.getElementById('lastJoinedName').textContent = p.name || p.phone || '';
  lastJoined.hidden = false;
  if (lastJoinedTimer) clearTimeout(lastJoinedTimer);
  lastJoinedTimer = setTimeout(() => { lastJoined.hidden = true; }, 1000);
});
socket.on('playerDisconnected', (p) => {
  activeCallIds.delete(p.callId);
  updateConnectedCount();
  refreshConnectionsPanelIfVisible();
});
function updateConnectedCount() {
  document.getElementById('connectedCount').textContent = activeCallIds.size;
}
// פאנל "מחוברים כרגע" נטען פעם אחת בלחיצת טאב - זה גרם לו להיות "קפוא" עד
// שהמנחה עוזב ושב לטאב. עכשיו הוא מתרענן גם באירוע חי, אבל רק אם הטאב פתוח כרגע -
// אין טעם לבזבז קריאת שרת על פאנל מוסתר.
function refreshConnectionsPanelIfVisible() {
  const panel = document.getElementById('panel-connections');
  if (panel && !panel.hidden) loadConnections();
}

socket.on('connect', () => {
  document.getElementById('connDot').className = 'conn-dot on';
  socket.emit('joinGame', GAME_ID);
  resyncConnectedCount();
});
socket.on('disconnect', () => document.getElementById('connDot').className = 'conn-dot off');

async function resyncConnectedCount() {
  const res = await authFetch('/admin/connected');
  if (!res.ok) return;
  const list = await res.json();
  activeCallIds.clear();
  list.forEach((p) => activeCallIds.add(p.callId));
  updateConnectedCount();
}

// ===================================================================
// החלפת משחק פעיל
// ===================================================================
socket.on('gameSwitched', (data) => {
  alert(data.gameName
    ? 'המשחק הפעיל הוחלף ל: ' + data.gameName + '\nהעמוד ייטען מחדש.'
    : 'המשחק הופסק.\nהעמוד ייטען מחדש.');
  location.reload();
});

// ===================================================================
// Fair Play: הבזק שם בלבד כשמישהו עונה
// ===================================================================
socket.on('playerAnswered', (a) => showAnswerToast(a.name || a.phone || 'שחקן'));

function showAnswerToast(label) {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'answer-toast';
  el.textContent = label;
  stack.appendChild(el);

  requestAnimationFrame(() => {
    const stackRect = stack.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const maxLeft = Math.max(0, stackRect.width - elRect.width);
    const maxTop = Math.max(0, stackRect.height - elRect.height);
    el.style.left = Math.round(Math.random() * maxLeft) + 'px';
    el.style.top = Math.round(Math.random() * maxTop) + 'px';
    requestAnimationFrame(() => el.classList.add('show'));
  });

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 1700);
}

// ===================================================================
// שאלה חיה
// ===================================================================
// שלב "קריאת השאלה": השאלה מוצגת, אבל הטיימר עוד לא רץ ותשובות עדיין
// לא נקלטות בשרת. הטיימר יתחיל בפועל רק עם אירוע questionTimerStarted.
// שלב "הצגה בלבד": השאלה מוצגת על המסך, בלי טיימר ובלי קליטת תשובות בשרת.
// ממתין ללחיצת המנחה על "פתיחת מענה" (ראו beginAnswerBtn למטה).
socket.on('questionOpened', (data) => {
  document.getElementById('idleState').hidden = true;
  document.getElementById('questionResults').hidden = true;
  document.getElementById('questionLive').hidden = false;

  // תג סקר
  const surveyBadge = document.getElementById('surveyBadge');
  if (surveyBadge) surveyBadge.hidden = !data.question.isSurvey;

  document.getElementById('liveQText').textContent = data.question.text;
  renderLiveOptions(data.question.options);
  showDisplayedState();
  setControlState('displayed');
  updateNavButtons(data.hasPrev, data.hasNext);
});

// מציג את השאלה בלי טיימר בכלל, וחושף את כפתור "פתיחת מענה" למנחה
function showDisplayedState() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.querySelector('.timer-wrap').hidden = true;
  document.getElementById('beginAnswerBtn').hidden = false;
}

// המנחה לחץ "פתיחת מענה" - מכאן והלאה זהה למה שהיה קורה אוטומטית בעבר:
// טבעת "ממתינים" עד שהטיימר הגלוי מתחיל בפועל (questionTimerStarted).
socket.on('answeringBegan', () => {
  document.getElementById('beginAnswerBtn').hidden = true;
  document.querySelector('.timer-wrap').hidden = false;
  showReadyState();
  setControlState('open');
});

document.getElementById('beginAnswerBtn').addEventListener('click', async () => {
  const res = await authFetch('/admin/begin-answering', { method: 'POST' });
  if (!res.ok) { const e = await res.json(); alert('שגיאה: ' + e.error); }
});

// הטבעת מוצגת מלאה ("..."), בלי לרדת, כל עוד אנחנו בשלב הקריאה
function showReadyState() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  const ring = document.getElementById('timerRing');
  const numEl = document.getElementById('timerNum');
  ring.style.strokeDasharray = RING_CIRCUMFERENCE;
  ring.style.strokeDashoffset = 0;
  numEl.hidden = true;
  document.getElementById('timerHourglass').hidden = false;
}

// כאן בפועל מתחיל הטיימר לרדת - ומהרגע הזה השרת גם מתחיל לקלוט תשובות
socket.on('questionTimerStarted', (data) => {
  startTimer(data.answerWindowSeconds, data.openedAt);
});

function renderLiveOptions(options) {
  const opts = document.getElementById('liveQOptions');
  opts.innerHTML = '';
  options.forEach((o, i) => {
    const d = document.createElement('div');
    d.className = 'q-option';
    d.textContent = `${i + 1}. ${o}`;
    opts.appendChild(d);
  });
  fitQuestionStage();
}

// ===================================================================
// התאמת גודל הבמה - מקטין את כל התוכן (טקסט השאלה, כרטיסי התשובות,
// תג הסקר, הטיימר) יחד באותו יחס בדיוק, כדי שהכל ייכנס בגובה הפנוי
// בלי גלגלת גלילה אנכית. משתמש במשתנה CSS ‎--fit-scale שמוגדר על
// .question-stage ומוכפל בתוך clamp() של כל האלמנטים הרלוונטיים -
// כך שכל הדיבים על אותו מסך מוקטנים באותה מידה בדיוק (לא בנפרד זה מזה).
function fitQuestionStage() {
  const stage = document.getElementById('questionStage');
  const container = document.querySelector('.stage-middle');
  if (!stage || !container) return;

  // איפוס לגודל מלא לפני מדידה
  stage.style.setProperty('--fit-scale', '1');

  requestAnimationFrame(() => {
    const maxH = container.clientHeight;
    if (stage.scrollHeight <= maxH) return; // נכנס בשלמותו - אין צורך בהקטנה

    const MIN_SCALE = 0.45;
    stage.style.setProperty('--fit-scale', MIN_SCALE);
    if (stage.scrollHeight > maxH) return; // אפילו במינימום לא נכנס - משאירים במינימום

    // חיפוש בינארי אחר הגודל המקסימלי שעדיין נכנס בשלמותו
    let lo = MIN_SCALE, hi = 1;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      stage.style.setProperty('--fit-scale', mid);
      if (stage.scrollHeight <= maxH) lo = mid; else hi = mid;
    }
    stage.style.setProperty('--fit-scale', lo);
  });
}

let fitResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitResizeTimer);
  fitResizeTimer = setTimeout(fitQuestionStage, 150);
});

function startTimer(seconds, openedAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  const ring = document.getElementById('timerRing');
  const numEl = document.getElementById('timerNum');
  document.getElementById('timerHourglass').hidden = true;
  numEl.hidden = false;
  ring.style.strokeDasharray = RING_CIRCUMFERENCE;

  function tick() {
    const elapsed = (Date.now() - openedAt) / 1000;
    const remaining = Math.max(0, seconds - elapsed);
    numEl.textContent = Math.ceil(remaining);
    const frac = remaining / seconds;
    ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - frac);
    if (remaining <= 0) clearInterval(countdownInterval);
  }
  tick();
  countdownInterval = setInterval(tick, 200);
}

socket.on('questionClosed', () => {
  if (countdownInterval) clearInterval(countdownInterval);
  document.getElementById('questionLive').hidden = true;
  setControlState('closed');
});

// ===================================================================
// תוצאות שאלה (ברים + הדגשת תשובה נכונה)
// תיקון: פונקציה אחת שמטפלת בכל הלוגיקה, כולל isSurvey
// ===================================================================
socket.on('questionResults', (r) => {
  const panel = document.getElementById('questionResults');
  panel.hidden = false;

  // תג סקר בפאנל התוצאות
  const surveyBadge = document.getElementById('resultsSurveyBadge');
  if (surveyBadge) surveyBadge.hidden = !r.isSurvey;

  const q = questionsCache.find((qq) => qq._id === r.questionId);
  document.getElementById('resultsQText').textContent = q ? q.text : '';

  const barsWrap = document.getElementById('resultsBars');
  barsWrap.innerHTML = '';
  const options = q ? q.options : r.percentages.map((_, i) => `אפשרות ${i + 1}`);

  options.forEach((opt, i) => {
    // הדגשת תשובה נכונה: רק בשאלות ידע (לא סקר), ורק האפשרות הנכונה
    const isCorrect = !r.isSurvey && i === r.correctIndex;
    const row = document.createElement('div');
    row.className = 'bar-row' + (isCorrect ? ' correct' : '');
    row.innerHTML = `
      <div class="bar-label">${opt}${isCorrect ? ' ✔' : ''}</div>
      <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
      <div class="bar-pct">${r.percentages[i] ?? 0}%</div>
    `;
    barsWrap.appendChild(row);
    // אנימציה מושהית כדי שה-CSS transition יתפוס
    requestAnimationFrame(() => {
      row.querySelector('.bar-fill').style.width = (r.percentages[i] ?? 0) + '%';
    });
  });

  fitQuestionStage();
});

socket.on('gamePaused', () => {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  setControlState('paused');
});
socket.on('gameResumed', () => setControlState('resumed'));

// ===================================================================
// מסך תוצאות סופיות
// ===================================================================
socket.on('gameEnded', ({ results }) => {
  document.getElementById('questionLive').hidden = true;
  document.getElementById('questionResults').hidden = true;
  const idle = document.getElementById('idleState');
  idle.hidden = false;
  updateNavButtons(false, false);
  showFinalResults(results);
});

function ensureBackToGamesButton() {
  if (document.getElementById('backToGamesBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'backToGamesBtn';
  btn.className = 'btn-mini';
  btn.textContent = 'חזרה לרשימת המשחקים';
  btn.addEventListener('click', () => { location.href = '/games.html'; });
  document.getElementById('closeFinalOverlay').insertAdjacentElement('afterend', btn);
}

// הרגעים (בשניות, לפי הוידאו v-leaders.mp4) שבהם כל שם עולה בהדרגה -
// לפי בקשה מפורשת: מקום 3 בשנייה 7, מקום 2 בשנייה 9, מקום 1 בשנייה 12.
const WINNERS_REVEAL_TIMES = { 3: 7.0, 2: 9.0, 1: 12.0 };

// הוידאו המקורי נחתך לשחור פתאומי סביב 16.05 שניות (אחרי שכבר רואים
// הכל בבירור) - במקום לתת לו להגיע לשם, עוצרים אותו קצת קודם, כדי
// שהתמונה האחרונה שנשארת על המסך היא הסצנה עם הפודיומים, לא שחור.
const WINNERS_VIDEO_SAFE_END = 15.85;

function resetWinnersReveal() {
  for (let i = 1; i <= 3; i++) {
    document.getElementById('winnerName' + i).classList.remove('show');
    document.getElementById('winnerScore' + i).classList.remove('show');
  }
}

function attachWinnersVideoHandlers() {
  const video = document.getElementById('winnersVideo');
  if (video.dataset.handlersAttached) return;
  video.dataset.handlersAttached = '1';

  const revealed = new Set();
  video.addEventListener('timeupdate', () => {
    for (const rank of [3, 2, 1]) {
      if (!revealed.has(rank) && video.currentTime >= WINNERS_REVEAL_TIMES[rank]) {
        revealed.add(rank);
        document.getElementById('winnerName' + rank).classList.add('show');
        document.getElementById('winnerScore' + rank).classList.add('show');
      }
    }
    if (video.currentTime >= WINNERS_VIDEO_SAFE_END) {
      video.pause();
      video.currentTime = WINNERS_VIDEO_SAFE_END;
    }
  });
  video.addEventListener('play', () => { revealed.clear(); resetWinnersReveal(); });
}

function showFinalResults(results) {
  for (let i = 0; i < 3; i++) {
    const p = results[i];
    document.getElementById('winnerName' + (i + 1)).textContent = p ? (p.name || p.phone) : '';
    document.getElementById('winnerScore' + (i + 1)).textContent = p ? p.score + ' נק\'' : '';
  }

  document.querySelector('#finalFullTable tbody').innerHTML =
    results.map((p) => `
      <tr>
        <td class="rank">${p.rank}</td>
        <td>${p.name || p.phone}</td>
        <td>${p.score}</td>
        <td>${p.correctAnswers}</td>
        <td>${p.avgResponseTimeMs != null ? (p.avgResponseTimeMs / 1000).toFixed(1) + " שנ'" : '—'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="muted">אין נתונים</td></tr>';

  document.getElementById('fullResultsOverlay').hidden = true;
  document.getElementById('finalOverlay').hidden = false;
  ensureBackToGamesButton();

  // מפעיל את סרטון הפודיום מההתחלה בכל סיום משחק (השמות מתחילים מוסתרים
  // ועולים בהדרגה - ראה attachWinnersVideoHandlers / WINNERS_REVEAL_TIMES)
  const video = document.getElementById('winnersVideo');
  attachWinnersVideoHandlers();
  resetWinnersReveal();
  video.currentTime = 0;
  video.play().catch(() => {});
}

document.getElementById('toggleFullResults').addEventListener('click', () => {
  document.getElementById('fullResultsOverlay').hidden = false;
});

document.getElementById('closeFullResultsX').addEventListener('click', () => {
  document.getElementById('fullResultsOverlay').hidden = true;
});

document.getElementById('closeFinalOverlay').addEventListener('click', () => {
  document.getElementById('finalOverlay').hidden = true;
});

document.getElementById('endGameBtn').addEventListener('click', async () => {
  if (!confirm('לסיים את המשחק עכשיו ולעבור למסך התוצאות הסופיות?')) return;
  await authFetch('/admin/end-game', { method: 'POST' });
});

// ===================================================================
// כפתורי שליטה
// ===================================================================
function setControlState(kind) {
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const closeBtn = document.getElementById('closeBtn');

  if (kind === 'displayed') {
    startBtn.hidden = true;
    pauseBtn.hidden = true;
    closeBtn.hidden = false;
  }
  if (kind === 'open') {
    startBtn.hidden = true;
    pauseBtn.hidden = false;
    closeBtn.hidden = false;
  }
  if (kind === 'closed') closeBtn.hidden = true;
  if (kind === 'paused') {
    pauseBtn.classList.add('is-paused');
    pauseBtn.title = 'המשך';
  }
  if (kind === 'resumed') {
    pauseBtn.classList.remove('is-paused');
    pauseBtn.title = 'השהה';
  }
}

document.getElementById('startBtn').addEventListener('click', async () => {
  // בדיקה מקדימה: אם כבר יש Player/Answer קיימים למשחק הזה (למשל אחרי קריסת
  // state בזיכרון באמצע סשן קודם), start-game ימחק אותם במכוון - מזהירים
  // עם מספרים אמיתיים לפני שממשיכים, כדי שלא יימחקו נתונים בטעות.
  const previewRes = await authFetch('/admin/start-game-preview');
  if (previewRes.ok) {
    const { playerCount, answerCount } = await previewRes.json();
    if (playerCount > 0 || answerCount > 0) {
      const msg = `קיימים כבר ${playerCount} שחקנים ו-${answerCount} תשובות למשחק הזה (כנראה מסשן קודם). ` +
        `התחלת משחק תמחק את כל הנתונים האלה לצמיתות. להתחיל בכל זאת?`;
      if (!confirm(msg)) return;
    }
  }

  const res = await authFetch('/admin/start-game', { method: 'POST' });
  if (!res.ok) { const e = await res.json(); alert('שגיאה: ' + e.error); }
});

document.getElementById('pauseBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pauseBtn');
  if (!btn.classList.contains('is-paused')) await authFetch('/admin/pause', { method: 'POST' });
  else await authFetch('/admin/resume', { method: 'POST' });
});

document.getElementById('closeBtn').addEventListener('click', async () => {
  await authFetch('/admin/close-question', { method: 'POST' });
});

// ===================================================================
// חצי ניווט - שאלה קודמת / הבאה
// ===================================================================
document.getElementById('prevQBtn').addEventListener('click', async () => {
  const res = await authFetch('/admin/prev-question', { method: 'POST' });
  if (!res.ok) { const e = await res.json(); alert('שגיאה: ' + e.error); }
});
document.getElementById('nextQBtn').addEventListener('click', async () => {
  const res = await authFetch('/admin/next-question', { method: 'POST' });
  if (!res.ok) { const e = await res.json(); alert('שגיאה: ' + e.error); }
});

// מעדכן את הזמינות (disabled) של החצים - לפי דגלים שמגיעים ישירות מהשרת
// (hasNext/hasPrev), ולא לפי רשימת השאלות המקומית - כדי למנוע מצב של
// "מירוץ" שבו הרשימה עוד לא נטענה והחצים נשארים תקועים.
function updateNavButtons(hasPrev, hasNext) {
  document.getElementById('prevQBtn').disabled = !hasPrev;
  document.getElementById('nextQBtn').disabled = !hasNext;
}

// ===================================================================
// הצגת 3 מובילים
// ===================================================================
document.getElementById('top3Btn').addEventListener('click', async () => {
  const overlay = document.getElementById('top3Overlay');
  if (!overlay.hidden) { overlay.hidden = true; return; }

  const res = await authFetch('/admin/leaderboard');
  const players = await res.json();
  const top3 = players.slice(0, 3);

  for (let i = 0; i < 3; i++) {
    const p = top3[i];
    document.getElementById('leaderName' + (i + 1)).textContent = p ? (p.name || p.phone) : '—';
    document.getElementById('leaderScore' + (i + 1)).textContent = p ? p.score + ' נק\'' : '';
  }

  overlay.hidden = false;
});

document.getElementById('top3Overlay').addEventListener('click', (e) => {
  if (e.target.id === 'top3Overlay' || e.target.classList.contains('overlay-bg-video')) {
    document.getElementById('top3Overlay').hidden = true;
  }
});
document.getElementById('top3CloseX').addEventListener('click', () => {
  document.getElementById('top3Overlay').hidden = true;
});

// ===================================================================
// סרגל ניהול נשלף
// ===================================================================
const drawer = document.getElementById('drawer');
const drawerOverlay = document.getElementById('drawerOverlay');

document.getElementById('adminToggle').addEventListener('click', openDrawer);
document.getElementById('drawerClose').addEventListener('click', closeDrawer);
drawerOverlay.addEventListener('click', closeDrawer);

function openDrawer() { drawer.classList.add('open'); drawerOverlay.hidden = false; }
function closeDrawer() { drawer.classList.remove('open'); drawerOverlay.hidden = true; }

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => (p.hidden = true));
    document.getElementById('panel-' + btn.dataset.panel).hidden = false;

    if (btn.dataset.panel === 'users') loadUsers();
    if (btn.dataset.panel === 'scores') loadScores();
    if (btn.dataset.panel === 'connections') loadConnections();
  });
});

// ===================================================================
// ניהול שאלות
// ===================================================================
async function loadQuestions() {
  const res = await authFetch('/admin/questions');
  if (!res.ok) return;
  questionsCache = await res.json();
  const wrap = document.getElementById('qlist');
  wrap.innerHTML = '';

  if (questionsCache.length === 0) {
    wrap.innerHTML = '<div class="muted">עדיין לא נוספו שאלות</div>';
    return;
  }

  questionsCache.forEach((q, idx) => {
    const isSurvey = !!q.isSurvey;
    const row = document.createElement('div');
    row.className = 'qrow';
    // בשאלת סקר לא מסמנים תשובה נכונה ברשימה
    const optLine = q.options
      .map((o, i) => (!isSurvey && i === q.correctIndex ? '✔ ' : '') + o)
      .join(' · ');
    row.innerHTML = `
      <div class="qmain">
        <div class="t">${q.order}. ${isSurvey ? '📊 ' : ''}${q.text}</div>
        <div class="o">${optLine} · ${q.answerWindowSeconds} שנ'</div>
      </div>
      <div class="q-actions">
        <button class="btn-mini" data-up="${q._id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn-mini" data-down="${q._id}" ${idx === questionsCache.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn-mini" data-open="${q._id}">פתח</button>
        <button class="btn-mini" data-edit="${q._id}">ערוך</button>
        <button class="btn-mini" data-del="${q._id}">מחק</button>
      </div>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => moveQuestion(b.dataset.up, -1)));
  wrap.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => moveQuestion(b.dataset.down, 1)));
  wrap.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
    await authFetch('/admin/open-question/' + b.dataset.open, { method: 'POST' });
    closeDrawer();
  }));
  wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => startEditQuestion(b.dataset.edit)));
  wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('למחוק את השאלה הזו לצמיתות?')) return;
    await authFetch('/admin/questions/' + b.dataset.del, { method: 'DELETE' });
    // אם השאלה שנמחקה היא זו שהייתה בעריכה כרגע - יוצאים ממצב עריכה
    if (editingQuestionId === b.dataset.del) resetEditState(true);
    loadQuestions();
  }));
}

// ===== כניסה למצב עריכה: ממלא את הטופס בנתוני השאלה הקיימת ומחליף
// את הפעולה שהשליחה מבצעת מ"יצירה" ל"עדכון" =====
function startEditQuestion(id) {
  const q = questionsCache.find((qq) => qq._id === id);
  if (!q) return;

  editingQuestionId = id;

  document.getElementById('qText').value = q.text;
  document.getElementById('qSeconds').value = q.answerWindowSeconds;

  document.getElementById('typeKnowledge').checked = !q.isSurvey;
  document.getElementById('typeSurvey').checked = !!q.isSurvey;
  document.getElementById('correctAnswerSection').hidden = !!q.isSurvey;

  // תיבת הבחירה תומכת כרגע ב-2 עד 6 אפשרויות; אם לשאלה יש יותר (עד 9 נתמך
  // במודל/בשרת), נציג את המקסימום הזמין בתיבה כדי לא לאבד אף אפשרות בפועל
  const selectEl = document.getElementById('optCount');
  const availableCounts = Array.from(selectEl.options).map((o) => Number(o.value));
  const maxAvailable = Math.max(...availableCounts);
  const count = Math.min(Math.max(q.options.length, availableCounts[0]), maxAvailable);
  selectEl.value = String(count);

  renderOptionInputs(q.options, q.isSurvey ? null : q.correctIndex);

  document.getElementById('addForm').classList.add('editing');
  document.getElementById('submitQBtn').textContent = 'עדכון שאלה';
  document.getElementById('editActionsRow').hidden = false;

  document.getElementById('addForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== יציאה ממצב עריכה חזרה למצב "הוספת שאלה" =====
// resetForm=true גם מאפס את שדות הטופס (משמש בביטול עריכה / אחרי מחיקת השאלה הנערכת)
function resetEditState(resetForm) {
  editingQuestionId = null;
  document.getElementById('addForm').classList.remove('editing');
  document.getElementById('submitQBtn').textContent = 'הוספת שאלה';
  document.getElementById('editActionsRow').hidden = true;

  if (resetForm) {
    document.getElementById('addForm').reset();
    document.getElementById('correctAnswerSection').hidden = false;
    document.getElementById('typeKnowledge').checked = true;
    renderOptionInputs();
  }
}

document.getElementById('cancelEditBtn').addEventListener('click', () => resetEditState(true));

async function moveQuestion(id, direction) {
  const idx = questionsCache.findIndex((q) => q._id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= questionsCache.length) return;
  const reordered = [...questionsCache];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  await authFetch('/admin/questions/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds: reordered.map((q) => q._id) })
  });
  loadQuestions();
}

// ===== טופס הוספת/עריכת שאלה + תמיכה בסקר =====
// prefillOptions/prefillCorrectIndex משמשים רק בכניסה למצב עריכה (startEditQuestion).
// בכל קריאה רגילה (למשל שינוי כמות האפשרויות) - שומרים את מה שכבר הוקלד בטופס:
// אם מגדילים כמות, האפשרויות הקיימות נשארות כמו שהן ורק מתווספות שדות ריקים
// נוספים בסוף; אם מקטינים, רק העודפות בסוף נגזרות.
function renderOptionInputs(prefillOptions, prefillCorrectIndex) {
  const count = Number(document.getElementById('optCount').value);
  const isSurvey = document.getElementById('typeSurvey').checked;
  const wrap = document.getElementById('optionsWrap');

  const existingValues = prefillOptions
    || Array.from(wrap.querySelectorAll('.opt-input')).map((i) => i.value);

  const existingChecked = wrap.querySelector('input[name=correctIndex]:checked');
  let currentCorrectIndex = prefillCorrectIndex != null
    ? prefillCorrectIndex
    : (existingChecked ? Number(existingChecked.value) : 0);

  wrap.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'opt-row';
    const value = existingValues[i] || '';
    const isChecked = i === currentCorrectIndex;
    // radio לתשובה נכונה מוצג רק בשאלת ידע
    row.innerHTML = `
      ${!isSurvey ? `<input type="radio" name="correctIndex" value="${i}" ${isChecked ? 'checked' : ''}>` : ''}
      <input type="text" class="opt-input" placeholder="אפשרות ${i + 1}" value="${escapeHtml(value)}" required>
    `;
    wrap.appendChild(row);
  }

  // אם התשובה הנכונה שהייתה מסומנת נמצאת מעבר לכמות האפשרויות החדשה
  // (הקטנת כמות מתחת לאינדקס שנבחר) - נבחר כברירת מחדל את האפשרות הראשונה
  if (!isSurvey && currentCorrectIndex >= count) {
    const first = wrap.querySelector('input[name=correctIndex]');
    if (first) first.checked = true;
  }
}

document.getElementById('optCount').addEventListener('change', renderOptionInputs);

// מעבר בין סוג שאלה: הסתרת/הצגת בחירת תשובה נכונה
document.querySelectorAll('input[name="qType"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isSurvey = document.getElementById('typeSurvey').checked;
    document.getElementById('correctAnswerSection').hidden = isSurvey;
    renderOptionInputs(); // מרנדר מחדש כדי להוסיף/להסיר את ה-radios
  });
});

renderOptionInputs();

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const isSurvey = document.getElementById('typeSurvey').checked;
  const options = Array.from(document.querySelectorAll('.opt-input')).map((i) => i.value.trim());
  const text = document.getElementById('qText').value.trim();
  const answerWindowSeconds = Number(document.getElementById('qSeconds').value);

  // correctIndex: רלוונטי רק לשאלת ידע
  let correctIndex = null;
  if (!isSurvey) {
    const checked = document.querySelector('input[name=correctIndex]:checked');
    if (!checked) { alert('יש לסמן תשובה נכונה'); return; }
    correctIndex = Number(checked.value);
  }

  const isEditing = !!editingQuestionId;
  const url = isEditing ? '/admin/questions/' + editingQuestionId : '/admin/questions';
  const method = isEditing ? 'PATCH' : 'POST';

  const res = await authFetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, options, correctIndex, answerWindowSeconds, isSurvey })
  });

  if (res.ok) {
    resetEditState(true);
    loadQuestions();
  } else {
    const err = await res.json();
    alert('שגיאה: ' + (err.error || 'לא ידועה'));
  }
});

// ===================================================================
// ניהול משתמשים
// ===================================================================
async function loadUsers() {
  const res = await authFetch('/admin/contacts');
  if (!res.ok) return;
  const contacts = await res.json();
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '';

  contacts.forEach((c) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${c.phone}${c.hasCalled ? '' : ' <span class="muted">(טרם התקשר)</span>'}</td>
      <td><input type="text" class="nick-input" value="${c.name || ''}" placeholder="כינוי..." data-phone="${c.phone}"></td>
      <td><button class="btn-mini" data-save="${c.phone}">שמור</button></td>
      <td><button class="btn-mini" data-delplayer="${c.phone}">מחק שחקן</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.save;
      const input = tbody.querySelector(`.nick-input[data-phone="${phone}"]`);
      await authFetch('/admin/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name: input.value.trim() })
      });
      const original = btn.textContent;
      btn.textContent = '✔ נשמר';
      setTimeout(() => (btn.textContent = original), 1200);
    });
  });

  tbody.querySelectorAll('[data-delplayer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const phone = btn.dataset.delplayer;
      if (!confirm(`למחוק לצמיתות את השחקן ${phone}?`)) return;
      await authFetch('/admin/players/' + phone, { method: 'DELETE' });
      loadUsers();
    });
  });
}

document.getElementById('addPlayerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('newPlayerPhone').value.trim();
  const name = document.getElementById('newPlayerName').value.trim();
  const res = await authFetch('/admin/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, name })
  });
  if (res.ok) { e.target.reset(); loadUsers(); }
  else { const err = await res.json(); alert('שגיאה: ' + (err.error || 'לא ידועה')); }
});

// ===================================================================
// ניקוד חי
// ===================================================================
async function loadScores() {
  const [scoreRes, speedRes] = await Promise.all([
    authFetch('/admin/leaderboard'),
    authFetch('/admin/leaderboard-speed')
  ]);
  if (!scoreRes.ok || !speedRes.ok) return;
  const scores = await scoreRes.json();
  const speed = await speedRes.json();

  document.querySelector('#scoresTable tbody').innerHTML =
    scores.map((p, i) => `
      <tr><td class="rank">${i + 1}</td><td>${p.name || p.phone}</td><td>${p.score}</td><td><span class="dot ${p.active ? 'dot-on' : 'dot-off'}"></span></td></tr>
    `).join('') || '<tr><td colspan="4" class="muted">אין עדיין נתונים</td></tr>';

  document.querySelector('#speedTable tbody').innerHTML =
    speed.map((p, i) => `
      <tr><td class="rank">${i + 1}</td><td>${p.name || p.phone}</td><td>${(p.avgTimeMs / 1000).toFixed(1)} שנ'</td><td>${p.correctCount}</td></tr>
    `).join('') || '<tr><td colspan="4" class="muted">אין עדיין נתונים</td></tr>';
}

// ===================================================================
// מחוברים כרגע
// ===================================================================
async function loadConnections() {
  const res = await authFetch('/admin/connected');
  if (!res.ok) return;
  const list = await res.json();
  document.querySelector('#connectionsTable tbody').innerHTML =
    list.map((p) => `
      <tr><td>${p.name || '—'}</td><td>${p.phone}</td><td>${new Date(p.connectedAt).toLocaleTimeString('he-IL')}</td></tr>
    `).join('') || '<tr><td colspan="3" class="muted">אין שחקנים מחוברים כרגע</td></tr>';
}

// ===================================================================
// סטטוס ראשוני
// ===================================================================
async function loadStatus() {
  const [statusRes, connectedRes] = await Promise.all([
    authFetch('/admin/status'),
    authFetch('/admin/connected')
  ]);
  if (!statusRes.ok || !connectedRes.ok) return;
  const s = await statusRes.json();
  const connected = await connectedRes.json();

  activeCallIds.clear();
  connected.forEach((p) => activeCallIds.add(p.callId));
  updateConnectedCount();

  if (s.activeGame) {
    document.getElementById('activeGameName').textContent = '· ' + s.activeGame.name;
    const code = s.activeGame.code || '----';
    const codeEl = document.getElementById('callCardCode');
    if (codeEl) codeEl.textContent = code;
    const headerCodeEl = document.getElementById('headerCode');
    if (headerCodeEl) headerCodeEl.textContent = code;
  }

  if (s.status === 'displayed' && s.currentQuestion) {
    document.getElementById('idleState').hidden = true;
    document.getElementById('questionResults').hidden = true;
    document.getElementById('questionLive').hidden = false;

    const surveyBadge = document.getElementById('surveyBadge');
    if (surveyBadge) surveyBadge.hidden = !s.currentQuestion.isSurvey;

    document.getElementById('liveQText').textContent = s.currentQuestion.text;
    renderLiveOptions(s.currentQuestion.options);
    showDisplayedState();
    setControlState('displayed');
    updateNavButtons(s.hasPrev, s.hasNext);
  }

  if ((s.status === 'open' || s.status === 'paused') && s.currentQuestion) {
    document.getElementById('idleState').hidden = true;
    document.getElementById('questionResults').hidden = true;
    document.getElementById('questionLive').hidden = false;

    const surveyBadge = document.getElementById('surveyBadge');
    if (surveyBadge) surveyBadge.hidden = !s.currentQuestion.isSurvey;

    document.getElementById('liveQText').textContent = s.currentQuestion.text;
    renderLiveOptions(s.currentQuestion.options);
    updateNavButtons(s.hasPrev, s.hasNext);

    if (s.status === 'paused') {
      // קפוא לגמרי - בלי טיימר רץ, עד שהמנהל ילחץ "המשך"
      showReadyState();
      setControlState('paused');
    } else if (s.openedAt) {
      // visualStartAt חייב להיבנות באותו נוסחה כמו armQuestionTimers בשרת
      const visualStartAt = s.openedAt + (s.readingSeconds || 0) * 1000;
      const untilVisual = visualStartAt - Date.now();
      if (untilVisual > 0) {
        showReadyState();
        setTimeout(() => startTimer(s.currentQuestion.answerWindowSeconds, visualStartAt), untilVisual);
      } else {
        startTimer(s.currentQuestion.answerWindowSeconds, visualStartAt);
      }
      setControlState('open');
    }
  }

  if (s.autoAdvance) setControlState('resumed');
}