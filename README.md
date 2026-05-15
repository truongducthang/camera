# Frigate Alert — Cảnh báo Telegram khi phát hiện người

Pipeline:
```
[Camera RTSP] → [Frigate: record + AI detect] → MQTT → [Alerter] → Telegram
```

## Yêu cầu phần cứng

- **CPU**: ≥ 4 core. Pi 4/5, Intel N100, hoặc máy x86 cũ. Pi Zero KHÔNG đủ.
- **RAM**: ≥ 2GB free cho Frigate (cộng 256MB shm).
- **Storage**: SSD khuyến nghị (SD card sẽ bị hao mòn nhanh). 32GB tối thiểu.
- **Coral USB TPU** ($60, optional): bật detect 100+ FPS chỉ với 2W, CPU gần như rảnh. Không có Coral vẫn chạy được nhưng ăn CPU.

## Setup

### 1. Cài Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Logout và login lại
```

### 2. Tạo Telegram bot

1. Chat với [@BotFather](https://t.me/BotFather), gõ `/newbot`, đặt tên → nhận **bot token**.
2. Chat với chính bot vừa tạo (gửi /start), sau đó mở:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   → tìm field `"chat":{"id":...}` → đó là **chat_id**.

### 3. Cấu hình

```bash
cp .env.example .env
nano .env       # Điền RTSP URL, Telegram token, chat_id
```

Nếu camera không có sub-stream low-res, mở `config/config.yml` và bỏ block `roles: [detect]` thứ 2 — sẽ dùng chung stream chính (tốn CPU hơn).

### 4. Chạy

```bash
docker compose up -d
docker compose logs -f frigate alerter
```

- Frigate UI: `http://<ip-máy>:5000`
- Alerter sẽ log `MQTT connected` và `Telegram bot OK: @your_bot` lúc khởi động.

### 5. Test

Đứng trước camera, bạn sẽ thấy:
- Frigate UI: hiện bounding box quanh người, event xuất hiện trong tab "Review".
- Telegram: nhận tin nhắn kèm snapshot trong vòng 1–3 giây.

## Tinh chỉnh

### Vẽ zone bằng UI

Sau khi chạy lần đầu, vào Frigate UI → Settings → Camera → Mask & Zone Editor. Vẽ vùng bằng chuột, copy tọa độ vào `config/config.yml` thay cho zone mặc định của mình.

### Thêm camera thứ 2

Trong `config/config.yml`:
```yaml
go2rtc:
  streams:
    cam01: ...
    cam02: "rtsp://admin:pass@192.168.1.11:554/..."

cameras:
  front_door: ...
  back_yard:
    ffmpeg:
      inputs:
        - path: rtsp://127.0.0.1:8554/cam02
          input_args: preset-rtsp-restream
          roles: [record, detect]
    detect: { width: 1280, height: 720, fps: 5 }
```

Alerter tự động phân biệt theo `camera` trong message, cooldown tính riêng từng cam.

### Bật Coral USB TPU

1. Cắm Coral vào máy.
2. Trong `docker-compose.yml`, bỏ comment dòng `/dev/bus/usb`.
3. Trong `config/config.yml`, comment block `cpu1`, bỏ comment block `edgetpu`.
4. `docker compose up -d --force-recreate frigate`.

### Tăng/giảm độ nhạy

Trong `.env` của alerter (sửa trong docker-compose.yml):
- `ALERT_MIN_SCORE=0.7` → tăng lên `0.85` nếu false positive nhiều.
- `ALERT_COOLDOWN_SEC=60` → giảm xuống `30` nếu muốn báo dày hơn.
- `ALERT_LABELS=person,car` → cảnh báo cả xe hơi.

### Cảnh báo theo giờ

Sửa `alerter/index.js`, hàm `handleEvent`, thêm sớm:
```js
const hour = new Date().getHours();
if (hour >= 7 && hour < 22) {
  log('Bỏ qua: ngoài giờ cảnh báo');
  return;
}
```

### Đẩy clip lên Google Drive

Frigate lưu clip vào `./storage/clips/`. Thêm service rclone vào docker-compose:
```yaml
  rclone:
    image: rclone/rclone:latest
    container_name: rclone
    restart: unless-stopped
    volumes:
      - ./storage:/data:ro
      - ~/.config/rclone:/config/rclone:ro
    command: >
      sh -c "while true; do
        rclone copy /data/clips gdrive:FrigateClips/ --min-age 5m --quiet;
        sleep 600;
      done"
```

## Troubleshoot

**Frigate không kết nối được camera**
- `docker compose logs frigate | grep -i error`
- Test RTSP từ máy chạy Frigate: `ffmpeg -rtsp_transport tcp -i "$FRIGATE_CAM01_URL" -t 5 -f null -`
- Cam có thể giới hạn số client → đảm bảo bạn không đang xem trên VLC cùng lúc.

**CPU 100% liên tục**
- Giảm `fps: 5` xuống `3` trong `detect`.
- Giảm `detect.width/height` xuống `640x480`.
- Bật restream với sub-stream low-res của cam (đa số cam có).
- Mua Coral TPU.

**Telegram không nhận tin nhắn**
- `docker compose logs alerter`
- Token sai → log sẽ báo `Telegram getMe lỗi`.
- Chat_id sai → API call thành công nhưng tin không đến. Test thủ công:
  `curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>&text=hi"`

**Snapshot trống/đen**
- Bình thường với event `new` rất ngắn → alerter đã có retry 5 lần.
- Nếu mọi snapshot đều lỗi, vào Frigate UI xem event đó có ảnh không. Nếu không có → tăng `snapshots.required_zones` để bỏ qua event rác.

**MQTT không kết nối**
- Test từ host: `docker run --rm -it --network=frigate-alert_default eclipse-mosquitto mosquitto_sub -h mosquitto -t 'frigate/#' -v`
- Sẽ thấy mọi event Frigate publish.

## Bảo mật

Setup này mặc định **chỉ chạy trong LAN**. Đừng expose port 5000/1883 ra Internet trực tiếp. Nếu muốn xem Frigate từ xa, dùng Cloudflare Tunnel hoặc Tailscale (xem trao đổi trước).

Nếu buộc phải expose:
- Đặt nginx/Caddy trước Frigate với basic auth + HTTPS.
- Bật authentication cho Mosquitto (`password_file`).
- Đổi `allow_anonymous` thành `false`.

## Cấu trúc file

```
frigate-alert/
├── docker-compose.yml          # 3 service: mosquitto + frigate + alerter
├── .env                        # Secrets (tạo từ .env.example)
├── .env.example
├── config/
│   └── config.yml              # Frigate config
├── mosquitto/
│   └── mosquitto.conf
├── storage/                    # Frigate records + clips (auto-tạo)
└── alerter/
    ├── Dockerfile
    ├── package.json
    └── index.js                # ~180 dòng, dễ chỉnh
```
