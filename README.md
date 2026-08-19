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
- Multi-timeframe Fibonacci opsional untuk membangun support/resistance dan level grid dari candle yang sudah close.
- Notifikasi, status berkala, dan command operasional via Telegram.
- Dashboard web live untuk chart harga, order grid aktif, fill, dan hasil profit.

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

### Versi Futures USD-M

Implementasi futures terpisah tersedia di `futures-grid.js`. Bot memakai Binance
USD-M perpetual, Hedge Mode, dan hanya mengelola sisi `LONG`. Mulai dengan
credential Binance Futures Demo Trading dan simbol unified CCXT seperti
`BTC/USDT:USDT`.

```bash
npm run start:futures
```

Gunakan `futures-env.example` sebagai template `.env`. Saat startup bot mengatur
Hedge Mode, margin `ISOLATED`/`CROSSED`, dan leverage per simbol. Order grid
selalu membawa `positionSide=LONG`; `reduceOnly` tidak dikirim karena Binance
menolaknya pada Hedge Mode. Jika `GRID_POST_ONLY=true`, order yang akan langsung
match ditolak dan tidak diulang sebagai taker order.

Khusus versi futures, `GRID_STOP_LOSS_PRICE` dan `GRID_TAKE_PROFIT_PRICE`
digunakan sebagai persentase ROI posisi meskipun nama variabelnya masih memakai
akhiran `PRICE`. Default `-100` dan `100`: bot menutup seluruh LONG ketika ROI
mencapai -100% atau +100%. Bot membatalkan semua order grid sebelum market SELL,
lalu menghentikan simbol tersebut sampai bot direstart. Nilai `0` menonaktifkan
batas ROI yang bersangkutan.

Laporan futures memisahkan realized profit dari grid dan market exit, mencatat
trading fee setiap fill, menyinkronkan funding income Binance, serta menampilkan
unrealized PnL posisi aktif. Nilai `net` adalah realized trading profit ditambah
funding dan unrealized PnL. `FUNDING_SYNC_INTERVAL_MINUTES` mengatur interval
sinkronisasi funding dengan default 60 menit.

Gemini Smart Range Advisor juga tersedia pada futures. Seluruh variabelnya ada
di `futures-env.example`. Advisor hanya merekomendasikan batas grid berdasarkan
OHLCV dan indikator; pengelolaan posisi tetap long-only dan exit tetap mengikuti
batas ROI futures.

Referensi resmi Binance:

- https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order
- https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Position-Mode
- https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Margin-Type
- https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Initial-Leverage
- https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information

Saat berjalan, bot akan validasi konfigurasi, membersihkan temp file state, mengambil process lock, lalu sinkronisasi order dan fill setiap `INTERVAL_MINUTES`.

### Dashboard Live

Dashboard berbasis Bootstrap dan Alpine.js aktif secara default. Alamat awalnya `http://127.0.0.1:3000` setelah bot selesai melakukan inisialisasi. Jika port tersebut sudah dipakai, server otomatis mencoba `3001`, `3002`, dan seterusnya sampai menemukan port kosong; alamat yang terpilih ditampilkan pada log `[DASHBOARD]`. Data chart, order, dan profit diambil langsung dari engine serta exchange, lalu diperbarui otomatis tanpa perlu refresh halaman.

- `DASHBOARD_ENABLED`: aktif/nonaktifkan dashboard. Default `true`.
- `DASHBOARD_HOST`: alamat bind server. Default `127.0.0.1`; gunakan `0.0.0.0` hanya jika dashboard perlu diakses dari jaringan dan sudah dilindungi firewall/reverse proxy.
- `DASHBOARD_PORT`: port dashboard. Default `3000`.
- `DASHBOARD_REFRESH_SECONDS`: interval refresh data, minimal 2 detik. Default `5`.
- `DASHBOARD_CHART_TIMEFRAME`: timeframe candle chart CCXT, misalnya `1m`, `5m`, atau `1h`. Default `1m`.
- `DASHBOARD_CHART_LIMIT`: jumlah candle yang ditampilkan, minimal 20. Default `120`.

## Struktur Kode

- `index.js`: entrypoint, validasi runtime, process lock, dan bootstrap engine.
- `src/config.js`: parser `.env`, konstanta runtime, dan validasi konfigurasi.
- `src/spot-grid-engine.js`: alur utama grid bot dan rekonsiliasi symbol.
- `src/order-execution.js`: fetch context, recovery managed order, cancel order, dan place limit order.
- `src/trailing-range.js`: trailing up/down, remap level index, dan helper trailing.
- `src/telegram-controller.js`: alert, status report, dan command Telegram.
- `src/dashboard-server.js`: server dashboard dan API snapshot live.
- `public/dashboard.html`: antarmuka chart, order, dan profit.
- `src/grid-state.js`: state grid lokal dan processed trade id.
- `src/fibonacci-range-advisor.js`: confluence Fibonacci multi-timeframe dari candle yang sudah close.
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
- `GRID_MAX_REFILLS`: batas buy refill per grid level setelah sell selesai. Default `2`; order sell untuk menutup inventory tetap dibuat agar posisi tidak tertahan.
- `GRID_POST_ONLY`: gunakan maker/post-only order jika exchange mendukung.
- `GRID_PRICE_PRECISION_MAX_DEVIATION_PCT`: toleransi perubahan harga setelah dibulatkan mengikuti precision exchange.
- `BINANCE_SPOT_MAKER_FEE_RATE`: asumsi fee maker Binance Spot per sisi untuk prompt AI. Default `0.001` atau 0.1%; gunakan `0.00075` jika fee dibayar pakai BNB dengan diskon 25%, atau sesuaikan dengan tier VIP/pair akun.
- `GRID_MIN_NET_PROFIT_PCT`: target profit bersih minimum per jarak grid setelah fee buy+sell. Default `0.05` atau 0.05%.

## State Dan Lock

- `GRID_STATE_FILE`: file state grid lokal.
- `BOT_LOCK_FILE`: file lock process. Jangan pakai file lock yang sama untuk dua proses bot.
- `BOT_LOCK_STALE_GRACE_MS`: waktu tunggu sebelum bot memeriksa ulang dan membersihkan stale lock secara otomatis. Lock tidak dihapus jika PID pemilik masih aktif atau identitas lock berubah selama waktu tunggu.

Default file runtime:

- `grid-state-spot.json`
- `grid-state-spot.json.lock`
- `gemini-range-advisor-state.json`
- `fibonacci-range-advisor-state.json`
- `bot-paused.flag`

File runtime tersebut diabaikan lewat `.gitignore`.

## Safety

- `STOP_TRADING=true`: bot tidak menempatkan order baru.
- `KILL_SWITCH_ENABLED`: bot pause jika file `KILL_SWITCH_FILE` ada. Default `true`.
- `KILL_SWITCH_FILE`: nama file pause lokal.
- `GRID_STOP_LOSS_PRICE`: cancel grid dan stop order baru jika harga <= nilai ini. `0` berarti nonaktif.
- `GRID_TAKE_PROFIT_PRICE`: cancel grid dan stop order baru jika harga >= nilai ini. `0` berarti nonaktif.

## Multi-timeframe Fibonacci Range Advisor

Advisor Fibonacci membangun level deterministik dari high/low candle terakhir yang sudah close pada banyak timeframe. Setiap candle menghasilkan retracement `0` sampai `1` serta extension di atas dan di bawah candle. Harga Fibonacci yang berdekatan digabung menjadi zona confluence berbobot; timeframe besar dan rasio golden ratio `0.618`/`1.618` mendapat bobot lebih tinggi.

Aktifkan dengan:

```env
FIBONACCI_RANGE_ADVISOR_ENABLED=true
FIBONACCI_RANGE_ADVISOR_TIMEFRAMES=all
```

Nilai `all` memakai seluruh timeframe OHLCV yang dilaporkan Binance. Untuk mengurangi request atau noise timeframe sangat kecil, isi daftar eksplisit seperti `5m,15m,1h,4h,1d,1w`. Advisor mengambil ulang setiap timeframe hanya setelah candle timeframe tersebut close, kemudian menyimpan hasilnya di cache lokal.

- `FIBONACCI_RANGE_ADVISOR_RATIOS`: retracement dan extension yang dihitung. Default `0,0.236,0.382,0.5,0.618,0.786,1,1.272,1.618,2,2.618`.
- `FIBONACCI_RANGE_ADVISOR_CANDLE_CLOSE_BUFFER_SECONDS`: jeda setelah boundary close agar candle exchange sudah final.
- `FIBONACCI_RANGE_ADVISOR_CLUSTER_TOLERANCE_PCT`: jarak maksimum dua harga untuk digabung menjadi satu zona confluence.
- `FIBONACCI_RANGE_ADVISOR_MIN_CLUSTER_SCORE`: skor minimum zona yang boleh menjadi level grid.
- `FIBONACCI_RANGE_ADVISOR_MIN_RANGE_WIDTH_PCT`: lebar minimum range terhadap harga saat ini. Range tetap harus cukup lebar untuk `GRID_COUNT`, fee, dan target profit.
- `FIBONACCI_RANGE_ADVISOR_MAX_DISTANCE_PCT`: batas jarak level dari harga saat ini agar extension timeframe besar tidak membuat range tidak terkendali.
- `FIBONACCI_RANGE_ADVISOR_REBUILD_THRESHOLD_PCT`: perubahan median minimum pada seluruh level sebelum grid lama boleh diganti. Satu level ekstrem tidak cukup untuk memicu cancel/rebuild seluruh grid.
- `FIBONACCI_RANGE_ADVISOR_REBUILD_COOLDOWN_MINUTES`: cooldown cancel/remap/rebuild order setelah rekomendasi diterapkan.
- `FIBONACCI_RANGE_ADVISOR_APPLY_ON`: `AUTO_RANGE_ONLY` atau `ALWAYS`, sama seperti advisor Gemini.
- `FIBONACCI_RANGE_ADVISOR_ALLOW_TRAILING`: default `false`. Trailing dijeda ketika Fibonacci menguasai range agar level tidak bergeser dari zona candle lalu dibangun ulang pada siklus berikutnya.
- `FIBONACCI_RANGE_ADVISOR_STATE_FILE`: cache candle dan rekomendasi terakhir.

Advisor selalu meminta tepat `GRID_COUNT + 1` level yang mengelilingi harga saat ini dan memenuhi jarak profit minimum sebelum precision exchange. Mesin grid melakukan validasi tick size dan fee sekali lagi. Jika level Fibonacci tidak dapat dipakai, bot fallback ke Gemini (jika aktif), lalu ke range/level lokal yang sudah ada. Jika Fibonacci dan Gemini sama-sama aktif, Fibonacci memiliki prioritas.

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
