/* ============================================================
   CloudVPN – конфигурация
   Здесь ключи/параметры, которые заполняются позже.
   ВАЖНО: secret-ключи Платеги НЕЛЬЗЯ держать в клиенте –
   они должны жить на бэкенде. Тут только публичные параметры
   и базовый URL вашего сервера (когда появится).
   ============================================================ */
window.CLOUDVPN_CONFIG = {
  // Единый бэкенд (cloudvpn-api / FastAPI), общий для сайта, бота и
  // десктоп-клиента. Email/Telegram-вход, подписки и платежи живут здесь.
  // Пусто = demo без сервера.
  apiBase: "https://cloude.one",

  // Праздничное оформление. 'auto' – по дате; либо принудительно:
  // 'newyear' | 'halloween' | 'none'
  holiday: "auto",
  // Даты включения (ММ-ДД). Можно править. НГ переходит через год.
  holidayDates: {
    halloween: { from: "10-24", to: "11-02" },  // 🎃 24 окт – 2 ноя
    newyear:   { from: "12-15", to: "01-14" },  // 🎄 15 дек – 14 янв
    valentine: { from: "02-13", to: "02-15" },  // 💝 14 февраля
    defender:  { from: "02-22", to: "02-24" },  // 🎖️ 23 февраля
    womensday: { from: "03-07", to: "03-09" },  // 🌷 8 марта
    victory:   { from: "05-08", to: "05-10" },  // 🎆 9 мая, День Победы
  },

  telegram: {
    // Единый бот — @cloudesvpn_bot. Деплинк на /start <token> приходит через
    // /api/auth/telegram/start, это значение — фолбэк для demo.
    botUsername: "cloudesvpn_bot",
    // Живая поддержка (отдельный аккаунт, НЕ бот).
    supportUsername: "cloudhelps",
  },

  platega: {
    // Публичные параметры. SECRET и merchant-операции – только на сервере!
    enabled: true,
    title: "Платега",
    // Способы оплаты, которые показываем пользователю
    methods: [
      { id: "card", label: "Банковская карта", icon: "card" },
      { id: "sbp",  label: "СБП",              icon: "sbp" },
      { id: "crypto", label: "Криптовалюта",   icon: "crypto" },
    ],
  },

  // Тарифы. Цены/скидки правьте здесь.
  // Canonical prices = the bot (single billing source of truth).
  plans: [
    { id: "day",      title: "1 день",    price: 18,  per: "18 ₽ в день", badge: "" },
    { id: "month",    title: "1 месяц",   price: 95,  per: "95 ₽/мес",    badge: "" },
    { id: "quarter",  title: "3 месяца",  price: 229, per: "76 ₽/мес",    badge: "−20%" },
    { id: "semester", title: "6 месяцев", price: 385, per: "64 ₽/мес",    badge: "−32%", popular: true },
    { id: "year",     title: "1 год",     price: 639, per: "53 ₽/мес",    badge: "−44%" },
  ],
  currency: "₽",

  // Бонус новым пользователям почты
  trialDays: 5,
  // Бесплатный Telegram-only туннель для входа: гостевой узел, клиент гонит
  // через него ТОЛЬКО Telegram (см. кнопку «Разблокировать Telegram»).
  tgAuth: {
    vless: "vless://a3da2e26-705f-4c49-aed6-f2ad8da7e3a3@147.45.39.113:1443?encryption=none&flow=xtls-rprx-vision&type=tcp&security=reality&sni=des.cloude.one&fp=edge&pbk=Uk0lkzXOEC1pbahlfe6KCawkMtG2rjBZJTuucpGgMCg&sid=69bcff3e083d91ec#Free%20Telegram",
  },
};
