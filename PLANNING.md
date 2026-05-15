# Plan: Alerter gửi video clip lên Telegram khi event kết thúc

## Mục tiêu

Hiện tại `alerter/index.js` chỉ gửi **ảnh snapshot + caption** khi event `new` (đối tượng vừa xuất hiện).
Mở rộng để cũng gửi **video clip MP4** khi event `end` (đối tượng đã rời khung hình),
biến Telegram chat thành cloud storage thay vì phải thuê VPS.

## Tại sao gửi ở event `end`, không phải `new`?

Frigate chỉ tạo file clip MP4 hoàn chỉnh **sau khi event kết thúc** (gồm pre-event 5s + duration + post-event 5s).
Gọi `/api/events/<id>/clip.mp4` lúc `new` sẽ trả 404 hoặc clip chưa đủ.

## Frigate API endpoint

```
GET /api/events/<event_id>/clip.mp4
```

- Chỉ available khi `record.enabled: true` trong [config.yml:54-63](config/config.yml) (đã bật).
- Sau khi `end`, clip còn cần ~2-5s để finalize → cần retry với backoff.
- Retention mặc định: 14 ngày cho alerts (xem mục `record.alerts.retain.days` trong config).

## Telegram API

```
POST https://api.telegram.org/bot<TOKEN>/sendVideo
multipart/form-data:
  chat_id
  video         (binary)
  caption       (HTML)
  parse_mode    HTML
  supports_streaming  true     ← cho phép xem trong chat không cần download
```

Giới hạn: **50MB/file qua Bot API public**. Vượt → cần self-hosted Bot API server.
Cam sub-stream H264/H265 720p, event ~30-60s → file ~3-10MB, dư xa 50MB.

## Thay đổi code (chi tiết)

### 1. Thêm `fetchClip(eventId)` — song song với `fetchSnapshot`

```js
// alerter/index.js, sau fetchSnapshot()
async function fetchClip(eventId) {
  const url = `${CFG.frigateBaseUrl}/api/events/${eventId}/clip.mp4`;
  // Clip cần 2-5s để finalize sau event end → retry tăng dần
  const delays = [2000, 3000, 5000, 8000, 13000];  // tổng ~31s
  for (let i = 0; i < delays.length; i++) {
    await new Promise(r => setTimeout(r, delays[i]));
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 10_000) return buf;  // < 10KB là clip lỗi/rỗng
        log(`Clip ${eventId} mới ${buf.length}B — thử lại`);
      } else if (res.status !== 404) {
        log(`Clip ${eventId} status ${res.status}`);
      }
    } catch (err) {
      log(`Fetch clip ${eventId} lần ${i+1}: ${err.message}`);
    }
  }
  return null;
}
```

### 2. Thêm `sendTelegramVideo()` — song song với `sendTelegramPhoto`

```js
async function sendTelegramVideo(videoBuf, caption) {
  const url = `https://api.telegram.org/bot${CFG.telegramToken}/sendVideo`;
  const form = new FormData();
  form.append('chat_id', CFG.telegramChat);
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  form.append('video', new Blob([videoBuf], { type: 'video/mp4' }), 'clip.mp4');

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram sendVideo ${res.status}: ${text}`);
  }
  return res.json();
}
```

### 3. Mở rộng `handleEvent()` xử lý `type === 'end'`

```js
async function handleEvent(evt) {
  const after = evt.after;
  if (!after) return;
  const { id, camera, label, top_score } = after;

  // Filter chung — cùng logic cho cả `new` và `end`
  if (!CFG.alertLabels.includes(label)) return;
  if (typeof top_score === 'number' && top_score < CFG.minScore) return;

  if (evt.type === 'new') {
    // Hiện tại: gửi snapshot (giữ nguyên)
    if (inCooldown(camera)) return;
    markAlerted(camera);
    // ... fetchSnapshot + sendTelegramPhoto ...
  } else if (evt.type === 'end') {
    // Mới: gửi video clip
    if (sentClips.has(id)) return;       // chống duplicate (Frigate có thể retry)
    sentClips.add(id);

    const clip = await fetchClip(id);
    if (!clip) {
      log(`Không lấy được clip cho event ${id}`);
      return;
    }
    if (clip.length > 50 * 1024 * 1024) {
      log(`Clip ${id} quá lớn (${(clip.length/1024/1024).toFixed(1)}MB > 50MB), bỏ qua`);
      return;
    }

    const caption = buildCaption(after, 'end');  // tách hàm để dùng chung
    try {
      await sendTelegramVideo(clip, caption);
      log(`Đã gửi video clip ${id} (${(clip.length/1024/1024).toFixed(1)}MB)`);
    } catch (err) {
      log(`LỖI gửi video: ${err.message}`);
    }
  }
  // type === 'update' bỏ qua
}
```

### 4. Thêm `sentClips` Set với TTL cleanup

```js
const sentClips = new Set();
// Dọn ID cũ mỗi 30 phút để tránh memory leak khi alerter chạy lâu ngày
setInterval(() => sentClips.clear(), 30 * 60 * 1000);
```

### 5. Refactor `buildCaption()` để snapshot + video dùng chung

```js
function buildCaption(after, kind /* 'new' | 'end' */) {
  const { label, top_score, camera, entered_zones, current_zones } = after;
  const zones = (entered_zones || current_zones || []).join(', ') || '(không zone)';
  const scoreStr = typeof top_score === 'number' ? (top_score*100).toFixed(0)+'%' : 'n/a';
  const time = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const icon = kind === 'new' ? '🚨' : '🎬';
  const title = kind === 'new' ? `Phát hiện ${label}` : `Clip ${label}`;
  return `${icon} <b>${title}</b>\n📷 ${camera}\n📍 ${zones}\n🎯 ${scoreStr}\n🕒 ${time}`;
}
```

## Env vars mới (thêm vào docker-compose.yml)

```yaml
alerter:
  environment:
    # ... cũ ...
    ALERT_SEND_VIDEO: "true"            # bật/tắt gửi video clip
    ALERT_MAX_CLIP_MB: "50"             # giới hạn size, vượt thì bỏ qua
```

Đọc trong `CFG`:
```js
sendVideo:    process.env.ALERT_SEND_VIDEO === 'true',
maxClipBytes: Number(process.env.ALERT_MAX_CLIP_MB || 50) * 1024 * 1024,
```

## Edge cases phải test

1. **Event kết thúc nhưng clip = null**: thường do `record` disabled hoặc event quá ngắn. Log + skip.
2. **Cùng event ID nhận multiple `end`**: dùng `sentClips` Set chặn duplicate.
3. **Clip > 50MB**: caption-only fallback hoặc bỏ qua (đã handle ở step 3).
4. **Network timeout khi upload**: try/catch, không exit alerter.
5. **Retention hết hạn trước khi clip về**: rất hiếm (clip về sau ~10s, retention ngày), nhưng `fetch` sẽ 404 → log graceful.

## Plan deploy

1. Phát triển local trên dev PC (CPU mode hiện tại) — đủ test logic.
2. Test scenario: đứng trước cam → đi ra. Verify nhận được:
   - Tin snapshot khi vừa vào (event `new`)
   - Tin video clip ~30-60s sau (event `end`)
3. Khi RPi 5 về: copy thẳng `alerter/` (Node.js multi-arch, không phải build lại), `docker compose up -d`.

## Risks / Open questions

- **Telegram rate limit**: 30 msg/s per bot, 20 msg/min per chat. Cooldown 60s đã đủ buffer.
- **Frigate `end` event delay**: nếu chế độ Frigate `birdseye` hoặc heavy tracking, `end` có thể trễ. Theo dõi log thực tế.
- **Disk wear trên RPi SD card**: clip lưu vào `./storage` 14 ngày. RPi nên dùng SSD USB3, không phải SD card.
- **Self-hosted Bot API**: nếu sau này cần gửi clip > 50MB (cam độ phân giải cao), deploy [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) container.
