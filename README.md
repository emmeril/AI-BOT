# Binance Spot Grid Bot

Bot grid spot Binance berbasis Node.js. Bot membaca konfigurasi dari `.env`, menyimpan state lokal, memakai lock file agar tidak berjalan ganda, dan dapat berjalan di Binance Spot `testnet` maupun `live`.

Entrypoint runtime ada di `index.js`; implementasi utama sudah dipisah ke modul `src/` agar lebih mudah dirawat.

## Fitur

- Trading grid spot untuk satu atau banyak pair, contoh `BTC/USDT,ETH/USDT`.
- Mode exchange `live`, `testnet`, atau `demo` (`demo` diperlakukan sebagai `testnet`; default aman adalah `testnet`).
- Grid `ARITHMETIC` atau `GEOMETRIC`.
- Range manual, auto range, stale range auto reset, trailing up, dan trailing down.
- Batas modal per order atau total modal grid.
- Refill order setelah fill, cancel order out-of-range, post-only maker order, dan recovery order dari `clientOrderId`.
- Stop trading manual, kill switch file, stop-loss, dan take-profit.
- Smart Range Advisor opsional via Gemini untuk menyarankan range grid.
- Notifikasi, status berkala, dan command operasional via Telegram.

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
3. Mulai dari `EXCHANGE_MODE=testnet`.
4. Sesuaikan `SYMBOLS`, `GRID_COUNT`, `GRID_ORDER_SIZE_USDT`, dan range.
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

Saat berjalan, bot akan validasi konfigurasi, membersihkan temp file state, mengambil process lock, lalu sinkronisasi order dan fill setiap `INTERVAL_MINUTES`.

## Struktur Kode

- `index.js`: entrypoint, validasi runtime, process lock, dan bootstrap engine.
- `src/config.js`: parser `.env`, konstanta runtime, dan validasi konfigurasi.
- `src/spot-grid-engine.js`: alur utama grid bot dan rekonsiliasi symbol.
- `src/order-execution.js`: fetch context, recovery managed order, cancel order, dan place limit order.
- `src/trailing-range.js`: trailing up/down, remap level index, dan helper trailing.
- `src/telegram-controller.js`: alert, status report, dan command Telegram.
- `src/grid-state.js`: state grid lokal dan processed trade id.
- `src/gemini-range-advisor.js`: indikator teknikal dan Smart Range Advisor Gemini.
- `src/process-lock.js`: lock file satu proses.
- `src/atomic-file-writer.js`: penulisan state/cache atomik.
- `src/exchange-manager.js`: singleton Binance spot exchange via ccxt.
- `src/utils.js`: helper umum.

## Test

```bash
npm test
```

## Format Nilai

Boolean menerima `true`, `false`, `1`, `0`, `yes`, `no`, `on`, atau `off`.

Angka persen ditulis sebagai angka biasa. Contoh `GRID_RANGE_PCT=5` berarti 5%.

## Exchange

- `EXCHANGE_API_KEY`: API key Binance.
- `EXCHANGE_SECRET`: secret key Binance.
- `EXCHANGE_MODE`: `live`, `testnet`, atau `demo`. Nilai `demo` diperlakukan sebagai `testnet`.
- `EXCHANGE_DEMO`: legacy flag lama. Gunakan `EXCHANGE_MODE`; jika kosong, bot default ke `testnet`.
- `SYMBOLS`: daftar pair dipisah koma, contoh `BTC/USDT,ETH/USDT`.
- `INTERVAL_MINUTES`: jarak antar siklus sinkronisasi.

## Grid

- `GRID_MODE`: `ARITHMETIC` atau `GEOMETRIC`.
- `GRID_COUNT`: jumlah grid, minimal 2.
- `GRID_LOWER_PRICE` dan `GRID_UPPER_PRICE`: isi keduanya untuk range manual. Jika salah satu saja diisi, konfigurasi invalid.
- `GRID_RANGE_PCT`: range otomatis di sekitar harga saat range dibuat.
- `GRID_RESET_RANGE_ON_START`: hitung ulang auto range saat bot start.
- `GRID_STALE_RANGE_DEVIATION_PCT`: ambang deteksi stored range yang terlalu jauh dari harga saat ini.
- `GRID_STALE_RANGE_AUTO_RESET`: otomatis reset stored range yang stale.

Trailing range hanya berlaku untuk auto range. Manual range tidak digeser oleh trailing.

- `GRID_TRAILING_RANGE_ENABLED`: default global untuk trailing up dan down.
- `GRID_TRAILING_UP_ENABLED`: aktifkan range mengikuti kenaikan harga.
- `GRID_TRAILING_UP_COOLDOWN_MINUTES`: cooldown trailing up.
- `GRID_TRAILING_DOWN_ENABLED`: aktifkan range mengikuti penurunan harga.
- `GRID_TRAILING_DOWN_COOLDOWN_MINUTES`: cooldown trailing down. Jika kosong, fallback ke cooldown trailing up.

## Modal Dan Order

- `GRID_ORDER_SIZE_USDT`: target ukuran order per grid level.
- `ORDER_SIZE_USDT`: fallback legacy jika `GRID_ORDER_SIZE_USDT` kosong.
- `GRID_TOTAL_INVESTMENT_USDT`: jika lebih dari 0, menjadi batas total modal grid dan mengambil prioritas. Ukuran efektif per grid menjadi `GRID_TOTAL_INVESTMENT_USDT / GRID_COUNT`.
- `GRID_MAX_ACTIVE_BUY_ORDERS`: batas order buy aktif per symbol.
- `GRID_MAX_ACTIVE_SELL_ORDERS`: batas order sell aktif per symbol.
- `GRID_RECREATE_ON_START`: cancel dan buat ulang grid saat bot start.
- `GRID_CANCEL_OUT_OF_RANGE`: cancel managed order yang keluar range.
- `GRID_CANCEL_OUT_OF_RANGE_THRESHOLD_MINUTES`: umur minimal order sebelum boleh dicancel karena out-of-range.
- `GRID_REFILL_ON_FILLED`: buat order pengganti setelah fill.
- `GRID_POST_ONLY`: gunakan maker/post-only order jika exchange mendukung.
- `GRID_PRICE_PRECISION_MAX_DEVIATION_PCT`: toleransi perubahan harga setelah dibulatkan mengikuti precision exchange.

## State Dan Lock

- `GRID_STATE_FILE`: file state grid lokal.
- `BOT_LOCK_FILE`: file lock process. Jangan pakai file lock yang sama untuk dua proses bot.
- `BOT_LOCK_STALE_GRACE_MS`: waktu tunggu sebelum bot menolak stale lock. Hapus file lock manual hanya setelah memastikan tidak ada proses bot yang masih berjalan.

Default file runtime:

- `grid-state-spot.json`
- `grid-state-spot.json.lock`
- `gemini-range-advisor-state.json`
- `bot-paused.flag`

File runtime tersebut diabaikan lewat `.gitignore`.

## Safety

- `STOP_TRADING=true`: bot tidak menempatkan order baru.
- `KILL_SWITCH_ENABLED`: bot pause jika file `KILL_SWITCH_FILE` ada. Default `true`.
- `KILL_SWITCH_FILE`: nama file pause lokal.
- `GRID_STOP_LOSS_PRICE`: cancel grid dan stop order baru jika harga <= nilai ini. `0` berarti nonaktif.
- `GRID_TAKE_PROFIT_PRICE`: cancel grid dan stop order baru jika harga >= nilai ini. `0` berarti nonaktif.

## Smart Range Advisor Gemini

Aktifkan dengan:

```env
GEMINI_RANGE_ADVISOR_ENABLED=true
GEMINI_API_KEY=your_gemini_api_key_here
```

Advisor mengambil candle OHLCV, menghitung indikator teknikal lokal, lalu meminta Gemini menyarankan `lower`, `upper`, dan opsional `levels` untuk harga order grid. Rekomendasi hanya dipakai jika confidence memenuhi threshold dan range masih lolos safety clamp. Jika Gemini mengirim `levels`, jumlahnya harus tepat `GRID_COUNT + 1`, berurutan naik dari `lower` ke `upper`, tanpa duplikat, dan tetap distinct setelah precision exchange; kalau tidak valid bot fallback ke level lokal dari range.

- `GEMINI_API_KEY`: API key Gemini. Wajib jika advisor aktif.
- `GEMINI_MODEL`: model Gemini yang dipakai.
- `GEMINI_API_BASE_URL`: base URL Gemini API.
- `GEMINI_RANGE_ADVISOR_TIMEFRAME`: timeframe OHLCV untuk konteks analisis. Advisor hanya melakukan request setelah candle baru untuk timeframe ini close, bukan berdasarkan interval rolling.
- `GEMINI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_SECONDS`: jeda kecil setelah boundary candle close sebelum advisor mengambil candle, agar exchange punya waktu memfinalisasi candle terbaru.
- `GEMINI_RANGE_ADVISOR_CANDLE_LIMIT`: jumlah candle yang diambil.
- `GEMINI_RANGE_ADVISOR_MAX_SHIFT_PCT`: batas deviasi rekomendasi dari harga saat ini. Lower dan upper akan di-clamp agar tidak terlalu jauh.
- `GEMINI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT`: lebar minimal rekomendasi sebagai persen dari harga saat ini.
- `GEMINI_RANGE_ADVISOR_MIN_CONFIDENCE`: confidence minimal `0` sampai `1` agar rekomendasi dipakai.
- `GEMINI_RANGE_ADVISOR_TIMEOUT_MS`: timeout request Gemini.
- `GEMINI_RANGE_ADVISOR_APPLY_ON`: `AUTO_RANGE_ONLY` agar tidak mengubah range manual, atau `ALWAYS` agar boleh menimpa range manual.
- `GEMINI_RANGE_ADVISOR_STATE_FILE`: file cache rekomendasi lokal.

Jika advisor nonaktif, gagal, atau confidence di bawah threshold, bot tetap memakai range manual atau auto range lokal.

## Telegram Alert, Status, Dan Command

Aktifkan dengan:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

- `TELEGRAM_API_URL`: endpoint Telegram API.
- `TELEGRAM_TIMEOUT_MS`: timeout request Telegram.
- `TELEGRAM_STATUS_REPORT_ENABLED`: kirim laporan status berkala.
- `TELEGRAM_STATUS_REPORT_INTERVAL_MINUTES`: jarak antar laporan status.
- `TELEGRAM_COMMANDS_ENABLED`: aktifkan command dari chat Telegram yang sama dengan `TELEGRAM_CHAT_ID`.
- `TELEGRAM_COMMAND_POLL_INTERVAL_SECONDS`: interval polling command.
- `TELEGRAM_COMMANDS_SKIP_OLD_UPDATES`: abaikan command lama saat bot baru start.

Command yang tersedia:

- `/status`: ringkasan mode, pause/circuit, total fill/profit, harga, range, order aktif, dan saldo free per symbol.
- `/orders`: jumlah dan daftar ringkas order grid aktif.
- `/pause`: membuat `KILL_SWITCH_FILE` dan menghentikan order baru. Jika `KILL_SWITCH_ENABLED=false`, command ditolak agar tidak memberi sinyal pause palsu.
- `/resume`: menghapus `KILL_SWITCH_FILE`.
- `/help`: daftar command.

## Catatan Operasional

- Selalu uji di `testnet` sebelum memakai `live`.
- Pastikan saldo, minimum notional exchange, dan ukuran order cocok untuk pair yang dipakai.
- Jangan menjalankan dua proses bot dengan state file dan lock file yang sama.
- Backup state sebelum mengubah range atau mengganti symbol secara besar-besaran.
