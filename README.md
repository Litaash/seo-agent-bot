# SEO Agent Bot

Автономний AI-агент, який збирає ключі, генерує SEO-статтю через Gemini 2.5 Flash, після людського approve у дашборді публікує її в Telegram-канал, а через тиждень сам перевіряє позиції в Google Search Console й переписує слабкі сторінки.

> **Документація:** [docs/PRD.md](./docs/PRD.md) (продуктова постановка) · [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) (технічна архітектура)

---

## Quick links

- **Дашборд:** `http://localhost:3000` — список задач + new task form
- **Live-стрім задачі:** `/tasks/[id]` — думки агента в реальному часі + Approve
- **Settings:** `/settings` — поточний денний бюджет, ENV-стан
- **API:** `POST /api/agent/run`, `POST /api/agent/approve`, `GET /api/tasks/[id]/stream` (SSE), `GET /api/cron/weekly-check`

---

## Стек (квітень 2026)

- **Next.js** `16.2.4` · **React** `19` · **TypeScript** `5+`
- **Vercel AI SDK** `6.x` + `@ai-sdk/google` (Gemini 2.5 Flash)
- **Supabase Postgres** + RLS (`@supabase/ssr`, `@supabase/supabase-js`)
- **Tailwind CSS v4** + **shadcn/ui** + **lucide-react**
- **Zod 4** для валідації + structured output
- **grammy** для Telegram-публікації
- **cheerio** + `fetch` для SERP-парсингу (без Playwright)
- **Vercel Cron** для щотижневого evaluator

---

## Передумови

1. **Node.js ≥ 20** і **npm** (або pnpm/yarn).
2. **Google AI Studio API key** — створіть на [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey). Поставте hard budget cap у Google Cloud Billing.
3. **Supabase project** — реєстрація на [supabase.com](https://supabase.com), безкоштовний tier.
4. **Telegram bot** — створіть через [@BotFather](https://t.me/BotFather), додайте бота як адміна у ваш канал.
5. (Опціонально) **Google Search Console** service account для evaluator.

---

## Setup (локально)

```bash
# 1. Клонувати + встановити залежності
git clone https://github.com/Litaash/seo-agent-bot.git
cd seo-agent-bot
npm install

# 2. Створити .env.local з шаблону
cp .env.example .env.local
# → відредагуйте .env.local: вставте справжні ключі

# 3. Прогнати міграцію в Supabase
# Варіант A (SQL Editor у Supabase Dashboard):
#   скопіюйте вміст supabase/migrations/0001_init.sql і виконайте.
# Варіант B (Supabase CLI):
#   supabase db push

# 4. Запустити dev-сервер
npm run dev
# → відкрийте http://localhost:3000
```

---

## Перший запуск (smoke test)

1. Відкрийте `http://localhost:3000`.
2. Введіть тему, наприклад: **«Як вибрати CRM для малого бізнесу»**.
3. Натисніть **Run** — задача переходить у `running`, відкривається `/tasks/[id]` з live-логом.
4. Дочекайтесь, поки оркестратор пройде `research_keywords → generate_content → save_draft` (≈ 1–3 хв).
5. Статус зміниться на **awaiting_approval** + зʼявиться preview статті.
6. Натисніть **Approve** → стаття публікується в ваш Telegram-канал.
7. Перевірте `tasks.cost_usd` — типове значення < `$0.05`.

---

## Структура проєкту (вкорочено)

```
seo-agent-bot/
├── app/
│   ├── (dashboard)/          single-owner UI без auth
│   └── api/                  агент, approve, SSE-стрім, cron
├── lib/
│   ├── agents/               orchestrator + 3 субагенти
│   ├── tools/                keywords, serp, gsc, telegram
│   ├── cost.ts               pricing + tracking
│   ├── guardrails.ts         5-рівнева система захисту
│   └── supabase/             admin/anon clients
├── components/
│   ├── dashboard/            доменні компоненти
│   └── ui/                   shadcn/ui примітиви
├── supabase/migrations/0001_init.sql
├── docs/
│   ├── PRD.md
│   └── ARCHITECTURE.md
├── vercel.json               cron config
└── .env.example
```

Повна структура та архітектурні рішення — у [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Гардрейли

5 рівнів захисту від runaway-spending у [`lib/guardrails.ts`](./lib/guardrails.ts):

1. **Pre-flight daily budget** — refuse to start if today's spend ≥ `DAILY_BUDGET_USD`
2. **Step count cap** — `MAX_STEPS = 20` (orchestrator: 8)
3. **Token budget** — `MAX_TOTAL_TOKENS = 50_000`
4. **Loop detection** — однакова `(tool, args)` пара 3 рази → stop
5. **Wall-clock timeout** — `RUN_TIMEOUT_MS = 5 хв` через `AbortSignal`

Плюс safety net на рівні Google Cloud — email-alerts у Billing при 50/90/100% від $10.

---

## Бюджет

| Сервіс | Очікувані витрати на MVP |
|---|---|
| Gemini 2.5 Flash | ~$0.03 / повний цикл, ~$1.50 за 50 циклів |
| Vercel Hobby | $0 |
| Supabase Free | $0 |
| Telegram Bot API | $0 |
| DuckDuckGo HTML SERP scraping | $0 |
| Google Search Console API (опціонально) | $0 |
| **Разом** | **~$1.50** |

---

## Скрипти

```bash
npm run dev        # next dev (Turbopack за замовчуванням)
npm run build      # next build
npm run start      # next start
npm run lint       # eslint
```

---

## Деплой на Vercel

1. **Імпортуйте репо** на [vercel.com/new](https://vercel.com/new).
2. **Environment Variables** — додайте все з `.env.example` (відмітьте `Production`, `Preview`, `Development` за потреби).
3. **Build settings** — Vercel автоматично визначить Next.js 16. Нічого змінювати не потрібно.
4. **Cron** — `vercel.json` уже містить розклад. Vercel Cron автоматично зчитує конфіг при деплої.
5. **CRON_SECRET** — після першого деплою Vercel згенерує `Authorization: Bearer ${CRON_SECRET}` автоматично, якщо змінна виставлена.
6. **Public hostname** — `your-project.vercel.app` зразу працює; домен можна додати у Settings → Domains.

---

## Вирізане з MVP (свідомо)

- Публічний `/blog/[slug]` (публікуємо лише в Telegram)
- WordPress / Ghost / Medium інтеграції
- Multi-tenant + auth + білінг
- A/B тести title/meta
- Multi-language
- RAG / embeddings
- Playwright-скрапінг

Roadmap у [docs/PRD.md § 9](./docs/PRD.md#9-post-mvp-roadmap).

---

## Ліцензія

Pet-проєкт. Поки без ліцензії — всі права за автором ([@Litaash](https://github.com/Litaash)).
