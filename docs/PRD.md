# SEO Agent Bot — Product Requirements Document

> Lite-PRD на одну сторінку для MVP. Технічна перспектива описана окремо у [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Проблема

SEO-маркетологи витрачають **4–6 годин** на одну якісну статтю:

- ~1 година — дослідження ключових слів і трендів
- ~1 година — аналіз топ-10 конкурентів у SERP
- ~2 години — написання та оптимізація під ключі
- ~1 година — щотижневий моніторинг позицій і переписування слабких місць

**~80%** цієї роботи — рутина, яку можна автоматизувати без втрати якості.

---

## 2. Цільовий користувач

**Solo-маркетолог** або **власник малого бізнесу**, який:

- хоче регулярно публікувати SEO-контент (1–4 статті на тиждень)
- не має часу/команди на повний цикл
- готовий перевіряти чернетку перед публікацією (HITL)
- публікує контент у Telegram-канал як основний канал дистрибуції

**НЕ цільові:** контент-агенції на 100+ статей/тиждень (їм потрібна multi-tenant платформа), enterprise-команди (їм потрібен ABAC, SSO, аудит).

---

## 3. Рішення

Автономний AI-агент, що проходить повний цикл:

```
research → generate → approve → publish → measure → re-optimize
```

- **Оркестратор** ([lib/agents/orchestrator.ts](../lib/agents/orchestrator.ts)) керує трьома субагентами
- **Keyword Researcher** будує бриф із прямого аналізу SERP топ-10 (DuckDuckGo) — без trend-data
- **Content Generator** пише статтю Gemini 2.5 Flash зі структурованим виводом
- **Evaluator** через cron щотижня перевіряє позиції в GSC і ставить слабкі статті в чергу на переписування
- **Дашборд** показує live-логи думок агента + кнопку Approve перед публікацією
- **Telegram-канал** — єдиний канал публікації у MVP

---

## 4. Success Metrics

| Метрика | Ціль | Як мірити |
|---|---|---|
| Time-to-publish | < 5 хв (vs. 4 год у людини) | `articles.published_at - tasks.created_at` |
| Cost per article | < $0.10 LLM-витрат | `sum(agent_runs.cost_usd) per task` |
| Quality (топ-20 за 30 днів) | 30% статей | `articles.gsc_position <= 20` після 30 днів |
| Runaway-spending інциденти | 0 | hard budget cap у Google Cloud + код |
| Approve rate | > 70% | `approved_at IS NOT NULL / total tasks` |

---

## 5. User Stories (MVP)

| # | Story | Acceptance criteria |
|---|---|---|
| 1 | Як власник, хочу ввести тему і отримати чернетку за 2 хв | форма у `/`, статус `running → awaiting_approval` ≤ 120 с |
| 2 | Як власник, хочу бачити логіку агента в реальному часі | SSE-стрім кроків у `/tasks/[id]` |
| 3 | Як власник, хочу схвалити публікацію перед відправкою (HITL) | кнопка Approve, поки не натиснута — нічого не відправляється |
| 4 | Як власник, хочу отримувати тижневі звіти про позиції | cron щопонеділка о 9:00, оновлення `articles.gsc_position` |
| 5 | Як власник, хочу бачити витрати в реальному часі | `daily-budget-meter` на дашборді |
| 6 | Як власник, хочу автоматично блокувати агент при перевитраті | daily cap $1, hard cap $10 |

---

## 6. Scope

### IN (MVP)

- 3 субагенти: Keyword Researcher, Content Generator, Evaluator
- Telegram-публікація (один канал власника)
- Google Search Console моніторинг
- Дашборд: список задач, live-лог, approve, daily budget meter, settings
- 5-рівневі гардрейли: stopWhen, token cap, daily cap, loop detection, timeout
- Vercel Cron на щотижневу переоцінку

### OUT (свідомо вирізане з MVP)

- Публічний `/blog/[slug]` — публікація лише в Telegram
- WordPress / Ghost / Medium інтеграції
- Multi-tenant (один користувач)
- Auth-система (доступ через приватний URL)
- Billing UI / paywall
- A/B тести title/meta
- Multi-language
- RAG на власну базу знань
- Playwright-скрапінг (тільки fetch+cheerio)

---

## 7. Constraints

- **Бюджет:** $5 кредитів Google AI Studio, daily cap $1
- **Час:** ~4–5 годин на MVP
- **Stack:** Next.js 16 + Vercel AI SDK 5 + Supabase Postgres
- **Хостинг:** Vercel Hobby (безкоштовний tier, 60-секундний ліміт на функції; cron підняли до 300 с через `vercel.json`)
- **Регіон:** не обмежено, але Telegram API працює через Vercel edge без VPN

---

## 8. Risks & Mitigations

| Ризик | Mitigation |
|---|---|
| Runaway agent (нескінченні цикли, $1000+ за ніч) | 5-рівнева система гардрейлів у [lib/guardrails.ts](../lib/guardrails.ts) + email-alerts у Google Cloud |
| Gemini галюцинації (вигадані факти, неправдиві джерела) | SERP-grounding (агент бачить реальний топ-10) + обовʼязковий human approve |
| Telegram rate limit (30 повідомлень/сек на канал) | розбиття довгих статей + sequential send |
| DuckDuckGo HTML endpoint може змінити розмітку | селектори у [lib/tools/serp.ts](../lib/tools/serp.ts) ізольовані; post-MVP — DataForSEO/SerpAPI як платний production-grade backend |
| Vercel timeout 60 с на Hobby для основного агента | агент пише крок за кроком у БД → клієнт читає через SSE; задача не блокує функцію довше 60 с |
| Витік API-ключів через `.env` у git | `.gitignore` блокує `.env*`, лише `.env.example` дозволено |

---

## 9. Post-MVP Roadmap

| Етап | Що додаємо |
|---|---|
| v0.2 | Публічний `/blog/[slug]` із SEO-метатегами + sitemap |
| v0.3 | WordPress REST API publisher (опціонально) |
| v0.4 | RAG на embeddings для бренд-войсу і фактчекінгу |
| v0.5 | A/B тести title/meta з автопереможцем |
| v0.6 | Multi-language (укр/англ/рос) |
| v1.0 | Multi-user + білінг через Stripe + auth через Supabase |

---

## 10. Definition of Done (для MVP)

- [ ] Створення задачі через UI працює end-to-end
- [ ] Live-лог думок агента відображається в реальному часі (SSE)
- [ ] Approve відправляє статтю в Telegram-канал
- [ ] Усі 5 рівнів гардрейлів увімкнено та задокументовано
- [ ] Daily budget meter показує реальні витрати
- [ ] Cron-маршрут захищений `CRON_SECRET`
- [ ] README із quick-start та посиланнями на PRD/ARCHITECTURE
- [ ] Зелений smoke-test: топік "Як вибрати CRM" → стаття у Telegram за < 5 хв
