# Smart Binance AI Futures Bot

Bot trading Binance Futures berbasis Node.js yang menggabungkan analisis teknikal multi-timeframe, filter risiko, dan validasi sinyal menggunakan Google Gemini AI.

> Peringatan: project ini berhubungan dengan futures trading yang berisiko tinggi. Gunakan testnet/demo terlebih dahulu. Jangan gunakan dana yang tidak siap hilang.

## Fitur Utama

- Scan multi-symbol untuk market Binance USDT Futures.
- Analisis teknikal dengan EMA, RSI, ATR, volume, funding rate, dan market regime.
- Validasi sinyal dengan Gemini AI.
- Mode `LONG_ONLY` untuk membatasi entry hanya ke posisi long.
- Risk guard: daily loss limit, consecutive loss limit, max notional, risk per trade, dan max open positions.
- Kill switch lewat environment variable atau file `bot-paused.flag`.
- Stop loss market dan take profit berbasis unrealized PnL profit.
- Profit ledger lokal untuk ringkasan realized PnL.
- Alert trade via Fonnte untuk info entry dan realized trade.
- AI explain log untuk audit keputusan sinyal.
- Walk-forward optimizer untuk mencari parameter yang lebih cocok dari data historis.

## Tech Stack

- Node.js CommonJS
- `ccxt` untuk koneksi Binance Futures
- `@google/generative-ai` untuk Gemini
- `dotenv` untuk konfigurasi environment
- `technicalindicators` untuk indikator teknikal

## Struktur Project

```text
.
|-- index.js                    # Bot trading utama
|-- walk-forward-optimizer.js   # Optimizer parameter berbasis data historis
|-- .env.example                # Contoh konfigurasi
|-- package.json
|-- pnpm-lock.yaml
`-- pnpm-workspace.yaml
```

File runtime seperti `.env`, `.env.tuned`, `profit-ledger.json`, `risk-state.json`, `walk-forward-report.json`, dan `ai-explain-log.jsonl` sengaja di-ignore dari Git.

## Instalasi

Clone repository, lalu install dependency:

```bash
pnpm install
```

Jika memakai npm:

```bash
npm install
```

## Konfigurasi

Salin file contoh environment:

```bash
cp .env.example .env
```

Di Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Lalu isi nilai berikut di `.env`:

```env
EXCHANGE_API_KEY=your_exchange_api_key
EXCHANGE_SECRET=your_exchange_secret
EXCHANGE_DEMO=true

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash-lite

FONNTE_ENABLED=true
FONNTE_TOKEN=your_fonnte_token
FONNTE_TARGET=62812xxxxxxx
```

Untuk awal penggunaan, sangat disarankan tetap memakai:

```env
EXCHANGE_DEMO=true
ORDER_SIZE_USDT=5
MAX_OPEN_POSITIONS=1
LONG_ONLY=true
```

## Menjalankan Bot

Jalankan bot utama:

```bash
node index.js
```

Bot akan menunggu candle berikutnya sesuai `INTERVAL_MINUTES`, lalu menjalankan siklus scan, validasi AI, risk check, dan eksekusi order jika ada setup yang lolos.

Kalau ingin lebih hemat rate limit AI, atur `SCAN_ROTATION_BATCH_SIZE` supaya bot hanya memeriksa sebagian simbol per siklus secara bergiliran. Misalnya `2` akan membuat bot scan 2 simbol dulu, lalu lanjut ke batch berikutnya di siklus berikutnya.

Saat mode rotating aktif, konfirmasi sinyal otomatis dipercepat ke `1` supaya setup yang lolos tidak keburu basi menunggu putaran scan berikutnya. Kalau rotating tidak aktif, bot kembali memakai `REQUIRED_CONFIRMATION`.

Bot juga punya cache ringan berbasis candle untuk market snapshot dan hasil AI. Itu membantu mengurangi hitungan indikator berulang dan panggilan Gemini yang sama. Kalau perlu, cache bisa dimatikan lewat `MARKET_SNAPSHOT_CACHE_ENABLED=false` atau `AI_SIGNAL_CACHE_ENABLED=false`.

## Menjalankan Optimizer

Optimizer dipakai untuk melakukan walk-forward test terhadap kombinasi parameter yang didefinisikan di `.env`.

```bash
pnpm optimize
```

Atau:

```bash
node walk-forward-optimizer.js
```

Output default:

- `walk-forward-report.json`
- `.env.tuned`

Nilai di `.env.tuned` bisa dijadikan referensi untuk memperbarui `.env`.

## Konfigurasi Penting

### Trading

```env
SYMBOLS=DOGE/USDT:USDT,1000SHIB/USDT:USDT,1000PEPE/USDT:USDT
MAX_OPEN_POSITIONS=1
LEVERAGE=10
ORDER_SIZE_USDT=5
TIMEFRAME=15m
HTF_TIMEFRAME=30m
INTERVAL_MINUTES=5
SCAN_ROTATION_BATCH_SIZE=2
MARKET_SNAPSHOT_CACHE_ENABLED=true
AI_SIGNAL_CACHE_ENABLED=true
CACHE_MAX_ENTRIES=500
```

### Risk Management

```env
RISK_PER_TRADE_PCT=1
MAX_DAILY_LOSS_PCT=3
MAX_DAILY_LOSS_USDT=0
MAX_CONSECUTIVE_LOSSES=3
MAX_POSITION_NOTIONAL_USDT=1000
MIN_RR=1.5
```

### Take Profit Unrealized PnL

Secara default bot tidak lagi memasang order `TAKE_PROFIT_MARKET` di exchange. Bot tetap memasang stop loss, lalu memonitor posisi terbuka selama waktu tunggu antarsiklus. Jika estimasi net unrealized PnL sudah profit setelah buffer fee, bot langsung menutup posisi dengan market reduce-only tanpa delay settle tambahan untuk TP unrealized.

```env
UNREALIZED_PROFIT_CLOSE_ENABLED=true
UNREALIZED_PROFIT_CLOSE_MIN_USDT=0
UNREALIZED_PROFIT_CLOSE_MIN_PCT=0
UNREALIZED_PROFIT_CLOSE_FEE_RATE=0.0004
UNREALIZED_PROFIT_CLOSE_FEE_SIDES=2
UNREALIZED_PROFIT_CLOSE_FEE_BUFFER_USDT=0
UNREALIZED_PROFIT_MONITOR_INTERVAL_MS=1000
```

Naikkan `UNREALIZED_PROFIT_CLOSE_MIN_USDT` atau `UNREALIZED_PROFIT_CLOSE_MIN_PCT` jika ingin posisi baru ditutup setelah estimasi net profit minimal tertentu. Bot mengurangi `unrealizedPnl` dengan estimasi fee `UNREALIZED_PROFIT_CLOSE_FEE_RATE * notional * UNREALIZED_PROFIT_CLOSE_FEE_SIDES` plus `UNREALIZED_PROFIT_CLOSE_FEE_BUFFER_USDT`, sehingga posisi tidak ditutup hanya karena gross unrealized PnL kecil yang masih habis oleh fee/slippage. Turunkan `UNREALIZED_PROFIT_MONITOR_INTERVAL_MS` jika ingin polling lebih cepat (minimum 250 ms). Set `UNREALIZED_PROFIT_CLOSE_ENABLED=false` untuk kembali memakai order TP exchange.

### AI Filter

```env
AI_FILTER_ENABLED=true
MIN_AI_CONFIDENCE=65
ALLOWED_AI_STRENGTHS=MEDIUM,STRONG,EXTREME
AI_RESPONSE_RETRIES=2
```

### Kill Switch

Matikan entry baru lewat `.env`:

```env
STOP_TRADING=true
```

Atau buat file:

```bash
touch bot-paused.flag
```

Di Windows PowerShell:

```powershell
New-Item bot-paused.flag
```

Hapus file tersebut untuk mengizinkan entry baru lagi.

## File Output Runtime

- `profit-ledger.json`: catatan realized PnL dan fee.
- `risk-state.json`: state risk harian, loss streak, dan cooldown symbol.
- `ai-explain-log.jsonl`: log keputusan AI dan alasan sinyal diterima/ditolak.
- `walk-forward-report.json`: hasil optimizer.
- `.env.tuned`: rekomendasi parameter dari optimizer.

## Catatan Keamanan

- Jangan commit `.env` atau API key.
- Aktifkan restriction API key di Binance.
- Gunakan key khusus futures testnet/demo saat pengujian.
- Mulai dari ukuran order kecil.
- Cek kembali semua parameter order sebelum menjalankan di akun live.
- Pastikan saldo dan leverage sesuai toleransi risiko.

## Disclaimer

Project ini hanya untuk edukasi dan eksperimen. Tidak ada jaminan profit. Semua keputusan trading dan risiko finansial sepenuhnya menjadi tanggung jawab pengguna.
