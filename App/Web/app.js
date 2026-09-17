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
  // Нативное уведомление Windows (через мост в C#). Формат: notify:<title>\x1f<body>
  function winNotify(body, title) {
    if (host) host.postMessage('notify:' + (title || 'CloudVPN') + '\x1f' + (body || '').replace(/\s+/g, ' ').slice(0, 180));
  }

  // Код из письма состоит только из цифр — буквы в поле не пускаем.
  $('#codeInput')?.addEventListener('input', (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 6);
    if (v !== e.target.value) e.target.value = v;
  });
  // Внешние ссылки — системным браузером через мост, иначе WebView2
  // открывает их отдельным пустым окном приложения.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    window.API.openExternal(a.href);
  });

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
  const PRECIP_KEY = 'cloudvpn.precip';
  let precipOn = localStorage.getItem(PRECIP_KEY) !== '0';   // тумблер осадков (дождь/снег)
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
    if (!precipOn) return 'none';                                                // осадки выключены в настройках
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
    winNotify(n.text || 'Новое сообщение', 'Новость от Клауди');   // уведомление Windows
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

  // ---- Бесплатный Telegram-only туннель для входа ------------------------
  // Вход в Cloud VPN идёт через Telegram. Если у человека Telegram заблокирован,
  // он не может авторизоваться. Эта кнопка на экране входа поднимает TUN, где
  // в туннель (гостевой узел) уходит ТОЛЬКО трафик Telegram, всё остальное —
  // напрямую (route:'apps' => MATCH,DIRECT). Так разблокируется и deep-link
  // входа, и сам Telegram пользователя, бесплатно и без подписки.
  const TELEGRAM_RULES = [
    'IP-CIDR,91.108.4.0/22,GLOBAL,no-resolve',
    'IP-CIDR,91.108.8.0/22,GLOBAL,no-resolve',
    'IP-CIDR,91.108.12.0/22,GLOBAL,no-resolve',
    'IP-CIDR,91.108.16.0/22,GLOBAL,no-resolve',
    'IP-CIDR,91.108.20.0/22,GLOBAL,no-resolve',
    'IP-CIDR,91.108.56.0/22,GLOBAL,no-resolve',
    'IP-CIDR,95.161.64.0/20,GLOBAL,no-resolve',
    'IP-CIDR,149.154.160.0/20,GLOBAL,no-resolve',
    'IP-CIDR,185.76.151.0/24,GLOBAL,no-resolve',
    'IP-CIDR6,2001:67c:4e8::/48,GLOBAL,no-resolve',
    'IP-CIDR6,2001:b28:f23c::/48,GLOBAL,no-resolve',
    'IP-CIDR6,2001:b28:f23d::/48,GLOBAL,no-resolve',
    'IP-CIDR6,2001:b28:f23f::/48,GLOBAL,no-resolve',
    'IP-CIDR6,2a0a:f280::/32,GLOBAL,no-resolve',
    'DOMAIN-SUFFIX,telegram.org,GLOBAL',
    'DOMAIN-SUFFIX,t.me,GLOBAL',
    'DOMAIN-SUFFIX,telegram.me,GLOBAL',
    'DOMAIN-SUFFIX,telesco.pe,GLOBAL',
    'DOMAIN-SUFFIX,telegra.ph,GLOBAL',
    'DOMAIN-SUFFIX,tdesktop.com,GLOBAL',
    'DOMAIN-SUFFIX,telegram-cdn.org,GLOBAL',
  ];
  let tgUnlockOn = false;
  function tgUnlockLabel(txt){ const b = $('#tgUnlockBtn'); if (b){ const s = b.querySelector('span'); if (s) s.textContent = txt; } }
  function tgUnlock(){
    const v = (cfg.tgAuth && cfg.tgAuth.vless) || '';
    if (!window.API.hasNativeVpn){ toast('Доступно только в приложении', true); return; }
    if (!v){ toast('Функция недоступна', true); return; }
    if (tgUnlockOn){ window.API.vpnDisconnect(); return; }   // повторный клик — выключить
    $('#tgUnlockBtn')?.classList.add('is-busy');
    tgUnlockLabel('Подключаю Telegram…');
    // route:'apps' => непойманное идёт DIRECT, а правила Telegram → GLOBAL (в туннель).
    window.API.vpnConnect({ vless: v, mode: 'tun', route: 'apps', rules: TELEGRAM_RULES });
  }
  function tgUnlockStop(){ if (tgUnlockOn || window.API.hasNativeVpn){ try { window.API.vpnDisconnect(); } catch {} } tgUnlockOn = false; }
  if (window.API.hasNativeVpn && (cfg.tgAuth && cfg.tgAuth.vless)) {
    const ub = $('#tgUnlockBtn'); if (ub){ ub.hidden = false; ub.addEventListener('click', tgUnlock); }
    window.API.onVpn(st => {
      const b = $('#tgUnlockBtn'); if (!b) return;
      if (appShell && !appShell.hidden) return;    // на экране входа только
      if (st.state === 'connected'){ tgUnlockOn = true; b.classList.remove('is-busy'); b.classList.add('is-on'); tgUnlockLabel('✓ Telegram разблокирован — входите'); toast('Telegram разблокирован. Теперь войдите через Telegram.'); }
      else if (st.state === 'connecting'){ b.classList.add('is-busy'); tgUnlockLabel('Подключаю Telegram…'); }
      else { tgUnlockOn = false; b.classList.remove('is-busy','is-on'); tgUnlockLabel('Не открывается Telegram? Разблокировать'); }
    });
  }

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
    tgUnlockStop();   // гасим бесплатный Telegram-туннель, дальше подключим подписку
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
      loadGamingServers();
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
  // «Игровые серверы» (AmneziaWG). Натив уже получил сырые конфиги (api.loadGaming
  // → gaming:load), сюда приходит только id+имя. Кладём в общий список с флагом
  // gaming, коннект пойдёт по gamingId. Раздел рисуется отдельной группой сверху.
  async function loadGamingServers() {
    if (!window.API.hasNativeVpn || !window.API.loadGaming) return;
    let list = [];
    try { list = await window.API.loadGaming(); } catch {}
    for (let i = servers.length - 1; i >= 0; i--) if (servers[i].gaming) servers.splice(i, 1);
    (list || []).forEach(g => {
      const code = (g.code || 'PL').toUpperCase();
      servers.push({
        id: 'game_' + g.id, gamingId: g.id, gaming: true,
        country: g.name || g.country || 'Игровой сервер', city: g.city || '',
        code, flag: flagFor(code), vless: '', ping: null, source: 'gaming',
        host: g.host || '', port: g.port || 443,
      });
    });
    renderServers($('#serverSearch').value);
    if ((list || []).length) measureAllPings();   // ICMP-пинг игровых узлов
    syncTray();
  }

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
    _subUrl = url; _subTries = 0;
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
    _avatarUrl = u.avatar || null; _avatarInitial = initial;
    $('#accName').textContent = u.name || '–'; $('#accHandle').textContent = u.handle || '';
    $('#accVia').textContent = 'Вход через ' + (u.via || '–');
    const bal = s.balance;
    $('#accBalance').textContent = bal ? `${(bal.rub ?? 0).toLocaleString('ru-RU')} ₽` : '0 ₽';
    _topupUrl = bal?.topupUrl || null;
    loadDevices();
  }
  let _avatarUrl = null, _avatarInitial = 'У';
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
    if (view === 'connections') startConnPoll(); else stopConnPoll();
  }
  $$('.rail__item[data-view]').forEach(b => b.addEventListener('click', () => go(b.dataset.view)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

  /* ---------- Поповер профиля (аватар) — отдельно от «Настроек» ---------- */
  const accPop = $('#accountPop');
  function openAccPop() {
    // берём уже отрендеренные значения из карточки аккаунта (renderAccount)
    $('#popName').textContent = $('#accName').textContent;
    $('#popHandle').textContent = $('#accHandle').textContent;
    // innerHTML, а не textContent: в карточке подписка размечена как план +
    // «до <дата>», и склейка текста давала «Premiumдо 09.07.2027».
    $('#popSub').innerHTML = $('#accSub').innerHTML;
    $('#popBalance').textContent = $('#accBalance').textContent;
    setAvatar($('#popAvatar'), _avatarUrl, _avatarInitial);
    accPop.hidden = false;
    requestAnimationFrame(() => accPop.classList.add('is-open'));
  }
  function closeAccPop() { accPop.classList.remove('is-open'); accPop.hidden = true; }
  $('#railAvatar').addEventListener('click', (e) => { e.stopPropagation(); accPop.hidden ? openAccPop() : closeAccPop(); });
  document.addEventListener('click', (e) => {
    if (!accPop.hidden && !accPop.contains(e.target) && e.target.id !== 'railAvatar') closeAccPop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccPop(); });
  $('#popManage').addEventListener('click', () => { closeAccPop(); go('subscribe'); });
  $('#popSettings').addEventListener('click', () => { closeAccPop(); go('settings'); });
  $('#popTopup').addEventListener('click', () => { closeAccPop(); $('#topupBtn')?.click(); });
  $('#popLogout').addEventListener('click', () => { closeAccPop(); $('#logoutBtn')?.click(); });

  function setTheme(val) {
    document.documentElement.setAttribute('data-theme', val);
    try { localStorage.setItem('cloudvpn.theme', val); } catch {}
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
  const fxToggle = $('#fxToggle');
  if (fxToggle) {
    fxToggle.checked = fxOn;
    fxToggle.addEventListener('change', () => {
      fxOn = fxToggle.checked; localStorage.setItem(FX_KEY, fxOn ? '1' : '0');
      applyHoliday(); updateSky(); if (fxOn) setTimeout(greetHoliday, 200);
      toast(fxOn ? 'Праздничные эффекты включены 🎉' : 'Праздничные эффекты выключены');
    });
  }
  const AUTO_SRV_KEY = 'cloudvpn.autoserver', NOTIFY_KEY = 'cloudvpn.notify';
  const AUTO_RC_KEY = 'cloudvpn.autoreconnect', KS_KEY = 'cloudvpn.killswitch', AUTO_CONN_KEY = 'cloudvpn.autoconnect';
  const BLOCK_OFF_KEY = 'cloudvpn.blockoffline';
  let autoServerOn = localStorage.getItem(AUTO_SRV_KEY) !== '0';
  let notifyOn = localStorage.getItem(NOTIFY_KEY) !== '0';
  let autoReconnectOn = localStorage.getItem(AUTO_RC_KEY) !== '0';   // по умолчанию включено
  let killSwitchOn = localStorage.getItem(KS_KEY) === '1';          // по умолчанию выключено
  let autoConnectOn = localStorage.getItem(AUTO_CONN_KEY) === '1';  // по умолчанию выключено
  let blockOfflineOn = localStorage.getItem(BLOCK_OFF_KEY) === '1'; // по умолчанию выключено
  const precipToggle = $('#precipToggle');
  if (precipToggle) {
    precipToggle.checked = precipOn;
    precipToggle.addEventListener('change', () => {
      precipOn = precipToggle.checked; localStorage.setItem(PRECIP_KEY, precipOn ? '1' : '0');
      updateSky();
      toast(precipOn ? 'Дождь и снег включены' : 'Дождь и снег выключены');
    });
  }
  const autoServerToggle = $('#autoServerToggle');
  if (autoServerToggle) {
    autoServerToggle.checked = autoServerOn;
    autoServerToggle.addEventListener('change', () => {
      autoServerOn = autoServerToggle.checked; localStorage.setItem(AUTO_SRV_KEY, autoServerOn ? '1' : '0');
      toast(autoServerOn ? 'Авто-сервер включён — выберу самый быстрый' : 'Авто-сервер выключен');
    });
  }
  const notifyToggle = $('#notifyToggle');
  if (notifyToggle) {
    notifyToggle.checked = notifyOn;
    notifyToggle.addEventListener('change', () => {
      notifyOn = notifyToggle.checked; localStorage.setItem(NOTIFY_KEY, notifyOn ? '1' : '0');
      toast(notifyOn ? 'Уведомления включены' : 'Уведомления выключены');
    });
  }
  const autoReconnectToggle = $('#autoReconnectToggle');
  if (autoReconnectToggle) {
    autoReconnectToggle.checked = autoReconnectOn;
    autoReconnectToggle.addEventListener('change', () => {
      autoReconnectOn = autoReconnectToggle.checked; localStorage.setItem(AUTO_RC_KEY, autoReconnectOn ? '1' : '0');
      toast(autoReconnectOn ? 'Авто-переподключение включено' : 'Авто-переподключение выключено');
    });
  }
  const killSwitchToggle = $('#killSwitchToggle');
  if (killSwitchToggle) {
    killSwitchToggle.checked = killSwitchOn;
    // Синхронизируем состояние с ядром на старте (вдруг настройка сохранена).
    try { window.API.setKillSwitch(killSwitchOn); } catch {}
    killSwitchToggle.addEventListener('change', () => {
      killSwitchOn = killSwitchToggle.checked; localStorage.setItem(KS_KEY, killSwitchOn ? '1' : '0');
      try { window.API.setKillSwitch(killSwitchOn); } catch {}
      toast(killSwitchOn ? 'Kill switch включён — без VPN интернета не будет' : 'Kill switch выключен');
    });
  }
  const blockOfflineToggle = $('#blockOfflineToggle');
  if (blockOfflineToggle) {
    blockOfflineToggle.checked = blockOfflineOn;
    blockOfflineToggle.addEventListener('change', () => {
      blockOfflineOn = blockOfflineToggle.checked;
      localStorage.setItem(BLOCK_OFF_KEY, blockOfflineOn ? '1' : '0');
      if (blockOfflineOn) {
        applyBlockMode();
        toast(blockRules().length
          ? 'Блокировка работает и без VPN'
          : 'Добавьте правило «Заблокировать» — пока блокировать нечего');
      } else if (!connected && !connecting) {
        // Гасим ядро, поднятое только ради блокировки.
        window.API.vpnDisconnect(); setState('off');
        toast('Блокировка только при включённом VPN');
      }
    });
  }
  const autoConnectToggle = $('#autoConnectToggle');
  if (autoConnectToggle) {
    autoConnectToggle.checked = autoConnectOn;
    autoConnectToggle.addEventListener('change', () => {
      autoConnectOn = autoConnectToggle.checked; localStorage.setItem(AUTO_CONN_KEY, autoConnectOn ? '1' : '0');
      toast(autoConnectOn ? 'Буду подключаться при запуске' : 'Автоподключение при запуске выключено');
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
  $('#tgSupportBtn').addEventListener('click', () => window.API.openExternal('https://t.me/' + (cfg.telegram.supportUsername || 'cloudhelps')));
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
      d.dataset.plan = p.id;
      d.addEventListener('click', () => {
        selectedPlan = p.id;
        // Тут был renderPlans(): он стирал innerHTML и строил ВСЕ карточки
        // заново, из-за чего блоки на миг пропадали и переигрывали анимацию.
        // Достаточно переставить класс активности.
        [...el.children].forEach((c) => c.classList.toggle('is-active', c.dataset.plan === p.id));
        updatePayBtn();
      });
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
    // Кнопка «Оплатить с баланса» — только для аккаунтов с кошельком (Telegram).
    const balBtn = $('#payBalanceBtn');
    if (balBtn) {
      const kop = window.API.getSession()?.balance?.kopecks;
      if (kop == null) { balBtn.hidden = true; }
      else {
        balBtn.hidden = false;
        const enough = kop >= Math.round(sp * 100);
        balBtn.disabled = !enough;
        $('#payBalanceText').textContent = enough
          ? `Оплатить с баланса · ${spStr} ${cfg.currency}`
          : `На балансе ${(kop / 100).toFixed(0)} ${cfg.currency} — не хватает`;
      }
    }
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
  let payingBal = false;
  $('#payBalanceBtn')?.addEventListener('click', async () => {
    if (payingBal) return; payingBal = true;
    const btn = $('#payBalanceBtn'); btn.setAttribute('disabled', '');
    const restore = $('#payBalanceText').textContent; $('#payBalanceText').textContent = 'Оплачиваем…';
    try {
      await window.API.payFromBalance(selectedPlan);
      const s = await window.API.refreshSession();
      renderSubscription(s.subscription); renderAccount(s);
      toast('Подписка оплачена с баланса 🎉');
    } catch (e) {
      const m = (e && e.message) || '';
      toast(m.includes('402') ? 'Недостаточно средств на балансе' : 'Не удалось оплатить с баланса', true);
    } finally {
      payingBal = false; btn.removeAttribute('disabled'); $('#payBalanceText').textContent = restore; updatePayBtn();
    }
  });

  /* ============================================================ СЕРВЕРЫ ============================================================ */
  // Список серверов больше НЕ захардкожен. Он строится из реальной подписки
  // пользователя (Remnawave): после входа autoImportUserSubscription тянет
  // sub-URL, C# парсит vless-конфиги и присылает их сюда.
  const servers = [];
  let activeId = null;
  let pendingImportSource = 'admin';   // 'sub' (подписка) | 'admin' (ручной импорт) — читается в onSub
  let _subUrl = null, _subTries = 0;   // URL подписки + счётчик авто-ретраев импорта
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
  // Из RU_COUNTRY без своего файла остались CA, BR, HK, AU — у них сложный герб,
  // рисовать примитивом хуже, чем глобус. Появится такая нода — добавить SVG сюда.
  const FLAGS = new Set(['ae','ch','de','ee','es','fi','fr','gb','it','jp','lt','lv','nl','pl','ru','se','sg','tr','us']);
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
    const renderRow = (s) => {
      const li = document.createElement('li');
      li.className = 'server' + (s.id === activeId ? ' is-active' : '') + (s.gaming ? ' server--game' : '');
      const sub = s.city || (s.code && s.code !== 'XX' ? s.code : '');
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
    };
    // Группы: сверху «Игровые серверы» (AmneziaWG), ниже обычные.
    const games = list.filter(s => s.gaming);
    const normal = list.filter(s => !s.gaming);
    const addHeader = (text) => { const h = document.createElement('li'); h.className = 'server-group'; h.textContent = text; serverList.appendChild(h); };
    if (games.length) { addHeader('🎮 Игровые серверы'); games.forEach(renderRow); }
    if (normal.length) { if (games.length) addHeader('Обычные серверы'); normal.forEach(renderRow); }
  }
  function setActive(id) {                          // выбрать сервер БЕЗ закрытия шторки
    const s = servers.find(x => x.id === id); if (!s) { activeId = null; return; }
    activeId = id;
    $('#currentServerName').textContent = s.city ? `${s.country} · ${s.city}` : s.country;
    $('#pickFlag').src = s.flag;
    if (s.ping != null) $('#mPing').textContent = s.ping;
    renderServers($('#serverSearch').value);
    syncTray();
  }
  function selectServer(id) {
    // Ручной выбор сервера выключает авто-сервер. Иначе connect() переопределит
    // выбор «самым быстрым» (для РФ это обычно Россия) — юзер выбирал Германию,
    // а подключалось к России.
    if (autoServerOn) {
      autoServerOn = false;
      try { localStorage.setItem(AUTO_SRV_KEY, '0'); } catch {}
      const t = $('#autoServerToggle'); if (t) t.checked = false;
      toast('Авто-сервер выключен — держу выбранный сервер');
    }
    setActive(id); const s = servers.find(x => x.id === id); if (!s) return;
    closeDrawer();
    if (connected || connecting) {                 // переключение на лету — переподключаемся
      if ((s.vless || (s.gaming && s.gamingId)) && window.API.hasNativeVpn) {
        // Сначала чисто отключаемся (даём TUN-адаптеру освободиться), затем
        // подключаемся к новому серверу — иначе ядро застревает на "Подключение".
        setState('connecting'); toast('Переключаю на ' + s.country);
        window.API.vpnDisconnect();
        // Слать полную конфигурацию (route/rules), а не голый vless — иначе сплит
        // по приложениям сбрасывался в route:all при смене сервера.
        setTimeout(() => window.API.vpnConnect(buildConnectOpts(s)), 900);
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
      const rawHash = (u.hash || '').replace(/^#/, '');
      // Кривой процент-эскейп в имени ноды не должен ронять парсинг (иначе сервер
      // молча пропадает из списка) — откатываемся на сырую строку.
      let remark; try { remark = decodeURIComponent(rawHash); } catch { remark = rawHash; }
      return { host, port, remark };
    } catch { return null; }
  }
  // Личность ноды для дедупа и поиска «той же самой» ноды между импортами.
  // ТОЛЬКО адреса мало: на одном IP:порту может висеть несколько инбаундов,
  // разведённых по WS-пути (у нас #1 и #2 «Обход глушилок» — 176.109.85.48:14443,
  // /cloudws и /plws). Дедуп по хосту выкидывал второй как дубль.
  // Ключ Reality (pbk/sid) и имя ноды в ключ НЕ входят: они ротируются, а нода
  // остаётся той же — иначе при ротации она бы «переезжала» на новый id и
  // слетал бы активный выбор. Разбираем регуляркой, а не URL: у vless://
  // нестандартная схема, и парсер местами капризничает.
  function nodeKey(vless, p) {
    const q = String(vless || '').split('#')[0];
    const grab = re => { const m = q.match(re); return m ? m[1] : ''; };
    let path = grab(/[?&]path=([^&]*)/);
    try { path = decodeURIComponent(path); } catch { }
    const sni = grab(/[?&]sni=([^&]*)/) || grab(/[?&]host=([^&]*)/);
    return `${p?.host || ''}:${p?.port || ''}|${path}|${sni}`;
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
    // Постоянно храним ТОЛЬКО серверы подписки. Ручной админ-импорт — инструмент
    // тестирования: он живёт лишь в текущей сессии и не должен залипать в
    // localStorage (иначе чужие/старые ноды, напр. с чужого сервиса, всплывают
    // в списке, особенно когда собственная подписка ничего не отдаёт).
    const list = servers.filter(s => s.imported && s.source === 'sub')
      .map(s => ({ id: s.id, code: s.code, country: s.country, city: s.city, host: s.host, port: s.port, vless: s.vless, source: 'sub' }));
    localStorage.setItem(IMP_KEY, JSON.stringify(list));
  }
  function loadImported() {
    let list; try { list = JSON.parse(localStorage.getItem(IMP_KEY) || '[]'); } catch { return; }
    let purged = false;
    list.forEach(it => {
      // Держим ТОЛЬКО явные серверы подписки. Заглушки панели, ручной админ-импорт
      // и легаси-записи без source — выкидываем (реальные серверы подписки
      // подтянутся заново из live-импорта, ничего не теряется).
      if (isStubVless(it.vless, it) || it.source !== 'sub') { purged = true; return; }
      const key = nodeKey(it.vless, { host: it.host, port: it.port || 443 });
      if (servers.some(s => s.id === it.id || (it.vless && s.vless === it.vless) || (key && s.key === key))) return;
      const num = parseInt(String(it.id).replace('imp', ''), 10); if (num > impCounter) impCounter = num;
      servers.push({ id: it.id, code: it.code || 'XX', country: it.country || 'Сервер', city: it.city || '',
                     host: it.host || '', port: it.port || 443, load: 0, ping: null, vless: it.vless, key,
                     flag: flagFor(it.code), imported: true, source: 'sub' });
    });
    if (purged) saveImported();   // почистить localStorage от заглушек и чужих импортов
    renderServers($('#serverSearch').value);
  }
  // Панель отдаёт для неактивных/лимитированных/заблокированных подписок фейковые
  // «серверы»-заглушки (адрес 0.0.0.0:1, uuid из нулей, имя вроде «Подписка
  // закончилась» / «Много устройств»). Это не серверы — не тащим их в список.
  function isStubVless(vless, p) {
    return !p || p.host === '0.0.0.0' || String(p.port) === '1'
        || /0{8}-0{4}-0{4}-0{4}-0{12}/.test(String(vless || ''));
  }
  // Собрать поля сервера из vless (без добавления в список). null — если это
  // заглушка панели или строка не парсится.
  function buildServer(vless) {
    const p = parseVlessLite(vless); if (!p || !p.host) return null;
    if (isStubVless(vless, p)) return null;   // заглушка панели, а не реальный сервер
    const code = flagToCode(p.remark);
    const labelNoFlag = String(p.remark || '').replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').trim();
    const country = RU_COUNTRY[code] || labelNoFlag || 'Сервер';
    // city/подпись: оригинальное имя ноды, если оно несёт что-то сверх страны.
    const city = (labelNoFlag && labelNoFlag.toLowerCase() !== country.toLowerCase()) ? labelNoFlag : '';
    return { code: code || 'XX', country, city, host: p.host, port: p.port || 443, vless,
             key: nodeKey(vless, p), flag: flagFor(code) };
  }
  // source: 'sub' (из подписки юзера) | 'admin' (ручной импорт админом)
  function addImportedServer(vless, source = 'admin') {
    const b = buildServer(vless); if (!b) return null;
    // Дедуп по vless и по личности ноды (см. nodeKey), чтобы один сервер не задвоился.
    const dup = servers.find(s => s.vless === vless || (s.key && s.key === b.key));
    if (dup) return dup;
    const id = 'imp' + (++impCounter);
    const s = { id, ...b, load: 0, ping: null, imported: true, source };
    servers.push(s);
    return s;
  }
  // Подписка — источник истины. На каждом импорте пересобираем её серверы под
  // актуальный ответ панели: обновляем имена/ключи существующих нод, добавляем
  // новые и выкидываем «призраков» (переименованные / сменившие IP / удалённые
  // ноды). Без этого старые импорты копятся в localStorage и список двоится.
  // Возвращает первый актуальный сервер (для авто-выбора).
  function syncSubServers(items) {
    const desired = [];
    const seen = new Set();
    (items || []).forEach(vless => {
      const b = buildServer(vless);
      if (!b || seen.has(b.key)) return;   // заглушки и дубли внутри самой подписки
      seen.add(b.key); desired.push(b);
    });
    if (!desired.length) return null;   // подписка пустая/битая — не трогаем список
    const keepKey = new Set(desired.map(b => b.key));
    const keepVless = new Set(desired.map(b => b.vless));
    for (let i = servers.length - 1; i >= 0; i--) {
      const s = servers[i];
      if (s.source !== 'sub') continue;                         // ручные (admin) не трогаем
      if (keepVless.has(s.vless) || keepKey.has(s.key)) continue;
      if (s.id === activeId && (connected || connecting)) continue;  // не рвём активное соединение
      servers.splice(i, 1);
    }
    let first = null;
    desired.forEach(b => {
      let s = servers.find(x => x.vless === b.vless || (x.key && x.key === b.key));
      if (s) {
        // нода могла переименоваться или обновить ключ — освежаем поля на месте
        Object.assign(s, { code: b.code, country: b.country, city: b.city, host: b.host, port: b.port,
                           vless: b.vless, key: b.key, flag: b.flag, imported: true });
      } else {
        const id = 'imp' + (++impCounter);
        s = { id, ...b, load: 0, ping: null, imported: true, source: 'sub' };
        servers.push(s);
      }
      if (!first) first = s;
    });
    // Порядок списка = порядок подписки, то есть порядок хостов в панели (там их
    // перетаскивают руками, и это осмысленная очередь). Без этого шага серверы
    // стояли в порядке ПЕРВОГО появления: новая нода всегда падала в хвост, и
    // список расходился с панелью. Ручные админ-импорты держим после подписки.
    const rank = new Map(desired.map((b, i) => [b.key, i]));
    const subs = [], rest = [];
    servers.forEach(s => ((s.source === 'sub' && rank.has(s.key)) ? subs : rest).push(s));
    subs.sort((a, b) => rank.get(a.key) - rank.get(b.key));
    servers.splice(0, servers.length, ...subs, ...rest);
    return first;
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
      const msg = res?.error || 'Не удалось импортировать';
      // Импорт подписки мог не зарезолвиться в короткое окно после сноса туннеля
      // (напр. сразу после гостевого Telegram-туннеля DNS ещё восстанавливается).
      // Тихо ретраим пару раз, прежде чем сдаться. Лимит устройств не ретраим.
      if (src === 'sub' && _subUrl && _subTries < 2 && !/лимит устройств/i.test(msg)) {
        _subTries++;
        setTimeout(() => { pendingImportSource = 'sub'; window.API.importSubscription(_subUrl); }, 1500);
        return;
      }
      // Тихо для авто-подписки (нет нужды пугать юзера), но лимит устройств —
      // это действие для юзера: показываем причину, иначе список просто пуст.
      if (src === 'admin' || /лимит устройств/i.test(msg)) toast(msg, true);
      return;
    }
    const items = res.items || [];
    let first = null;
    if (src === 'sub') {
      // Полная пересборка серверов подписки (иначе список двоится при смене IP/имён нод).
      first = syncSubServers(items);
    } else {
      items.forEach(vless => { const s = addImportedServer(vless, src); if (s && !first) first = s; });
    }
    saveImported(); renderServers($('#serverSearch').value);
    if (first && !activeServer()) setActive(first.id);
    measureAllPings();   // сразу показать реальный пинг по каждому серверу
    if (src === 'admin') {
      $('#importInput').value = '';
      toast(items.length > 1 ? `Добавлено серверов: ${items.length}` : 'Сервер добавлен');
    } else if (items.length) {
      toast(`Серверы подписки загружены: ${items.length}`);
      syncTray();
      maybeAutoConnect();   // «Подключаться при запуске» — один раз, когда серверы готовы
    }
  });

  // Фолбэк: если у юзера нет sub-URL, тянем одиночный vless с бэкенда
  // (/api/vpn/config) и добавляем его как сервер подписки.
  async function loadVpnConfig() {
    try {
      const c = await window.API.getVpnConfig();
      if (c && c.vless) {
        const s = syncSubServers([c.vless]);
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
    else if (st === 'blocking'){ statusText.textContent='Блокировка активна · VPN выключен'; orbLabel.textContent='Подключить'; }
    else { statusText.textContent='Отключено'; orbLabel.textContent='Подключить'; }
  }
  orb.addEventListener('click', () => {
    const sub = window.API.getSession()?.subscription;
    // админ может подключаться без активной подписки (тест чужих/своих конфигов)
    if (!connected && !isAdmin() && !(sub && sub.expires > Date.now())){ toast('Нужна активная подписка', true); go('subscribe'); return; }
    connected ? disconnect() : connect();
  });
  const activeServer = () => servers.find(x => x.id === activeId);
  // Самый быстрый доступный сервер (по пингу; без пинга — любой рабочий).
  // Вайтлист-ноды («Обход глушилок», «Обход белых списков», старое «Whitelist
  // RU-DE») — специализированные, авто-сервер их не выбирает вовсе.
  // Ноды переименовали в «Обход глушилок», и по старому шаблону они перестали
  // распознаваться — поэтому ловим любое «обход …», а не конкретную формулировку.
  function isWhitelistServer(s) {
    const hay = `${s.country || ''} ${s.city || ''} ${s.name || ''}`.toLowerCase();
    return /whitelist|бел(?:ых|ые)\s*спис|обход|глушилк|\bwl\b/.test(hay);
  }
  function pickAutoServer() {
    const cand = servers.filter(s => s.vless && !isWhitelistServer(s));
    if (!cand.length) return null;   // остались только вайтлист-ноды — не переключаем
    const pinged = cand.filter(s => s.ping != null);
    const pool = (pinged.length ? pinged : cand).slice().sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));
    return pool[0];
  }
  function connect() {
    if (connecting || connected) return;
    if (autoServerOn) { const best = pickAutoServer(); if (best && best.id !== activeId) { setActive(best.id); toast('Авто: ' + best.country); } }
    const s = activeServer();
    if (!s) return;
    if (!window.API.hasNativeVpn) { toast('VPN-ядро доступно только в приложении', true); return; }
    if (!s.vless && !(s.gaming && s.gamingId)) { toast('Конфиг этого сервера ещё не подключён', true); return; }
    intendedConnected = true; resetReconnect();
    connecting = true; setState('connecting');
    window.API.vpnConnect(buildConnectOpts(s));
  }
  // Полезная нагрузка для ядра с учётом текущего режима сплита. ВАЖНО: и обычный
  // коннект, и переключение сервера на лету должны слать ЭТО, иначе передача
  // одной строки vless в мост сбрасывает маршрутизацию в route:all (терялся
  // сплит по приложениям при смене сервера).
  function buildConnectOpts(s) {
    // s — объект сервера. Игровой (AmneziaWG) шлём по gamingId — сырой конфиг
    // живёт в нативе, в JS его нет. Обычный — строкой vless. Строку тоже примем.
    const exclude = vpnPrefs.route === 'apps' && vpnPrefs.split === 'exclude';
    const target = exclude ? 'DIRECT' : 'GLOBAL';
    const rules = RULES.filter(r => r.on).map(r => {
      const def = RULE_TYPES[r.type];
      return def ? def.emit(r.value, target) : null;
    }).filter(Boolean)
      .flatMap(line => line.split('\n')).filter(Boolean);   // «сервис» разворачивается в несколько строк
    const route = vpnPrefs.route === 'apps' ? (exclude ? 'apps-exclude' : 'apps') : 'all';
    const dns = vpnPrefs.dns === 'custom' ? (vpnPrefs.dnsCustom || 'auto') : (vpnPrefs.dns || 'auto');
    const base = { mode: vpnPrefs.mode, route, rules, dns };
    return (s && s.gaming) ? { ...base, gamingId: s.gamingId } : { ...base, vless: (s && s.vless) || s };
  }
  function disconnect(){
    intendedConnected = false; resetReconnect();   // осознанное отключение — не переподключаемся
    if (window.API.hasNativeVpn) window.API.vpnDisconnect();
    onDisconnected();
  }
  function onDisconnected(){
    connected = false; connecting = false; setState('off'); stopTimers();
    $('#mDown').textContent='0.0'; $('#mUp').textContent='0.0';
    $('#ipText').textContent='IP скрыт'; $('#ipChip').classList.remove('is-on');
    setEmotion('happy'); vpnOn = false; applyMood();
    syncTray();
    applyBlockMode();
  }

  /* ---------- Блокировка сайтов при выключенном VPN ---------- */
  // При выключенном VPN ядро не запущено, блокировать нечем. Поэтому держим
  // ядро поднятым с TUN, но БЕЗ прокси: весь трафик идёт напрямую (MATCH,DIRECT),
  // а заблокированные домены отбиваются REJECT.
  function blockRules() {
    const def = RULE_TYPES['block'];
    if (!def) return [];
    return RULES.filter(r => r.on && r.type === 'block')
                .map(r => def.emit(r.value)).filter(Boolean);
  }
  function applyBlockMode() {
    if (!window.API.hasNativeVpn) return;
    if (connected || connecting || reconnecting) return;   // обычный VPN важнее
    const rules = blockRules();
    if (blockOfflineOn && rules.length) window.API.vpnConnect({ mode: 'block', rules });
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
    // Запрос внешнего IP не мгновенный: без этого чип висел «IP скрыт» и
    // обновлялся рывком сильно позже.
    $('#ipText').textContent = 'IP определяем…';
    try {
      const r = await fetch('https://ipwho.is/', { cache: 'no-store' });
      const j = await r.json();
      if (j && j.ip) { $('#ipText').textContent = 'IP ' + j.ip; $('#ipChip').classList.add('is-on'); }
    } catch { $('#ipText').textContent = 'IP скрыт'; }
  }

  /* ---------- Авто-переподключение и фейловер по нодам ---------- */
  // autoReconnectOn/autoConnectOn объявлены выше, рядом с настройками подключения.
  let intendedConnected = false;   // юзер хочет быть подключённым (не жал «Отключить»)
  let autoConnectTried = false;    // «подключаться при запуске» — только один раз за сессию
  function maybeAutoConnect() {
    if (autoConnectTried || !autoConnectOn || !window.API.hasNativeVpn) return;
    if (connected || connecting) return;
    autoConnectTried = true;
    // Дать пингам секунду, чтобы авто-сервер выбрал лучшую ноду.
    setTimeout(() => { if (!connected && !connecting && activeServer()?.vless) { toast('Автоподключение…'); connect(); } }, 800);
  }

  // Отдаём в трей состояние + список серверов для быстрого меню.
  function syncTray() {
    try {
      const list = servers.filter(s => s.vless).slice(0, 12)
        .map(s => ({ id: s.id, name: (s.country || 'Сервер') + (s.city ? ' · ' + s.city : '') }));
      window.API.traySync({ connected: !!connected, activeId, servers: list });
    } catch {}
  }
  window.API.onTray(cmd => {
    if (cmd === 'connect') { if (!connected && !connecting) connect(); }
    else if (cmd === 'disconnect') { if (connected || connecting) disconnect(); }
    else if (cmd.startsWith('server:')) {
      const id = cmd.slice(7); const s = servers.find(x => x.id === id); if (!s) return;
      if (connected || connecting) selectServer(id);
      else { setActive(id); connect(); }
    }
  });
  let reconnecting = false, rcSameTries = 0, rcTotal = 0;
  let rcFailed = new Set();        // ноды, не поднявшиеся в этой серии — не долбим повторно
  const RC_SAME_MAX = 2;           // попыток на той же ноде до фейловера
  const RC_TOTAL_MAX = 8;          // общий предел серии, чтобы не крутить вечно
  function resetReconnect() { reconnecting = false; rcSameTries = 0; rcTotal = 0; rcFailed.clear(); }
  function pickFailoverServer() {
    const cur = activeServer();
    const cand = servers.filter(s => s.vless && !isWhitelistServer(s)
      && (!cur || s.id !== cur.id) && !rcFailed.has(s.id));
    if (!cand.length) return null;
    const pinged = cand.filter(s => s.ping != null);
    const pool = (pinged.length ? pinged : cand).slice().sort((a, b) => (a.ping ?? 9999) - (b.ping ?? 9999));
    return pool[0];
  }
  function driveReconnect() {
    if (!autoReconnectOn || !intendedConnected) { resetReconnect(); onDisconnected(); return; }
    if (rcTotal >= RC_TOTAL_MAX) {
      resetReconnect(); onDisconnected();
      toast('Не удалось переподключиться — проверьте интернет', true);
      if (notifyOn) winNotify('VPN не смог переподключиться', 'CloudVPN');
      return;
    }
    rcTotal++; reconnecting = true; connecting = true; setState('connecting');
    let target;
    if (rcSameTries < RC_SAME_MAX && activeServer()) {
      rcSameTries++; target = activeServer();
      toast(`Соединение потеряно, переподключаюсь… (${rcSameTries})`);
    } else {
      const cur = activeServer();
      target = pickFailoverServer();
      if (!target) { resetReconnect(); onDisconnected(); toast('Нет доступных серверов для переподключения', true); return; }
      if (cur) rcFailed.add(cur.id);
      setActive(target.id); rcSameTries = 0;
      toast('Переключаюсь на ' + target.country);
    }
    window.API.vpnConnect(buildConnectOpts(target));
  }

  /* ---------- Реальный статус от ядра Mihomo (через C#-мост) ---------- */
  window.API.onVpn(st => {
    if (!st || !st.state) return;
    // На экране входа ядро может быть поднято ради гостевого Telegram-туннеля
    // (кнопка «Разблокировать Telegram»). Его connect/connected/disconnected НЕ
    // должны трогать состояние основного приложения, иначе после входа UI висит
    // «подключено» без реального сервера. Пока не показан appShell — игнорируем.
    if (!appShell || appShell.hidden) return;
    if (st.state === 'connecting') { connecting = true; setState('connecting'); return; }
    if (st.state === 'error') {
      // Во время серии переподключения ошибка = неудачная попытка → следующая нода.
      if (reconnecting) { driveReconnect(); return; }
      onDisconnected();
      const head = st.error ? ('Не удалось подключиться: ' + st.error) : 'Не удалось подключиться';
      toast(head, true);
      if (st.details) {
        // Тихо положим хвост лога в консоль — есть кнопка «Открыть лог» в админ-секции.
        try { console.warn('[mihomo log tail]\n' + st.details); } catch {}
      }
      return;
    }
    if (st.state === 'dropped') {
      // Ядро упало само. Если включено авто-переподключение и юзер хотел быть в
      // сети — запускаем серию (та же нода → фейловер), иначе просто отключаемся.
      if (connected || connecting) {
        if (autoReconnectOn && intendedConnected) driveReconnect();
        else { onDisconnected(); playChime('disconnect'); toast('Соединение потеряно', true); if (notifyOn) winNotify('VPN отключён', 'CloudVPN'); }
      }
      return;
    }
    if (st.state === 'blocking') {   // ядро поднято только ради блокировки
      connected = false; connecting = false; setState('blocking');
      return;
    }
    if (st.state === 'disconnected') {
      if (reconnecting) return;   // серию переподключения не сбиваем
      if (connected || connecting) { onDisconnected(); playChime('disconnect'); toast('Отключено'); if (notifyOn) winNotify('VPN отключён', 'CloudVPN'); }
      return;
    }
    if (st.state === 'connected') {
      if (!connected) {
        connected = true; connecting = false; setState('on');
        resetReconnect(); intendedConnected = true;
        sessionStart = Date.now(); totalDownMB = totalUpMB = 0; startTimers();
        vpnOn = true; applyMood(); playChime('connect');
        const s = activeServer(); const where = s ? ' · ' + s.country : '';
        toast('Подключено' + where);
        if (notifyOn) winNotify('Защищено' + where, 'CloudVPN');
        revealRealIp();
        syncTray();
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

  /* ---------- Настройки туннеля (route/apps) — реально влияют на коннект ---------- */
  const PREF_KEY = 'cloudvpn.vpnprefs';
  const defaultPrefs = { mode: 'tun', route: 'all', split: 'include', dns: 'auto', dnsCustom: '', closeTray: true, keepAlive: false };
  let vpnPrefs;
  try { vpnPrefs = { ...defaultPrefs, ...(JSON.parse(localStorage.getItem(PREF_KEY) || 'null') || {}) }; }
  catch { vpnPrefs = { ...defaultPrefs }; }
  vpnPrefs.mode = 'tun';   // единственный режим — TUN (весь трафик системы через VPN)
  function savePrefs(){ try { localStorage.setItem(PREF_KEY, JSON.stringify(vpnPrefs)); } catch {} }
  // Свой дропдаун вместо нативного <select>: у нативного список рисует ОС своим
  // системным шрифтом (Segoe UI), из-за чего он выбивался из шрифта приложения.
  // Этот использует те же токены (--f-ui, карточки, тени), что и весь интерфейс.
  function miniSelect(el, initial, onChange) {
    if (!el) return;
    const btn = el.querySelector('.mini-select__btn');
    const valEl = el.querySelector('.mini-select__val');
    const menu = el.querySelector('.mini-select__menu');
    const items = Array.from(menu.querySelectorAll('li'));
    const setValue = (v, fire) => {
      const it = items.find(i => i.dataset.value === v) || items[0];
      valEl.textContent = it.textContent;
      items.forEach(i => i.classList.toggle('is-sel', i === it));
      el.dataset.value = it.dataset.value;
      if (fire) onChange(it.dataset.value);
    };
    const onDoc = (e) => { if (!el.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    // Пока меню открыто, поднимаем родительскую панель над соседними, иначе
    // выпадающий список уходит ПОД следующую панель (напр. «Диагностика»).
    const panel = el.closest('.panel');
    const open = () => {
      menu.hidden = false; el.classList.add('open');
      if (panel) { panel.style.position = 'relative'; panel.style.zIndex = '30'; }
      requestAnimationFrame(() => menu.classList.add('show'));
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', onKey);
    };
    const close = () => {
      el.classList.remove('open'); menu.classList.remove('show');
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { if (!el.classList.contains('open')) { menu.hidden = true; if (panel) panel.style.zIndex = ''; } }, 180);
    };
    btn.addEventListener('click', (e) => { e.stopPropagation(); el.classList.contains('open') ? close() : open(); });
    items.forEach(i => i.addEventListener('click', () => { setValue(i.dataset.value, true); close(); }));
    setValue(initial, false);
  }
  // Свой DNS: 1.1.1.1/8.8.8.8 в РФ временами душат, поэтому даём вписать любой
  // сервер (IP, IP:порт или DoH-URL, можно несколько через запятую).
  const sanitizeDns = (s) => String(s || '').trim().replace(/[^A-Za-z0-9.:/_,\- ]/g, '').slice(0, 200);
  const dnsCustomInput = $('#dnsCustom');
  const syncDnsCustom = () => { if (dnsCustomInput) dnsCustomInput.hidden = (vpnPrefs.dns !== 'custom'); };
  if (dnsCustomInput) {
    dnsCustomInput.value = vpnPrefs.dnsCustom || '';
    dnsCustomInput.addEventListener('change', () => {
      vpnPrefs.dnsCustom = sanitizeDns(dnsCustomInput.value);
      dnsCustomInput.value = vpnPrefs.dnsCustom; savePrefs();
      if (connected || connecting) toast('DNS применится после переподключения');
    });
  }
  miniSelect($('#dnsSelect'), vpnPrefs.dns || 'auto', (v) => {
    vpnPrefs.dns = v; savePrefs();
    syncDnsCustom();
    if (v === 'custom' && dnsCustomInput) dnsCustomInput.focus();
    if (connected || connecting) toast('DNS применится после переподключения');
  });
  syncDnsCustom();
  const trayTgl = $('#closeTrayToggle');
  if (trayTgl) {
    trayTgl.checked = vpnPrefs.closeTray !== false;
    const pushTray = () => { try { window.API.setCloseTray && window.API.setCloseTray(vpnPrefs.closeTray !== false); } catch {} };
    pushTray();
    trayTgl.addEventListener('change', () => { vpnPrefs.closeTray = trayTgl.checked; savePrefs(); pushTray(); });
  }
  const kaTgl = $('#keepAliveToggle');
  if (kaTgl) {
    kaTgl.checked = vpnPrefs.keepAlive === true;
    const pushKa = () => { try { window.API.setKeepAlive && window.API.setKeepAlive(vpnPrefs.keepAlive === true); } catch {} };
    pushKa();   // сообщаем нативу текущее состояние на старте
    kaTgl.addEventListener('change', () => {
      vpnPrefs.keepAlive = kaTgl.checked; savePrefs(); pushKa();
      if (kaTgl.checked) toast('Прямые соединения не будут рваться при вкл/выкл VPN');
    });
  }
  const proxyCopy = $('#proxyCopyBtn');
  if (proxyCopy) proxyCopy.addEventListener('click', async () => {
    const addr = '127.0.0.1:7897';
    try { await navigator.clipboard.writeText(addr); toast('Скопировано: ' + addr); } catch { toast(addr); }
  });
  const TUN_HINT = 'Весь трафик системы идёт через VPN (режим TUN).';

  /* ---------- Split-tunneling: универсальные правила (процесс / домен / ip / geo) ---------- */
  // Каждое правило: { id, type, value, name, on }
  //   type ∈ { process, domain-suffix, domain-keyword, geosite, ip-cidr, asn, geoip }
  //   value = что матчим (chrome.exe, youtube.com, RU и т.д.)
  //   name  = что показываем юзеру (для процессов — заголовок окна; иначе сам value)
  // sanitize: strip commas/newlines/control chars that would break a mihomo
  // CSV rule line and confuse the parser. We also forbid bare DIRECT/REJECT
  // injection at the end of value.
  const sanRule = v => String(v || '').replace(/[,\r\n\t]/g, '').trim();
  // Готовые наборы доменов для популярных сервисов. Один сервис = НЕСКОЛЬКО
  // доменов: например у YouTube страница на youtube.com, а само видео льётся с
  // googlevideo.com, превью с ytimg.com — по одному «youtube» видео не заработает.
  const SERVICE_PRESETS = {
    youtube:   { name: 'YouTube',     badge: '▶',  domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com', 'ggpht.com'] },
    discord:   { name: 'Discord',     badge: '🎧', domains: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media'] },
    instagram: { name: 'Instagram',   badge: '📸', domains: ['instagram.com', 'cdninstagram.com', 'ig.me'] },
    tiktok:    { name: 'TikTok',      badge: '🎵', domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'ibytedtos.com'] },
    twitch:    { name: 'Twitch',      badge: '🟣', domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net'] },
    spotify:   { name: 'Spotify',     badge: '🎶', domains: ['spotify.com', 'scdn.co', 'spotifycdn.com'] },
    twitter:   { name: 'X / Twitter', badge: '𝕏',  domains: ['x.com', 'twitter.com', 'twimg.com', 't.co'] },
  };
  // emit(value, target): target = 'GLOBAL' (через VPN) или 'DIRECT' (мимо VPN,
  // для инверсного сплита «всё кроме выбранных»).
  const RULE_TYPES = {
    // Блокировка: emit игнорирует target — сайт закрывается всегда, независимо
    // от режима сплита (в инверсном режиме DIRECT его бы «пропустил»).
    'block':          { label: 'Заблокировать',  badge: '⛔',  hint: 'сайт не будет открываться', placeholder: 'example.com',
                        emit: (v) => `DOMAIN-SUFFIX,${sanRule(v)},REJECT` },
    'service':        { label: 'Сервис',          badge: '⭐',  hint: 'готовый набор доменов', placeholder: 'youtube',
                        emit: (v, t) => (SERVICE_PRESETS[v]?.domains || []).map(d => `DOMAIN-SUFFIX,${sanRule(d)},${t}`).join('\n') },
    'process':        { label: 'Процесс',         badge: '💻',  hint: 'имя .exe',      placeholder: 'chrome.exe',
                        emit: (v, t) => `PROCESS-NAME,${sanRule(v)},${t}` },
    'domain-suffix':  { label: 'По суффиксу',     badge: '🌐',  hint: 'домен и всё под ним', placeholder: 'youtube.com',
                        emit: (v, t) => `DOMAIN-SUFFIX,${sanRule(v)},${t}` },
    'domain-keyword': { label: 'Слово в домене',  badge: 'Tt',  hint: 'подстрока в имени домена', placeholder: 'google',
                        emit: (v, t) => `DOMAIN-KEYWORD,${sanRule(v)},${t}` },
    'geosite':        { label: 'GeoSite',         badge: '📚',  hint: 'тег из meta-rules-dat',  placeholder: 'youtube',
                        emit: (v, t) => `GEOSITE,${sanRule(v)},${t}` },
    'ip-cidr':        { label: 'IP-CIDR',         badge: '🛣',  hint: 'IP или подсеть',         placeholder: '8.8.8.8/32',
                        emit: (v, t) => `IP-CIDR,${sanRule(v)},${t},no-resolve` },
    'asn':            { label: 'ASN',             badge: '#',   hint: 'номер автономной системы', placeholder: '13335',
                        emit: (v, t) => `IP-ASN,${sanRule(v)},${t},no-resolve` },
    'geoip':          { label: 'GeoIP',           badge: '📍',  hint: 'двухбуквенный код страны', placeholder: 'RU',
                        emit: (v, t) => `GEOIP,${sanRule(v).toUpperCase()},${t},no-resolve` },
  };
  // SVG-иконки только для известных .exe (process); для остальных типов рисуем
  // эмодзи-бейдж из RULE_TYPES.badge.
  const KNOWN_ICONS = {
    'chrome.exe':       { icon: 'googlechrome', name: 'Google Chrome' },
    'telegram.exe':     { icon: 'telegram',     name: 'Telegram' },
    'steam.exe':        { icon: 'steam',        name: 'Steam' },
    'discord.exe':      { icon: 'discord',      name: 'Discord' },
    'qbittorrent.exe':  { icon: 'qbittorrent',  name: 'qBittorrent' },
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
  // Чиним старые «сломанные» правила: одиночный домен/ключевое слово вида
  // «youtube» (без точки) не ловит googlevideo.com и т.п. — заменяем на готовый
  // сервис-пресет с полным набором доменов.
  (function migrateBareServices() {
    let changed = false;
    RULES = RULES.map(r => {
      if ((r.type === 'domain-suffix' || r.type === 'domain-keyword')
          && !String(r.value).includes('.')
          && SERVICE_PRESETS[String(r.value).toLowerCase()]) {
        const key = String(r.value).toLowerCase(); changed = true;
        return { ...r, type: 'service', value: key, name: SERVICE_PRESETS[key].name };
      }
      return r;
    });
    if (changed) { try { localStorage.setItem(RULES_KEY, JSON.stringify(RULES)); } catch {} }
  })();
  function saveRules(){ try { localStorage.setItem(RULES_KEY, JSON.stringify(RULES)); } catch {} }

  // Перетаскивание правил за «ручку». В mihomo приоритет у правил СВЕРХУ ВНИЗ
  // (первое совпадение выигрывает), а порядок эмита = порядок массива RULES
  // (см. buildConnectOpts). Плавный transform-драг: поднятая строка едет за
  // курсором, соседи расступаются, на отпускании строка мягко встаёт в слот.
  function commitRuleMove(from, to) {
    if (from === to || from < 0 || to < 0 || from >= RULES.length || to >= RULES.length) { renderApps(); return; }
    const [moved] = RULES.splice(from, 1);
    RULES.splice(to, 0, moved);
    saveRules(); renderApps();
    if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Порядок изменён, применится после переподключения', false);
  }
  let _ruleDragging = false;
  function startRuleDrag(downEv, li) {
    if (_ruleDragging) return;
    if (downEv.button != null && downEv.button !== 0) return;   // только левая кнопка / тач
    const list = $('#appList');
    const rows = Array.from(list.querySelectorAll('.app-row:not(.app-row--empty)'));
    const fromIndex = rows.indexOf(li);
    if (fromIndex < 0 || rows.length < 2) return;
    downEv.preventDefault();
    _ruleDragging = true;
    const step = Math.max(1, rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top);
    const startY = downEv.clientY;
    let toIndex = fromIndex;

    document.body.classList.add('is-reordering');
    li.classList.add('dragging');
    li.style.transition = 'none';   // поднятая строка едет за пальцем без задержки
    li.style.zIndex = '6';

    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      li.style.transform = `translateY(${dy}px) scale(1.03)`;
      let ti = fromIndex + Math.round(dy / step);
      ti = Math.max(0, Math.min(rows.length - 1, ti));
      if (ti !== toIndex) {
        toIndex = ti;
        rows.forEach((row, k) => {
          if (row === li) return;
          let shift = 0;
          if (fromIndex < toIndex && k > fromIndex && k <= toIndex) shift = -step;
          else if (fromIndex > toIndex && k >= toIndex && k < fromIndex) shift = step;
          row.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      const moved = toIndex !== fromIndex;
      const finalDy = (toIndex - fromIndex) * step;
      li.style.transition = 'transform .2s cubic-bezier(.2,.8,.2,1)';
      li.style.transform = `translateY(${finalDy}px) scale(1)`;   // мягко встаёт в слот
      li.classList.remove('dragging');
      window.setTimeout(() => {
        document.body.classList.remove('is-reordering');
        _ruleDragging = false;
        if (moved) commitRuleMove(fromIndex, toIndex);   // ре-рендер снимет все transform
        else { li.style.transform = ''; li.style.transition = ''; li.style.zIndex = ''; }
      }, moved ? 200 : 150);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

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
    if (r.type === 'service') {
      const p = SERVICE_PRESETS[r.value];
      return `<span class="app-row__initial" style="background:${colorFor(r.value)};font-size:14px">${p ? p.badge : '⭐'}</span>`;
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
      li.dataset.id = r.id;
      const subline = r.type === 'process'
        ? r.value
        : r.type === 'service'
          ? `Сервис · ${SERVICE_PRESETS[r.value]?.domains.length || 0} доменов`
          : `${typeLabel(r.type)} · ${r.value}`;
      li.innerHTML =
        `<span class="app-row__grip" title="Перетащите, чтобы изменить приоритет" aria-label="Перетащить">` +
          `<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">` +
          `<circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/>` +
          `<circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/>` +
          `<circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg>` +
        `</span>` +
        `<span class="app-row__icon">${iconHtml(r)}</span>` +
        `<div class="app-row__main"><b>${r.name || r.value}</b><small>${subline}</small></div>` +
        `<button class="app-row__rm" type="button" title="Убрать" aria-label="Убрать">&times;</button>` +
        `<input type="checkbox" ${r.on ? 'checked' : ''} hidden>` +
        `<span class="track"></span>`;
      const toggle = (ev) => {
        if (document.body.classList.contains('is-reordering')) return;   // клик после драга не переключает
        if (ev.target.closest('.app-row__rm') || ev.target.closest('.app-row__grip')) return;
        r.on = !r.on; li.querySelector('input').checked = r.on; saveRules();
        if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Применится после переподключения', false);
      };
      li.addEventListener('click', toggle);
      li.querySelector('.app-row__rm').addEventListener('click', (ev) => {
        ev.stopPropagation();
        RULES = RULES.filter(x => x.id !== r.id); saveRules(); renderApps();
        if ((connected || connecting) && vpnPrefs.route === 'apps') toast('Применится после переподключения', false);
      });
      // Тащим строку за «ручку» — плавный transform-драг (см. startRuleDrag).
      li.querySelector('.app-row__grip').addEventListener('pointerdown', (ev) => startRuleDrag(ev, li));
      el.appendChild(li);
    });
    const hint = $('#appOrderHint');
    if (hint) hint.hidden = RULES.length < 2;
    renderSvcPresets();
  }

  // Чипы быстрого добавления популярных сервисов (YouTube и т.п.).
  function renderSvcPresets() {
    const el = $('#svcPresets'); if (!el) return;
    el.innerHTML = '';
    Object.keys(SERVICE_PRESETS).forEach(key => {
      const p = SERVICE_PRESETS[key];
      const added = RULES.some(r => r.type === 'service' && r.value === key);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'svc-chip' + (added ? ' is-added' : '');
      chip.innerHTML = `<span>${p.badge}</span>${p.name}`;
      chip.title = p.domains.join(', ');
      chip.addEventListener('click', () => {
        if (RULES.some(r => r.type === 'service' && r.value === key)) { toast(p.name + ' уже в списке'); return; }
        addRule('service', key, p.name);
      });
      el.appendChild(chip);
    });
  }

  /* ---------- Профили раздельного туннеля (route + split + правила) ---------- */
  const PROFILES_KEY = 'cloudvpn.profiles.v1';
  let PROFILES = [];
  try { const p = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); if (Array.isArray(p)) PROFILES = p; } catch {}
  function saveProfiles() { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(PROFILES)); } catch {} }
  function currentAsProfile(name) {
    return { id: 'prof_' + Date.now().toString(36) + Math.floor(Math.random() * 1000), name,
             route: vpnPrefs.route, split: vpnPrefs.split,
             rules: RULES.map(r => ({ type: r.type, value: r.value, name: r.name, on: r.on })) };
  }
  function applyProfile(p) {
    vpnPrefs.route = p.route || 'all';
    vpnPrefs.split = p.split || 'include';
    savePrefs();
    RULES = (p.rules || []).map(r => ({ ...r, id: 'rule_' + Date.now().toString(36) + Math.floor(Math.random() * 1000) }));
    saveRules();
    $$('.seg--route button').forEach(b => b.classList.toggle('is-active', b.dataset.route === vpnPrefs.route));
    $$('.seg--split button').forEach(b => b.classList.toggle('is-active', b.dataset.split === vpnPrefs.split));
    $('#appRoutes').hidden = vpnPrefs.route !== 'apps';
    refreshRouteHint(); renderApps(); renderProfiles();
    toast((connected || connecting) ? `Профиль «${p.name}» — применится после переподключения` : `Профиль «${p.name}» применён`);
  }
  function renderProfiles() {
    const el = $('#profileBar'); if (!el) return;
    el.innerHTML = '';
    // Профили привязаны к режиму сплита: набор правил означает ПРОТИВОПОЛОЖНОЕ в
    // «только выбранные» (→ в VPN) и «все, кроме выбранных» (→ в DIRECT). Поэтому
    // показываем только профили текущего режима, чтобы случайно не применить
    // «исключающий» профиль во «включающем» режиме (и наоборот).
    const mode = vpnPrefs.split || 'include';
    PROFILES.filter(p => (p.split || 'include') === mode).forEach(p => {
      const chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'svc-chip'; chip.title = 'Применить профиль';
      chip.innerHTML = `<span>💾</span>${p.name}`;
      chip.addEventListener('click', () => applyProfile(p));
      const x = document.createElement('span'); x.className = 'prof-x'; x.textContent = '×'; x.title = 'Удалить профиль';
      x.addEventListener('click', ev => { ev.stopPropagation(); PROFILES = PROFILES.filter(q => q.id !== p.id); saveProfiles(); renderProfiles(); });
      chip.appendChild(x);
      el.appendChild(chip);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'svc-chip prof-add';
    add.innerHTML = '<span>+</span>Сохранить профиль';
    add.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.className = 'prof-input'; inp.placeholder = 'Название профиля'; inp.maxLength = 24;
      add.replaceWith(inp); inp.focus();
      let committed = false;
      const commit = () => {
        if (committed) return; committed = true;
        const name = inp.value.trim();
        if (name) { PROFILES.push(currentAsProfile(name)); saveProfiles(); toast('Профиль сохранён'); }
        renderProfiles();
      };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { committed = true; renderProfiles(); } });
      inp.addEventListener('blur', commit);
    });
    el.appendChild(add);
  }

  function addRule(type, value, name) {
    type = (type || '').toLowerCase();
    value = (value || '').trim();
    if (!value) { toast('Пустое значение', true); return false; }
    // «youtube» без точки — это не домен, а намерение «пусти YouTube»: разворачиваем
    // в готовый сервис-пресет (страница + видео-CDN googlevideo.com и т.п.).
    if ((type === 'domain-suffix' || type === 'domain-keyword') && !value.includes('.')
        && SERVICE_PRESETS[value.toLowerCase()]) {
      const key = value.toLowerCase();
      type = 'service'; value = key; name = SERVICE_PRESETS[key].name;
    }
    const def = RULE_TYPES[type];
    if (!def) { toast('Неизвестный тип правила', true); return false; }
    if (type === 'process' && !/\.exe$/i.test(value)) value = value + '.exe';
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
  const SPLIT_HINT = () => vpnPrefs.split === 'exclude'
    ? 'Через VPN идёт весь трафик, КРОМЕ выбранных приложений. Игры/голос оставляйте здесь — у них останется обычный пинг.'
    : 'Через VPN пойдёт трафик только выбранных приложений (mihomo process-name).';
  function refreshRouteHint() {
    $('#modeHint').textContent = vpnPrefs.route === 'apps' ? SPLIT_HINT() : TUN_HINT;
  }
  $$('.seg--route button').forEach(b => b.addEventListener('click', () => {
    $$('.seg--route button').forEach(x => x.classList.remove('is-active')); b.classList.add('is-active');
    const apps = b.dataset.route === 'apps';
    vpnPrefs.route = apps ? 'apps' : 'all'; savePrefs();
    if (connected || connecting) toast('Применится после переподключения', false);
    $('#appRoutes').hidden = !apps;
    refreshRouteHint();
    toast(apps ? 'Маршрутизация: по приложениям' : 'Маршрутизация: весь ПК');
  }));
  // Направление сплита: только выбранные → VPN, либо всё кроме выбранных → VPN.
  $$('.seg--split button').forEach(b => b.addEventListener('click', () => {
    $$('.seg--split button').forEach(x => x.classList.remove('is-active')); b.classList.add('is-active');
    vpnPrefs.split = b.dataset.split === 'exclude' ? 'exclude' : 'include'; savePrefs();
    if (connected || connecting) toast('Применится после переподключения', false);
    refreshRouteHint();
    renderProfiles();   // профили свои для каждого режима — обновляем список чипов
    toast(vpnPrefs.split === 'exclude' ? 'Через VPN: всё, кроме выбранных' : 'Через VPN: только выбранные');
  }));
  // На загрузке — синхронизировать переключатели с восстановленными prefs.
  $$('.seg--route button').forEach(b => b.classList.toggle('is-active', b.dataset.route === vpnPrefs.route));
  $$('.seg--split button').forEach(b => b.classList.toggle('is-active', b.dataset.split === vpnPrefs.split));
  $('#appRoutes').hidden = vpnPrefs.route !== 'apps';
  refreshRouteHint(); renderProfiles();
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
      valueHelp.textContent = `Mihomo: ${def.emit(def.placeholder, 'GLOBAL').split('\n')[0]}`;
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
    const v = await promptModal('Имя процесса', { placeholder: 'например, brave.exe' });
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
    let userUpdCheck = false;   // true, когда проверку запустил сам юзер кнопкой
    const checkBtn = $('#checkUpdBtn');
    const setCheckBusy = b => { if (checkBtn) { checkBtn.disabled = b; checkBtn.classList.toggle('is-busy', b); } };
    if (checkBtn) checkBtn.addEventListener('click', () => {
      userUpdCheck = true; setCheckBusy(true); toast('Проверяю обновления…');
      window.API.updateCheck();
      // страховка, если ответа не будет (нет сети и т.п.)
      setTimeout(() => { if (userUpdCheck) { userUpdCheck = false; setCheckBusy(false); } }, 10000);
    });
    window.API.onUpdate(ev => {
      // Любой финальный ответ снимает «занятость» с кнопки проверки.
      if (ev.type !== 'progress' && ev.type !== 'installing') setCheckBusy(false);
      if (ev.type === 'available') {
        updating = false;
        const v = ev.info?.version || '';
        // Для инкрементального апдейта качается маленькая дельта — полный размер
        // не показываем, чтобы не пугать.
        const tail = ev.info?.incremental ? ' · инкрементально'
          : (ev.info?.size ? ' · ' + fmtSize(ev.info.size) : '');
        $('#updText').innerHTML = `Доступно обновление <b>${v}</b>${tail}`;
        updBar.title = (ev.info?.notes || '').trim();   // «что нового» — по наведению
        $('#updProgWrap').hidden = true; $('#updProg').style.width = '0';
        $('#updNow').disabled = false; $('#updNow').textContent = 'Обновить';
        showUpd();
      } else if (ev.type === 'ready') {
        // Обновление уже скачано и проверено в фоне — установка мгновенная.
        updating = false;
        const v = ev.info?.version || '';
        $('#updText').innerHTML = `Обновление <b>${v}</b> готово`;
        updBar.title = (ev.info?.notes || '').trim();
        $('#updProgWrap').hidden = true; $('#updProg').style.width = '0';
        $('#updNow').disabled = false; $('#updNow').textContent = 'Перезапустить';
        showUpd();
      } else if (ev.type === 'progress') {
        $('#updProgWrap').hidden = false; $('#updProg').style.width = (ev.percent || 0) + '%';
        $('#updText').innerHTML = `Загрузка обновления… <b>${ev.percent || 0}%</b>`;
      } else if (ev.type === 'installing') {
        $('#updText').textContent = 'Устанавливаю и перезапускаю…';
        $('#updNow').disabled = true;
      } else if (ev.type === 'error') {
        updating = false; userUpdCheck = false;
        $('#updNow').disabled = false; $('#updNow').textContent = 'Повторить';
        toast('Не удалось обновить: ' + (ev.message || ''), true);
      } else if (ev.type === 'none') {
        // Тихую проверку на старте не озвучиваем; ручную — подтверждаем.
        if (userUpdCheck) toast('У вас последняя версия ✓');
        userUpdCheck = false;
      }
      if (ev.type === 'available' || ev.type === 'ready') userUpdCheck = false;
    });
    $('#updNow').addEventListener('click', () => {
      if (updating) return; updating = true;
      $('#updNow').disabled = true; $('#updProgWrap').hidden = false;
      window.API.updateInstall();
    });
    $('#updLater').addEventListener('click', hideUpd);
  }

  /* ============================================================ ДИАГНОСТИКА (спидтест + утечки) ============================================================ */
  const speedBtn = $('#speedTestBtn'), speedRes = $('#speedRes');
  // Замер загрузки за фиксированное окно времени: читаем поток до N секунд и
  // считаем принятые байты, потом обрываем. Так тест ограничен ~10с и не «висит»
  // 5 минут, если эндпоинт через туннель медленный.
  async function measureDownload(seconds) {
    const ctrl = new AbortController();
    const hardTo = setTimeout(() => ctrl.abort(), seconds * 1000 + 3000);
    try {
      const t0 = performance.now();
      const r = await fetch(`https://speed.cloudflare.com/__down?bytes=300000000&r=${Math.random().toString(36).slice(2)}`, { cache: 'no-store', signal: ctrl.signal });
      if (!r.body) { const b = await r.arrayBuffer(); const s = (performance.now() - t0) / 1000; clearTimeout(hardTo); return s > 0 ? (b.byteLength * 8 / 1e6) / s : null; }
      const reader = r.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (performance.now() - t0 > seconds * 1000) { try { ctrl.abort(); } catch {} break; }
      }
      const secs = (performance.now() - t0) / 1000;
      clearTimeout(hardTo);
      return secs > 0 && bytes > 0 ? (bytes * 8 / 1e6) / secs : null;
    } catch { clearTimeout(hardTo); return null; }
  }
  async function measureUpload() {
    const ctrl = new AbortController();
    const hardTo = setTimeout(() => ctrl.abort(), 15000);
    try {
      const payload = new Uint8Array(8000000), t0 = performance.now();
      await fetch('https://speed.cloudflare.com/__up', { method: 'POST', body: payload, cache: 'no-store', signal: ctrl.signal });
      const secs = (performance.now() - t0) / 1000;
      clearTimeout(hardTo);
      return secs > 0 ? (payload.byteLength * 8 / 1e6) / secs : null;
    } catch { clearTimeout(hardTo); return null; }
  }
  if (speedBtn) speedBtn.addEventListener('click', async () => {
    speedBtn.classList.add('is-busy'); speedRes.hidden = false; speedRes.classList.remove('leak');
    let ping = null, down = null, up = null;
    try { const s = activeServer(); if (s && s.host) ping = await pingServerHost(s.host, s.port); } catch {}
    speedRes.textContent = 'Измеряю загрузку…';
    down = await measureDownload(8);
    speedRes.textContent = 'Измеряю отдачу…';
    up = await measureUpload();
    const parts = [];
    if (down != null) parts.push(`Загрузка: <b>${down.toFixed(1)} Мбит/с</b>`);
    if (up != null) parts.push(`Отдача: <b>${up.toFixed(1)} Мбит/с</b>`);
    if (ping != null) parts.push(`Пинг: <b>${ping} мс</b>`);
    speedRes.innerHTML = parts.length ? parts.join(' · ') : 'Не удалось измерить (сервис недоступен через туннель?)';
    if (!connected) speedRes.innerHTML += '<br><small>VPN выключен — это скорость без туннеля</small>';
    speedBtn.classList.remove('is-busy');
  });

  const collectBtn = $('#collectLogsBtn');
  if (collectBtn) collectBtn.addEventListener('click', () => {
    try { window.API.collectLogs && window.API.collectLogs(); } catch {}
    toast('Собираю логи — сейчас откроется папка на Рабочем столе');
  });

  const leakBtn = $('#leakTestBtn'), leakRes = $('#leakRes');
  const isPublicIp = ip => ip && ip.indexOf(':') < 0
    && !/^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|198\.1[89]\.|0\.)/.test(ip);
  function webrtcIps() {
    return new Promise(resolve => {
      let pc; const ips = new Set();
      try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); }
      catch { resolve([]); return; }
      let done = false; const finish = () => { if (done) return; done = true; try { pc.close(); } catch {} resolve([...ips]); };
      try { pc.createDataChannel('x'); } catch {}
      pc.onicecandidate = e => {
        if (!e.candidate) return finish();
        const m = /((?:\d{1,3}\.){3}\d{1,3})/.exec(e.candidate.candidate || '');
        if (m) ips.add(m[1]);
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(finish);
      setTimeout(finish, 3500);
    });
  }
  if (leakBtn) leakBtn.addEventListener('click', async () => {
    leakBtn.classList.add('is-busy'); leakRes.hidden = false; leakRes.classList.remove('leak');
    leakRes.textContent = 'Проверяю утечки…';
    let extIp = null, extInfo = '';
    try {
      const j = await (await fetch('https://ipwho.is/', { cache: 'no-store' })).json();
      if (j && j.ip) { extIp = j.ip; extInfo = [j.country, j.connection && j.connection.isp].filter(Boolean).join(' · '); }
    } catch {}
    let rtc = []; try { rtc = await webrtcIps(); } catch {}
    const leaks = rtc.filter(ip => isPublicIp(ip) && ip !== extIp);
    const lines = [];
    lines.push(extIp ? `Внешний IP: <b>${extIp}</b>${extInfo ? ' · ' + extInfo : ''}` : 'Внешний IP: не определён');
    lines.push(connected ? 'Трафик идёт через VPN ✓' : 'VPN выключен — проверка вне туннеля');
    if (leaks.length) { leakRes.classList.add('leak'); lines.push(`⚠️ WebRTC раскрывает IP: <b>${leaks.join(', ')}</b>`); }
    else lines.push('WebRTC не раскрывает реальный IP ✓');
    leakRes.innerHTML = lines.join('<br>');
    leakBtn.classList.remove('is-busy');
  });

  /* ============================================================ СОЕДИНЕНИЯ ============================================================ */
  let connTimer = null, connFilterVal = 'all', lastConns = null;
  const fmtBytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' ГБ'
    : n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ'
    : n >= 1024 ? Math.round(n / 1024) + ' КБ' : (n || 0) + ' Б';
  function startConnPoll() {
    stopConnPoll();
    if (!window.API.getConnections) return;
    window.API.getConnections();
    connTimer = setInterval(() => window.API.getConnections(), 1500);
  }
  function stopConnPoll() { if (connTimer) { clearInterval(connTimer); connTimer = null; } }
  function renderConns(data) {
    const list = $('#connList'), empty = $('#connEmpty'), totals = $('#connTotals');
    if (!list) return;
    const conns = (data && data.conns) || [];
    if (totals) totals.innerHTML = data ? `↓ ${fmtBytes(data.down)} · ↑ ${fmtBytes(data.up)} · соединений: <b>${conns.length}</b>` : '';
    const filtered = conns.filter(c => connFilterVal === 'all' ? true : connFilterVal === 'vpn' ? !c.direct : c.direct);
    filtered.sort((a, b) => (b.down + b.up) - (a.down + a.up));   // тяжёлые сверху
    if (!filtered.length) {
      list.innerHTML = '';
      empty.hidden = false;
      empty.textContent = conns.length ? 'Нет соединений в этой категории.'
        : (connected ? 'Пока нет активных соединений.' : 'Нет активных соединений. Подключите VPN — здесь появятся запросы приложений.');
      return;
    }
    empty.hidden = true;
    list.innerHTML = filtered.slice(0, 200).map(c => {
      const dest = (c.host || c.ip || '—') + (c.port ? ':' + c.port : '');
      const proc = c.proc ? c.proc.replace(/\.exe$/i, '') : '';
      const badge = c.direct ? '<span class="conn-b conn-b--direct">напрямую</span>'
                             : '<span class="conn-b conn-b--vpn">через VPN</span>';
      const meta = [c.type || c.net, proc].filter(Boolean).join(' · ');
      return `<li class="conn-row">
        <div class="conn-row__main"><b title="${esc(dest)}">${esc(dest)}</b><small>${esc(meta)}</small></div>
        ${badge}
        <div class="conn-row__io">↓ ${fmtBytes(c.down)}<br>↑ ${fmtBytes(c.up)}</div>
      </li>`;
    }).join('');
  }
  $$('.seg--connfilter button').forEach(b => b.addEventListener('click', () => {
    $$('.seg--connfilter button').forEach(x => x.classList.remove('is-active')); b.classList.add('is-active');
    connFilterVal = b.dataset.cf; renderConns(lastConns);
  }));
  if (window.API.onConnData) window.API.onConnData(data => { lastConns = data; renderConns(data); });

  /* ============================================================ СТАРТ ============================================================ */
  applyHoliday(); setTheme(localStorage.getItem('cloudvpn.theme') || 'light'); renderServers(); loadImported(); setState('off');
  const existing = window.API.getSession();
  if (existing) enterApp(existing); else { authView.style.display = 'grid'; showStep('choose'); setTimeout(greetHoliday, 1400); }
})();
