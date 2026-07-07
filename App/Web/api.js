/* ============================================================
   CloudVPN – сервис-слой (auth / подписка / оплаты)
   Сейчас работает в DEMO-режиме (mock) полностью на клиенте.
   Когда в config.js задан apiBase – методы ходят на реальный
   бэкенд. Это единственное место, где нужно менять интеграцию.
   ============================================================ */
window.API = (() => {
  const cfg = window.CLOUDVPN_CONFIG;
  const LIVE = !!cfg.apiBase;
  const KEY = "cloudvpn.session";
  const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();
  const plus = (months) => { const d = new Date(); d.setMonth(d.getMonth() + months); return d.getTime(); };
  const plusDays = (days) => now() + days * 864e5;

  /* ---------- Сессия ---------- */
  function getSession() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      // В LIVE-режиме игнорируем старые demo-сессии (фейковый «@durov»),
      // оставшиеся в localStorage от тестов без сервера — иначе приложение
      // автоматически входит заглушкой.
      if (s && LIVE && typeof s.token === "string" && s.token.startsWith("demo")) {
        localStorage.removeItem(KEY);
        return null;
      }
      return s;
    } catch { return null; }
  }
  function setSession(s) {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
    return s;
  }
  function clearSession() { setSession(null); }

  /* ---------- HTTP (для реального бэкенда) ---------- */
  async function http(path, body, method = "POST") {
    const s = getSession();
    const res = await fetch(cfg.apiBase + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(s?.token ? { Authorization: "Bearer " + s.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /* ---------- Открыть внешнюю ссылку (через нативный мост) ---------- */
  function openExternal(url) {
    if (host) host.postMessage("open:" + url);
    else window.open(url, "_blank");
  }

  /* ============================================================
     VPN-ЯДРО (нативный мост к Mihomo в C#)
     JS просит подключиться по vless://-ссылке; C# поднимает TUN
     и шлёт обратно статус-сообщения "vpn:{...}". Без нативного
     моста (обычный браузер) hasNativeVpn = false.
     ============================================================ */
  const hasNativeVpn = !!host;
  const vpnListeners = [];
  const subListeners = [];
  if (host) host.addEventListener("message", (e) => {
    const d = e.data;
    if (typeof d !== "string") return;
    if (d.startsWith("vpn:")) {
      let obj; try { obj = JSON.parse(d.slice(4)); } catch { return; }
      vpnListeners.forEach(fn => { try { fn(obj); } catch {} });
    } else if (d.startsWith("sub:")) {
      let obj; try { obj = JSON.parse(d.slice(4)); } catch { return; }
      subListeners.forEach(fn => { try { fn(obj); } catch {} });
    }
  });
  function onVpn(fn) { vpnListeners.push(fn); }
  function onSub(fn) { subListeners.push(fn); }
  // opts: { vless, mode: "tun"|"proxy", route: "all"|"apps", apps: ["chrome.exe", ...] }
  function vpnConnect(optsOrVless) {
    if (!host) return;
    const opts = typeof optsOrVless === "string"
      ? { vless: optsOrVless, mode: "tun", route: "all", apps: [] }
      : { mode: "tun", route: "all", apps: [], ...optsOrVless };
    host.postMessage("vpn:connect:" + JSON.stringify(opts));
  }
  function vpnDisconnect() { if (host) host.postMessage("vpn:disconnect"); }
  // input — одиночный vless:// или http(s) subscription-URL; результат придёт в onSub
  function importSubscription(input) { if (host) host.postMessage("vpn:sub:" + input); }
  function openLog() { if (host) host.postMessage("log:open"); }
  // Список запущенных приложений (с видимым окном). Ответ придёт в onAppsList.
  const appsListListeners = [];
  function onAppsList(fn) { appsListListeners.push(fn); }
  function requestAppsList() { if (host) host.postMessage("apps:list"); }
  // Запросить хвост лога; ответ придёт в onLogTail
  const logTailListeners = [];
  function onLogTail(fn) { logTailListeners.push(fn); }
  const updateListeners = [];
  function onUpdate(fn) { updateListeners.push(fn); }
  function updateCheck() { if (host) host.postMessage("update:check"); }
  function updateInstall() { if (host) host.postMessage("update:install"); }
  function emitUpdate(ev) { updateListeners.forEach(fn => { try { fn(ev); } catch {} }); }

  // Нативный ICMP-пинг (только в десктоп-приложении). Возвращает мс или null.
  const pongWaiters = new Map();   // id → resolve
  let pingSeq = 0;
  function nativePing(host_, timeout = 3500) {
    if (!host) return Promise.resolve(null);
    return new Promise(resolve => {
      const id = "p" + (++pingSeq);
      const tm = setTimeout(() => { if (pongWaiters.delete(id)) resolve(null); }, timeout);
      pongWaiters.set(id, ms => { clearTimeout(tm); resolve(ms); });
      host.postMessage(`ping:${id}:${host_}`);
    });
  }

  if (host) host.addEventListener("message", (e) => {
    const d = e.data;
    if (typeof d !== "string") return;
    if (d.startsWith("log:tail:")) {
      try { const j = JSON.parse(d.slice(9)); logTailListeners.forEach(fn => { try { fn(j.tail); } catch {} }); }
      catch {}
    } else if (d.startsWith("apps:list:")) {
      try { const arr = JSON.parse(d.slice(10)); appsListListeners.forEach(fn => { try { fn(arr); } catch {} }); }
      catch {}
    } else if (d.startsWith("pong:")) {
      // pong:<id>:<ms>  (-1 = ICMP не прошёл)
      const parts = d.split(":");
      const id = parts[1], ms = parseInt(parts[2], 10);
      const w = pongWaiters.get(id);
      if (w) { pongWaiters.delete(id); w(Number.isFinite(ms) && ms >= 0 ? ms : null); }
    } else if (d.startsWith("update:")) {
      // update:available:<json> | update:progress:<n> | update:installing | update:none | update:error:<msg>
      const rest = d.slice(7);
      if (rest.startsWith("available:")) {
        let info = null; try { info = JSON.parse(rest.slice(10)); } catch {}
        emitUpdate({ type: "available", info });
      } else if (rest.startsWith("progress:")) {
        emitUpdate({ type: "progress", percent: parseInt(rest.slice(9), 10) || 0 });
      } else if (rest === "installing") {
        emitUpdate({ type: "installing" });
      } else if (rest === "none") {
        emitUpdate({ type: "none" });
      } else if (rest.startsWith("error:")) {
        emitUpdate({ type: "error", message: rest.slice(6) });
      }
    }
  });
  function requestLogTail() { if (host) host.postMessage("log:tail"); }

  /* ============================================================
     AUTH – Telegram
     ============================================================ */
  // Шаг 1: получить диплинк для входа через бота
  async function tgStart() {
    if (LIVE) {
      const r = await http("/api/auth/telegram/start");
      // central api возвращает {token, link, bot}. Префиксуем токен app_, чтобы
      // главный бот узнал, что это deeplink десктоп-клиента / сайта.
      const token = r.token && !r.token.startsWith("app_") ? "app_" + r.token : r.token;
      const link = `https://t.me/${r.bot || cfg.telegram.botUsername}?start=${token}`;
      return { token, link };
    }
    // demo: генерируем токен входа
    const token = "app_" + Math.random().toString(36).slice(2, 10);
    const link = `https://t.me/${cfg.telegram.botUsername}?start=${token}`;
    return { token, link };
  }
  // Шаг 2: открыть Telegram
  function tgOpen(link) { openExternal(link); }
  // Шаг 3: опрос статуса входа (пользователь нажал Start у бота)
  async function tgPoll(token) {
    if (LIVE) {
      // central api ждёт RAW токен (без app_)
      const raw = token.startsWith("app_") ? token.slice(4) : token;
      const r = await http("/api/auth/telegram/poll?token=" + encodeURIComponent(raw), null, "GET");
      if (r.status === "ok" && r.user) {
        const handle = r.user.telegramUsername ? "@" + r.user.telegramUsername : (r.user.email || "Telegram");
        const session = sessionFromApi(r, "telegram", "Telegram", handle);
        setSession(session);
        return { status: "ok", session };
      }
      return r;
    }
    // demo: считаем, что подтверждение придёт; см. tgConfirmDemo()
    return { status: "pending" };
  }
  // Email-code login (альтернатива Telegram-диплинку, не требует пароля)
  async function emailRequestCode(email) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("bad-email");
    if (LIVE) {
      return http("/api/auth/email/request_code", { email });
    }
    await sleep(400);
    return { ok: true };
  }
  async function emailLoginWithCode(email, code) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("bad-email");
    if (!/^\d{4,8}$/.test(String(code).trim())) throw new Error("bad-code");
    if (LIVE) {
      const r = await http("/api/auth/email/login_with_code", { email, code: String(code).trim() });
      if (r.ok && r.user) {
        const session = {
          token: "cookie", method: "email-code",
          user: { name: r.user.name, handle: email, via: "Email-код" },
          subscription: r.subscription || { plan: "Trial", status: "trial", expires: Date.now() + cfg.trialDays * 864e5 },
          token: r.token,
        };
        return setSession(session);
      }
      throw new Error("bad-code");
    }
    // demo: код "0000" принимаем за валидный
    if (String(code).trim() !== "0000") throw new Error("bad-code");
    return setSession({
      token: "demo-code", method: "email-code",
      user: { name: email.split("@")[0], handle: email, via: "Email-код" },
      subscription: { plan: "Trial", status: "trial", expires: plus(7) },
    });
  }

  // demo-хелпер: имитируем, что пользователь подтвердил в Telegram
  async function tgConfirmDemo() {
    await sleep(400);
    const session = {
      token: "demo-tg-token",
      method: "telegram",
      user: { name: "Пользователь", handle: "@durov", via: "Telegram" },
      // через TG подписка подтянулась автоматически
      subscription: { plan: "Premium", status: "active", expires: plus(6), source: "telegram" },
    };
    return setSession(session);
  }

  /* ============================================================
     AUTH – Email + password
     Пара e-mail/пароль заводится пользователем в Telegram-боте
     (меню → «Почта для входа»). Здесь — только вход по ней.
     ============================================================ */
  // Build a session object out of an api response. The central api returns
  // {user, token, subscription, ...}; we mirror it into the shape the rest of
  // the desktop UI expects (handle = email or @tg, via = display label).
  function sessionFromApi(data, method, viaLabel, handle) {
    const sub = data.subscription || {};
    return {
      token: data.token,           // JWT, sent as Authorization: Bearer …
      method,
      user: { name: data.user?.name || handle, handle, via: viaLabel, avatar: data.user?.avatar || null },
      subscription: sub.status ? {
        plan: sub.plan === "premium" ? "Premium" : sub.plan === "trial" ? "Trial" : "Free",
        status: sub.status,
        expires: sub.expires || (sub.expiresAt ? new Date(sub.expiresAt).getTime() : null),
        url: sub.url || null,      // Remnawave-issued https://sub.cloude.tech/<short>
        source: method,
      } : { plan: "Trial", status: "trial", expires: plusDays(cfg.trialDays), source: method },
      balance: data.balance || null,
    };
  }

  // Освежить сессию из /api/auth/me по сохранённому Bearer-токену. Нужно чтобы
  // подхватить только что выданную подписку (sub_url) без релогина.
  async function refreshSession() {
    const s = getSession();
    if (!s || !s.token || !LIVE || String(s.token).startsWith("demo")) return s;
    try {
      const r = await http("/api/auth/me", null, "GET");   // http шлёт Bearer из сессии
      if (r && r.user) {
        const handle = s.user?.handle
          || (r.user.telegramUsername ? "@" + r.user.telegramUsername : (r.user.email || ""));
        const ns = sessionFromApi({ ...r, token: s.token }, s.method || "email", s.user?.via || "Email", handle);
        return setSession(ns);
      }
    } catch { /* офлайн / 401 — оставляем что есть */ }
    return s;
  }

  async function emailLogin(email, password) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("bad-email");
    if (!password) throw new Error("bad-password");
    if (LIVE) {
      const r = await fetch(cfg.apiBase + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (r.status === 401) throw new Error("HTTP 401");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      return setSession(sessionFromApi(data, "email", "Email", email));
    }
    await sleep(500);
    return setSession({
      token: "demo-email-token",
      method: "email",
      user: { name: email.split("@")[0], handle: email, via: "Email" },
      subscription: { plan: "Trial", status: "trial", expires: plusDays(cfg.trialDays), source: "email" },
    });
  }

  /* ============================================================
     ПОДПИСКА
     ============================================================ */
  async function getSubscription() {
    if (LIVE) return http("/api/subscription", null, "GET");
    return getSession()?.subscription || null;
  }

  // vless-конфиг рабочего VPN-сервера для подписчиков (LIVE-бэкенд)
  async function getVpnConfig() {
    if (LIVE) { try { return await http("/api/vpn/config", null, "GET"); } catch { return null; } }
    return null;
  }

  // Устройства (Remnawave HWID): список + отвязка. Покупка слотов — в боте.
  async function getDevices() {
    if (LIVE) { try { return await http("/api/devices", null, "GET"); } catch { return null; } }
    return null;
  }
  async function removeDevice(hwid) {
    if (LIVE) { try { await http("/api/devices/remove", { hwid }, "POST"); return true; } catch { return false; } }
    return false;
  }
  // Жёсткий «кик всех»: ротация подписки. Возвращает {sub_url} или null.
  async function resetKey() {
    if (LIVE) { try { return await http("/api/subscription/reset", {}, "POST"); } catch { return null; } }
    return null;
  }

  /* ============================================================
     СЕРВЕРНОЕ ВРЕМЯ + ПРАЗДНИК + ПОДАРОК
     ============================================================ */
  // Авторитетные дата/время с сервера (нельзя обмануть переводом часов)
  async function getServerTime() {
    if (LIVE) { try { return await http("/api/time", null, "GET"); } catch {} }
    // demo: локальное время (праздник вычислит сам клиент)
    const d = new Date();
    return { now: d.toISOString(), date: d.toISOString().slice(0, 10), holiday: null, gift: null, demo: true };
  }

  // Последняя новость от ClaudiNewsBot
  async function getLatestNews() {
    if (LIVE) { try { return await http("/api/news/latest", null, "GET"); } catch { return null; } }
    return null; // без сервера новостей нет
  }

  // Забрать праздничный подарок: +дни подписки (раз в день, проверка на сервере)
  async function claimGift() {
    if (LIVE) {
      const r = await http("/api/gift/claim", {}, "POST");
      if (r.claimed && r.expires) { const s = getSession(); if (s) { s.subscription = { ...s.subscription, plan: "Premium", status: "active", expires: r.expires }; setSession(s); } }
      return r;
    }
    // demo: +1 день локально, один раз в день
    const KEY_G = "cloudvpn.gift";
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(KEY_G) === today) return { claimed: false, reason: "already" };
    const s = getSession(); if (!s) return { claimed: false, reason: "no-user" };
    const base = (s.subscription?.expires && s.subscription.expires > now()) ? s.subscription.expires : now();
    const exp = base + 864e5;
    s.subscription = { ...s.subscription, plan: "Premium", status: "active", expires: exp };
    setSession(s); localStorage.setItem(KEY_G, today);
    return { claimed: true, days: 1, expires: exp };
  }

  /* ============================================================
     ОПЛАТЫ – Платега
     Реальная схема: клиент просит бэкенд создать транзакцию,
     бэкенд (со secret-ключом) вызывает Платегу и возвращает
     paymentUrl. Клиент открывает ссылку, затем опрашивает статус,
     который бэкенд узнаёт из вебхука Платеги.
     ============================================================ */
  async function createPayment(planId) {
    if (LIVE) {
      const r = await http("/api/payments/create", { plan_id: planId }, "POST");
      return { id: r.transactionId, url: r.url, paymentUrl: r.url, status: "pending" };
    }
    await sleep(500);
    return { id: "pay_demo", url: "https://app.platega.io", paymentUrl: "https://app.platega.io", status: "pending" };
  }
  function openPayment(payment) { openExternal(payment.url || payment.paymentUrl); }

  async function pollPayment(paymentId) {
    if (LIVE) return http("/api/payments/" + paymentId, null, "GET");
    await sleep(900);
    return { id: paymentId, status: "succeeded" }; // demo: считаем оплату успешной
  }

  // Применить успешную оплату к подписке (в реале это делает бэкенд)
  function applyPurchase(planId) {
    const plan = cfg.plans.find(p => p.id === planId);
    const s = getSession();
    if (!s || !plan) return null;
    const base = (s.subscription?.expires && s.subscription.expires > now())
      ? s.subscription.expires : now();
    const d = new Date(base); d.setMonth(d.getMonth() + plan.months);
    s.subscription = { plan: "Premium", status: "active", expires: d.getTime(), source: s.subscription?.source || s.method };
    return setSession(s).subscription;
  }

  function logout() { clearSession(); }

  return {
    LIVE,
    getSession, clearSession, logout, refreshSession,
    tgStart, tgOpen, tgPoll, tgConfirmDemo,
    emailLogin, emailRequestCode, emailLoginWithCode,
    getSubscription, getVpnConfig, getDevices, removeDevice, resetKey, getServerTime, getLatestNews, claimGift,
    createPayment, openPayment, pollPayment, applyPurchase,
    openExternal,
    hasNativeVpn, onVpn, onSub, vpnConnect, vpnDisconnect, importSubscription,
    openLog, requestLogTail, onLogTail,
    requestAppsList, onAppsList,
    onUpdate, updateCheck, updateInstall,
    nativePing,
  };
})();
