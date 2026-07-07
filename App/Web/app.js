/* ============================================================
   CloudVPN – клиентская логика (v3)
   ============================================================ */
(() => {
  'use strict';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const cfg = window.CLOUDVPN_CONFIG;
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
  const fmtDate = ts => new Date(ts).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' });
  const daysLeft = ts => Math.max(0, Math.ceil((ts - Date.now()) / 864e5));

  // Красивый confirm в стиле приложения вместо нативного браузерного окна.
  function confirmModal(text, okLabel) {
    return new Promise(resolve => {
      const m = $('#confirmModal');
      if (!m) { resolve(window.confirm(text)); return; }
      $('#confirmText').textContent = text;
      $('#confirmYes').textContent = okLabel || 'Подтвердить';
      m.hidden = false;
      const close = (v) => { m.hidden = true; resolve(v); };
      $('#confirmYes').onclick = () => close(true);
      $('#confirmNo').onclick = () => close(false);
      $('#confirmBackdrop').onclick = () => close(false);
    });
  }

  // Текстовый ввод в нашем стиле вместо убогого нативного prompt() WebView2.
  function promptModal(text, { placeholder = '', okLabel = 'ОК', value = '' } = {}) {
    return new Promise(resolve => {
      const m = $('#promptModal'), inp = $('#promptInput');
      if (!m || !inp) { resolve(window.prompt(text) ); return; }
      $('#promptText').textContent = text;
      $('#promptYes').textContent = okLabel;
      inp.placeholder = placeholder; inp.value = value;
      m.hidden = false;
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
      const close = (v) => {
        m.hidden = true;
        inp.onkeydown = null;
        resolve(v);
      };
      const ok = () => { const v = (inp.value || '').trim(); close(v || null); };
      $('#promptYes').onclick = ok;
      $('#promptNo').onclick = () => close(null);
      $('#promptBackdrop').onclick = () => close(null);
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      };
    });
  }

  /* ---------- Тосты ---------- */
  let toastT;
  function toast(msg, err = false) {
    const el = $('#toast'); el.textContent = msg; el.classList.toggle('err', err); el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------- Мягкий «облачный» звук (синтез Web Audio, без файлов/АП) ---------- */
  let audioCtx = null;
  function playChime(kind) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const ctx = audioCtx, t0 = ctx.currentTime;
      const master = ctx.createGain(); master.gain.value = 0.0001; master.connect(ctx.destination);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2300; lp.Q.value = 0.6; lp.connect(master);
      const CH = {
        news:       [587.33, 739.99, 880.00],   // ре-мажор — уведомление
        connect:    [659.25, 830.61, 987.77],   // ми-мажор — похож на уведомление, но ярче/выше
        disconnect: [523.25, 659.25, 783.99],   // до-мажор — бывший звук «включения»
      };
      const notes = CH[kind] || CH.news;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(lp);
        const s = t0 + i * 0.07;
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.22, s + 0.05);              // мягкая «облачная» атака
        g.gain.exponentialRampToValueAtTime(0.0008, s + 0.95);       // плавное затухание
        o.frequency.setValueAtTime(f * 0.996, s);
        o.frequency.linearRampToValueAtTime(f, s + 0.14);            // лёгкий подъём
        o.start(s); o.stop(s + 1.05);
      });
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.linearRampToValueAtTime(0.85, t0 + 0.02);
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.15);
    } catch {}
  }
  // Нативное уведомление Windows (через мост в C#); заголовок задаёт C#
  function winNotify(body) {
    if (host) host.postMessage('notify:' + (body || '').replace(/\s+/g, ' ').slice(0, 180));
  }

  /* ---------- Окно ---------- */
  $('#winControls').addEventListener('click', e => { const b = e.target.closest('[data-win]'); if (b && host) host.postMessage('win:' + b.dataset.win); });
  $('#titlebar').addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('[data-win]') && host) host.postMessage('win:drag'); });
  $('#titlebar').addEventListener('dblclick', e => { if (!e.target.closest('[data-win]') && host) host.postMessage('win:max'); });

  /* ---------- Подсветка под кнопками (эффект при наведении) ---------- */
  document.addEventListener('pointermove', e => {
    const b = e.target.closest('.btn'); if (!b) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    b.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  /* ---------- Маскот: глаза за курсором ---------- */
  const glow = $('#cursorGlow');
  function moveEyes(cx, cy) {
    $$('[data-mascot]').forEach(m => {
      if (!m.offsetParent) return;
      const r = m.getBoundingClientRect();
      const mx = r.left + r.width/2, my = r.top + r.height*0.55;
      const a = Math.atan2(cy-my, cx-mx), d = Math.min(4.5, Math.hypot(cx-mx, cy-my)/40);
      const dx = Math.cos(a)*d, dy = Math.sin(a)*d;
      $$('.eye__pupil', m).forEach(p => p.style.transform = `translate(${dx}px,${dy}px)`);
      $$('.eye__spark', m).forEach(p => p.style.transform = `translate(${dx*.6}px,${dy*.6}px)`);
    });
  }
  document.addEventListener('mousemove', e => { moveEyes(e.clientX, e.clientY); glow.style.left = e.clientX+'px'; glow.style.top = e.clientY+'px'; });
  (function blink(){ const m = $$('[data-mascot]').find(x => x.offsetParent); if (m){ m.classList.add('blink'); setTimeout(()=>m.classList.remove('blink'),150);} setTimeout(blink, 2600+Math.random()*3500); })();

  // Эффекты Клауди (Zzz во сне, дождик, эмоции-оверлеи)
  $$('[data-mascot]').forEach(m => {
    const z = document.createElement('div'); z.className = 'mascot__zzz'; z.innerHTML = 'Z<span>z</span><span>z</span>'; m.appendChild(z);
    const r = document.createElement('div'); r.className = 'mascot__rain';
    for (let i = 0; i < 6; i++) { const d = document.createElement('i'); d.style.left = (8 + i*16) + '%'; d.style.animationDelay = (Math.random()).toFixed(2) + 's'; d.style.height = (7 + Math.random()*5).toFixed(0) + 'px'; r.appendChild(d); }
    m.appendChild(r);
    const emo = document.createElement('div'); emo.className = 'mascot__emo';
    emo.innerHTML = '<span class="emo-glasses"></span><span class="emo-heart emo-heart--l">❤</span><span class="emo-heart emo-heart--r">❤</span>';
    m.appendChild(emo);
  });
  // Переключение эмоции (love/cool/wow/sad/happy)
  function setEmotion(name) {
    const cls = { love:'emo-love', cool:'emo-cool', wow:'emo-wow', sad:'emo-sad', angry:'emo-sad', party:'emo-cool' }[name];
    $$('[data-mascot]').forEach(m => {
      ['emo-love','emo-cool','emo-wow','emo-sad'].forEach(c => m.classList.remove(c));
      if (cls) m.classList.add(cls);
    });
  }
  window.__setEmotion = setEmotion;

  // Настроение по времени суток (+ погода). VPN включён или недавнее уведомление — будит Клауди.
  let weather = null, vpnOn = false, wakeUntil = 0;
  const moodByHour = () => { const h = new Date().getHours(); return (h >= 23 || h < 6) ? 'sleep' : (h >= 18) ? 'tired' : 'awake'; };
  function applyMood() {
    const awake = vpnOn || Date.now() < wakeUntil;          // VPN вкл / только что пришло уведомление
    const base = awake ? 'awake' : moodByHour();
    const raining = !!(weather && weather.isRain);
    $$('[data-mascot]').forEach(m => {
      m.classList.toggle('mood-sleep', base === 'sleep');
      m.classList.toggle('mood-tired', base === 'tired');
      m.classList.toggle('mood-rain', raining && base !== 'sleep'); // спящий не «дождит»
    });
  }
  function wakeMascot(ms = 30000) { wakeUntil = Date.now() + ms; applyMood(); setTimeout(applyMood, ms + 300); }
  applyMood(); setInterval(applyMood, 60000);

  // Реальная погода (без ключей: ipwho.is + open-meteo), best-effort
  (async function loadWeather() {
    try {
      const loc = await fetch('https://ipwho.is/').then(r => r.json());
      if (!loc || !loc.latitude) return;
      const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`).then(r => r.json());
      const cw = w.current_weather, code = cw.weathercode;
      const rain = [51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99], snow = [71,73,75,77,85,86];
      weather = { isRain: rain.includes(code), isSnow: snow.includes(code), clear: code === 0, temp: Math.round(cw.temperature), city: loc.city || '' };
      applyMood(); updateSky();
    } catch { /* офлайн – остаёмся на «погоде по часам» */ }
  })();

  // Пожелание с учётом времени и погоды
  let lastWishText = '';
  function pickWish() {
    const h = new Date().getHours();
    const pool = [
      'Хорошего дня! ☀️', 'Ты под надёжной защитой 🛡️', 'Не забудь сделать перерыв ☕',
      'Пусть скорость будет с тобой ⚡', 'Я приглядываю за твоим трафиком 👀',
      'Улыбнись – всё зашифровано 🔐', 'Попей водички 💧', 'Ты сегодня молодец! 🌟',
      'Витаю в облаках ради тебя ☁️', 'Твои данные – только твои 🤫', 'Пусть пинг будет низким 🏓',
    ];
    if (h >= 23 || h < 6) pool.push('Ммм… дай поспать 😴', 'Уже поздно, отдохни 🌙', 'Тссс, я сплю 💤');
    else if (h >= 18) pool.push('Уф, какой был день… 😮‍💨', 'Вечер – время расслабиться 🛋️');
    else if (h < 11) pool.push('Доброе утро! ☕', 'Бодрого дня! 🌅');
    if (weather) {
      if (weather.isRain) pool.push('За окном дождь ☔ – посиди дома', 'Кап-кап… уютной погоды 🌧️');
      else if (weather.isSnow) pool.push('Снежно ❄️ – не мёрзни!');
      else if (weather.clear) pool.push('За окном ясно ☀️ – красота!');
      if (weather.city) pool.push(`Сейчас ${weather.temp}° в г. ${weather.city} 🌡️`);
    }
    const hol = getHoliday();
    if (hol === 'newyear') pool.push('С наступающим! 🎄', 'Загадай желание ✨', 'Пусть Новый год мчит, как наш VPN 🎅');
    else if (hol === 'halloween') pool.push('Бу! 👻', 'Сладость или гадость? 🎃', 'Сегодня даже трафик призрачный 🕸️');
    else if (hol === 'valentine') pool.push('С Днём всех влюблённых! 💝', 'Ты сегодня особенно мил 💗', 'Сердечко тебе ❤️');
    else if (hol === 'defender') pool.push('С 23 Февраля! 🎖️', 'Ты — наш герой 💪', 'Защищаю твой трафик как настоящий боец 🛡️');
    else if (hol === 'womensday') pool.push('С 8 Марта! 🌷', 'Ты прекрасна! 🌸', 'Цветы для тебя 💐');
    else if (hol === 'victory') pool.push('С Днём Победы! 🎆', 'Спасибо за мир 🕊️', 'Помним и гордимся ⭐');
    let t; do { t = pool[Math.floor(Math.random()*pool.length)]; } while (t === lastWishText && pool.length > 1);
    return (lastWishText = t);
  }
  $$('[data-mascot]').forEach(m => m.addEventListener('click', () => {
    const b = m.querySelector('[data-bubble]'); if (!b) return;
    b.textContent = pickWish(); b.classList.add('show');
    m.classList.add('blink'); setTimeout(() => m.classList.remove('blink'), 150);
    clearTimeout(m.__bt); m.__bt = setTimeout(() => b.classList.remove('show'), 4000);
  }));

  /* ============================================================ ПРАЗДНИКИ И СЕЗОНЫ ============================================================ */
  function inHolidayRange(r) {
    if (!r) return false;
    const d = new Date(), md = (d.getMonth() + 1) * 100 + d.getDate();
    const f = +r.from.replace('-', ''), t = +r.to.replace('-', '');
    return f <= t ? (md >= f && md <= t) : (md >= f || md <= t); // переход через год (НГ)
  }
  const FX_KEY = 'cloudvpn.fx';
  let fxOn = localStorage.getItem(FX_KEY) !== '0';   // тумблер праздничных эффектов
  function getHolidayRaw() {
    const o = cfg.holiday || 'auto';
    if (o !== 'auto') return o === 'none' ? null : o;
    const D = cfg.holidayDates || {};
    for (const k of ['halloween', 'newyear', 'valentine', 'defender', 'womensday', 'victory'])
      if (inHolidayRange(D[k])) return k;
    return null;
  }
  const getHoliday = () => (fxOn ? getHolidayRaw() : null);
  const isNewYearNight = () => { const d = new Date(), m = d.getMonth() + 1, dd = d.getDate(); return (m === 12 && dd === 31) || (m === 1 && dd === 1); };
  let lightningTimer = null;
  const isWinter = () => { const m = new Date().getMonth() + 1; return m === 12 || m === 1 || m === 2; };

  // Что сыпать: снег зимой/в НГ, иначе дождь в тёмной теме или по реальной погоде
  function decidePrecip() {
    const theme = document.documentElement.getAttribute('data-theme');
    const h = getHoliday();
    if (h === 'halloween') return 'rain';                                        // дождь на Хеллоуин
    if (fxOn && (h === 'newyear' || isWinter() || (weather && weather.isSnow))) return 'snow';
    if (theme === 'dark' || (weather && weather.isRain)) return 'rain';
    return 'none';
  }
  const fireworksActive = () => {
    if (!fxOn) return false;
    const h = getHoliday();
    if (h === 'victory') return true;                                            // салют на 9 мая
    return h === 'newyear' && (cfg.holiday === 'newyear' || isNewYearNight());   // НГ — в ночь
  };
  function updateSky() {
    if (!window.Sky) return;
    window.Sky.set(decidePrecip());
    if (window.Sky.fireworks) window.Sky.fireworks(fireworksActive());
  }

  const HAT = {
    newyear: `<svg class="mascot__hat" viewBox="0 0 64 54" aria-hidden="true"><path d="M6 46C12 14 44 6 58 20L24 50Z" fill="#e0344a"/><rect x="2" y="42" width="40" height="11" rx="5.5" fill="#fff"/><circle cx="60" cy="18" r="7" fill="#fff"/></svg>`,
    halloween: `<svg class="mascot__hat" viewBox="0 0 64 60" aria-hidden="true"><ellipse cx="30" cy="50" rx="30" ry="8" fill="#3a2a5e"/><path d="M30 4C36 22 40 38 42 50H18C20 38 24 22 30 4Z" fill="#5a3aa0"/><path d="M22 40h16" stroke="#ffd56b" stroke-width="3" stroke-linecap="round"/></svg>`,
  };

  function startStorm(box) {
    const flash = document.createElement('div'); flash.className = 'hw-lightning'; box.appendChild(flash);
    (function strike() {
      flash.classList.remove('flash'); void flash.offsetWidth; flash.classList.add('flash');
      lightningTimer = setTimeout(strike, 5000 + Math.random() * 7000);
    })();
  }

  const rndPick = a => a[(Math.random() * a.length) | 0];
  function floatUp(emojis, n) {
    return Array.from({ length: n }, () => {
      const dur = 7 + Math.random() * 7;
      return `<span class="fl-up" style="left:${(Math.random()*96+2).toFixed(1)}%;font-size:${(18+Math.random()*16)|0}px;animation-duration:${dur.toFixed(1)}s;animation-delay:${(-Math.random()*dur).toFixed(1)}s">${rndPick(emojis)}</span>`;
    }).join('');
  }
  function twinkle(emojis, n) {
    return Array.from({ length: n }, () => {
      const dur = 2 + Math.random() * 2.5;
      return `<span class="fl-tw" style="left:${(Math.random()*92+4).toFixed(1)}%;top:${(Math.random()*55+4).toFixed(1)}%;font-size:${(16+Math.random()*14)|0}px;animation-duration:${dur.toFixed(1)}s;animation-delay:${(-Math.random()*dur).toFixed(1)}s">${rndPick(emojis)}</span>`;
    }).join('');
  }
  const GREET = {
    newyear:   'С наступающим Новым годом! 🎄🎅',
    halloween: 'С Хеллоуином! Бу! 👻🎃',
    valentine: 'С Днём святого Валентина! 💝',
    defender:  'С Днём защитника Отечества! 🎖️',
    womensday: 'С 8 Марта! Ты прекрасна 🌷',
    victory:   'С Днём Победы! 🎆 Помним 🕊️',
  };
  function greetHoliday() {
    const h = getHoliday(); if (!h || !GREET[h]) return;
    const m = $$('[data-mascot]').find(x => x.offsetParent); if (!m) return;
    const b = m.querySelector('[data-bubble]'); if (!b) return;
    b.textContent = GREET[h]; b.classList.add('show');
    clearTimeout(m.__bt); m.__bt = setTimeout(() => b.classList.remove('show'), 6000);
  }

  function applyHoliday() {
    const h = getHoliday();
    ['newyear', 'halloween', 'valentine', 'defender', 'womensday'].forEach(k =>
      document.body.classList.toggle('holiday-' + k, h === k));
    const box = document.getElementById('holiday'); box.innerHTML = ''; clearTimeout(lightningTimer);
    if (h === 'halloween') {
      box.innerHTML =
        '<div class="hw-web hw-web--tl">🕸️</div><div class="hw-web hw-web--tr">🕸️</div>' +
        '<div class="hw-spider"><span class="hw-spider__thread"></span><span class="hw-spider__body">🕷️</span></div>' +
        '<div class="hw-bat hw-bat--1">🦇</div><div class="hw-bat hw-bat--2">🦇</div><div class="hw-bat hw-bat--3">🦇</div>' +
        '<div class="hw-pumpkin hw-pumpkin--l">🎃</div><div class="hw-pumpkin hw-pumpkin--r">🎃</div>';
      startStorm(box);
    } else if (h === 'newyear') {
      const colors = ['#ff5168', '#2f6bff', '#16b277', '#f0a31a', '#b06bff'];
      const bulbs = Array.from({ length: 22 }, (_, i) => `<i style="color:${colors[i % colors.length]};animation-delay:${(i % 5) * .2}s"></i>`).join('');
      box.innerHTML = `<div class="ny-garland">${bulbs}</div><div class="ny-deco ny-deco--l">🎄</div><div class="ny-deco ny-deco--r">🎁</div>`;
    } else if (h === 'valentine') {
      box.innerHTML = floatUp(['💝', '❤️', '💕', '💗'], 12) +
        '<div class="fl-corner" style="left:92px">💐</div><div class="fl-corner" style="right:14px">🌹</div>';
    } else if (h === 'defender') {
      box.innerHTML = twinkle(['⭐', '✨', '🎖️'], 12) +
        '<div class="fl-corner" style="left:92px">🎖️</div><div class="fl-corner" style="right:14px">⭐</div>';
    } else if (h === 'womensday') {
      box.innerHTML = floatUp(['🌷', '🌹', '💐', '🌸'], 12) +
        '<div class="fl-corner" style="left:92px">🌷</div><div class="fl-corner" style="right:14px">💐</div>';
    } else if (h === 'victory') {
      box.innerHTML = twinkle(['⭐', '🎆', '🎗️'], 12) +
        '<div class="fl-corner" style="left:92px">🎆</div><div class="fl-corner" style="right:14px">🕊️</div>';
    }
    // головной убор облачку (есть только для НГ и Хеллоуина)
    $$('[data-mascot]').forEach(m => {
      const old = m.querySelector('.mascot__hat'); if (old) old.remove();
      if (HAT[h]) m.insertAdjacentHTML('beforeend', HAT[h]);
    });
    // тумблер эффектов показываем только когда есть что отключать
    const row = $('#fxToggleRow'); if (row) row.hidden = !(getHolidayRaw() || isWinter());
    if (h === 'valentine') setEmotion('love');
  }

  /* ============================================================ НОВОСТИ (ClaudiNewsBot) ============================================================ */
  const newsCard = $('#newsCard');
  let newsTimer = null, shownNewsId = +(localStorage.getItem('cloudvpn.newsSeen') || 0);
  function closeNews() { newsCard.classList.remove('show'); setTimeout(() => { newsCard.hidden = true; }, 400); }
  $('#newsClose').addEventListener('click', closeNews);
  function showNews(n) {
    $('#newsText').textContent = n.text || '';
    $('#newsDate').textContent = n.date ? new Date(n.date).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
    const img = $('#newsImg');
    if (n.imageUrl) { img.src = n.imageUrl; img.hidden = false; } else { img.hidden = true; }
    newsCard.hidden = false; requestAnimationFrame(() => newsCard.classList.add('show'));
    if (n.emotion) { setEmotion(n.emotion); setTimeout(() => setEmotion('happy'), 6000); }
  }
  async function pollNews() {
    let n; try { n = await window.API.getLatestNews(); } catch { return; }
    if (!n || (!n.text && !n.imageUrl)) return;
    const id = n.id || 0;
    if (id <= shownNewsId) return;                       // эту новость уже показывали
    shownNewsId = id; localStorage.setItem('cloudvpn.newsSeen', String(id));
    showNews(n);                                         // новая — показываем сразу
    playChime('news');                                  // «облачный» звук
    winNotify(n.text || 'Новое сообщение');             // уведомление Windows
    wakeMascot();                                       // Клауди просыпается
  }
  function startNews() {
    pollNews();                                          // при входе
    if (window.API.LIVE) { clearInterval(newsTimer); newsTimer = setInterval(pollNews, 20000); }  // живой опрос
  }
  function stopNews() { clearInterval(newsTimer); newsTimer = null; }

  /* ============================================================ ПРАЗДНИЧНЫЙ ПОДАРОК (+дни, время с сервера) ============================================================ */
  const giftBtn = $('#giftBtn');
  async function refreshGift() {
    let st; try { st = await window.API.getServerTime(); } catch { st = null; }
    const today = (st && st.date) || new Date().toISOString().slice(0, 10);
    // праздник: с сервера (LIVE) либо локально (demo)
    const holiday = st && !st.demo ? st.holiday : (fxOn ? getHolidayRaw() : null);
    const claimed = localStorage.getItem('cloudvpn.gift') === today;
    const show = !!holiday && fxOn && !claimed && !!window.API.getSession();
    if (show) { giftBtn.hidden = false; requestAnimationFrame(() => giftBtn.classList.add('show')); }
    else { giftBtn.classList.remove('show'); setTimeout(() => { giftBtn.hidden = true; }, 300); }
  }
  giftBtn.addEventListener('click', async () => {
    giftBtn.classList.add('pop');
    try {
      const r = await window.API.claimGift();
      if (r.claimed) {
        localStorage.setItem('cloudvpn.gift', new Date().toISOString().slice(0, 10));
        renderSubscription(window.API.getSession()?.subscription);
        toast(`Подарок твой! +${r.days || 1} день подписки 🎁`);
        setEmotion('party'); setTimeout(() => setEmotion('happy'), 2600);
        giftBtn.classList.remove('show'); setTimeout(() => { giftBtn.hidden = true; }, 400);
      } else {
        toast(r.reason === 'already' ? 'Сегодня подарок уже получен 🎁' : 'Подарок недоступен', true);
        if (r.reason === 'already') { giftBtn.classList.remove('show'); setTimeout(() => { giftBtn.hidden = true; }, 400); }
      }
    } catch { toast('Не удалось забрать подарок', true); }
    finally { setTimeout(() => giftBtn.classList.remove('pop'), 300); }
  });

  /* ============================================================ АВТОРИЗАЦИЯ ============================================================ */
  const authView = $('#authView'), appShell = $('#appShell');
  const showStep = n => $$('#authView .auth__step').forEach(s => s.hidden = s.dataset.step !== n);
  $('#tgBotName').textContent = '@' + cfg.telegram.botUsername;

  let tgToken = null, tgPollTimer = null;
  $('#tgLoginBtn').addEventListener('click', async () => {
    const { token, link } = await window.API.tgStart(); tgToken = token; showStep('tg'); window.API.tgOpen(link);
    clearInterval(tgPollTimer);
    tgPollTimer = setInterval(async () => { const r = await window.API.tgPoll(tgToken); if (r.status === 'ok'){ clearInterval(tgPollTimer); enterApp(window.API.getSession()); } }, 2500);
  });
  $('#tgConfirmBtn').addEventListener('click', async () => {
    if (window.API.LIVE) { toast('Ждём подтверждения из Telegram…'); return; }   // в LIVE вход подтвердит опрос
    clearInterval(tgPollTimer); const s = await window.API.tgConfirmDemo(); toast('Вход через Telegram выполнен'); enterApp(s);
  });
  $('#tgCancelBtn').addEventListener('click', () => { clearInterval(tgPollTimer); showStep('choose'); });

  async function doEmailLogin() {
    const email = $('#emailInput').value.trim();
    const password = $('#passInput').value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Введите корректный e-mail', true); return; }
    if (!password) { toast('Введите пароль', true); return; }
    const btn = $('#emailLoginBtn'); btn.disabled = true;
    try {
      const s = await window.API.emailLogin(email, password);
      $('#passInput').value = '';
      toast('Добро пожаловать!'); enterApp(s);
    } catch (e) {
      const msg = String(e && e.message || e);
      toast(msg.includes('401') ? 'Неверная почта или пароль' : 'Не удалось войти', true);
    } finally { btn.disabled = false; }
  }
  $('#emailLoginBtn').addEventListener('click', doEmailLogin);
  $('#passInput').addEventListener('keydown', e => { if (e.key === 'Enter') doEmailLogin(); });

  // ----- Email-code login (альтернатива паролю) -----
  let codeCooldownT = null;
  function fmtMMSS(s){ const m = Math.floor(s/60); return m + ':' + String(s%60).padStart(2,'0'); }
  function startCodeCooldown(seconds) {
    clearInterval(codeCooldownT);
    let left = Math.max(1, Math.floor(seconds || 180));
    const btn = $('#codeResendBtn');
    btn.disabled = true;
    btn.textContent = 'Прислать снова через ' + fmtMMSS(left);
    codeCooldownT = setInterval(() => {
      left--;
      if (left <= 0) {
        clearInterval(codeCooldownT);
        btn.disabled = false; btn.textContent = 'Прислать ещё раз';
      } else {
        btn.textContent = 'Прислать снова через ' + fmtMMSS(left);
      }
    }, 1000);
  }
  async function requestNewCode(email) {
    const r = await window.API.emailRequestCode(email);
    startCodeCooldown(r && r.retry_after);
    return r;
  }
  $('#emailCodeBtn').addEventListener('click', async () => {
    const email = $('#emailInput').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('Введите корректный e-mail', true); return; }
    const btn = $('#emailCodeBtn'); btn.disabled = true;
    try {
      await requestNewCode(email);
      $('#codeEmail').textContent = email;
      $('#codeInput').value = '';
      showStep('code');
      setTimeout(() => $('#codeInput').focus(), 200);
      toast('Код отправлен на ' + email);
    } catch (e) {
      toast('Не удалось отправить код', true);
    } finally { btn.disabled = false; }
  });
  async function doCodeLogin() {
    const email = $('#codeEmail').textContent.trim();
    const code = $('#codeInput').value.trim();
    if (!/^\d{4,8}$/.test(code)) { toast('Введите код из письма', true); return; }
    const btn = $('#codeSubmitBtn'); btn.disabled = true;
    try {
      const s = await window.API.emailLoginWithCode(email, code);
      clearInterval(codeCooldownT);
      toast('Добро пожаловать!'); enterApp(s);
    } catch (e) {
      toast('Неверный или истёкший код', true);
    } finally { btn.disabled = false; }
  }
  $('#codeSubmitBtn').addEventListener('click', doCodeLogin);
  $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doCodeLogin(); });
  $('#codeResendBtn').addEventListener('click', async () => {
    const email = $('#codeEmail').textContent.trim();
    if (!email) return;
    try { await requestNewCode(email); toast('Код отправлен ещё раз'); }
    catch (e) { toast('Не удалось отправить', true); }
  });
  $('#codeCancelBtn').addEventListener('click', () => { clearInterval(codeCooldownT); showStep('choose'); });

  /* ============================================================ ВХОД В ПРИЛОЖЕНИЕ ============================================================ */
  function enterApp(session) {
    if (!session) return;
    authView.style.display = 'none'; appShell.hidden = false;
    renderAccount(session); renderSubscription(session.subscription);
    renderPlans(); renderMethods(); refreshAdminUI();
    // Освежаем /me (вдруг подписку только что выдали на бэкенде), затем
    // тянем список серверов из sub-URL. Если refresh не дал URL — фолбэк.
    (async () => {
      let fresh = session;
      try { const r = await window.API.refreshSession(); if (r) fresh = r; } catch {}
      renderAccount(fresh); renderSubscription(fresh.subscription);
      autoImportUserSubscription(fresh);
    })();
    resizeChart(); drawChart();
    // переинициализируем осадки под уже видимую карточку (после раскладки)
    if (window.Sky) { window.Sky.stop(); requestAnimationFrame(() => requestAnimationFrame(updateSky)); }
    setTimeout(greetHoliday, 900);
    startNews();     // последняя новость + живой опрос новых
    refreshGift();   // подарок, если сегодня праздник (время с сервера)
  }

  // Автоматический импорт подписки юзера: берём URL, который выдал бэкенд
  // (Remnawave subscription endpoint), парсим в C#-мосте через
  // importSubscription, получаем список рабочих vless и сохраняем как
  // imported-серверы. Без нативного моста (обычный браузер) — пропуск.
  function autoImportUserSubscription(session) {
    const url = session?.subscription?.url;
    if (!url) { loadVpnConfig(); return; }
    if (!window.API.hasNativeVpn) return;
    // Старые imported (от предыдущего юзера) могут быть в локалке — чистим
    // только при логине НОВОГО юзера: дешёво и без двойных серверов в списке.
    const key = 'cloudvpn.imported.owner';
    const ownerNow = (session.user?.handle || '') + ':' + url;
    const prevOwner = localStorage.getItem(key);
    if (prevOwner && prevOwner !== ownerNow) {
      try { localStorage.removeItem('cloudvpn.imported'); } catch {}
      // выкинуть имеющиеся imported из памяти
      for (let i = servers.length - 1; i >= 0; i--) if (servers[i].imported) servers.splice(i, 1);
    } else {
      // тот же владелец — показываем сохранённые серверы сразу, до ответа сети
      loadImported();
    }
    localStorage.setItem(key, ownerNow);
    pendingImportSource = 'sub';
    window.API.importSubscription(url);   // ответ придёт в onSub
  }
  function setAvatar(el, url, initial) {
    if (url) { el.innerHTML = `<img class="avatar-img" src="${url}" alt="">`; el.classList.add('has-img'); }
    else { el.textContent = initial; el.classList.remove('has-img'); }
  }
  function renderAccount(s) {
    const u = s.user || {}, initial = (u.name || 'U')[0].toUpperCase();
    setAvatar($('#railAvatar'), u.avatar, initial);
    setAvatar($('#accAvatar'), u.avatar, initial);
    $('#accName').textContent = u.name || '–'; $('#accHandle').textContent = u.handle || '';
    $('#accVia').textContent = 'Вход через ' + (u.via || '–');
    const bal = s.balance;
    $('#accBalance').textContent = bal ? `${(bal.rub ?? 0).toLocaleString('ru-RU')} ₽` : '0 ₽';
    _topupUrl = bal?.topupUrl || null;
    loadDevices();
  }
  let _topupUrl = null;
  $('#topupBtn')?.addEventListener('click', () => {
    if (_topupUrl) window.API.openExternal(_topupUrl);
    else go('subscribe');
  });
  function renderSubscription(sub) {
    const names = { Premium:'Premium', Trial:'Пробный период', Free:'Бесплатный' };
    const name = names[sub?.plan] || sub?.plan || 'Нет подписки';
    const active = sub && sub.expires > Date.now(), left = sub ? daysLeft(sub.expires) : 0;
    $('#subChipText').textContent = active ? `${name} · ${left} дн.` : 'Нет подписки';
    $('#subStatusPlan').textContent = name;
    $('#subStatusInfo').textContent = active ? `Активна до ${fmtDate(sub.expires)} · осталось ${left} дн.` : 'Подписка неактивна – выберите тариф ниже';
    $('#subStatusProgress').style.width = (active ? Math.max(6, Math.min(100, left/30*100)) : 0) + '%';
    $('#accSub').innerHTML = active
      ? `${name}<small>до ${fmtDate(sub.expires)}</small>`
      : 'неактивна';
  }

  /* ---------- Устройства (Remnawave HWID) ---------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  let _buyUrl = null;
  async function loadDevices() {
    const list = $('#devList'); if (!list) return;
    const data = await window.API.getDevices();
    if (!data) { $('#devCount').textContent = '–'; list.innerHTML = ''; $('#devEmpty').hidden = false; return; }
    $('#devCount').textContent = `${data.used} / ${data.max}`;
    _buyUrl = data.buyUrl;
    const devs = data.devices || [];
    $('#devEmpty').hidden = devs.length > 0;
    list.innerHTML = devs.map(d => `
      <li class="devrow">
        <div class="devrow__meta"><b>${esc(d.label)}</b><small>${esc(d.platform)}${d.createdAt ? ' · с ' + fmtDate(d.createdAt) : ''}</small></div>
        <button class="devrow__del" data-hwid="${esc(d.hwid)}">отвязать</button>
      </li>`).join('');
  }
  $('#buySlotBtn')?.addEventListener('click', () => { if (_buyUrl) window.API.openExternal(_buyUrl); });
  $('#resetKeyBtn')?.addEventListener('click', async () => {
    if (!await confirmModal('Сбросить ключ? Отключатся СРАЗУ ВСЕ устройства. Заново импортируйте новую ссылку на тех, что оставляете.', 'Сбросить')) return;
    const r = await window.API.resetKey();
    if (r) { toast('Ключ сброшен — все устройства отключены'); await window.API.refreshSession?.(); loadDevices(); }
    else toast('Не удалось сбросить', true);
  });
  $('#devList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.devrow__del'); if (!btn) return;
    if (!await confirmModal('Отвязать это устройство? На нём VPN перестанет подключаться.', 'Отвязать')) return;
    btn.disabled = true; btn.textContent = '…';
    const ok = await window.API.removeDevice(btn.dataset.hwid);
    if (ok) { toast('Устройство отвязано'); loadDevices(); }
    else { toast('Не удалось отвязать', true); btn.disabled = false; btn.textContent = 'отвязать'; }
  });

  /* ============================================================ НАВИГАЦИЯ ============================================================ */
  function go(view) {
    $$('.rail__item[data-view]').forEach(b => b.classList.toggle('is-active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('is-active', v.dataset.view === view));
    if (view === 'settings') loadDevices();
  }
  $$('.rail__item[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  function setTheme(val) {
    document.documentElement.setAttribute('data-theme', val);
    $$('#themeSeg button').forEach(b => b.classList.toggle('is-active', b.dataset.themeVal === val));
    $('#themeBtn use').setAttribute('href', val === 'dark' ? '#ic-sun' : '#ic-moon');
    if (host) host.postMessage('theme:' + val);   // синхронизируем фон окна – без тёмных ободков
    updateSky();                                   // дождь/снег по теме и сезону
    drawChart();
  }
  $('#themeBtn').addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  $$('#themeSeg button').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeVal)));
  // Автозапуск через Scheduled Task на стороне C# (начальное состояние ставит хост).
  $('#autostartToggle')?.addEventListener('change', (e) => {
    if (host) host.postMessage(e.target.checked ? 'autostart:on' : 'autostart:off');
    toast(e.target.checked ? 'Автозапуск включён' : 'Автозапуск выключен');
  });
  // Kill Switch: блокировка сети при разрыве туннеля (pf в рут-хелпере на macOS).
  // Начальное состояние ставит нативный хост из сохранённого значения.
  $('#killSwitchToggle')?.addEventListener('change', (e) => {
    if (host) host.postMessage(e.target.checked ? 'killswitch:on' : 'killswitch:off');
    toast(e.target.checked
      ? 'Kill Switch включён — при разрыве сеть блокируется'
      : 'Kill Switch выключен');
  });
  const fxToggle = $('#fxToggle');
  if (fxToggle) {
    fxToggle.checked = fxOn;
    fxToggle.addEventListener('change', () => {
      fxOn = fxToggle.checked; localStorage.setItem(FX_KEY, fxOn ? '1' : '0');
      applyHoliday(); updateSky(); if (fxOn) setTimeout(greetHoliday, 200);
      toast(fxOn ? 'Праздничные эффекты включены 🎉' : 'Праздничные эффекты выключены');
    });
  }
  $('#logoutBtn').addEventListener('click', () => {
    if (connected || connecting) { try { disconnect(); } catch {} }
    // Серверы НЕ стираем из localStorage — они привязаны к владельцу: если этот же
    // аккаунт войдёт снова, они подхватятся сразу (не зависим от повторного импорта,
    // который из-за HWID-кэша Remnawave мог бы временно вернуть пусто). Если войдёт
    // ДРУГОЙ аккаунт — autoImportUserSubscription почистит их по owner-проверке.
    for (let i = servers.length - 1; i >= 0; i--) if (servers[i].imported) servers.splice(i, 1);
    renderServers($('#serverSearch').value);
    window.API.logout(); stopNews(); appShell.hidden = true; authView.style.display = 'grid'; showStep('choose');
    $('#passInput').value = ''; $('#emailInput').value=''; go('connect'); toast('Вы вышли из аккаунта');
  });
  $('#tgSupportBtn').addEventListener('click', () => window.API.openExternal('https://t.me/' + cfg.telegram.botUsername));
  // Почта скрыта блюром — показываем по клику.
  $('#accHandle')?.addEventListener('click', () => $('#accHandle').classList.toggle('revealed'));

  /* ============================================================ ПОДПИСКА / ОПЛАТА ============================================================ */
  let selectedPlan = (cfg.plans.find(p => p.popular) || cfg.plans[0]).id;
  let selectedMethod = cfg.platega.methods[0].id;
  let saleP = 0;   // active global sale %, from /api/sale
  (async () => {
    try {
      const r = await fetch(cfg.apiBase.replace(/\/$/, '') + '/api/sale');
      const d = await r.json();
      if (d && d.active && d.percent > 0) { saleP = d.percent; renderPlans(); }
    } catch (_) {}
  })();

  function renderSaleBanner() {
    const plans = $('#plans'); if (!plans) return;
    let b = document.getElementById('saleBanner');
    if (saleP > 0) {
      if (!b) { b = document.createElement('div'); b.id = 'saleBanner'; plans.parentNode.insertBefore(b, plans); }
      b.style.cssText = 'text-align:center;margin:0 0 16px;padding:11px 16px;border-radius:12px;background:linear-gradient(90deg,rgba(255,86,54,.16),rgba(255,150,64,.16));border:1px solid rgba(255,120,64,.4);color:#ffb27a;font-weight:700;font-size:15px';
      b.textContent = `🔥 Скидка −${saleP}% на всё до понедельника`;
    } else if (b) { b.remove(); }
  }
  function renderPlans() {
    renderSaleBanner();
    const el = $('#plans'); el.innerHTML = '';
    cfg.plans.forEach((p, idx) => {
      const d = document.createElement('div');
      d.className = 'plan' + (p.id === selectedPlan ? ' is-active' : '') + (p.popular ? ' is-popular' : '');
      d.style.setProperty('--i', idx);
      const sp = saleP > 0 ? (p.price * (100 - saleP)) / 100 : p.price;
      const spStr = Number.isInteger(sp) ? sp : sp.toFixed(1);
      const badge = saleP > 0 ? `−${saleP}%` : p.badge;
      const priceHtml = saleP > 0
        ? `<div class="plan__price"><span style="text-decoration:line-through;opacity:.45;font-size:.6em;margin-right:5px">${p.price}</span>${spStr}<span> ${cfg.currency}</span></div>`
        : `<div class="plan__price">${p.price}<span> ${cfg.currency}</span></div>`;
      d.innerHTML = `
        ${p.popular ? '<span class="plan__pop">Выбор большинства</span>' : ''}
        ${badge ? `<span class="plan__badge">${badge}</span>` : '<span class="plan__badge" style="visibility:hidden">·</span>'}
        <div class="plan__title">${p.title}</div>
        ${priceHtml}
        <div class="plan__per">${p.per}</div>`;
      d.addEventListener('click', () => { selectedPlan = p.id; renderPlans(); updatePayBtn(); });
      el.appendChild(d);
    });
    updatePayBtn();
  }
  function renderMethods() {
    const el = $('#payMethods'); el.innerHTML = '';
    cfg.platega.methods.forEach(m => {
      const b = document.createElement('button');
      b.className = 'pmethod' + (m.id === selectedMethod ? ' is-active' : '');
      b.innerHTML = `<svg class="ic"><use href="#ic-${m.icon}"/></svg>${m.label}`;
      b.addEventListener('click', () => { selectedMethod = m.id; renderMethods(); });
      el.appendChild(b);
    });
  }
  function updatePayBtn() {
    const p = cfg.plans.find(x => x.id === selectedPlan);
    const sp = saleP > 0 ? (p.price * (100 - saleP)) / 100 : p.price;
    const spStr = Number.isInteger(sp) ? sp : sp.toFixed(1);
    $('#payBtnText').textContent = `Оплатить ${spStr} ${cfg.currency}`;
    $('#payBtnSub').textContent = saleP > 0 ? `${p.title} · −${saleP}% до понедельника` : `${p.title} · через Платега`;
  }
  let paying = false;
  $('#payBtn').addEventListener('click', async () => {
    if (paying) return; paying = true; const btn = $('#payBtn'); btn.setAttribute('disabled','');
    $('#payBtnText').textContent = 'Создаём платёж…';
    try {
      const beforeExp = window.API.getSession()?.subscription?.expires || 0;
      const payment = await window.API.createPayment(selectedPlan);
      window.API.openPayment(payment); toast('Откройте окно оплаты Платега…');
      $('#payBtnText').textContent = 'Ожидаем оплату…';
      // Подписку активирует callback Platega на стороне сервера — поллим /me.
      let ok = false;
      for (let i = 0; i < 48; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const s = await window.API.refreshSession();
        const sub = s?.subscription;
        if (sub && sub.status === 'active' && (sub.expires || 0) > beforeExp) { ok = true; break; }
      }
      if (ok) { renderSubscription(window.API.getSession().subscription); renderAccount(window.API.getSession()); toast('Оплата прошла – подписка активна 🎉'); }
      else toast('Оплату пока не подтвердили. Если оплатили — обновится автоматически.', true);
    } catch { toast('Не удалось создать платёж', true); }
    finally { paying = false; btn.removeAttribute('disabled'); updatePayBtn(); }
  });

  /* ============================================================ СЕРВЕРЫ ============================================================ */
  // Список серверов больше НЕ захардкожен. Он строится из реальной подписки
  // пользователя (Remnawave): после входа autoImportUserSubscription тянет
  // sub-URL, C# парсит vless-конфиги и присылает их сюда.
  const servers = [];
  let activeId = null;
  let pendingImportSource = 'admin';   // 'sub' (подписка) | 'admin' (ручной импорт) — читается в onSub
  const serverList = $('#serverList');
  const pingClass = p => p == null ? 'ping-wait' : p < 80 ? 'ping-good' : p < 160 ? 'ping-mid' : 'ping-bad';
  const bars = p => { const l = p==null?0:p<80?4:p<130?3:p<200?2:1; return [7,9,11,13].map((h,i)=>`<i class="${i<l?'on':''}" style="height:${h}px"></i>`).join(''); };

  // Флаг-эмодзи → ISO-код (🇩🇪 → DE), как на сайте.
  function flagToCode(str) {
    const cps = [...String(str || '')].map(c => c.codePointAt(0)).filter(c => c >= 0x1F1E6 && c <= 0x1F1FF);
    if (cps.length >= 2) return String.fromCharCode(cps[0]-0x1F1E6+65) + String.fromCharCode(cps[1]-0x1F1E6+65);
    return '';
  }
  const RU_COUNTRY = { DE:'Германия', NL:'Нидерланды', EE:'Эстония', JP:'Япония', US:'США',
    GB:'Великобритания', FI:'Финляндия', FR:'Франция', TR:'Турция', AE:'ОАЭ', SE:'Швеция',
    PL:'Польша', CH:'Швейцария', ES:'Испания', IT:'Италия', CA:'Канада', BR:'Бразилия',
    SG:'Сингапур', HK:'Гонконг', AU:'Австралия', LV:'Латвия', LT:'Литва', RU:'Россия' };
  // Какие флаги реально лежат в web/flags/ (остальные → globe).
  const FLAGS = new Set(['ae','de','fi','fr','gb','jp','nl','sg','tr','us']);
  const flagFor = code => FLAGS.has((code||'').toLowerCase()) ? `flags/${code.toLowerCase()}.svg` : 'flags/globe.svg';

  function pluralLoc(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return 'локация';
    if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'локации';
    return 'локаций';
  }
  function updateLocCount() {
    const el = $('#locCount'); if (!el) return;
    const n = servers.length;
    el.textContent = n ? `${n} ${pluralLoc(n)}` : '—';
  }

  function renderServers(filter='') {
    updateLocCount();
    const q = filter.trim().toLowerCase(); serverList.innerHTML = '';
    const list = servers.filter(s => !q || s.country.toLowerCase().includes(q) || (s.city||'').toLowerCase().includes(q));
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'server server--empty';
      li.innerHTML = `<span class="server__empty">${servers.length ? 'Ничего не найдено' : 'Серверы появятся после входа — подписка подтянется автоматически.'}</span>`;
      serverList.appendChild(li);
      return;
    }
    list.forEach(s => {
      const li = document.createElement('li');
      li.className = 'server' + (s.id === activeId ? ' is-active' : '');
      const sub = s.city || s.code || '';
      li.innerHTML = `<img class="flag-slot" src="${s.flag}" alt="" onerror="this.onerror=null;this.src='flags/globe.svg'">
        <span class="server__info"><b>${s.country}</b><small>${sub}</small></span>
        <span class="server__ping ${pingClass(s.ping)}"><span class="server__bars">${bars(s.ping)}</span>${s.ping==null?'–':s.ping+' мс'}</span>
        ${s.source === 'admin' ? '<button class="server__rm" title="Удалить">&times;</button>' : ''}`;
      li.addEventListener('click', () => selectServer(s.id));
      if (s.source === 'admin') {
        const rm = li.querySelector('.server__rm');
        rm.addEventListener('click', ev => { ev.stopPropagation(); removeImported(s.id); });
      }
      serverList.appendChild(li);
    });
  }
  function setActive(id) {                          // выбрать сервер БЕЗ закрытия шторки
    const s = servers.find(x => x.id === id); if (!s) { activeId = null; return; }
    activeId = id;
    $('#currentServerName').textContent = s.city ? `${s.country} · ${s.city}` : s.country;
    $('#pickFlag').src = s.flag;
    if (s.ping != null) $('#mPing').textContent = s.ping;
    renderServers($('#serverSearch').value);
  }
  function selectServer(id) {
    setActive(id); const s = servers.find(x => x.id === id); if (!s) return;
    closeDrawer();
    if (connected || connecting) {                 // переключение на лету — переподключаемся
      if (s.vless && window.API.hasNativeVpn) {
        // Сначала чисто отключаемся (даём TUN-адаптеру освободиться), затем
        // подключаемся к новому серверу — иначе ядро застревает на "Подключение".
        setState('connecting'); toast('Переключаю на ' + s.country);
        window.API.vpnDisconnect();
        setTimeout(() => window.API.vpnConnect(buildConnectOpts(s.vless)), 900);
      }
      else { disconnect(); toast('У сервера нет конфига — отключено', true); }
    }
  }
  $('#serverSearch').addEventListener('input', e => renderServers(e.target.value));

  /* ---------- Админ: импорт чужого конфига (проверка ядра) ---------- */
  function isAdmin() {
    const u = window.API.getSession()?.user;
    return !!(u && (u.admin || u.handle === '@ilyasubbotnikov'));
  }
  function refreshAdminUI() { const el = $('#adminImport'); if (el) el.hidden = !isAdmin(); }
  function parseVlessLite(vless) {
    try {
      const u = new URL(vless);
      let host = u.hostname, port = parseInt(u.port, 10) || 443;
      if (!host) { const m = vless.match(/@([^:/?#]+):?(\d+)?/); host = m ? m[1] : ''; if (m && m[2]) port = parseInt(m[2], 10); }
      const remark = decodeURIComponent((u.hash || '').replace(/^#/, ''));
      return { host, port, remark };
    } catch { return null; }
  }

  // Замер задержки до сервера. В приоритете — настоящий ICMP-пинг от машины
  // юзера (нативный мост C#). Если ICMP заблокирован файрволом ноды или нет
  // нативного моста (обычный браузер) — откатываемся на TCP/TLS-тайминг.
  function tlsProbe(host, port) {
    const probe = (p) => new Promise(resolve => {
      const img = new Image(); const t0 = performance.now(); let done = false;
      const fin = ok => { if (done) return; done = true; clearTimeout(tm); img.onload = img.onerror = null; resolve(ok ? performance.now() - t0 : null); };
      const tm = setTimeout(() => fin(false), 4000);
      img.onload = () => fin(true); img.onerror = () => fin(true);
      img.src = `https://${host}${p && p !== 443 ? ':' + p : ''}/favicon.ico?cb=${Math.random().toString(36).slice(2)}`;
    });
    const ports = [...new Set([port, 443].filter(Boolean))];
    return (async () => {
      let best = null;
      for (let i = 0; i < 2; i++) {
        const rs = await Promise.all(ports.map(probe));
        for (const v of rs) if (v != null) best = best == null ? v : Math.min(best, v);
      }
      return best == null ? null : Math.max(1, Math.round(best / 2));
    })();
  }
  async function pingServerHost(host, port) {
    if (!host) return null;
    if (window.API.hasNativeVpn && window.API.nativePing) {
      // 2 ICMP-замера, берём минимум (как настоящий ping).
      let best = null;
      for (let i = 0; i < 2; i++) {
        const ms = await window.API.nativePing(host);
        if (ms != null) best = best == null ? ms : Math.min(best, ms);
      }
      if (best != null) return best;   // ICMP прошёл — настоящий пинг
    }
    return tlsProbe(host, port);       // фолбэк
  }
  // Прогнать пинг по всем серверам и обновить список.
  function measureAllPings() {
    servers.forEach(s => {
      if (!s.host) return;
      pingServerHost(s.host, s.port).then(ms => {
        s.ping = ms;
        if (s.id === activeId && ms != null) $('#mPing').textContent = ms;
        renderServers($('#serverSearch').value);
      });
    });
  }
  let impCounter = 0;
  const IMP_KEY = 'cloudvpn.imported';
  function saveImported() {
    const list = servers.filter(s => s.imported)
      .map(s => ({ id: s.id, code: s.code, country: s.country, city: s.city, host: s.host, port: s.port, vless: s.vless, source: s.source }));
    localStorage.setItem(IMP_KEY, JSON.stringify(list));
  }
  function loadImported() {
    let list; try { list = JSON.parse(localStorage.getItem(IMP_KEY) || '[]'); } catch { return; }
    list.forEach(it => {
      if (servers.some(s => s.id === it.id || (it.vless && s.vless === it.vless))) return;
      const num = parseInt(String(it.id).replace('imp', ''), 10); if (num > impCounter) impCounter = num;
      servers.push({ id: it.id, code: it.code || 'XX', country: it.country || 'Сервер', city: it.city || '',
                     host: it.host || '', port: it.port || 443, load: 0, ping: null, vless: it.vless,
                     flag: flagFor(it.code), imported: true, source: it.source || 'admin' });
    });
    renderServers($('#serverSearch').value);
  }
  // source: 'sub' (из подписки юзера) | 'admin' (ручной импорт админом)
  function addImportedServer(vless, source = 'admin') {
    const p = parseVlessLite(vless); if (!p || !p.host) return null;
    // Дедуп по vless и по хосту, чтобы один сервер не задвоился.
    const dup = servers.find(s => s.vless === vless || (s.host && s.host === p.host));
    if (dup) return dup;
    const code = flagToCode(p.remark);
    const labelNoFlag = String(p.remark || '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
    const country = RU_COUNTRY[code] || labelNoFlag || 'Сервер';
    // city/подпись: оригинальное имя ноды, если оно несёт что-то сверх страны.
    const city = (labelNoFlag && labelNoFlag.toLowerCase() !== country.toLowerCase()) ? labelNoFlag : '';
    const id = 'imp' + (++impCounter);
    const s = { id, code: code || 'XX', country, city, host: p.host, port: p.port || 443, load: 0,
                ping: null, vless, flag: flagFor(code), imported: true, source };
    servers.push(s);
    return s;
  }
  function removeImported(id) {
    const i = servers.findIndex(s => s.id === id); if (i < 0) return;
    servers.splice(i, 1); saveImported();
    if (activeId === id) {
      if (connected || connecting) disconnect();
      const def = servers[0]; if (def) setActive(def.id);
    }
    renderServers($('#serverSearch').value);
  }
  $('#importBtn')?.addEventListener('click', () => {
    const v = $('#importInput').value.trim();
    if (!v) { toast('Вставь vless:// или ссылку подписки', true); return; }
    if (!window.API.hasNativeVpn) { toast('Импорт доступен только в приложении', true); return; }
    $('#importBtn').classList.add('is-busy');
    pendingImportSource = 'admin';
    window.API.importSubscription(v);          // ответ придёт в onSub
  });
  $('#importInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') $('#importBtn').click(); });
  // Результат импорта (от C#: один vless или целый subscription-список).
  // Источник (sub/admin) знаем из pendingImportSource, выставленного перед вызовом.
  window.API.onSub(res => {
    $('#importBtn')?.classList.remove('is-busy');
    const src = pendingImportSource; pendingImportSource = 'admin';
    if (!res || res.error) {
      // тихо для авто-подписки (нет нужды пугать юзера), явно для ручного импорта
      if (src === 'admin') toast(res?.error || 'Не удалось импортировать', true);
      return;
    }
    const items = res.items || [];
    let first = null;
    items.forEach(vless => { const s = addImportedServer(vless, src); if (s && !first) first = s; });
    saveImported(); renderServers($('#serverSearch').value);
    if (first && !activeServer()) setActive(first.id);
    measureAllPings();   // сразу показать реальный пинг по каждому серверу
    if (src === 'admin') {
      $('#importInput').value = '';
      toast(items.length > 1 ? `Добавлено серверов: ${items.length}` : 'Сервер добавлен');
    } else if (items.length) {
      toast(`Серверы подписки загружены: ${items.length}`);
    }
  });

  // Фолбэк: если у юзера нет sub-URL, тянем одиночный vless с бэкенда
  // (/api/vpn/config) и добавляем его как сервер подписки.
  async function loadVpnConfig() {
    try {
      const c = await window.API.getVpnConfig();
      if (c && c.vless) {
        const s = addImportedServer(c.vless, 'sub');
        saveImported(); renderServers($('#serverSearch').value);
        if (s && !activeServer()) setActive(s.id);
      }
    } catch { /* нет конфига — список останется пустым с подсказкой */ }
  }

  /* ---------- Выезжающая панель ---------- */
  const drawer = $('#serverDrawer');
  function openDrawer(){ refreshAdminUI(); drawer.hidden = false; requestAnimationFrame(() => drawer.classList.add('show')); setTimeout(()=>$('#serverSearch').focus(),300); }
  function closeDrawer(){ drawer.classList.remove('show'); setTimeout(() => drawer.hidden = true, 420); }
  $('#serverPick').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !drawer.hidden) closeDrawer(); });

  $('#pingAllBtn').addEventListener('click', async () => {
    const btn = $('#pingAllBtn'); if (btn.classList.contains('is-busy')) return;
    if (!servers.length) { toast('Сначала войдите — серверы подтянутся', true); return; }
    btn.classList.add('is-busy'); servers.forEach(s => s.ping = null); renderServers($('#serverSearch').value);
    // Реальный замер из WebView, все серверы параллельно.
    await Promise.all(servers.map(async s => {
      if (!s.host) return;
      s.ping = await pingServerHost(s.host, s.port);
      if (s.id === activeId && s.ping != null) $('#mPing').textContent = s.ping;
      renderServers($('#serverSearch').value);
    }));
    btn.classList.remove('is-busy'); toast('Пинг обновлён ⚡');
  });

  /* ============================================================ ПОДКЛЮЧЕНИЕ ============================================================ */
  const orb = $('#connectOrb'), orbLabel = $('#orbLabel'), chip = $('#statusChip'), statusText = $('#statusText'), hero = $('.hero');
  let connected = false, connecting = false, timerId, statsId, sessionStart = 0, totalDownMB = 0, totalUpMB = 0;
  function setState(st) {
    orb.classList.remove('is-on','is-connecting'); chip.classList.remove('is-on','is-connecting'); hero.classList.remove('is-on');
    if (st === 'connecting'){ orb.classList.add('is-connecting'); chip.classList.add('is-connecting'); statusText.textContent='Подключение…'; orbLabel.textContent='Ждите…'; }
    else if (st === 'on'){ orb.classList.add('is-on'); chip.classList.add('is-on'); hero.classList.add('is-on'); statusText.textContent='Защищено'; orbLabel.textContent='Отключить'; }
    else { statusText.textContent='Отключено'; orbLabel.textContent='Подключить'; }
  }
  orb.addEventListener('click', () => {
    const sub = window.API.getSession()?.subscription;
    // админ может подключаться без активной подписки (тест чужих/своих конфигов)
    if (!connected && !isAdmin() && !(sub && sub.expires > Date.now())){ toast('Нужна активная подписка', true); go('subscribe'); return; }
    connected ? disconnect() : connect();
  });
  const activeServer = () => servers.find(x => x.id === activeId);
  // Полный набор опций подключения (режим/маршрут/правила) для заданного vless.
  // Используется и при первом connect, и при переключении сервера на лету — чтобы
  // смена сервера не сбрасывала прокси-режим/split-tunnel в full-TUN.
  function buildConnectOpts(vless) {
    const rules = RULES.filter(r => r.on).map(r => {
      const def = RULE_TYPES[r.type];
      return def ? def.emit(r.value) : null;
    }).filter(Boolean);
    return { vless, mode: vpnPrefs.mode, route: vpnPrefs.route, rules };
  }
  function connect() {
    if (connecting || connected) return;
    const s = activeServer();
    if (!s) return;
    if (!window.API.hasNativeVpn) { toast('VPN-ядро доступно только в приложении', true); return; }
    if (!s.vless) { toast('Конфиг этого сервера ещё не подключён', true); return; }
    connecting = true; setState('connecting');
    window.API.vpnConnect(buildConnectOpts(s.vless));
  }
  function disconnect(){
    if (window.API.hasNativeVpn) window.API.vpnDisconnect();
    onDisconnected();
  }
  function onDisconnected(){
    connected = false; connecting = false; setState('off'); stopTimers();
    $('#mDown').textContent='0.0'; $('#mUp').textContent='0.0';
    $('#ipText').textContent='IP скрыт'; $('#ipChip').classList.remove('is-on');
    setEmotion('happy'); vpnOn = false; applyMood();
  }
  function startTimers() {
    stopTimers();
    timerId = setInterval(() => { const s = Math.floor((Date.now()-sessionStart)/1000); $('#mTime').textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }, 1000);
  }
  function stopTimers(){ clearInterval(timerId); clearInterval(statsId); }
  const fmtMB = v => v >= 1024 ? (v/1024).toFixed(2)+' ГБ' : Math.round(v)+' МБ';
  const bytesToMBs = b => b / 1048576;   // байт/с -> МБ/с

  // Узнать реальный внешний IP через туннель (идёт уже через VPN)
  async function revealRealIp() {
    try {
      const r = await fetch('https://ipwho.is/', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ip) { $('#ipText').textContent = 'IP ' + j.ip; $('#ipChip').classList.add('is-on'); }
    } catch { $('#ipText').textContent = 'IP скрыт'; }
  }

  /* ---------- Реальный статус от ядра Mihomo (через C#-мост) ---------- */
  window.API.onVpn(st => {
    if (!st || !st.state) return;
    if (st.state === 'connecting') { connecting = true; setState('connecting'); return; }
    if (st.state === 'error') {
      onDisconnected();
      const head = st.error ? ('Не удалось подключиться: ' + st.error) : 'Не удалось подключиться';
      toast(head, true);
      if (st.details) {
        // Тихо положим хвост лога в консоль — есть кнопка «Открыть лог» в админ-секции.
        try { console.warn('[mihomo log tail]\n' + st.details); } catch {}
      }
      return;
    }
    if (st.state === 'disconnected') {
      if (connected || connecting) { onDisconnected(); playChime('disconnect'); toast('Отключено'); }
      return;
    }
    if (st.state === 'connected') {
      if (!connected) {
        connected = true; connecting = false; setState('on');
        sessionStart = Date.now(); totalDownMB = totalUpMB = 0; startTimers();
        setEmotion('cool'); vpnOn = true; applyMood(); playChime('connect');
        const s = activeServer(); toast('Подключено' + (s ? ' · ' + s.country : ''));
        revealRealIp();
      }
      // реальная статистика
      if (typeof st.ping === 'number') {
        $('#mPing').textContent = st.ping; const s = activeServer();
        if (s) { s.ping = st.ping; renderServers($('#serverSearch').value); }
      }
      if (typeof st.down === 'number' || typeof st.up === 'number') {
        const d = bytesToMBs(st.down || 0), u = bytesToMBs(st.up || 0);
        $('#mDown').textContent = d.toFixed(1); $('#mUp').textContent = u.toFixed(1);
        pushChart(d, u);
      }
      if (typeof st.totalDown === 'number') $('#totalDown').textContent = fmtMB(bytesToMBs(st.totalDown));
      if (typeof st.totalUp === 'number') $('#totalUp').textContent = fmtMB(bytesToMBs(st.totalUp));
    }
  });

  /* ---------- Настройки туннеля (mode/route/apps) — реально влияют на коннект ---------- */
  const PREF_KEY = 'cloudvpn.vpnprefs';
  const defaultPrefs = { mode: 'tun', route: 'all' };
  let vpnPrefs;
  try { vpnPrefs = { ...defaultPrefs, ...(JSON.parse(localStorage.getItem(PREF_KEY) || 'null') || {}) }; }
  catch { vpnPrefs = { ...defaultPrefs }; }
  function savePrefs(){ try { localStorage.setItem(PREF_KEY, JSON.stringify(vpnPrefs)); } catch {} }
  const modeHints = {
    proxy: 'Прокси-режим: SOCKS5/HTTP на 127.0.0.1:7897. Без admin-прав, маршрутизирует только то, что использует прокси.',
    tun:   'TUN-режим: весь системный трафик через VPN (через системный хелпер).',
  };
  function applyModeUI(){
    $$('.seg--mode button').forEach(b => b.classList.toggle('is-active', b.dataset.mode === vpnPrefs.mode));
    $('#modeHint').textContent = modeHints[vpnPrefs.mode];
  }
  $$('.seg--mode button').forEach(b => b.addEventListener('click', () => {
    vpnPrefs.mode = b.dataset.mode; savePrefs(); applyModeUI();
    toast(vpnPrefs.mode === 'tun' ? 'Режим TUN — весь трафик' : 'Режим прокси (127.0.0.1:7897)');
    if (connected || connecting) toast('Применится после переподключения', false);
  }));
  applyModeUI();

  /* ---------- Split-tunneling: универсальные правила (процесс / домен / ip / geo) ---------- */
  // Каждое правило: { id, type, value, name, on }
  //   type ∈ { process, domain-suffix, domain-keyword, geosite, ip-cidr, asn, geoip }
  //   value = что матчим (chrome.exe, youtube.com, RU и т.д.)
  //   name  = что показываем юзеру (для процессов — заголовок окна; иначе сам value)
  // sanitize: strip commas/newlines/control chars that would break a mihomo
  // CSV rule line and confuse the parser. We also forbid bare DIRECT/REJECT
  // injection at the end of value.
  const sanRule = v => String(v || '').replace(/[,\r\n\t]/g, '').trim();
  const RULE_TYPES = {
    'process':        { label: 'Процесс',         badge: '💻',  hint: 'имя процесса',  placeholder: 'Google Chrome',
                        emit: v => `PROCESS-NAME,${sanRule(v)},GLOBAL` },
    'domain-suffix':  { label: 'По суффиксу',     badge: '🌐',  hint: 'домен и всё под ним', placeholder: 'youtube.com',
                        emit: v => `DOMAIN-SUFFIX,${sanRule(v)},GLOBAL` },
    'domain-keyword': { label: 'Слово в домене',  badge: 'Tt',  hint: 'подстрока в имени домена', placeholder: 'google',
                        emit: v => `DOMAIN-KEYWORD,${sanRule(v)},GLOBAL` },
    'geosite':        { label: 'GeoSite',         badge: '📚',  hint: 'тег из meta-rules-dat',  placeholder: 'youtube',
                        emit: v => `GEOSITE,${sanRule(v)},GLOBAL` },
    'ip-cidr':        { label: 'IP-CIDR',         badge: '🛣',  hint: 'IP или подсеть',         placeholder: '8.8.8.8/32',
                        emit: v => `IP-CIDR,${sanRule(v)},GLOBAL,no-resolve` },
    'asn':            { label: 'ASN',             badge: '#',   hint: 'номер автономной системы', placeholder: '13335',
                        emit: v => `IP-ASN,${sanRule(v)},GLOBAL,no-resolve` },
    'geoip':          { label: 'GeoIP',           badge: '📍',  hint: 'двухбуквенный код страны', placeholder: 'RU',
                        emit: v => `GEOIP,${sanRule(v).toUpperCase()},GLOBAL,no-resolve` },
  };
  // SVG-иконки только для известных .exe (process); для остальных типов рисуем
  // эмодзи-бейдж из RULE_TYPES.badge.
  const KNOWN_ICONS = {
    'chrome.exe':       { icon: 'googlechrome', name: 'Google Chrome' },
    'telegram.exe':     { icon: 'telegram',     name: 'Telegram' },
    'steam.exe':        { icon: 'steam',        name: 'Steam' },
    'discord.exe':      { icon: 'discord',      name: 'Discord' },
    'qbittorrent.exe':  { icon: 'qbittorrent',  name: 'qBittorrent' },
    'google chrome':    { icon: 'googlechrome', name: 'Google Chrome' },
    'telegram':         { icon: 'telegram',     name: 'Telegram' },
    'steam':            { icon: 'steam',        name: 'Steam' },
    'discord':          { icon: 'discord',      name: 'Discord' },
    'qbittorrent':      { icon: 'qbittorrent',  name: 'qBittorrent' },
  };

  const RULES_KEY = 'cloudvpn.rules.v1';
  let RULES = [];
  // Миграция со старого формата (cloudvpn.apps.v2 — только процессы)
  try {
    const saved = JSON.parse(localStorage.getItem(RULES_KEY) || 'null');
    if (Array.isArray(saved)) RULES = saved.filter(r => r && r.type && r.value);
    else {
      const old = JSON.parse(localStorage.getItem('cloudvpn.apps.v2') || 'null');
      if (Array.isArray(old)) {
        RULES = old.filter(a => a && a.binary).map(a => ({
          id: a.id || ('rule_' + Math.random().toString(36).slice(2, 9)),
          type: 'process', value: a.binary, name: a.name || a.binary, on: !!a.on,
        }));
        try { localStorage.setItem(RULES_KEY, JSON.stringify(RULES)); } catch {}
      }
    }
  } catch {}
  function saveRules(){ try { localStorage.setItem(RULES_KEY, JSON.stringify(RULES)); } catch {} }

  function colorFor(s) {
    s = String(s || '');
    let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360}, 62%, 56%)`;
  }
  function iconHtml(r) {
    if (r.type === 'process') {
      const known = KNOWN_ICONS[(r.value || '').toLowerCase()];
      if (known) return `<img src="appicons/${known.icon}.svg" alt="">`;
      const letter = (r.name || r.value || '?').replace(/\.exe$/i, '').trim().charAt(0).toUpperCase() || '?';
      return `<span class="app-row__initial" style="background:${colorFor(r.value)}">${letter}</span>`;
    }
    const t = RULE_TYPES[r.type];
    return `<span class="app-row__initial" style="background:${colorFor(r.type)};font-size:13px">${t ? t.badge : '?'}</span>`;
  }
  function typeLabel(type) { return (RULE_TYPES[type] || {}).label || type; }

  function renderApps() {
    const el = $('#appList');
    el.innerHTML = '';
    if (!RULES.length) {
      const empty = document.createElement('li');
      empty.className = 'app-row app-row--empty';
      empty.innerHTML = '<span class="app-row__empty">Пока пусто. Жмите «Добавить» — приложение, домен, IP или страну.</span>';
      el.appendChild(empty);
      return;
    }
    RULES.forEach(r => {
      const li = document.createElement('li');
      li.className = 'app-row';
      const subline = r.type === 'process'
        ? r.value
        : `${typeLabel(r.type)} · ${r.value}`;
      li.innerHTML =
        `<span class="app-row__icon">${iconHtml(r)}</span>` +
        `<div class="app-row__main"><b>${r.name || r.value}</b><small>${subline}</small></div>` +
        `<button class="app-row__rm" type="button" title="Убрать" aria-label="Убрать">&times;</button>` +
        `<input type="checkbox" ${r.on ? 'checked' : ''} hidden>` +
        `<span class="track"></span>`;
      const toggle = (ev) => {
        if (ev.target.closest('.app-row__rm')) return;
        r.on = !r.on; li.querySelector('input').checked = r.on; saveRules();
        if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Применится после переподключения', false);
      };
      li.addEventListener('click', toggle);
      li.querySelector('.app-row__rm').addEventListener('click', (ev) => {
        ev.stopPropagation();
        RULES = RULES.filter(x => x.id !== r.id); saveRules(); renderApps();
        if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Применится после переподключения', false);
      });
      el.appendChild(li);
    });
  }

  function addRule(type, value, name) {
    type = (type || '').toLowerCase();
    const def = RULE_TYPES[type];
    if (!def) { toast('Неизвестный тип правила', true); return false; }
    value = (value || '').trim();
    if (!value) { toast('Пустое значение', true); return false; }
    // macOS: имя процесса как есть (без .exe)
    if (type === 'geoip') value = value.toUpperCase();
    const dup = RULES.find(r => r.type === type && r.value.toLowerCase() === value.toLowerCase());
    if (dup) { toast('Уже в списке'); return false; }
    if (!name) {
      if (type === 'process') {
        const known = KNOWN_ICONS[value.toLowerCase()];
        name = known ? known.name : value.replace(/\.exe$/i, '');
      } else name = value;
    }
    RULES.push({
      id: 'rule_' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      type, value, name, on: true,
    });
    saveRules(); renderApps();
    if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Применится после переподключения');
    return true;
  }
  // Legacy wrapper — старый код вызывает addApp(binary)
  function addApp(binary) { return addRule('process', binary); }
  $$('.seg--route button').forEach(b => b.addEventListener('click', () => {
    $$('.seg--route button').forEach(x => x.classList.remove('is-active')); b.classList.add('is-active');
    const apps = b.dataset.route === 'apps';
    vpnPrefs.route = apps ? 'apps' : 'all'; savePrefs();
    if (connected || connecting) toast('Применится после переподключения', false);
    $('#appRoutes').hidden = !apps;
    $('#modeHint').textContent = apps
      ? 'Через VPN пойдёт трафик только выбранных приложений (mihomo process-name).'
      : modeHints[vpnPrefs.mode];
    toast(apps ? 'Маршрутизация: выбранные приложения' : 'Маршрутизация: весь ПК');
  }));
  // На загрузке — синхронизировать переключатели с восстановленными prefs.
  $$('.seg--route button').forEach(b => b.classList.toggle('is-active', b.dataset.route === vpnPrefs.route));
  $('#appRoutes').hidden = vpnPrefs.route !== 'apps';
  // «Добавить правило» — модалка с типом (процесс / домен / IP / geo)
  const picker = $('#appPicker');
  const pickerList = $('#appPickerList');
  const pickerSearch = $('#appPickerSearch');
  const valueInput = $('#valueInput');
  const valueHint = $('#valueHint');
  const valueHelp = $('#valueHelp');
  let pickerAll = [];
  let currentType = 'process';

  function setPickerType(type) {
    if (!RULE_TYPES[type]) return;
    currentType = type;
    $$('#ruleTypes .picker__type').forEach(b => b.classList.toggle('is-active', b.dataset.type === type));
    const isProcess = type === 'process';
    $$('.picker__body').forEach(el => el.hidden = (el.dataset.mode !== (isProcess ? 'process' : 'value')));
    if (isProcess) {
      pickerAll = [];
      pickerSearch.value = '';
      if (!window.API.hasNativeVpn) {
        pickerList.innerHTML = '<li class="picker__empty">Список запущенных доступен только в десктоп-приложении. Используйте «Ввести имя процесса вручную» или другой тип правила.</li>';
        return;
      }
      pickerList.innerHTML = '<li class="picker__loading">Собираем список запущенных…</li>';
      setTimeout(() => pickerSearch.focus(), 80);
      window.API.requestAppsList();
    } else {
      const def = RULE_TYPES[type];
      valueHint.textContent = def.label + ' — ' + def.hint;
      valueInput.value = '';
      valueInput.placeholder = def.placeholder;
      valueHelp.textContent = `Mihomo: ${def.emit(def.placeholder)}`;
      setTimeout(() => valueInput.focus(), 80);
    }
  }
  function pickerOpen() {
    picker.hidden = false;
    setPickerType('process');
  }
  function pickerClose() { picker.hidden = true; }

  function pickerRender(filter) {
    const q = (filter || '').trim().toLowerCase();
    const filtered = q
      ? pickerAll.filter(a => (a.name || '').toLowerCase().includes(q) || (a.binary || '').toLowerCase().includes(q))
      : pickerAll;
    if (!filtered.length) {
      pickerList.innerHTML = q
        ? `<li class="picker__empty">Ничего не найдено</li>`
        : `<li class="picker__empty">Видимых окон не нашли. Попробуйте «Ввести имя процесса вручную».</li>`;
      return;
    }
    pickerList.innerHTML = '';
    filtered.forEach(a => {
      const known = KNOWN_ICONS[(a.binary || '').toLowerCase()];
      // Приоритет: реальная иконка .exe из C# → наш SVG для известных → буква.
      let iconInner, iconBg;
      if (a.icon) {
        iconInner = `<img src="${a.icon}" alt="" style="width:22px;height:22px;border-radius:5px">`;
        iconBg = 'transparent';
      } else if (known) {
        iconInner = `<img src="appicons/${known.icon}.svg" alt="" style="width:18px;height:18px">`;
        iconBg = 'transparent';
      } else {
        iconInner = (a.process || a.binary || '?').charAt(0).toUpperCase();
        iconBg = colorFor(a.binary || a.process || '?');
      }
      const li = document.createElement('li');
      li.className = 'picker__row';
      li.innerHTML =
        `<span class="picker__row__icon" style="background:${iconBg}">${iconInner}</span>` +
        `<div class="picker__row__main">` +
          `<div class="picker__row__name">${a.name}</div>` +
          `<div class="picker__row__sub">${a.binary}</div>` +
        `</div>`;
      li.addEventListener('click', () => {
        if (addRule('process', a.binary, a.name)) { pickerClose(); toast(`${a.binary} добавлено`); }
      });
      pickerList.appendChild(li);
    });
  }
  window.API.onAppsList(arr => {
    pickerAll = Array.isArray(arr) ? arr : [];
    pickerRender(pickerSearch.value);
  });
  pickerSearch.addEventListener('input', e => pickerRender(e.target.value));
  pickerSearch.addEventListener('keydown', e => {
    if (e.key === 'Escape') pickerClose();
    else if (e.key === 'Enter') {
      const first = pickerList.querySelector('.picker__row');
      if (first) first.click();
    }
  });
  $('#appPickerRefresh').addEventListener('click', () => {
    pickerList.innerHTML = '<li class="picker__loading">Обновляем…</li>';
    window.API.requestAppsList();
  });
  $('#appPickerManual').addEventListener('click', async e => {
    e.preventDefault();
    const v = await promptModal('Имя процесса', { placeholder: 'например, Brave Browser' });
    if (v) { addRule('process', v); pickerClose(); }
  });

  // value-mode: добавление по Enter / по кнопке
  function commitValue() {
    const v = (valueInput.value || '').trim();
    if (!v) return;
    if (addRule(currentType, v)) { pickerClose(); toast(`${RULE_TYPES[currentType].label} добавлено`); }
  }
  $('#valueAddBtn').addEventListener('click', commitValue);
  valueInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') commitValue();
    else if (e.key === 'Escape') pickerClose();
  });

  // type chips
  $$('#ruleTypes .picker__type').forEach(b => b.addEventListener('click', () => setPickerType(b.dataset.type)));

  picker.querySelectorAll('[data-picker-close]').forEach(el => el.addEventListener('click', pickerClose));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !picker.hidden) pickerClose(); });
  $('#addAppBtn').addEventListener('click', pickerOpen);
  renderApps();

  /* ---------- Лог mihomo (для диагностики) ---------- */
  const openLogBtn = $('#openLogBtn');
  if (openLogBtn) {
    openLogBtn.addEventListener('click', () => {
      if (window.API.hasNativeVpn) window.API.openLog();
      else toast('Лог доступен только в приложении', true);
    });
  }

  /* ---------- График ---------- */
  const cvs = $('#trafficChart'), ctx = cvs.getContext('2d');
  const histD = Array(48).fill(0), histU = Array(48).fill(0);
  function resizeChart(){ const r = cvs.getBoundingClientRect(), dpr = window.devicePixelRatio||1; if (!r.width) return; cvs.width = r.width*dpr; cvs.height = r.height*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); }
  function pushChart(d,u){ histD.push(d); histD.shift(); histU.push(u); histU.shift(); drawChart(); }
  function drawChart() {
    const dpr = window.devicePixelRatio||1, w = cvs.width/dpr, h = cvs.height/dpr; if (!w) return; ctx.clearRect(0,0,w,h);
    const max = Math.max(10, ...histD, ...histU);
    const area = (data,color,fill) => {
      ctx.beginPath();
      data.forEach((v,i) => { const x = i/(data.length-1)*w, y = h-(v/max)*(h-8)-4; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath();
      const g = ctx.createLinearGradient(0,0,0,h); g.addColorStop(0,fill); g.addColorStop(1,'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fill();
    };
    area(histD,'#2f6bff','rgba(47,107,255,.26)'); area(histU,'#e0344a','rgba(224,52,74,.18)');
  }
  window.addEventListener('resize', () => { resizeChart(); drawChart(); });

  /* ============================================================ АВТООБНОВЛЕНИЕ ============================================================ */
  const updBar = $('#updBar');
  if (updBar) {
    const fmtSize = b => b >= 1048576 ? (b/1048576).toFixed(0) + ' МБ' : Math.round(b/1024) + ' КБ';
    function showUpd(){ updBar.hidden = false; requestAnimationFrame(() => updBar.classList.add('show')); }
    function hideUpd(){ updBar.classList.remove('show'); setTimeout(() => updBar.hidden = true, 320); }
    let updating = false;
    window.API.onUpdate(ev => {
      if (ev.type === 'available') {
        const v = ev.info?.version || '';
        // Для инкрементального апдейта качается маленькая дельта — полный размер
        // не показываем, чтобы не пугать.
        const tail = ev.info?.incremental ? ' · инкрементально'
          : (ev.info?.size ? ' · ' + fmtSize(ev.info.size) : '');
        $('#updText').innerHTML = `Доступно обновление <b>${v}</b>${tail}`;
        $('#updProgWrap').hidden = true; $('#updProg').style.width = '0';
        $('#updNow').disabled = false; $('#updNow').textContent = 'Обновить';
        showUpd();
      } else if (ev.type === 'progress') {
        $('#updProgWrap').hidden = false; $('#updProg').style.width = (ev.percent || 0) + '%';
        $('#updText').innerHTML = `Загрузка обновления… <b>${ev.percent || 0}%</b>`;
      } else if (ev.type === 'installing') {
        $('#updText').textContent = 'Устанавливаю и перезапускаю…';
        $('#updNow').disabled = true;
      } else if (ev.type === 'error') {
        updating = false; $('#updNow').disabled = false; $('#updNow').textContent = 'Повторить';
        toast('Не удалось обновить: ' + (ev.message || ''), true);
      }
      // type 'none' — на старте молчим
    });
    $('#updNow').addEventListener('click', () => {
      if (updating) return; updating = true;
      $('#updNow').disabled = true; $('#updProgWrap').hidden = false;
      window.API.updateInstall();
    });
    $('#updLater').addEventListener('click', hideUpd);
  }

  /* ============================================================ СТАРТ ============================================================ */
  applyHoliday(); setTheme('light'); renderServers(); loadImported(); setState('off');
  const existing = window.API.getSession();
  if (existing) enterApp(existing); else { authView.style.display = 'grid'; showStep('choose'); setTimeout(greetHoliday, 1400); }
})();
