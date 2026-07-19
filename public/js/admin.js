const socket = io();
const activeCallIds = new Set();
let questionsCache = [];
let countdownInterval = null;
let currentRole = null; // 'super' | 'game'
let appInitialized = false;

const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

// ===================================================================
// התחברות
// ===================================================================

async function checkAuth() {
  const res = await fetch('/admin/me');
  const data = await res.json();
  if (data.authenticated) onAuthenticated(data.role, data.gameName);
  else showLogin();
}

function showLogin(errorMsg) {
  document.getElementById('loginOverlay').hidden = false;
  document.getElementById('loginError').textContent = errorMsg || '';
}

function onAuthenticated(role, gameName) {
  currentRole = role;
  document.getElementById('loginOverlay').hidden = true;
  document.getElementById('gamesNavBtn').hidden = role !== 'super';
  document.getElementById('activeGameName').textContent = gameName ? '· ' + gameName : '';
  initApp();
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('loginPassword').value;
  const res = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (res.ok) {
    document.getElementById('loginPassword').value = '';
    onAuthenticated(data.role, data.gameName);
  } else {
    showLogin(data.error || 'שגיאה בהתחברות');
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/admin/logout', { method: 'POST' });
  location.reload();
});

// עוטף fetch לפעולות ניהול - אם השרת מחזיר 401 (session פג/לא קיים), חוזרים למסך login
async function authFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    showLogin('פג תוקף ההתחברות - יש להתחבר מחדש');
  }
  return res;
}

function initApp() {
  if (appInitialized) return;
  appInitialized = true;
  loadQuestions();
  loadStatus();
}

checkAuth();

// ===================================================================
// מונה מחוברים
// ===================================================================
socket.on('playerConnected', (p) => { activeCallIds.add(p.callId); updateConnectedCount(); });
socket.on('playerDisconnected', (p) => { activeCallIds.delete(p.callId); updateConnectedCount(); });
function updateConnectedCount() {
  document.getElementById('connectedCount').textContent = activeCallIds.size;
}

socket.on('connect', () => document.getElementById('connDot').className = 'conn-dot on');
socket.on('disconnect', () => document.getElementById('connDot').className = 'conn-dot off');

// ===================================================================
// החלפת משחק פעיל (ע"י סיסמת-על) - כל דשבורד פתוח מתעדכן
// ===================================================================
socket.on('gameSwitched', (data) => {
  alert('המשחק הפעיל הוחלף ל: ' + data.gameName + '\nהעמוד ייטען מחדש.');
  location.reload();
});

// ===================================================================
// Fair Play: הבזק שם בלבד כשמישהו עונה, בלי לחשוף מה נבחר או אם נכון
// ===================================================================
socket.on('playerAnswered', (a) => showAnswerToast(a.name || a.phone || 'שחקן'));
function showAnswerToast(label) {
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'answer-toast';
  el.textContent = '✓ ' + label + ' ענה/תה';
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 1300);
}

// ===================================================================
// שאלה חיה
// ===================================================================
socket.on('questionOpened', (data) => {
  document.getElementById('idleState').hidden = true;
  document.getElementById('questionResults').hidden = true;
  document.getElementById('questionLive').hidden = false;

  document.getElementById('liveQText').textContent = data.question.text;
  renderLiveOptions(data.question.options);
  startTimer(data.answerWindowSeconds, data.openedAt);
  setControlState('open');
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
}

function startTimer(seconds, openedAt) {
  if (countdownInterval) clearInterval(countdownInterval);
  const ring = document.getElementById('timerRing');
  const numEl = document.getElementById('timerNum');
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

socket.on('questionResults', (r) => {
  const panel = document.getElementById('questionResults');
  panel.hidden = false;

  const q = questionsCache.find((qq) => qq._id === r.questionId);
  document.getElementById('resultsQText').textContent = q ? q.text : '';

  const bars = document.getElementById('resultsBars');
  bars.innerHTML = '';
  const options = q ? q.options : r.percentages.map((_, i) => `אפשרות ${i + 1}`);

  options.forEach((opt, i) => {
    const row = document.createElement('div');
    row.className = 'bar-row' + (i === r.correctIndex ? ' correct' : '');
    row.innerHTML = `
      <div class="bar-label">${opt}</div>
      <div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>
      <div class="bar-pct">${r.percentages[i]}%</div>
    `;
    bars.appendChild(row);
    requestAnimationFrame(() => {
      row.querySelector('.bar-fill').style.width = r.percentages[i] + '%';
    });
  });
});

socket.on('gamePaused', () => setControlState('paused'));
socket.on('gameResumed', () => setControlState('resumed'));
socket.on('gameFinished', () => {
  document.getElementById('questionLive').hidden = true;
  document.getElementById('questionResults').hidden = true;
  const idle = document.getElementById('idleState');
  idle.hidden = false;
  idle.textContent = '🏁 המשחק הסתיים!';
});

// ===================================================================
// כפתורי שליטה (גלויים, קטנים)
// ===================================================================
function setControlState(kind) {
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const closeBtn = document.getElementById('closeBtn');

  if (kind === 'open') {
    startBtn.hidden = true;
    pauseBtn.hidden = false;
    pauseBtn.textContent = '⏸ השהה';
    closeBtn.hidden = false;
  }
  if (kind === 'closed') closeBtn.hidden = true;
  if (kind === 'paused') pauseBtn.textContent = '▶ המשך';
  if (kind === 'resumed') pauseBtn.textContent = '⏸ השהה';
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const res = await authFetch('/admin/start-game', { method: 'POST' });
  if (!res.ok) { const e = await res.json(); alert('שגיאה: ' + e.error); }
});
document.getElementById('pauseBtn').addEventListener('click', async () => {
  const btn = document.getElementById('pauseBtn');
  if (btn.textContent.includes('השהה')) await authFetch('/admin/pause', { method: 'POST' });
  else await authFetch('/admin/resume', { method: 'POST' });
});
document.getElementById('closeBtn').addEventListener('click', async () => {
  await authFetch('/admin/close-question', { method: 'POST' });
});

// ===================================================================
// הצגת 3 מובילים
// ===================================================================
document.getElementById('top3Btn').addEventListener('click', async () => {
  const overlay = document.getElementById('top3Overlay');
  if (!overlay.hidden) { overlay.hidden = true; return; }

  const res = await authFetch('/admin/leaderboard');
  const players = await res.json();
  const top3 = players.slice(0, 3);
  const medals = ['🥇', '🥈', '🥉'];

  const panel = document.getElementById('top3Panel');
  panel.innerHTML = '<h2 class="top3-title">המובילים כרגע</h2>' +
    (top3.length
      ? top3.map((p, i) => `
          <div class="top3-row rank-${i + 1}">
            <span class="top3-medal">${medals[i]}</span>
            <span class="top3-name">${p.name || p.phone}</span>
            <span class="top3-score">${p.score} נק'</span>
          </div>`).join('')
      : '<div class="muted">אין עדיין נתונים</div>');

  overlay.hidden = false;
});
document.getElementById('top3Overlay').addEventListener('click', (e) => {
  if (e.target.id === 'top3Overlay') e.target.hidden = true;
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
    if (btn.dataset.panel === 'games') loadGames();
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
    const row = document.createElement('div');
    row.className = 'qrow';
    row.innerHTML = `
      <div class="qmain">
        <div class="t">${q.order}. ${q.text}</div>
        <div class="o">${q.options.map((o, i) => (i === q.correctIndex ? '✔ ' : '') + o).join(' · ')} · ${q.answerWindowSeconds} שנ'</div>
      </div>
      <button class="btn-mini" data-up="${q._id}" ${idx === 0 ? 'disabled' : ''}>▲</button>
      <button class="btn-mini" data-down="${q._id}" ${idx === questionsCache.length - 1 ? 'disabled' : ''}>▼</button>
      <button class="btn-mini" data-open="${q._id}">▶ פתח</button>
      <button class="btn-mini" data-del="${q._id}">מחק</button>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => moveQuestion(b.dataset.up, -1)));
  wrap.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => moveQuestion(b.dataset.down, 1)));
  wrap.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
    await authFetch('/admin/open-question/' + b.dataset.open, { method: 'POST' });
    closeDrawer();
  }));
  wrap.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('למחוק את השאלה הזו לצמיתות?')) return;
    await authFetch('/admin/questions/' + b.dataset.del, { method: 'DELETE' });
    loadQuestions();
  }));
}

async function moveQuestion(id, direction) {
  const idx = questionsCache.findIndex((q) => q._id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= questionsCache.length) return;

  const reordered = [...questionsCache];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  const orderedIds = reordered.map((q) => q._id);

  await authFetch('/admin/questions/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds })
  });
  loadQuestions();
}

function renderOptionInputs() {
  const count = Number(document.getElementById('optCount').value);
  const wrap = document.getElementById('optionsWrap');
  wrap.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'opt-row';
    row.innerHTML = `
      <input type="radio" name="correctIndex" value="${i}" ${i === 0 ? 'checked' : ''}>
      <input type="text" class="opt-input" placeholder="אפשרות ${i + 1}" required>
    `;
    wrap.appendChild(row);
  }
}
document.getElementById('optCount').addEventListener('change', renderOptionInputs);
renderOptionInputs();

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const options = Array.from(document.querySelectorAll('.opt-input')).map((i) => i.value.trim());
  const correctIndex = Number(document.querySelector('input[name=correctIndex]:checked').value);
  const text = document.getElementById('qText').value.trim();
  const answerWindowSeconds = Number(document.getElementById('qSeconds').value);

  const res = await authFetch('/admin/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, options, correctIndex, answerWindowSeconds })
  });
  if (res.ok) {
    e.target.reset();
    renderOptionInputs();
    loadQuestions();
  } else {
    const err = await res.json();
    alert('שגיאה: ' + (err.error || 'לא ידועה'));
  }
});

// ===================================================================
// ניהול משתמשים - כינויים + מחיקת שחקן
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
      <td>${c.phone}</td>
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
      if (!confirm(`למחוק לצמיתות את השחקן ${phone}? כל התשובות, הניקוד והכינוי שלו יימחקו ולא ניתן לשחזר.`)) return;
      await authFetch('/admin/players/' + phone, { method: 'DELETE' });
      loadUsers();
    });
  });
}

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

  document.querySelector('#scoresTable tbody').innerHTML = scores.map((p, i) => `
    <tr><td class="rank">${i + 1}</td><td>${p.name || p.phone}</td><td>${p.score}</td><td>${p.active ? '🟢' : '⚪'}</td></tr>
  `).join('') || '<tr><td colspan="4" class="muted">אין עדיין נתונים</td></tr>';

  document.querySelector('#speedTable tbody').innerHTML = speed.map((p, i) => `
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
  document.querySelector('#connectionsTable tbody').innerHTML = list.map((p) => `
    <tr><td>${p.name || '—'}</td><td>${p.phone}</td><td>${new Date(p.connectedAt).toLocaleTimeString('he-IL')}</td></tr>
  `).join('') || '<tr><td colspan="3" class="muted">אין שחקנים מחוברים כרגע</td></tr>';
}

// ===================================================================
// ניהול משחקים - רק לסיסמת-על
// ===================================================================
async function loadGames() {
  const res = await authFetch('/admin/games');
  if (!res.ok) return;
  const games = await res.json();

  document.querySelector('#gamesTable tbody').innerHTML = games.map((g) => `
    <tr>
      <td>${g.name}${g.isActive ? ' <span class="game-badge-active">פעיל</span>' : ''}</td>
      <td>${!g.isActive ? `<button class="btn-mini" data-activate="${g._id}">הפעל</button>` : ''}</td>
      <td>${!g.isActive ? `<button class="btn-mini" data-delgame="${g._id}">מחק</button>` : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="3" class="muted">אין עדיין משחקים</td></tr>';

  document.querySelectorAll('[data-activate]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('להפעיל את המשחק הזה? המשחק הפעיל הנוכחי (אם יש) ייסגר מיידית.')) return;
    await authFetch('/admin/games/' + b.dataset.activate + '/activate', { method: 'POST' });
  }));
  document.querySelectorAll('[data-delgame]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('למחוק את המשחק הזה לצמיתות? כל השאלות, השחקנים והתשובות שלו יימחקו ולא ניתן לשחזר.')) return;
    await authFetch('/admin/games/' + b.dataset.delgame, { method: 'DELETE' });
    loadGames();
  }));
}

document.getElementById('newGameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newGameName').value.trim();
  const password = document.getElementById('newGamePassword').value;

  const res = await authFetch('/admin/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password })
  });
  if (res.ok) {
    e.target.reset();
    loadGames();
  } else {
    const err = await res.json();
    alert('שגיאה: ' + (err.error || 'לא ידועה'));
  }
});

// ===================================================================
// סטטוס ראשוני (בעת רענון עמוד)
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

  if (s.activeGame) document.getElementById('activeGameName').textContent = '· ' + s.activeGame.name;

  if (s.status === 'open' && s.currentQuestion) {
    document.getElementById('idleState').hidden = true;
    document.getElementById('questionResults').hidden = true;
    document.getElementById('questionLive').hidden = false;
    document.getElementById('liveQText').textContent = s.currentQuestion.text;
    renderLiveOptions(s.currentQuestion.options);
    startTimer(s.currentQuestion.answerWindowSeconds, s.openedAt);
    setControlState('open');
  }

  if (s.autoAdvance) setControlState('resumed');
}
