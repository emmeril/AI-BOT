(() => {
  'use strict';

  const state = { data: null, positionSide: 'LONG', activeNode: 'supervisor', timer: null, controller: null, requestId: 0, loading: true, refreshSpinTimer: null, flowLayoutFrame: null, motionPreference: 'on' };
  const MOTION_STORAGE_KEY = 'grid-flow-motion';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const FLOW_EDGES = [
    ['market', 'fibonacci'], ['fibonacci', 'supervisor'],
    ['supervisor', 'buy'], ['buy', 'position'], ['position', 'sell'],
  ];
  const byId = id => document.getElementById(id);
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const nullable = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const intel = () => state.data?.intelligence || {};
  const quote = () => state.data?.profit?.quoteAsset || 'USDT';
  const isShort = () => state.positionSide === 'SHORT';

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
  function setFlowNodeState(name, flowState) {
    const node = document.querySelector(`[data-node="${name}"]`);
    if (node) node.dataset.flowState = flowState;
  }
  function setFlowEdge(from, to, flowState) {
    document.querySelector(`.flow-signal [data-edge="${from}-${to}"]`)?.setAttribute('data-state', flowState);
  }
  function flowNodeBox(name, mapBox) {
    const box = document.querySelector(`[data-node="${name}"]`)?.getBoundingClientRect();
    if (!box) return null;
    return {
      left: box.left - mapBox.left, right: box.right - mapBox.left,
      top: box.top - mapBox.top, bottom: box.bottom - mapBox.top,
      centerX: box.left - mapBox.left + box.width / 2,
      centerY: box.top - mapBox.top + box.height / 2,
    };
  }
  function flowConnectionPath(source, target) {
    if (target.left - source.right >= 8) {
      const middleX = (source.right + target.left) / 2;
      return `M ${source.right} ${source.centerY} C ${middleX} ${source.centerY}, ${middleX} ${target.centerY}, ${target.left} ${target.centerY}`;
    }
    const sourceX = clamp(target.centerX, source.left + 22, source.right - 22);
    const targetX = clamp(source.centerX, target.left + 22, target.right - 22);
    const middleY = (source.bottom + target.top) / 2;
    return `M ${sourceX} ${source.bottom} C ${sourceX} ${middleY}, ${targetX} ${middleY}, ${targetX} ${target.top}`;
  }
  function layoutFlowConnections() {
    state.flowLayoutFrame = null;
    const map = byId('flow-map'); const svg = map?.querySelector('.flow-lines');
    if (!map || !svg) return;
    const mapBox = map.getBoundingClientRect();
    if (!(mapBox.width > 0 && mapBox.height > 0)) return;
    svg.setAttribute('viewBox', `0 0 ${mapBox.width} ${mapBox.height}`);
    for (const [from, to] of FLOW_EDGES) {
      const source = flowNodeBox(from, mapBox); const target = flowNodeBox(to, mapBox);
      if (!source || !target) continue;
      const path = flowConnectionPath(source, target); const edge = `${from}-${to}`;
      svg.querySelectorAll(`[data-edge="${edge}"]`).forEach(element => element.setAttribute('d', path));
    }
  }
  function queueFlowLayout() {
    if (state.flowLayoutFrame !== null) cancelAnimationFrame(state.flowLayoutFrame);
    state.flowLayoutFrame = requestAnimationFrame(layoutFlowConnections);
  }
  function savedMotionPreference() {
    try {
      const value = localStorage.getItem(MOTION_STORAGE_KEY);
      return ['on', 'system', 'off'].includes(value) ? value : 'on';
    } catch { return 'on'; }
  }
  function applyMotionPreference(value, { persist = false } = {}) {
    const preference = ['on', 'system', 'off'].includes(value) ? value : 'on';
    state.motionPreference = preference; document.documentElement.dataset.motion = preference;
    byId('motion-select').value = preference;
    const description = preference === 'on' ? 'Animasi dashboard aktif.' : preference === 'off' ? 'Animasi dashboard dimatikan.' : `Animasi mengikuti sistem dan saat ini ${reducedMotion.matches ? 'mati' : 'aktif'}.`;
    text('motion-state', description); byId('motion-control').title = description;
    if (persist) { try { localStorage.setItem(MOTION_STORAGE_KEY, preference); } catch {} }
  }
  function profileCopy(profile) {
    return ({
      BULLISH: 'BUY tetap aktif dengan jarak sedikit lebih rapat.',
      SIDEWAYS: 'BUY memakai bobot dan jarak grid standar.',
      BEARISH: 'BUY dekat harga dikurangi dan bobot dipindahkan ke level bawah.',
      RISK_OFF: 'BUY diperjarang dan difokuskan ke level bawah oleh aturan safety.',
    })[String(profile || '').toUpperCase()] || 'Keputusan adaptive belum tersedia.';
  }

  function renderPositionTabs() {
    document.querySelectorAll('.position-tab').forEach(tab => {
      const selected = tab.dataset.positionSide === state.positionSide;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    byId('position-detail').setAttribute('aria-labelledby', `${state.positionSide.toLowerCase()}-tab`);
  }

  function renderComparison() {
    const comparison = state.data.comparison || {};
    const combined = comparison.combined || {};
    text('combined-exposure', `${money(combined.exposure, 2)} ${quote()}`);
    text('combined-pnl', `${signed(combined.strategyPnl, 4)} ${quote()}`);
    pnlTone(byId('combined-pnl'), combined.strategyPnl);
    for (const side of ['LONG', 'SHORT']) {
      const metrics = comparison[side] || {};
      const prefix = side.toLowerCase();
      text(`${prefix}-exposure`, metrics.available ? `${money(metrics.exposure, 2)} ${quote()}` : 'Tidak dikelola');
      text(`${prefix}-pnl`, metrics.available ? `${signed(metrics.strategyPnl, 4)} ${quote()}` : 'N/A');
      text(`${prefix}-runtime`, !metrics.available ? 'Pair tidak aktif' : metrics.running ? 'Bot online' : 'Bot offline');
      pnlTone(byId(`${prefix}-pnl`), metrics.available ? metrics.strategyPnl : null);
    }
  }

  function renderOverview() {
    const data = state.data;
    const adaptive = intel().adaptive || {};
    const fib = intel().fibonacci || {};
    const profile = isShort() ? (fib.appliedDirection || 'RANGING') : (adaptive.profile || 'PENDING');
    text('source-label', data.source || 'Binance');
    text('overview-title', `${data.selectedSymbol || 'Pair belum dipilih'} · ${state.positionSide}`);
    text('overview-copy', isShort()
      ? (fib.appliedDirection === 'BEARISH' ? 'Entry SELL diizinkan oleh konfirmasi Fibonacci bearish.' : 'Entry SELL menunggu arah Fibonacci BEARISH yang terkonfirmasi.')
      : profileCopy(profile));
    text('market-price', `${data.market?.priceText || price(data.market?.price)} ${quote()}`);
    text('market-change', `24 jam: ${signed(data.market?.changePercent, 2)}%`);
    text('profile-label', isShort() ? 'Gate SELL' : 'Profil BUY');
    text('active-profile', profile);
    text('profile-source', isShort() ? `Arah wajib BEARISH · raw ${fib.direction || 'UNKNOWN'}` : (adaptive.source ? `Sumber ${adaptive.source}` : 'Sumber belum tersedia'));
    text('exposure-value', percent(adaptive.exposurePct));
    text('exposure-note', adaptive.investmentCap > 0 ? `${money(adaptive.allocatedInvestment, 2)} dari ${money(adaptive.investmentCap, 0)} USDT` : 'Batas investasi belum tersedia');
    text('net-pnl', `${signed(data.profit?.net, 4)} ${quote()}`);
    pnlTone(byId('net-pnl'), data.profit?.net);
    byId('active-profile').className = `metric-value ${toneFor(profile)}`;
  }

  function renderFlow() {
    const data = state.data;
    byId('flow-map').dataset.running = String(Boolean(data.running));
    const fib = intel().fibonacci || {};
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const position = data.futures?.position;
    const weights = adaptive.recommendation?.buyWeight;
    const weightText = weights ? `${weights.upper}/${weights.middle}/${weights.lower}` : 'N/A';
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const entrySide = isShort() ? 'SELL' : 'BUY';
    const exitSide = isShort() ? 'BUY' : 'SELL';
    const entryCount = num(execution.entryCount ?? data.orders?.[`${entrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${exitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${entrySide.toLowerCase()}Value`]);
    const marketAvailable = Boolean(data.running && num(data.market?.price) > 0);
    const fibonacciAvailable = Boolean(marketAvailable && fib.available);
    const adaptiveAvailable = Boolean(data.running && adaptive.available);
    const shortGateAvailable = Boolean(data.running && fib.available);
    const decisionAvailable = isShort() ? shortGateAvailable : adaptiveAvailable;
    const safetyOverride = Boolean(adaptiveAvailable && (String(adaptive.profile).toUpperCase() === 'RISK_OFF' || String(adaptive.source).toUpperCase().includes('SAFETY')));
    const adaptiveBuyAvailable = Boolean(adaptiveAvailable && String(adaptive.mode).toUpperCase() === 'LIVE');
    const shortEntryAllowed = Boolean(shortGateAvailable && fib.appliedDirection === 'BEARISH');
    const entryAvailable = Boolean(data.running && (data.tradingEnabled || entryCount > 0));
    const positionAvailable = Boolean(data.running && position && num(position.contracts) > 0);
    const exitNeedsAttention = Boolean(positionAvailable && num(execution.uncovered) > 0);
    const exitAvailable = Boolean(positionAvailable && !exitNeedsAttention && coverage !== null && coverage !== undefined && num(coverage) >= 99.999);
    text('flow-title', `Dari sinyal pasar ke exit ${exitSide}`);
    text('supervisor-node-title', isShort() ? 'Fibonacci entry gate' : 'Adaptive supervisor');
    text('entry-node-title', `${entrySide} grid`);
    text('position-node-title', `${state.positionSide} position`);
    text('exit-node-title', `${exitSide} ladder`);
    setNode('market', 'accent', String(data.mode || 'LIVE').toUpperCase(), `${data.market?.priceText || price(data.market?.price)} ${quote()}`, `${signed(data.market?.changePercent, 2)}% dalam 24 jam`);
    setNode('fibonacci', toneFor(fib.direction), fib.direction || 'MENUNGGU', `Score ${fib.score ?? 'N/A'}`, fib.available ? `Applied ${fib.appliedDirection} · conf ${percent(num(fib.confidence) * 100, 1)}` : 'Belum ada analisis');
    setNode('supervisor', isShort() ? toneFor(fib.appliedDirection) : toneFor(adaptive.profile), isShort() ? (shortEntryAllowed ? 'ENTRY AKTIF' : 'MENUNGGU') : (adaptive.profile || 'MENUNGGU'), isShort() ? `Applied ${fib.appliedDirection || 'RANGING'}` : `Exposure ${percent(adaptive.exposurePct)}`, isShort() ? `Wajib BEARISH · raw ${fib.direction || 'UNKNOWN'}` : `${adaptive.source || 'PENDING'} · spacing ${adaptive.recommendation?.spacingMultiplier ?? 'N/A'}`);
    setNode('buy', entrySide === 'BUY' ? 'positive' : 'warning', `${entryCount} ORDER`, `${money(entryValue, 2)} ${quote()}`, isShort() ? 'Entry hanya saat gate BEARISH aktif' : `Bobot atas/tengah/bawah ${weightText}`);
    setNode('position', position ? (num(data.profit?.unrealizedPnl) >= 0 ? 'positive' : 'negative') : 'accent', position ? `${state.positionSide} AKTIF` : 'TIDAK ADA POSISI', position ? compact(position.contracts) : '0', `PnL berjalan ${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`);
    setNode('sell', coverage !== null && coverage !== undefined && coverage < 99.999 ? 'negative' : 'positive', `${exitCount} ORDER`, coverage == null ? 'Coverage N/A' : `Coverage ${percent(coverage, 0)}`, execution.uncovered > 0 ? `${compact(execution.uncovered)} kontrak belum tertutup` : 'Tidak ada posisi tanpa exit');
    setFlowNodeState('market', marketAvailable ? 'active' : 'waiting');
    setFlowNodeState('fibonacci', fibonacciAvailable ? 'active' : 'waiting');
    setFlowNodeState('supervisor', isShort() ? (shortEntryAllowed ? 'active' : 'waiting') : safetyOverride ? 'safety' : adaptiveAvailable ? 'active' : 'waiting');
    setFlowNodeState('buy', !isShort() && safetyOverride && adaptiveBuyAvailable ? 'safety' : entryAvailable ? 'active' : 'waiting');
    setFlowNodeState('position', positionAvailable ? 'active' : 'waiting');
    setFlowNodeState('sell', exitNeedsAttention ? 'error' : exitAvailable ? 'active' : 'waiting');
    setFlowEdge('market', 'fibonacci', fibonacciAvailable ? 'active' : 'waiting');
    setFlowEdge('fibonacci', 'supervisor', fibonacciAvailable && decisionAvailable ? 'active' : 'waiting');
    setFlowEdge('supervisor', 'buy', !isShort() && safetyOverride && adaptiveBuyAvailable ? 'safety' : (isShort() ? shortEntryAllowed : adaptiveBuyAvailable) ? 'active' : 'waiting');
    setFlowEdge('buy', 'position', positionAvailable ? 'active' : 'waiting');
    setFlowEdge('position', 'sell', exitNeedsAttention ? 'error' : exitAvailable ? 'active' : 'waiting');
    queueFlowLayout();
  }

  function inspectorModel() {
    const data = state.data;
    const fib = intel().fibonacci || {};
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const position = data.futures?.position;
    const weights = adaptive.recommendation?.buyWeight;
    const entrySide = isShort() ? 'SELL' : 'BUY';
    const exitSide = isShort() ? 'BUY' : 'SELL';
    const entryCount = num(execution.entryCount ?? data.orders?.[`${entrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${exitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${entrySide.toLowerCase()}Value`]);
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const tfTags = Object.entries(fib.timeframes || {}).map(([key, value]) => `${key}: ${value.direction}`);
    return ({
      market: { title: 'Market feed', status: String(data.mode || 'LIVE').toUpperCase(), summary: 'Ticker dan candle Binance menjadi input harga untuk range, sinyal, dan penempatan level grid.', tags: data.market?.timeframe ? [`Chart ${data.market.timeframe}`] : [], details: [['Harga terakhir', `${data.market?.priceText || price(data.market?.price)} ${quote()}`], ['Perubahan 24 jam', `${signed(data.market?.changePercent, 2)}%`], ['High 24 jam', `${data.market?.highText || price(data.market?.high)} ${quote()}`], ['Low 24 jam', `${data.market?.lowText || price(data.market?.low)} ${quote()}`]] },
      fibonacci: { title: 'Fibonacci direction', status: fib.direction || 'MENUNGGU', summary: fib.available ? `Arah mentah ${fib.direction}. Arah yang diterapkan ke bias level saat ini ${fib.appliedDirection}.` : 'Analisis Fibonacci belum tersedia untuk pair ini.', tags: tfTags, details: [['Score', fib.score ?? 'N/A'], ['Confidence', fib.confidence == null ? 'N/A' : percent(num(fib.confidence) * 100, 1)], ['Alignment', fib.alignment == null ? 'N/A' : percent(num(fib.alignment) * 100, 1)], ['Konfirmasi', `${num(fib.confirmationCount)}/${num(fib.confirmationsRequired)}`], ['Confirmed', fib.confirmedDirection || 'RANGING'], ['Diperbarui', time(fib.generatedAt)]] },
      supervisor: isShort()
        ? { title: 'Fibonacci entry gate', status: fib.appliedDirection === 'BEARISH' ? 'ENTRY AKTIF' : 'MENUNGGU', summary: fib.appliedDirection === 'BEARISH' ? 'Arah terapan BEARISH mengizinkan bot memasang entry SELL.' : 'Entry SELL ditahan sampai arah terapan Fibonacci menjadi BEARISH.', tags: tfTags, details: [['Arah mentah', fib.direction || 'UNKNOWN'], ['Arah terapan', fib.appliedDirection || 'RANGING'], ['Arah wajib', 'BEARISH'], ['Confidence', fib.confidence == null ? 'N/A' : percent(num(fib.confidence) * 100, 1)], ['Konfirmasi', `${num(fib.confirmationCount)}/${num(fib.confirmationsRequired)}`], ['Mode', fib.strategy || 'N/A']] }
        : { title: 'Adaptive supervisor', status: adaptive.profile || 'MENUNGGU', summary: profileCopy(adaptive.profile), tags: adaptive.reasons || [], details: [['Profil aktif', adaptive.profile || 'N/A'], ['Kandidat raw', adaptive.rawProfile || 'N/A'], ['Sumber', adaptive.source || 'PENDING'], ['Exposure', percent(adaptive.exposurePct)], ['Konfirmasi profil', `${num(adaptive.candidateCount)}/${num(adaptive.confirmationsRequired)}`], ['Spacing', adaptive.recommendation?.spacingMultiplier ?? 'N/A'], ['Bobot BUY', weights ? `${weights.upper} / ${weights.middle} / ${weights.lower}` : 'N/A'], ['Mode', adaptive.mode || 'OFF']] },
      buy: { title: `${entrySide} grid`, status: `${entryCount} ORDER AKTIF`, summary: isShort() ? 'Order SELL membuka posisi SHORT hanya setelah gate Fibonacci mengizinkan entry.' : 'Order BUY baru mengikuti profil adaptive. Batas investasi tetap berasal dari konfigurasi pengguna.', tags: isShort() ? [`Gate ${fib.appliedDirection || 'RANGING'}`] : (weights ? [`Upper ${weights.upper}x`, `Middle ${weights.middle}x`, `Lower ${weights.lower}x`] : []), details: [['Order aktif', entryCount], ['Nilai pending', `${money(entryValue, 4)} ${quote()}`], ['Grid count', num(execution.gridCount) || 'N/A'], ['Investment cap', adaptive.investmentCap > 0 ? `${money(adaptive.investmentCap, 0)} ${quote()}` : 'N/A'], ['Allocated', `${money(adaptive.allocatedInvestment, 4)} ${quote()}`], ['Sisi entry', entrySide]] },
      position: { title: `${state.positionSide} position`, status: position ? 'AKTIF' : 'KOSONG', summary: position ? `Posisi ${state.positionSide} berasal dari ${entrySide} grid yang sudah terisi. PnL berjalan mengikuti mark price Binance.` : `Tidak ada kontrak ${state.positionSide} terbuka pada pair ini.`, tags: position ? [`${data.futures?.leverage || 0}x`, data.futures?.marginMode || 'N/A', data.futures?.positionSide || state.positionSide] : [], details: [['Kontrak', position ? compact(position.contracts) : '0'], ['Entry', position ? price(position.entryPrice) : 'N/A'], ['Mark', position ? price(position.markPrice) : 'N/A'], ['Likuidasi', position?.liquidationPrice > 0 ? price(position.liquidationPrice) : 'N/A'], ['Margin posisi', `${money(data.futures?.positionMargin, 4)} ${quote()}`], ['ROI posisi', position ? percent(position.roiPct, 2) : 'N/A'], ['PnL berjalan', `${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`]] },
      sell: { title: `${exitSide} ladder`, status: execution.uncovered > 0 ? 'PERLU REKONSILIASI' : 'TERLINDUNGI', summary: execution.uncovered > 0 ? `Sebagian posisi belum memiliki jumlah ${exitSide} yang setara pada snapshot ini. Bot akan merekonsiliasi pada siklus berikutnya.` : `Jumlah kontrak ${state.positionSide} sudah dicadangkan oleh ${exitSide} aktif, atau tidak ada posisi terbuka.`, tags: data.futures?.exits?.nearestLabel ? [data.futures.exits.nearestLabel] : [], details: [[`Order ${exitSide}`, exitCount], [`Reserved ${exitSide}`, compact(execution.reservedExit)], [`Kontrak ${state.positionSide}`, compact(execution.positionContracts)], ['Belum tertutup', compact(execution.uncovered)], ['Coverage', coverage == null ? 'N/A' : percent(coverage, 0)], [`${exitSide} terdekat`, data.futures?.exits?.nearestPrice ? `${price(data.futures.exits.nearestPrice)} ${quote()}` : 'N/A']] },
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
    text('ledger-title', `PnL strategi ${state.positionSide}`);
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
    text('orders-copy', `Urutan level, harga, jumlah, dan fungsi order untuk posisi ${state.positionSide}.`);
    const body = byId('orders-body'); const cards = byId('order-cards'); body.replaceChildren(); cards.replaceChildren();
    if (!orders.length) {
      const row = document.createElement('tr'); row.className = 'empty-row'; const cell = document.createElement('td'); cell.colSpan = 7; cell.textContent = state.loading ? 'Mengambil order aktif dari Binance.' : 'Tidak ada order grid aktif untuk pair ini.'; row.append(cell); body.append(row);
      const empty = document.createElement('div'); empty.className = 'order-empty'; empty.textContent = state.loading ? 'Memuat order aktif.' : 'Tidak ada order grid aktif untuk pair ini.'; cards.append(empty); return;
    }
    for (const order of [...orders].sort((a, b) => b.price - a.price || String(a.side).localeCompare(String(b.side)))) {
      const row = document.createElement('tr');
      const values = [{ value: String(order.side || '').toUpperCase(), className: `side-label ${order.side}` }, { value: `L${order.level ?? 'N/A'}` }, { value: order.priceText || price(order.price) }, { value: order.amountText || compact(order.amount) }, { value: order.remainingText || compact(order.remaining) }, { value: order.entryComparison || 'Order grid' }, { value: order.id }];
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
    const data = state.data; text('status-text', state.loading ? 'Memperbarui' : !data.running ? `${state.positionSide} · Bot offline` : data.tradingEnabled ? `${state.positionSide} · Trading aktif` : `${state.positionSide} · Order dijeda`); byId('status-mark').dataset.state = state.loading ? '' : data.tradingEnabled ? 'active' : data.running ? 'paused' : 'error';
    text('updated-at', `Diperbarui ${time(data.generatedAt)}`); text('runtime-label', `${String(data.mode || '').toUpperCase()} · ${data.source || 'Binance'} · refresh ${num(data.refreshSeconds) || 5} detik`); byId('logout-form').hidden = !data.dashboardAuthEnabled;
  }
  function render() { renderPositionTabs(); renderComparison(); renderOverview(); renderFlow(); renderInspector(); renderLedger(); renderRisk(); renderOrders(); renderChartMeta(); renderRuntime(); }
  function renderSymbols(symbols, selected) {
    const select = byId('symbol-select'); const current = [...select.options].map(option => option.value);
    if (JSON.stringify(current) !== JSON.stringify(symbols)) { select.replaceChildren(); for (const symbol of symbols) { const option = document.createElement('option'); option.value = symbol; option.textContent = symbol; select.append(option); } }
    select.value = selected || symbols[0] || '';
  }
  function spinRefreshButton() {
    const button = byId('refresh-button');
    const icon = button.querySelector('.refresh-icon');
    clearTimeout(state.refreshSpinTimer);
    icon.classList.remove('fa-spin');
    button.classList.remove('is-refreshing');
    void icon.offsetWidth;
    icon.classList.add('fa-spin');
    button.classList.add('is-refreshing');
    button.setAttribute('aria-busy', 'true');
    const stopWhenReady = () => {
      if (button.disabled) {
        state.refreshSpinTimer = setTimeout(stopWhenReady, 150);
        return;
      }
      icon.classList.remove('fa-spin');
      button.classList.remove('is-refreshing');
      button.setAttribute('aria-busy', 'false');
    };
    state.refreshSpinTimer = setTimeout(stopWhenReady, 1100);
  }
  function setLoading(loading, initial = false, announced = false) { state.loading = loading; byId('app').setAttribute('aria-busy', String(loading)); byId('refresh-button').disabled = loading && (initial || announced); byId('loading-state').hidden = !loading || (!initial && Boolean(state.data)); }
  async function load(options = {}) {
    const initial = !state.data; const announced = Boolean(options.announced); const requestId = ++state.requestId; state.controller?.abort(); state.controller = new AbortController(); setLoading(true, initial, announced); byId('error-notice').hidden = true; clearTimeout(state.timer);
    try {
      const selected = options.symbol ?? byId('symbol-select').value;
      const positionSide = options.positionSide || state.positionSide;
      const query = new URLSearchParams({ positionSide });
      if (selected) query.set('symbol', selected);
      const response = await fetch(`/api/dashboard?${query.toString()}`, { signal: state.controller.signal, cache: 'no-store' });
      if (response.status === 401) { window.location.assign('/login'); return; }
      if (!response.ok) throw new Error('Binance atau bot belum memberikan snapshot dashboard.');
      const data = await response.json(); if (requestId !== state.requestId) return; state.data = data; state.positionSide = data.selectedPositionSide || positionSide; renderSymbols(data.symbols || [], data.selectedSymbol); setLoading(false); render(); state.timer = setTimeout(() => load(), Math.max(2, num(data.refreshSeconds) || 5) * 1000);
    } catch (error) {
      if (error.name === 'AbortError') return; setLoading(false); text('error-text', error.message || 'Data dashboard tidak tersedia.'); byId('error-notice').hidden = false; text('status-text', 'Offline · mencoba lagi'); byId('status-mark').dataset.state = 'error'; state.timer = setTimeout(() => load(), 5000);
    }
  }
  function bindEvents() {
    document.querySelectorAll('.flow-node').forEach(node => node.addEventListener('click', () => { state.activeNode = node.dataset.node; if (state.data) renderInspector(); }));
    byId('symbol-select').addEventListener('change', event => load({ symbol: event.target.value, announced: true })); byId('refresh-button').addEventListener('click', () => { spinRefreshButton(); load({ announced: true }); }); byId('retry-button').addEventListener('click', () => load({ announced: true }));
    byId('motion-select').addEventListener('change', event => applyMotionPreference(event.target.value, { persist: true }));
    document.querySelectorAll('.position-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const positionSide = tab.dataset.positionSide;
        if (positionSide === state.positionSide) return;
        state.positionSide = positionSide;
        state.activeNode = 'supervisor';
        renderPositionTabs();
        load({ positionSide, announced: true });
      });
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll('.position-tab')];
        const current = tabs.indexOf(event.currentTarget);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      });
    });
    reducedMotion.addEventListener?.('change', () => { if (state.motionPreference === 'system') applyMotionPreference('system'); });
    let resizeTimer; window.addEventListener('resize', () => { queueFlowLayout(); clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 100); });
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(queueFlowLayout);
      observer.observe(byId('flow-map'));
      observer.observe(byId('flow-map').querySelector('.flow-grid'));
    }
    document.fonts?.ready.then(queueFlowLayout);
    queueFlowLayout();
  }
  applyMotionPreference(savedMotionPreference()); bindEvents(); load();
})();
