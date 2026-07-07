/* ============================================================
   CloudVPN – осадки на весь экран: дождь и снег
   window.Sky.set('rain' | 'snow' | 'none')
   ============================================================ */
window.Sky = (() => {
  let cv, ctx, raf = 0, running = false, last = 0, mode = 'none';
  let W = 0, H = 0, dpr = 1;
  let streaks = [], drops = [], trails = [], flakes = [];
  const rnd = (a, b) => a + Math.random() * (b - a);

  function resize() {
    if (!cv) return;
    const host = cv.parentElement || cv;      // размер берём от карточки-родителя
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;                      // ещё не разложено
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = w; H = h;
    cv.width = Math.max(1, W * dpr); cv.height = Math.max(1, H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- ДОЖДЬ ---------- */
  const newStreak = spread => ({
    x: rnd(0, W), y: spread ? rnd(-H, H) : rnd(-40, -10),
    len: rnd(11, 30), sp: rnd(560, 1050), a: rnd(.14, .34), w: rnd(.8, 1.8),
  });
  const newDrop = () => ({
    x: rnd(0, W), y: rnd(-H, -6), r: rnd(2.6, 7.5), vy: 0,
    slide: rnd(.55, 1.15), wob: rnd(0, Math.PI * 2), stuck: rnd(0, 70),
  });
  function buildRain() {
    streaks = Array.from({ length: Math.max(70, Math.round(W / 4.5)) }, () => newStreak(true));
    drops = Array.from({ length: Math.max(32, Math.round(W / 11)) }, () => newDrop());
    trails = [];
  }
  function drawDrop(d) {
    const g = ctx.createRadialGradient(d.x - d.r * .3, d.y - d.r * .4, d.r * .1, d.x, d.y, d.r);
    g.addColorStop(0, 'rgba(230,240,255,.72)');
    g.addColorStop(.35, 'rgba(150,190,255,.36)');
    g.addColorStop(1, 'rgba(90,135,225,.08)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(150,185,255,.3)'; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(d.x - d.r * .35, d.y - d.r * .42, d.r * .24, 0, 7); ctx.fill();
  }
  function frameRain(dt) {
    ctx.lineCap = 'round';
    for (const s of streaks) {
      s.y += s.sp * dt;
      ctx.strokeStyle = `rgba(175,205,255,${s.a})`; ctx.lineWidth = s.w;
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - 2, s.y - s.len); ctx.stroke();
      if (s.y - s.len > H) Object.assign(s, newStreak(false));
    }
    for (let i = trails.length - 1; i >= 0; i--) {
      const p = trails[i]; p.a *= .955;
      if (p.a < .02) { trails.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(185,208,255,${p.a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
    }
    for (const d of drops) {
      if (d.stuck > 0) d.stuck -= dt * 60;
      else {
        d.vy += 240 * dt * d.slide; d.wob += dt * 6; d.x += Math.sin(d.wob) * .35; d.y += d.vy * dt;
        if (Math.random() < .16 && d.r > 2.6) { trails.push({ x: d.x, y: d.y, r: d.r * .42, a: .26 }); d.r *= .99; }
      }
      drawDrop(d);
      if (d.y - d.r > H) Object.assign(d, newDrop());
    }
  }

  /* ---------- СНЕГ ---------- */
  const newFlake = spread => ({
    x: rnd(0, W), y: spread ? rnd(-H, H) : rnd(-20, -4),
    r: rnd(2, 6), sp: rnd(26, 72), sway: rnd(8, 26), ph: rnd(0, Math.PI * 2), a: rnd(.65, 1),
  });
  function buildSnow() {
    flakes = Array.from({ length: Math.max(60, Math.round(W / 5)) }, () => newFlake(true));
  }
  function frameSnow(dt, t) {
    // голубоватые снежинки видны и на светлом, и на тёмном фоне
    ctx.shadowColor = 'rgba(120,150,220,.6)'; ctx.shadowBlur = 5;
    for (const f of flakes) {
      f.y += f.sp * dt; f.x += Math.sin(f.ph + t * .0009) * f.sway * dt;
      ctx.globalAlpha = f.a; ctx.fillStyle = '#aec6f0';
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill();
      ctx.globalAlpha = f.a * .9; ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(f.x - f.r * .3, f.y - f.r * .3, f.r * .45, 0, 7); ctx.fill();
      if (f.y - f.r > H) { f.y = -4; f.x = rnd(0, W); }
      if (f.x < -10) f.x = W + 8; else if (f.x > W + 10) f.x = -8;
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  function frame(t) {
    if (!running) return;
    // карточка могла получить/сменить размер уже после старта — подстраиваемся
    const host = cv.parentElement || cv;
    if (host.clientWidth && (Math.abs(host.clientWidth - W) > 2 || Math.abs(host.clientHeight - H) > 2)) {
      resize(); mode === 'snow' ? buildSnow() : buildRain();
    }
    const dt = Math.min(.05, (t - last) / 1000 || 0); last = t;
    ctx.clearRect(0, 0, W, H);
    if (mode === 'rain') frameRain(dt);
    else if (mode === 'snow') frameSnow(dt, t);
    raf = requestAnimationFrame(frame);
  }

  function set(m) {
    cv = cv || document.getElementById('rainCanvas');
    if (!cv) return;
    ctx = ctx || cv.getContext('2d');
    if (m === mode && running) return;
    mode = m;
    if (m === 'none') { stop(); return; }
    resize();
    m === 'snow' ? buildSnow() : buildRain();
    cv.classList.add('on');
    if (!running) { running = true; last = performance.now(); window.addEventListener('resize', onResize); raf = requestAnimationFrame(frame); }
  }
  function onResize() { resize(); mode === 'snow' ? buildSnow() : buildRain(); }
  function stop() {
    running = false; mode = 'none';
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    if (cv) { cv.classList.remove('on'); ctx && ctx.clearRect(0, 0, W, H); }
  }

  /* ---------- ФЕЙЕРВЕРК (Новый год) ---------- */
  let fcv, fctx, fraf = 0, frun = false, flast = 0, fW = 0, fH = 0, fdpr = 1, fspawn = 0, sparks = [];
  const FCOL = ['255,90,110', '120,170,255', '120,230,160', '255,210,90', '200,140,255', '255,255,255'];
  function fresize() { fdpr = Math.min(2, window.devicePixelRatio || 1); fW = fcv.clientWidth; fH = fcv.clientHeight; fcv.width = Math.max(1, fW * fdpr); fcv.height = Math.max(1, fH * fdpr); fctx.setTransform(fdpr, 0, 0, fdpr, 0, 0); }
  function burst() {
    const x = rnd(fW * .12, fW * .88), y = rnd(fH * .08, fH * .44), col = FCOL[(Math.random() * FCOL.length) | 0];
    const n = 46 + ((Math.random() * 42) | 0);
    for (let i = 0; i < n; i++) { const a = (Math.PI * 2 * i) / n + rnd(-.06, .06), v = rnd(70, 230); sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(.9, 1.5), col, r: rnd(1.4, 2.7) }); }
  }
  function fframe(t) {
    if (!frun) return;
    const dt = Math.min(.05, (t - flast) / 1000 || 0); flast = t;
    fctx.clearRect(0, 0, fW, fH);
    fctx.globalCompositeOperation = 'lighter';
    fspawn -= dt; if (fspawn <= 0) { burst(); fspawn = rnd(.7, 1.9); }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.vy += 120 * dt; p.vx *= .986; p.vy *= .986; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * .6;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      fctx.fillStyle = `rgba(${p.col},${Math.max(0, p.life)})`;
      fctx.beginPath(); fctx.arc(p.x, p.y, p.r, 0, 7); fctx.fill();
    }
    fctx.globalCompositeOperation = 'source-over';
    fraf = requestAnimationFrame(fframe);
  }
  function fireworks(on) {
    fcv = fcv || document.getElementById('fxCanvas'); if (!fcv) return;
    fctx = fctx || fcv.getContext('2d');
    if (on) { if (frun) return; fresize(); fcv.classList.add('on'); frun = true; flast = performance.now(); fspawn = .3; window.addEventListener('resize', fresize); fraf = requestAnimationFrame(fframe); }
    else { frun = false; if (fraf) cancelAnimationFrame(fraf); window.removeEventListener('resize', fresize); if (fcv) { fcv.classList.remove('on'); fctx && fctx.clearRect(0, 0, fW, fH); } sparks = []; }
  }

  return { set, stop, fireworks };
})();
/* совместимость со старым именем */
window.Rain = { start: () => window.Sky.set('rain'), stop: () => window.Sky.set('none') };
