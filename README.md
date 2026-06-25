# Binance Spot Grid Bot

Bot grid spot Binance berbasis Node.js. Bot membaca konfigurasi dari `.env`, menyimpan state lokal, memakai lock file agar tidak berjalan ganda, dan dapat berjalan di Binance Spot testnet maupun live.

## Fitur

- Binance Spot grid bot untuk satu atau banyak pair, contoh `BTC/USDT,ETH/USDT`.
- Mode exchange `live`, `testnet`, atau `demo` (`demo` dipetakan ke `testnet`).
- Grid `ARITHMETIC` atau `GEOMETRIC`.
- Range manual, auto range, stale range auto reset, trailing up, dan trailing down.
- Batas modal per order atau total investasi grid.
- Refill order setelah fill, cancel order out-of-range, post-only maker order, dan recovery metadata order dari `clientOrderId`.
- Stop trading manual, kill switch file, stop-loss, dan take-profit.
- Validasi AI opsional via Gemini.
- Learning memory opsional dari hasil profit aktual.
- Notifikasi WhatsApp opsional via Fonnte.

## Kebutuhan

- Node.js 18+.
- Akun Binance Spot.
- API key dan secret Binance Spot. Untuk `testnet`, gunakan credential dari Binance Spot Testnet.

## Instalasi

```bash
npm install
```

## Setup Cepat

1. Salin `env.example` menjadi `.env`.
2. Isi `EXCHANGE_API_KEY` dan `EXCHANGE_SECRET`.
3. Mulai dari `EXCHANGE_MODE=testnet` untuk uji coba.
4. Sesuaikan `SYMBOLS`, `GRID_COUNT`, `GRID_ORDER_SIZE_USDT`, dan pengaturan range.
5. Jalankan test sebelum start bot.

Contoh minimal:

```env
EXCHANGE_API_KEY=your_binance_api_key_here
EXCHANGE_SECRET=your_binance_secret_here
EXCHANGE_MODE=testnet
SYMBOLS=BTC/USDT
GRID_ORDER_SIZE_USDT=20
```

## Menjalankan

```bash
npm start
```

Atau langsung:

```bash
node index.js
```

Saat berjalan, bot akan:

1. Validasi konfigurasi.
2. Membersihkan temp file state yang tertinggal dari proses sebelumnya.
3. Mengambil lock process.
4. Sinkronisasi order dan fill per symbol setiap `INTERVAL_MINUTES`.

## Test

```bash
npm test
```

## Konfigurasi Utama

- `EXCHANGE_MODE`: `live`, `testnet`, atau `demo`. Nilai `demo` diperlakukan sebagai `testnet`.
- `EXCHANGE_DEMO`: fallback legacy jika `EXCHANGE_MODE` tidak diisi.
- `SYMBOLS`: pair dipisah koma, contoh `BTC/USDT,ETH/USDT`.
- `INTERVAL_MINUTES`: jarak antar siklus sinkronisasi.
- `GRID_MODE`: `ARITHMETIC` atau `GEOMETRIC`.
- `GRID_COUNT`: jumlah level grid, minimal 2.

Nilai boolean menerima `true`, `false`, `1`, `0`, `yes`, `no`, `on`, atau `off`.

## Range Grid

- `GRID_LOWER_PRICE` dan `GRID_UPPER_PRICE`: isi keduanya untuk range manual. Jika salah satu saja diisi, konfigurasi dianggap invalid.
- `GRID_RANGE_PCT`: range otomatis `+/-` dari harga saat range dibuat.
- `GRID_RESET_RANGE_ON_START`: paksa hitung ulang auto range saat start.
- `GRID_STALE_RANGE_DEVIATION_PCT`: ambang deteksi range lama yang terlalu jauh dari harga.
- `GRID_STALE_RANGE_AUTO_RESET`: otomatis reset stale range.

Trailing range hanya aktif untuk auto range. Jika range manual dipakai, trailing up/down tidak menggeser range.

- `GRID_TRAILING_RANGE_ENABLED`: default global untuk trailing up/down.
- `GRID_TRAILING_UP_ENABLED`: aktifkan range mengikuti kenaikan harga.
- `GRID_TRAILING_UP_COOLDOWN_MINUTES`: jeda minimal antar trailing up.
- `GRID_TRAILING_DOWN_ENABLED`: aktifkan range mengikuti penurunan harga.
- `GRID_TRAILING_DOWN_COOLDOWN_MINUTES`: jeda minimal antar trailing down. Jika tidak diisi, fallback ke cooldown trailing up.

## Modal dan Order

- `GRID_ORDER_SIZE_USDT`: ukuran target order per grid.
- `ORDER_SIZE_USDT`: fallback legacy jika `GRID_ORDER_SIZE_USDT` tidak diisi.
- `GRID_TOTAL_INVESTMENT_USDT`: jika lebih dari 0, menjadi batas total modal dan mengambil prioritas. Ukuran efektif per grid menjadi `GRID_TOTAL_INVESTMENT_USDT / GRID_COUNT`.
- `GRID_MAX_ACTIVE_BUY_ORDERS`: batas order buy aktif per symbol.
- `GRID_MAX_ACTIVE_SELL_ORDERS`: batas order sell aktif per symbol.
- `GRID_RECREATE_ON_START`: cancel dan buat ulang grid saat bot start.
- `GRID_CANCEL_OUT_OF_RANGE`: cancel order yang sudah keluar range.
- `GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MINUTES`: umur minimal order sebelum boleh dibatalkan karena out-of-range.
- `GRID_REFILL_ON_FILLED`: buat order pengganti setelah fill.
- `GRID_POST_ONLY`: gunakan maker/post-only order jika exchange mendukung.
- `GRID_PRICE_PRECISION_MAX_DEVIATION_PCT`: toleransi perubahan harga setelah pembulatan precision exchange.

## Safety

- `STOP_TRADING=true`: bot tidak menempatkan order baru.
- `KILL_SWITCH_ENABLED=true`: bot pause jika file `KILL_SWITCH_FILE` ada.
- `KILL_SWITCH_FILE`: nama file pause lokal, default `bot-paused.flag`.
- `GRID_STOP_LOSS_PRICE`: cancel grid dan stop order baru jika harga <= nilai ini.
- `GRID_TAKE_PROFIT_PRICE`: cancel grid dan stop order baru jika harga >= nilai ini.

## AI Validation

Aktifkan dengan:

```env
AI_VALIDATION_ENABLED=true
GEMINI_API_KEY=your_gemini_api_key_here
```

Konfigurasi terkait:

- `GEMINI_MODEL`: model Gemini yang dipakai.
- `AI_VALIDATION_TIMEFRAME`: timeframe OHLCV untuk konteks AI.
- `AI_VALIDATION_LOOKBACK`: jumlah candle yang diambil.
- `AI_VALIDATION_CACHE_TTL_MS`: durasi cache keputusan AI.
- `AI_VALIDATION_MIN_INTERVAL_MS`: jarak minimal antar request AI per symbol.
- `AI_VALIDATION_BACKOFF_MS`: jeda saat rate limited/error berulang.
- `AI_VALIDATION_PRICE_BUCKET_PCT`: bucket harga untuk cache.
- `AI_VALIDATION_RETRIES`: jumlah retry request AI.
- `AI_VALIDATION_TIMEOUT_MS`: timeout request AI.
- `AI_MIN_CONFIDENCE`: confidence minimal agar keputusan AI dipakai.

Jika AI tidak aktif, bot tetap berjalan dengan validasi lokal.

## Learning Memory

Aktifkan dengan:

```env
LEARNING_MEMORY_ENABLED=true
```

- `LEARNING_MEMORY_FILE`: file penyimpanan memory lokal.
- `LEARNING_MEMORY_LOOKBACK`: jumlah outcome terakhir yang dievaluasi.
- `LEARNING_MEMORY_MIN_SAMPLES`: minimal sample sebelum memory memengaruhi keputusan.

Learning memory memakai data profit aktual dari fill order dan tidak memakai env threshold profit khusus.

## Alert Fonnte

Aktifkan dengan:

```env
FONNTE_ENABLED=true
FONNTE_TOKEN=your_fonnte_token
FONNTE_TARGET=628xxxxxxxxxx
```

- `FONNTE_API_URL`: endpoint Fonnte.
- `FONNTE_COUNTRY_CODE`: kode negara target.
- `FONNTE_TIMEOUT_MS`: timeout request alert.

## File Lokal

Default file yang dibuat bot:

- `grid-state-spot.json`
- `grid-state-spot.json.lock`
- `learning-memory.json`
- `bot-paused.flag`

File runtime tersebut sudah diabaikan lewat `.gitignore`.

## Catatan Operasional

- Selalu uji di `testnet` sebelum memakai `live`.
- Pastikan saldo, minimum notional exchange, dan ukuran order sesuai pair yang dipakai.
- Jangan menjalankan dua proses bot dengan state file yang sama. Lock file akan menolak proses kedua.
- Backup state sebelum mengubah range atau mengganti symbol secara besar-besaran.