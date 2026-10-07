(() => {
  'use strict';

  const state = { data: null, activeNode: 'supervisor', timer: null, controller: null, requestId: 0, loading: true, refreshSpinTimer: null };
  const byId = id => document.getElementById(id);
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const nullable = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const intel = () => state.data?.intelligence || {};
  const quote = () => state.data?.profit?.quoteAsset || 'USDT';

  function text(id, value) { const element = byId(id); if (element) element.textContent = value; }
  function money(value, digits = 4) {
    const numeric = nullable(value);
    if (numeric === null) return 'N/A';
    return new Intl.NumberFormat('id-ID', { minimumFractionDigits: digits > 2 ? 2 : 0, maximumFractionDigits: digits }).format(numeric);
  }
  function percent(value, digits = 1) { const numeric = nullable(value); return numeric === null ? 'N/A' : `${money(numeric, digits)}%`; }
  function compact(value) { return new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 2 }).format(num(value)); }
  function signed(value, digits = 2) { const numeric = nullable(value); return numeric === null ? 'N/A' : `${numeric >= 0 ? '+' : ''}${money(numeric, digits)}`; }
  function price(value) {
    const numeric = nullable(value);
    if (numeric === null || numeric <= 0) return 'N/A';
    const digits = num(state.data?.market?.priceDigits);
    return new Intl.NumberFormat('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(numeric);
  }
  function time(value) {
    if (!value) return 'Belum tersedia';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Belum tersedia' : date.toLocaleString('id-ID', { hour12: false });
  }
  function toneFor(value) {
    const normalized = String(value || '').toUpperCase();
    if (['BULLISH', 'ACCEPTED', 'ACTIVE', 'COVERED'].includes(normalized)) return 'positive';
    if (['BEARISH', 'RISK_OFF', 'PAUSED'].includes(normalized)) return 'warning';
    if (['ERROR', 'UNCOVERED', 'OFFLINE'].includes(normalized)) return 'negative';
    return 'accent';
  }
  function pnlTone(element, value) {
    element.classList.remove('positive', 'negative', 'warning');
    const numeric = nullable(value);
    if (numeric !== null) element.classList.add(numeric >= 0 ? 'positive' : 'negative');
  }
  function nodeId(name) { return name === 'fibonacci' ? 'fib' : name; }
  function setNode(name, tone, status, value, meta) {
    const node = document.querySelector(`[data-node="${name}"]`);
    if (!node) return;
    node.dataset.tone = tone;
    text(`${nodeId(name)}-node-status`, status);
    text(`${nodeId(name)}-node-value`, value);
    text(`${nodeId(name)}-node-meta`, meta);
  }
  function profileCopy(profile) {
    return ({
      BULLISH: 'BUY tetap aktif dengan jarak sedikit lebih rapat.',
      SIDEWAYS: 'BUY memakai bobot dan jarak grid standar.',
      BEARISH: 'BUY dekat harga dikurangi dan bobot dipindahkan ke level bawah.',
      RISK_OFF: 'BUY diperjarang dan difokuskan ke level bawah oleh aturan safety.',
    })[String(profile || '').toUpperCase()] || 'Keputusan adaptive belum tersedia.';
  }

  function renderOverview() {
    const data = state.data;
    const adaptive = intel().adaptive || {};
    const profile = adaptive.profile || 'PENDING';
    text('source-label', data.source || 'Binance');
    text('overview-title', data.selectedSymbol || 'Pair belum dipilih');
    text('overview-copy', profileCopy(profile));
    text('market-price', `${data.market?.priceText || price(data.market?.price)} ${quote()}`);
    text('market-change', `24 jam: ${signed(data.market?.changePercent, 2)}%`);
    text('active-profile', profile);
    text('profile-source', adaptive.source ? `Sumber ${adaptive.source}` : 'Sumber belum tersedia');
    text('exposure-value', percent(adaptive.exposurePct));
    text('exposure-note', adaptive.investmentCap > 0 ? `${money(adaptive.allocatedInvestment, 2)} dari ${money(adaptive.investmentCap, 0)} USDT` : 'Batas investasi belum tersedia');
    text('net-pnl', `${signed(data.profit?.net, 4)} ${quote()}`);
    pnlTone(byId('net-pnl'), data.profit?.net);
    byId('active-profile').className = `metric-value ${toneFor(profile)}`;
  }

  function renderFlow() {
    const data = state.data;
    const fib = intel().fibonacci || {};
    const gemini = intel().gemini || {};
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const position = data.futures?.position;
    const weights = adaptive.recommendation?.buyWeight;
    const weightText = weights ? `${weights.upper}/${weights.middle}/${weights.lower}` : 'N/A';
    const coverage = execution.sellCoveragePct;
    setNode('market', 'accent', String(data.mode || 'LIVE').toUpperCase(), `${data.market?.priceText || price(data.market?.price)} ${quote()}`, `${signed(data.market?.changePercent, 2)}% dalam 24 jam`);
    setNode('fibonacci', toneFor(fib.direction), fib.direction || 'MENUNGGU', `Score ${fib.score ?? 'N/A'}`, fib.available ? `Applied ${fib.appliedDirection} · conf ${percent(num(fib.confidence) * 100, 1)}` : 'Belum ada analisis');
    setNode('gemini', gemini.error ? 'negative' : toneFor(gemini.profile), gemini.profile || (gemini.enabled ? 'MENUNGGU' : 'OFF'), `Confidence ${gemini.confidence == null ? 'N/A' : percent(num(gemini.confidence) * 100, 0)}`, gemini.error || gemini.model || 'Belum ada keputusan');
    setNode('supervisor', toneFor(adaptive.profile), adaptive.profile || 'MENUNGGU', `Exposure ${percent(adaptive.exposurePct)}`, `${adaptive.source || 'PENDING'} · spacing ${adaptive.recommendation?.spacingMultiplier ?? 'N/A'}`);
    setNode('buy', 'positive', `${num(data.orders?.buyCount)} ORDER`, `${money(data.orders?.buyValue, 2)} ${quote()}`, `Bobot atas/tengah/bawah ${weightText}`);
    setNode('position', position ? (num(data.profit?.unrealizedPnl) >= 0 ? 'positive' : 'negative') : 'accent', position ? 'LONG AKTIF' : 'TIDAK ADA POSISI', position ? compact(position.contracts) : '0', `PnL berjalan ${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`);
    setNode('sell', coverage !== null && coverage !== undefined && coverage < 99.999 ? 'negative' : 'positive', `${num(data.orders?.sellCount)} ORDER`, coverage == null ? 'Coverage N/A' : `Coverage ${percent(coverage, 0)}`, execution.uncovered > 0 ? `${compact(execution.uncovered)} kontrak belum tertutup` : 'Tidak ada posisi tanpa exit');
  }

  function inspectorModel() {
    const data = state.data;
    const fib = intel().fibonacci || {};
    const gemini = intel().gemini || {};
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const position = data.futures?.position;
    const weights = adaptive.recommendation?.buyWeight;
    const tfTags = Object.entries(fib.timeframes || {}).map(([key, value]) => `${key}: ${value.direction}`);
    return ({
      market: { title: 'Market feed', status: String(data.mode || 'LIVE').toUpperCase(), summary: 'Ticker dan candle Binance menjadi input harga untuk range, sinyal, dan penempatan level grid.', tags: data.market?.timeframe ? [`Chart ${data.market.timeframe}`] : [], details: [['Harga terakhir', `${data.market?.priceText || price(data.market?.price)} ${quote()}`], ['Perubahan 24 jam', `${signed(data.market?.changePercent, 2)}%`], ['High 24 jam', `${data.market?.highText || price(data.market?.high)} ${quote()}`], ['Low 24 jam', `${data.market?.lowText || price(data.market?.low)} ${quote()}`]] },
      fibonacci: { title: 'Fibonacci direction', status: fib.direction || 'MENUNGGU', summary: fib.available ? `Arah mentah ${fib.direction}. Arah yang diterapkan ke bias level saat ini ${fib.appliedDirection}.` : 'Analisis Fibonacci belum tersedia untuk pair ini.', tags: tfTags, details: [['Score', fib.score ?? 'N/A'], ['Confidence', fib.confidence == null ? 'N/A' : percent(num(fib.confidence) * 100, 1)], ['Alignment', fib.alignment == null ? 'N/A' : percent(num(fib.alignment) * 100, 1)], ['Konfirmasi', `${num(fib.confirmationCount)}/${num(fib.confirmationsRequired)}`], ['Confirmed', fib.confirmedDirection || 'RANGING'], ['Diperbarui', time(fib.generatedAt)]] },
      gemini: { title: 'Gemini monitor', status: gemini.error ? 'ERROR' : gemini.profile || (gemini.enabled ? 'MENUNGGU' : 'OFF'), summary: gemini.error || gemini.reasoning || (gemini.enabled ? 'Gemini aktif, keputusan pertama belum diterima.' : 'Gemini monitor tidak aktif.'), tags: gemini.riskFactors || [], details: [['Status', gemini.accepted ? 'Accepted' : 'Fallback'], ['Profile', gemini.profile || 'N/A'], ['Confidence', gemini.confidence == null ? 'N/A' : percent(num(gemini.confidence) * 100, 0)], ['Model', gemini.model || 'N/A'], ['Diperbarui', time(gemini.generatedAt)]] },
      supervisor: { title: 'Adaptive supervisor', status: adaptive.profile || 'MENUNGGU', summary: profileCopy(adaptive.profile), tags: adaptive.reasons || [], details: [['Profil aktif', adaptive.profile || 'N/A'], ['Kandidat raw', adaptive.rawProfile || 'N/A'], ['Sumber', adaptive.source || 'PENDING'], ['Exposure', percent(adaptive.exposurePct)], ['Konfirmasi profil', `${num(adaptive.candidateCount)}/${num(adaptive.confirmationsRequired)}`], ['Spacing', adaptive.recommendation?.spacingMultiplier ?? 'N/A'], ['Bobot BUY', weights ? `${weights.upper} / ${weights.middle} / ${weights.lower}` : 'N/A'], ['Mode', adaptive.mode || 'OFF']] },
      buy: { title: 'BUY grid', status: `${num(data.orders?.buyCount)} ORDER AKTIF`, summary: 'Order BUY baru mengikuti profil adaptive. Batas investasi tetap berasal dari konfigurasi pengguna.', tags: weights ? [`Upper ${weights.upper}x`, `Middle ${weights.middle}x`, `Lower ${weights.lower}x`] : [], details: [['Order aktif', num(data.orders?.buyCount)], ['Nilai pending', `${money(data.orders?.buyValue, 4)} ${quote()}`], ['Grid count', num(execution.gridCount) || 'N/A'], ['Investment cap', adaptive.investmentCap > 0 ? `${money(adaptive.investmentCap, 0)} ${quote()}` : 'N/A'], ['Allocated', `${money(adaptive.allocatedInvestment, 4)} ${quote()}`], ['Spacing', adaptive.recommendation?.spacingMultiplier ?? 'N/A']] },
      position: { title: 'LONG position', status: position ? 'AKTIF' : 'KOSONG', summary: position ? 'Posisi LONG berasal dari BUY grid yang sudah terisi. PnL berjalan mengikuti mark price Binance.' : 'Tidak ada kontrak LONG terbuka pada pair ini.', tags: position ? [`${data.futures?.leverage || 0}x`, data.futures?.marginMode || 'N/A', data.futures?.positionSide || 'LONG'] : [], details: [['Kontrak', position ? compact(position.contracts) : '0'], ['Entry', position ? price(position.entryPrice) : 'N/A'], ['Mark', position ? price(position.markPrice) : 'N/A'], ['Likuidasi', position?.liquidationPrice > 0 ? price(position.liquidationPrice) : 'N/A'], ['Margin posisi', `${money(data.futures?.positionMargin, 4)} ${quote()}`], ['ROI posisi', position ? percent(position.roiPct, 2) : 'N/A'], ['PnL berjalan', `${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`]] },
      sell: { title: 'SELL ladder', status: execution.uncovered > 0 ? 'PERLU REKONSILIASI' : 'TERLINDUNGI', summary: execution.uncovered > 0 ? 'Sebagian posisi belum memiliki jumlah SELL yang setara pada snapshot ini. Bot akan merekonsiliasi pada siklus berikutnya.' : 'Jumlah kontrak LONG sudah dicadangkan oleh SELL aktif, atau tidak ada posisi terbuka.', tags: data.futures?.exits?.nearestLabel ? [data.futures.exits.nearestLabel] : [], details: [['Order SELL', num(data.orders?.sellCount)], ['Reserved SELL', compact(execution.reservedSell)], ['Kontrak LONG', compact(execution.positionContracts)], ['Belum tertutup', compact(execution.uncovered)], ['Coverage', execution.sellCoveragePct == null ? 'N/A' : percent(execution.sellCoveragePct, 0)], ['SELL terdekat', data.futures?.exits?.nearestPrice ? `${price(data.futures.exits.nearestPrice)} ${quote()}` : 'N/A']] },
    })[state.activeNode];
  }

  function renderDefinitionList(container, rows) {
    container.replaceChildren();
    for (const [label, value] of rows) {
      const item = document.createElement('div'); item.className = 'detail-item';
      const term = document.createElement('dt'); term.textContent = label;
      const description = document.createElement('dd'); description.textContent = String(value ?? 'N/A');
      item.append(term, description); container.append(item);
    }
  }
  function renderInspector() {
    const model = inspectorModel();
    text('inspector-title', model.title); text('inspector-status', model.status); text('inspector-summary', model.summary);
    renderDefinitionList(byId('inspector-details'), model.details);
    const tags = byId('inspector-tags'); tags.replaceChildren();
    for (const value of model.tags.filter(Boolean)) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = value; tags.append(tag); }
    document.querySelectorAll('.flow-node').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.node === state.activeNode)));
  }
  function renderLedger() {
    const profit = state.data.profit || {};
    for (const [id, value] of [['realized-pnl', profit.realized], ['funding-pnl', profit.accounting?.ready ? profit.funding : null], ['unrealized-pnl', profit.unrealizedPnl], ['grid-profit', profit.gridPairProfit], ['ledger-net', profit.net]]) { text(id, `${signed(value, 4)} ${quote()}`); pnlTone(byId(id), value); }
    text('fees-value', `${money(profit.fees, 4)} ${quote()}`);
  }
  function renderRisk() {
    const data = state.data; const adaptive = intel().adaptive || {}; const position = data.futures?.position;
    const exposure = num(adaptive.exposurePct); const threshold = num(adaptive.riskExposurePct) || 90;
    text('risk-exposure', percent(adaptive.exposurePct));
    text('risk-caption', adaptive.investmentCap > 0 ? `${money(adaptive.allocatedInvestment, 4)} dari batas ${money(adaptive.investmentCap, 0)} ${quote()}` : 'Batas investasi belum tersedia.');
    byId('exposure-fill').style.width = `${clamp(exposure, 0, 100)}%`; byId('exposure-fill').style.background = exposure >= threshold ? 'var(--warning)' : 'var(--accent)';
    byId('exposure-limit').style.left = `${clamp(threshold, 0, 100)}%`; byId('exposure-meter').setAttribute('aria-valuenow', String(clamp(exposure, 0, 100)));
    const mark = num(position?.markPrice); const liquidation = num(position?.liquidationPrice); const distance = mark > 0 && liquidation > 0 ? Math.abs(mark - liquidation) / mark * 100 : null;
    renderDefinitionList(byId('risk-facts'), [['Risk-off threshold', percent(threshold, 0)], ['Margin posisi', `${money(data.futures?.positionMargin, 4)} ${quote()}`], ['Margin order', `${money(data.futures?.openOrderMargin, 4)} ${quote()}`], ['Saldo tersedia', `${money(data.futures?.availableBalance, 4)} ${quote()}`], ['Jarak likuidasi', distance == null ? 'N/A' : percent(distance, 2)], ['Leverage', `${num(data.futures?.leverage)}x`]]);
  }

  function renderOrders() {
    const orders = state.data.orders?.active || [];
    text('buy-count', `BUY ${num(state.data.orders?.buyCount)}`); text('sell-count', `SELL ${num(state.data.orders?.sellCount)}`);
    const body = byId('orders-body'); const cards = byId('order-cards'); body.replaceChildren(); cards.replaceChildren();
    if (!orders.length) {
      const row = document.createElement('tr'); row.className = 'empty-row'; const cell = document.createElement('td'); cell.colSpan = 7; cell.textContent = state.loading ? 'Mengambil order aktif dari Binance.' : 'Tidak ada order grid aktif untuk pair ini.'; row.append(cell); body.append(row);
      const empty = document.createElement('div'); empty.className = 'order-empty'; empty.textContent = state.loading ? 'Memuat order aktif.' : 'Tidak ada order grid aktif untuk pair ini.'; cards.append(empty); return;
    }
    for (const order of [...orders].sort((a, b) => b.price - a.price || String(a.side).localeCompare(String(b.side)))) {
      const row = document.createElement('tr');
      const values = [{ value: String(order.side || '').toUpperCase(), className: `side-label ${order.side}` }, { value: `L${order.level ?? 'N/A'}` }, { value: order.priceText || price(order.price) }, { value: order.amountText || compact(order.amount) }, { value: order.remainingText || compact(order.remaining) }, { value: order.entryComparison || (order.side === 'buy' ? 'Menambah LONG' : 'Exit LONG') }, { value: order.id }];
      for (const item of values) { const cell = document.createElement('td'); if (item.className) { const span = document.createElement('span'); span.className = item.className; span.textContent = item.value; cell.append(span); } else cell.textContent = item.value; row.append(cell); } body.append(row);
      const card = document.createElement('article'); card.className = 'order-card';
      const side = document.createElement('span'); side.className = `side-label ${order.side}`; side.textContent = String(order.side || '').toUpperCase();
      const level = document.createElement('small'); level.textContent = `Level ${order.level ?? 'N/A'}`;
      const orderPrice = document.createElement('div'); orderPrice.className = 'order-price'; orderPrice.textContent = `${order.priceText || price(order.price)} ${quote()}`;
      const amount = document.createElement('small'); amount.textContent = `Jumlah ${order.amountText || compact(order.amount)} · Tersisa ${order.remainingText || compact(order.remaining)}`;
      const comparison = document.createElement('small'); comparison.textContent = order.entryComparison || '';
      card.append(side, level, orderPrice, amount, comparison); cards.append(card);
    }
  }

  function drawChart() {
    const canvas = byId('price-chart'); const candles = state.data?.market?.candles || []; if (!canvas || !candles.length) return;
    const box = canvas.getBoundingClientRect(); if (!(box.width > 0 && box.height > 0)) return;
    const ratio = window.devicePixelRatio || 1; canvas.width = Math.floor(box.width * ratio); canvas.height = Math.floor(box.height * ratio);
    const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = box.width; const height = box.height; const padding = { left: 10, right: Math.min(86, width * .25), top: 12, bottom: 24 }; const range = state.data.range || {};
    const values = candles.flatMap(candle => [num(candle.high), num(candle.low)]).concat([range.lower, range.upper].filter(Boolean).map(num)); const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
    const plotWidth = width - padding.left - padding.right; const plotHeight = height - padding.top - padding.bottom; const x = index => padding.left + index * plotWidth / Math.max(candles.length - 1, 1); const y = value => padding.top + (max - value) * plotHeight / span;
    context.clearRect(0, 0, width, height); context.font = '10px ui-monospace, monospace'; context.fillStyle = '#aab5c2'; context.strokeStyle = '#25313e'; context.lineWidth = 1;
    for (let index = 0; index < 5; index += 1) { const gridY = padding.top + index * plotHeight / 4; const value = max - index * span / 4; context.beginPath(); context.moveTo(padding.left, gridY); context.lineTo(width - padding.right, gridY); context.stroke(); context.fillText(price(value), width - padding.right + 9, gridY + 4); }
    [{ value: num(range.lower), color: '#65d6ad', label: 'LOW' }, { value: num(range.upper), color: '#ffbe66', label: 'HIGH' }].forEach(item => { if (!(item.value > 0)) return; const lineY = y(item.value); context.setLineDash([6, 5]); context.strokeStyle = item.color; context.beginPath(); context.moveTo(padding.left, lineY); context.lineTo(width - padding.right, lineY); context.stroke(); context.setLineDash([]); context.fillStyle = item.color; context.fillText(item.label, padding.left + 4, lineY - 5); });
    const gradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom); gradient.addColorStop(0, 'rgba(198,243,111,.22)'); gradient.addColorStop(1, 'rgba(198,243,111,0)');
    context.beginPath(); candles.forEach((candle, index) => index ? context.lineTo(x(index), y(num(candle.close))) : context.moveTo(x(index), y(num(candle.close)))); context.lineTo(x(candles.length - 1), height - padding.bottom); context.lineTo(x(0), height - padding.bottom); context.closePath(); context.fillStyle = gradient; context.fill();
    context.beginPath(); candles.forEach((candle, index) => index ? context.lineTo(x(index), y(num(candle.close))) : context.moveTo(x(index), y(num(candle.close)))); context.strokeStyle = '#c6f36f'; context.lineWidth = 2; context.stroke();
  }
  function renderChartMeta() { const range = state.data.range || {}; text('range-copy', range.lower > 0 && range.upper > 0 ? `Grid ${range.lowerText || price(range.lower)} sampai ${range.upperText || price(range.upper)} ${quote()}` : 'Range grid belum tersedia untuk pair ini.'); text('timeframe-label', state.data.market?.timeframe || 'N/A'); requestAnimationFrame(drawChart); }
  function renderRuntime() {
    const data = state.data; text('status-text', state.loading ? 'Memperbarui' : data.tradingEnabled ? 'Live · Trading aktif' : 'Live · Order dijeda'); byId('status-mark').dataset.state = state.loading ? '' : data.tradingEnabled ? 'active' : 'paused';
    text('updated-at', `Diperbarui ${time(data.generatedAt)}`); text('runtime-label', `${String(data.mode || '').toUpperCase()} · ${data.source || 'Binance'} · refresh ${num(data.refreshSeconds) || 5} detik`); byId('logout-form').hidden = !data.dashboardAuthEnabled;
  }
  function render() { renderOverview(); renderFlow(); renderInspector(); renderLedger(); renderRisk(); renderOrders(); renderChartMeta(); renderRuntime(); }
  function renderSymbols(symbols, selected) {
    const select = byId('symbol-select'); const current = [...select.options].map(option => option.value);
    if (JSON.stringify(current) !== JSON.stringify(symbols)) { select.replaceChildren(); for (const symbol of symbols) { const option = document.createElement('option'); option.value = symbol; option.textContent = symbol; select.append(option); } }
    select.value = selected || symbols[0] || '';
  }
  function spinRefreshButton() {
    const button = byId('refresh-button');
    clearTimeout(state.refreshSpinTimer);
    button.classList.remove('is-spinning');
    void button.offsetWidth;
    button.classList.add('is-spinning');
    state.refreshSpinTimer = setTimeout(() => button.classList.remove('is-spinning'), 1100);
  }
  function setLoading(loading, initial = false, announced = false) { state.loading = loading; byId('app').setAttribute('aria-busy', String(loading)); byId('refresh-button').disabled = loading && (initial || announced); byId('loading-state').hidden = !loading || (!initial && Boolean(state.data)); }
  async function load(options = {}) {
    const initial = !state.data; const announced = Boolean(options.announced); const requestId = ++state.requestId; state.controller?.abort(); state.controller = new AbortController(); setLoading(true, initial, announced); byId('error-notice').hidden = true; clearTimeout(state.timer);
    try {
      const selected = options.symbol ?? byId('symbol-select').value; const query = selected ? `?symbol=${encodeURIComponent(selected)}` : '';
      const response = await fetch(`/api/dashboard${query}`, { signal: state.controller.signal, cache: 'no-store' });
      if (response.status === 401) { window.location.assign('/login'); return; }
      if (!response.ok) throw new Error('Binance atau bot belum memberikan snapshot dashboard.');
      const data = await response.json(); if (requestId !== state.requestId) return; state.data = data; renderSymbols(data.symbols || [], data.selectedSymbol); setLoading(false); render(); state.timer = setTimeout(() => load(), Math.max(2, num(data.refreshSeconds) || 5) * 1000);
    } catch (error) {
      if (error.name === 'AbortError') return; setLoading(false); text('error-text', error.message || 'Data dashboard tidak tersedia.'); byId('error-notice').hidden = false; text('status-text', 'Offline · mencoba lagi'); byId('status-mark').dataset.state = 'error'; state.timer = setTimeout(() => load(), 5000);
    }
  }
  function bindEvents() {
    document.querySelectorAll('.flow-node').forEach(node => node.addEventListener('click', () => { state.activeNode = node.dataset.node; if (state.data) renderInspector(); }));
    byId('symbol-select').addEventListener('change', event => load({ symbol: event.target.value, announced: true })); byId('refresh-button').addEventListener('click', () => { spinRefreshButton(); load({ announced: true }); }); byId('retry-button').addEventListener('click', () => load({ announced: true }));
    let resizeTimer; window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 100); });
  }
  bindEvents(); load();
})();
