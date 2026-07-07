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
  apiBase: "https://cloude.tech",

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
    { id: "day",      title: "1 день",    price: 36,   per: "36 ₽ в день", badge: "" },
    { id: "month",    title: "1 месяц",   price: 189,  per: "189 ₽/мес",   badge: "" },
    { id: "quarter",  title: "3 месяца",  price: 459,  per: "153 ₽/мес",   badge: "−19%" },
    { id: "semester", title: "6 месяцев", price: 769,  per: "128 ₽/мес",   badge: "−32%", popular: true },
    { id: "year",     title: "1 год",     price: 1279, per: "107 ₽/мес",   badge: "−44%" },
  ],
  currency: "₽",

  // Бонус новым пользователям почты
  trialDays: 5,
};
