'use strict';

/**
 * Frigate → Telegram alerter
 *
 * Subscribe MQTT topic `frigate/events`, lọc theo nhãn/score/zone,
 * gọi Frigate API lấy snapshot, gửi cảnh báo lên Telegram.
 *
 * Cấu trúc message của Frigate (tóm tắt):
 *   {
 *     type: "new" | "update" | "end",
 *     before: {...},
 *     after: {
 *       id: "1715769543.123456-abc",
 *       camera: "front_door",
 *       label: "person",
 *       top_score: 0.87,
 *       current_zones: ["sidewalk"],
 *       entered_zones: ["sidewalk"],
 *       has_snapshot: true,
 *       start_time: 1715769543.12,
 *       ...
 *     }
 *   }
 */

const mqtt = require('mqtt');

// ---------- Cấu hình từ env ----------
const CFG = {
  mqttHost:        process.env.MQTT_HOST        || 'localhost',
  mqttPort:        Number(process.env.MQTT_PORT || 1883),
  mqttTopic:       process.env.MQTT_TOPIC       || 'frigate/events',
  frigateBaseUrl:  process.env.FRIGATE_BASE_URL || 'http://localhost:5000',
  telegramToken:   process.env.TELEGRAM_BOT_TOKEN,
  telegramChat:    process.env.TELEGRAM_CHAT_ID,
  alertLabels:     (process.env.ALERT_LABELS || 'person').split(',').map(s => s.trim()),
  cooldownSec:     Number(process.env.ALERT_COOLDOWN_SEC || 60),
  minScore:        Number(process.env.ALERT_MIN_SCORE    || 0.7),
};

if (!CFG.telegramToken || !CFG.telegramChat) {
  console.error('[FATAL] Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
  process.exit(1);
}

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ---------- Cooldown per camera ----------
const lastAlertAt = new Map();  // camera → timestamp ms

function inCooldown(camera) {
  const last = lastAlertAt.get(camera);
  if (!last) return false;
  return (Date.now() - last) < CFG.cooldownSec * 1000;
}

function markAlerted(camera) {
  lastAlertAt.set(camera, Date.now());
}

// ---------- Frigate API: lấy snapshot ----------
async function fetchSnapshot(eventId) {
  const url = `${CFG.frigateBaseUrl}/api/events/${eventId}/snapshot.jpg?bbox=1&timestamp=1`;
  // Retry vì snapshot có thể chưa kịp sinh ra ngay khi event `new` đến
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 1024) return buf;       // < 1KB nghi là ảnh lỗi
      }
    } catch (err) {
      log(`Lấy snapshot lần ${attempt} lỗi:`, err.message);
    }
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  return null;
}

// ---------- Telegram: gửi photo + caption ----------
async function sendTelegramPhoto(photoBuf, caption) {
  const url = `https://api.telegram.org/bot${CFG.telegramToken}/sendPhoto`;
  const form = new FormData();
  form.append('chat_id', CFG.telegramChat);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('photo', new Blob([photoBuf], { type: 'image/jpeg' }), 'snapshot.jpg');

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram API ${res.status}: ${text}`);
  }
  return res.json();
}

async function sendTelegramText(text) {
  const url = `https://api.telegram.org/bot${CFG.telegramToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CFG.telegramChat,
      text,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) throw new Error(`Telegram API ${res.status}`);
}

// ---------- Xử lý event ----------
async function handleEvent(evt) {
  // Chỉ quan tâm event `new` — lúc object lần đầu xuất hiện
  if (evt.type !== 'new') return;

  const after = evt.after;
  if (!after) return;

  const { id, camera, label, top_score, entered_zones, current_zones } = after;

  // Filter: label
  if (!CFG.alertLabels.includes(label)) {
    log(`Bỏ qua: label=${label} không trong [${CFG.alertLabels.join(',')}]`);
    return;
  }

  // Filter: score
  if (typeof top_score === 'number' && top_score < CFG.minScore) {
    log(`Bỏ qua: score=${top_score.toFixed(2)} < ${CFG.minScore}`);
    return;
  }

  // Filter: cooldown
  if (inCooldown(camera)) {
    log(`Bỏ qua: cam ${camera} đang cooldown`);
    return;
  }

  // OK → gửi
  markAlerted(camera);

  const zones = (entered_zones || current_zones || []).join(', ') || '(không zone)';
  const scoreStr = typeof top_score === 'number' ? (top_score * 100).toFixed(0) + '%' : 'n/a';
  const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const caption =
    `🚨 <b>Phát hiện ${label}</b>\n` +
    `📷 Camera: <code>${camera}</code>\n` +
    `📍 Zone: ${zones}\n` +
    `🎯 Độ tin cậy: ${scoreStr}\n` +
    `🕒 ${time}`;

  log(`ALERT: ${label} @ ${camera} (zones=${zones}, score=${scoreStr})`);

  try {
    const snap = await fetchSnapshot(id);
    if (snap) {
      await sendTelegramPhoto(snap, caption);
      log(`Đã gửi Telegram (ảnh ${(snap.length / 1024).toFixed(0)}KB)`);
    } else {
      await sendTelegramText(caption + '\n\n⚠️ Không lấy được snapshot');
      log('Đã gửi Telegram (text-only, không có ảnh)');
    }
  } catch (err) {
    log('LỖI gửi Telegram:', err.message);
  }
}

// ---------- MQTT ----------
const client = mqtt.connect({
  host: CFG.mqttHost,
  port: CFG.mqttPort,
  reconnectPeriod: 5000,
  connectTimeout: 10000,
});

client.on('connect', () => {
  log(`MQTT connected ${CFG.mqttHost}:${CFG.mqttPort}`);
  client.subscribe(CFG.mqttTopic, { qos: 1 }, (err) => {
    if (err) {
      log('Subscribe lỗi:', err.message);
      process.exit(1);
    }
    log(`Đã subscribe ${CFG.mqttTopic} — chờ event...`);
    log(`Cấu hình: labels=[${CFG.alertLabels.join(',')}] minScore=${CFG.minScore} cooldown=${CFG.cooldownSec}s`);
  });
});

client.on('message', async (topic, payload) => {
  let evt;
  try {
    evt = JSON.parse(payload.toString());
  } catch (err) {
    log('Payload không phải JSON:', err.message);
    return;
  }
  try {
    await handleEvent(evt);
  } catch (err) {
    log('handleEvent lỗi:', err.message);
  }
});

client.on('error', err => log('MQTT error:', err.message));
client.on('reconnect', () => log('MQTT reconnecting...'));
client.on('close', () => log('MQTT closed'));

// ---------- Shutdown ----------
function shutdown(sig) {
  log(`Nhận ${sig}, đang dừng...`);
  client.end(false, {}, () => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Init test: verify token + chat_id bằng cách gửi tin thật lúc khởi động.
// Fail-fast nếu chat_id sai → log rõ lý do, không phải chờ event đầu tiên mới phát hiện.
(async () => {
  // Bước 1: getMe — verify token
  let botUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/getMe`);
    const data = await res.json();
    if (!data.ok) {
      log(`❌ Telegram TOKEN sai: ${data.description}`);
      log('→ Kiểm tra TELEGRAM_BOT_TOKEN trong .env');
      process.exit(1);
    }
    botUsername = data.result.username;
    log(`✅ Telegram bot OK: @${botUsername}`);
  } catch (err) {
    log(`⚠️  Không gọi được Telegram API: ${err.message} (mạng có vấn đề?)`);
    return;   // Không exit — mạng có thể lên lại sau, alerter vẫn nên chờ
  }

  // Bước 2: gửi tin test — verify chat_id
  const hostname = require('os').hostname();
  const startupMsg =
    `🟢 <b>Frigate Alerter đã khởi động</b>\n` +
    `🤖 Bot: @${botUsername}\n` +
    `📡 MQTT: ${CFG.mqttHost}:${CFG.mqttPort}\n` +
    `🏷️ Labels: ${CFG.alertLabels.join(', ')}\n` +
    `🎯 Min score: ${CFG.minScore} | Cooldown: ${CFG.cooldownSec}s\n` +
    `🖥️ Host: <code>${hostname}</code>\n` +
    `🕒 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;

  try {
    await sendTelegramText(startupMsg);
    log(`✅ Đã gửi tin test tới chat ${CFG.telegramChat} — chat_id đúng`);
  } catch (err) {
    log(`❌ Gửi tin test thất bại: ${err.message}`);
    if (err.message.includes('chat not found')) {
      log('→ TELEGRAM_CHAT_ID sai hoặc bạn chưa /start bot bao giờ.');
      log(`→ Mở Telegram, search @${botUsername}, bấm Start, gửi 1 tin.`);
      log(`→ Sau đó vào https://api.telegram.org/bot<TOKEN>/getUpdates để lấy chat_id đúng.`);
    } else if (err.message.includes('bot was blocked')) {
      log('→ Bạn đã block bot. Vào Telegram unblock @' + botUsername);
    }
    process.exit(1);
  }
})();