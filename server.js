const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ============ CORS ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ============ SUPABASE ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Не заданы SUPABASE_URL или SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL || '', SUPABASE_KEY || '');

// ============ АВТОРИЗАЦИЯ TELEGRAM ============
const BOT_TOKEN = process.env.BOT_TOKEN;

function verifyTelegramInitData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;

        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secretKey = crypto
            .createHmac('sha256', 'WebAppData')
            .update(BOT_TOKEN)
            .digest();

        const calcHash = crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (calcHash !== hash) return null;

        const userJson = params.get('user');
        if (!userJson) return null;

        return JSON.parse(userJson);
    } catch (e) {
        return null;
    }
}

// ============ ЭНДПОИНТЫ ============

// Проверка работы
app.get('/', (req, res) => {
    res.json({ ok: true, message: 'KC Clicker Server is running' });
});

// Авторизация + получение состояния
app.post('/api/auth', async (req, res) => {
    try {
        const { initData } = req.body;

        if (!initData) {
            return res.status(400).json({ error: 'Нет initData' });
        }

        const user = verifyTelegramInitData(initData);

        if (!user) {
            return res.status(401).json({ error: 'Неверная подпись Telegram' });
        }

        const userId = String(user.id);

        // Ищем игрока в базе
        const { data: existing, error: selectErr } = await supabase
            .from('players')
            .select('*')
            .eq('telegram_id', userId)
            .maybeSingle();

        if (selectErr) {
            console.error('Ошибка SELECT:', selectErr);
            return res.status(500).json({ error: 'DB error' });
        }

        if (existing) {
            // Обновляем ник и аватар
            await supabase
                .from('players')
                .update({
                    username: user.username || null,
                    first_name: user.first_name || null,
                    last_name: user.last_name || null,
                    last_seen: new Date().toISOString()
                })
                .eq('telegram_id', userId);

            return res.json({
                player: {
                    telegramId: userId,
                    coins: existing.coins,
                    clickPower: existing.click_power,
                    maxEnergy: existing.max_energy,
                    energy: existing.energy,
                    upgrades: existing.upgrades,
                    dailyStreak: existing.daily_streak,
                    lastDailyClaim: existing.last_daily_claim,
                    clicksSinceCaptcha: existing.clicks_since_captcha,
                    lastSaveTime: existing.last_save_time
                },
                newPlayer: false
            });
        }

        // Создаём нового игрока
        const newPlayer = {
            telegram_id: userId,
            username: user.username || null,
            first_name: user.first_name || null,
            last_name: user.last_name || null,
            coins: 0,
            click_power: 1,
            max_energy: 1000,
            energy: 1000,
            upgrades: { clickPower: 0, maxEnergy: 0, autoClick: 0 },
            daily_streak: 0,
            last_daily_claim: 0,
            clicks_since_captcha: 0,
            last_save_time: Date.now(),
            last_seen: new Date().toISOString()
        };

        const { error: insertErr } = await supabase
            .from('players')
            .insert([newPlayer]);

        if (insertErr) {
            console.error('Ошибка INSERT:', insertErr);
            return res.status(500).json({ error: 'DB error' });
        }

        return res.json({
            player: {
                telegramId: userId,
                coins: 0,
                clickPower: 1,
                maxEnergy: 1000,
                energy: 1000,
                upgrades: { clickPower: 0, maxEnergy: 0, autoClick: 0 },
                dailyStreak: 0,
                lastDailyClaim: 0,
                clicksSinceCaptcha: 0,
                lastSaveTime: Date.now()
            },
            newPlayer: true
        });

    } catch (e) {
        console.error('auth error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Сохранение состояния
app.post('/api/save', async (req, res) => {
    try {
        const { initData, state } = req.body;

        if (!initData || !state) {
            return res.status(400).json({ error: 'Нет данных' });
        }

        const user = verifyTelegramInitData(initData);
        if (!user) return res.status(401).json({ error: 'Auth failed' });

        const userId = String(user.id);

        // Получаем старое состояние для античита
        const { data: old } = await supabase
            .from('players')
            .select('coins, click_power, energy')
            .eq('telegram_id', userId)
            .maybeSingle();

        if (!old) return res.status(404).json({ error: 'Player not found' });

        // АНТИЧИТ: проверяем, что монеты не выросли больше чем возможно
        const maxPossibleGain = (Date.now() - (state.lastSaveTime || Date.now())) / 1000 * 100;
        const actualGain = state.coins - old.coins;

        // Если рост больше возможного — обрезаем
        let finalCoins = state.coins;
        if (actualGain > maxPossibleGain && maxPossibleGain > 0) {
            console.warn('ANTICHEAT: слишком быстрый рост', { userId, actualGain, maxPossibleGain });
            finalCoins = old.coins + maxPossibleGain;
        }

        const { error: updateErr } = await supabase
            .from('players')
            .update({
                coins: Math.floor(finalCoins),
                click_power: state.clickPower,
                max_energy: state.maxEnergy,
                energy: state.energy,
                upgrades: state.upgrades,
                daily_streak: state.dailyStreak,
                last_daily_claim: state.lastDailyClaim,
                clicks_since_captcha: state.clicksSinceCaptcha,
                last_save_time: state.lastSaveTime || Date.now(),
                last_seen: new Date().toISOString()
            })
            .eq('telegram_id', userId);

        if (updateErr) {
            console.error('save error:', updateErr);
            return res.status(500).json({ error: 'DB error' });
        }

        res.json({ ok: true, coins: Math.floor(finalCoins) });

    } catch (e) {
        console.error('save error:', e);
        res.status(500).json({ error: 'Internal error' });
    }
});

// Топ игроков
app.get('/api/top', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('players')
            .select('telegram_id, username, first_name, coins')
            .order('coins', { ascending: false })
            .limit(50);

        if (error) return res.status(500).json({ error: 'DB error' });

        const top = (data || []).map((p, i) => ({
            rank: i + 1,
            telegramId: p.telegram_id,
            name: p.username || p.first_name || 'Игрок',
            coins: p.coins
        }));

        res.json({ top });

    } catch (e) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ============ ЗАПУСК ============
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log('✅ Сервер запущен на порту ' + PORT);
});

module.exports = app;