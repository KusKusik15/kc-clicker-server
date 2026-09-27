# KC Clicker Server

Backend для игры KC Clicker (Telegram Mini App).

## Переменные окружения

Создай в Vercel → Settings → Environment Variables:

- `BOT_TOKEN` — токен бота от @BotFather
- `SUPABASE_URL` — URL проекта Supabase
- `SUPABASE_KEY` — anon публичный ключ Supabase

## Эндпоинты

- `GET /` — проверка работы сервера
- `POST /api/auth` — авторизация через Telegram initData
- `POST /api/save` — сохранение состояния игрока
- `GET /api/top` — топ игроков

## Схема БД (Supabase SQL)

Запусти в Supabase → SQL Editor:

```sql
create table players (
    telegram_id text primary key,
    username text,
    first_name text,
    last_name text,
    coins bigint default 0,
    click_power int default 1,
    max_energy int default 1000,
    energy int default 1000,
    upgrades jsonb default '{"clickPower":0,"maxEnergy":0,"autoClick":0}'::jsonb,
    daily_streak int default 0,
    last_daily_claim bigint default 0,
    clicks_since_captcha int default 0,
    last_save_time bigint default 0,
    last_seen timestamptz default now()
);

create index players_coins_idx on players(coins desc);
