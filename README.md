# Binance Spot Grid Bot

Bot trading Binance Spot berbasis Node.js yang menjalankan strategi grid bergaya Binance: memasang limit buy di bawah harga berjalan, limit sell di atas harga berjalan, dan mengisi ulang order lawan ketika order grid terisi.

> Peringatan: trading crypto tetap berisiko. Mulai dari nominal kecil, gunakan API key dengan permission terbatas, dan cek semua parameter sebelum menjalankan di akun live.

## Catatan Penting

Binance tidak menyediakan endpoint publik standar untuk membuat atau mengelola Spot Grid Bot bawaan Binance lewat API biasa. Project ini memakai order spot Binance via `ccxt` untuk menjalankan mekanisme grid yang serupa secara lokal.

## Fitur

- Binance Spot grid untuk satu atau beberapa symbol.
- Grid arithmetic atau geometric.
- Range manual (`GRID_LOWER_PRICE` dan `GRID_UPPER_PRICE`) atau range otomatis dari harga berjalan.
- Batas jumlah active buy/sell order agar saldo tidak langsung terkunci semua.
- Refill order setelah fill: buy terisi akan memasang sell di level atas, sell terisi akan memasang buy di level bawah.
- Validasi optional dengan Gemini AI sebelum memasang/refill order baru.
- State lokal di `grid-state-spot.json`.
- Kill switch via env atau file `bot-paused.flag`.
- Alert optional via Fonnte.

## Instalasi

```bash
pnpm install
```

Atau:

```bash
npm install
```

## Konfigurasi

Salin file contoh environment:

```powershell
Copy-Item env.example .env
```

Isi API key Binance:

```env
EXCHANGE_API_KEY=your_binance_api_key
EXCHANGE_SECRET=your_binance_secret
EXCHANGE_MODE=live
```

Mode exchange yang tersedia:

```env
EXCHANGE_MODE=live
EXCHANGE_MODE=demo
EXCHANGE_MODE=testnet
```

- `live`: Binance live API.
- `demo`: Binance Demo Trading API (`https://demo-api.binance.com`).
- `testnet`: Binance Spot Testnet lama (`https://testnet.binance.vision`).

Untuk demo, buat API key dari Binance Demo Trading: https://demo.binance.com/en/my/settings/api-management. Untuk testnet, gunakan key Spot Testnet. Jangan memakai API key live untuk demo/testnet.

Contoh grid konservatif:

```env
SYMBOLS=BTC/USDT
INTERVAL_MINUTES=1
GRID_MODE=ARITHMETIC
GRID_COUNT=10
GRID_LOWER_PRICE=0
GRID_UPPER_PRICE=0
GRID_RANGE_PCT=5
GRID_ORDER_SIZE_USDT=20
GRID_MAX_ACTIVE_BUY_ORDERS=5
GRID_MAX_ACTIVE_SELL_ORDERS=5
GRID_RECREATE_ON_START=false
AI_VALIDATION_ENABLED=false
```

Jika `GRID_LOWER_PRICE` dan `GRID_UPPER_PRICE` bernilai `0`, bot membuat range otomatis saat grid pertama kali dibuat: harga saat itu plus/minus `GRID_RANGE_PCT`. Range tersebut disimpan di `grid-state-spot.json` agar tidak bergeser setiap siklus.

Dynamic re-centering opsional dapat diaktifkan untuk menggeser auto-range setelah harga bertahan dekat batas:

```env
GRID_DYNAMIC_RANGE=true
GRID_RECENTER_TRIGGER_PCT=10
GRID_RECENTER_CONFIRM_CYCLES=3
GRID_RECENTER_COOLDOWN_MINUTES=60
GRID_RECENTER_ALLOW_DOWN=false
```

Dengan konfigurasi tersebut, harga harus berada dalam 10% area dekat batas selama 3 siklus berturut-turut. Setelah re-center, bot menunggu 60 menit sebelum dapat menggeser range lagi. Re-center turun diblokir selama masih ada posisi hasil buy grid yang belum terjual.

## Menjalankan Bot

```bash
node index.js
```

Bot akan:

1. Load market Binance spot.
2. Hitung level grid.
3. Sinkron order grid yang tersimpan di state lokal.
4. Pasang order buy di bawah harga dan sell di atas harga sesuai saldo.
5. Setiap siklus, cek fill, refill order lawan, dan bersihkan order di luar range.

## Parameter Grid

```env
GRID_MODE=ARITHMETIC
GRID_COUNT=10
GRID_LOWER_PRICE=0
GRID_UPPER_PRICE=0
GRID_RANGE_PCT=5
GRID_ORDER_SIZE_USDT=20
GRID_TOTAL_INVESTMENT_USDT=0
GRID_MAX_ACTIVE_BUY_ORDERS=5
GRID_MAX_ACTIVE_SELL_ORDERS=5
GRID_MIN_PROFIT_PCT=0.1
```

- `GRID_MODE`: `ARITHMETIC` untuk jarak harga tetap, `GEOMETRIC` untuk jarak persentase tetap.
- `GRID_COUNT`: jumlah interval grid. Bot membuat `GRID_COUNT + 1` level harga.
- `GRID_ORDER_SIZE_USDT`: nominal per order grid.
- `GRID_TOTAL_INVESTMENT_USDT`: jika lebih dari `0`, modal dibagi rata ke jumlah grid.
- `GRID_MIN_PROFIT_PCT`: jarak minimal sell refill dari harga buy agar tidak terlalu tipis.

## Gemini AI Validation

AI validation bersifat optional. Saat aktif, Gemini hanya menjadi filter untuk order baru dan refill order. Bot tetap mengelola order lama yang sudah terbuka.

```env
GEMINI_API_KEY=your_gemini_api_key
AI_VALIDATION_ENABLED=true
GEMINI_MODEL=gemini-2.0-flash-lite
AI_VALIDATION_TIMEFRAME=15m
AI_VALIDATION_LOOKBACK=40
AI_VALIDATION_CACHE_TTL_MS=900000
AI_VALIDATION_MIN_INTERVAL_MS=300000
AI_VALIDATION_BACKOFF_MS=900000
AI_VALIDATION_PRICE_BUCKET_PCT=0.25
AI_VALIDATION_RETRIES=1
AI_MIN_CONFIDENCE=60
```

Jika Gemini menolak kondisi market, bot tidak memasang order baru pada siklus itu. Jika validasi AI gagal atau confidence di bawah `AI_MIN_CONFIDENCE`, bot juga tidak memasang order baru.

Untuk mengurangi risiko rate limit Gemini:

- `AI_VALIDATION_CACHE_TTL_MS`: berapa lama keputusan AI dipakai ulang.
- `AI_VALIDATION_MIN_INTERVAL_MS`: jeda minimum panggilan Gemini per symbol.
- `AI_VALIDATION_BACKOFF_MS`: jeda otomatis setelah respons rate limit/quota.
- `AI_VALIDATION_PRICE_BUCKET_PCT`: perubahan harga kecil tetap memakai cache yang sama.
- `AI_VALIDATION_RETRIES`: gunakan nilai kecil karena retry juga menghabiskan quota.

## Reset atau Buat Ulang Grid

Untuk membatalkan order grid lama saat startup:

```env
GRID_RECREATE_ON_START=true
```

Gunakan dengan hati-hati karena order grid yang masih terbuka akan dibatalkan.

## Kill Switch

Matikan siklus trading baru lewat `.env`:

```env
STOP_TRADING=true
```

Atau buat file:

```powershell
New-Item bot-paused.flag
```

Hapus file tersebut untuk mengizinkan bot berjalan lagi.

## File Runtime

- `grid-state-spot.json`: state order grid dan estimasi profit.
- `bot-paused.flag`: kill switch file jika diaktifkan.

## Disclaimer

Project ini untuk edukasi dan eksperimen. Tidak ada jaminan profit. Semua keputusan trading dan risiko finansial sepenuhnya menjadi tanggung jawab pengguna.
