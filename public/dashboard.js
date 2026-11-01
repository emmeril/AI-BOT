(() => {
  'use strict';

  const state = { data: null, positionSide: 'LONG', activeNode: 'supervisor', timer: null, controller: null, requestId: 0, loading: true, refreshSpinTimer: null, flowLayoutFrame: null, motionPreference: 'system' };
  const MOTION_STORAGE_KEY = 'grid-flow-motion';
  const SYMBOL_STORAGE_KEY = 'grid-flow-futures-symbol';
  const POSITION_SIDE_STORAGE_KEY = 'grid-flow-futures-position-side';
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
  const normalizePositionSide = value => String(value || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
  const positionSide = () => normalizePositionSide(state.data?.selectedPositionSide || state.positionSide);
  const entrySide = () => positionSide() === 'SHORT' ? 'SELL' : 'BUY';
  const exitSide = () => positionSide() === 'SHORT' ? 'BUY' : 'SELL';

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
      return ['on', 'system', 'off'].includes(value) ? value : 'system';
    } catch { return 'system'; }
  }
  function savedPositionSide() {
    try { return normalizePositionSide(localStorage.getItem(POSITION_SIDE_STORAGE_KEY)); } catch { return 'LONG'; }
  }
  function persistPositionSide(side) {
    try { localStorage.setItem(POSITION_SIDE_STORAGE_KEY, normalizePositionSide(side)); } catch {}
  }
  function symbolStorageKey(side) { return `${SYMBOL_STORAGE_KEY}-${normalizePositionSide(side).toLowerCase()}`; }
  function savedSelectedSymbol(side = state.positionSide) {
    try {
      return localStorage.getItem(symbolStorageKey(side)) ||
        (normalizePositionSide(side) === 'LONG' ? localStorage.getItem(SYMBOL_STORAGE_KEY) || '' : '');
    } catch { return ''; }
  }
  function persistSelectedSymbol(symbol, side = state.positionSide) {
    try {
      const key = symbolStorageKey(side);
      if (symbol) localStorage.setItem(key, symbol);
      else localStorage.removeItem(key);
    } catch {}
  }
  function applyMotionPreference(value, { persist = false } = {}) {
    const preference = ['on', 'system', 'off'].includes(value) ? value : 'system';
    state.motionPreference = preference; document.documentElement.dataset.motion = preference;
    byId('motion-select').value = preference;
    const description = preference === 'on' ? 'Animasi dashboard aktif.' : preference === 'off' ? 'Animasi dashboard dimatikan.' : `Animasi mengikuti sistem dan saat ini ${reducedMotion.matches ? 'mati' : 'aktif'}.`;
    text('motion-state', description); byId('motion-control').title = description;
    if (persist) { try { localStorage.setItem(MOTION_STORAGE_KEY, preference); } catch {} }
  }
  function signalView(scalper = {}) {
    const signal = scalper.signal || {};
    const flowPct = nullable(signal.flowDeltaRatio) === null ? null : num(signal.flowDeltaRatio) * 100;
    const cooldownMs = Math.max(0, num(scalper.cooldownUntil) - Date.now());
    const cooldownMinutes = Math.ceil(cooldownMs / 60_000);
    let status = 'MENUNGGU CANDLE';
    let tone = 'accent';
    let summary = `Bot menunggu candle ${scalper.timeframe || '15m'} yang selesai.`;
    if (!scalper.handoffActive) {
      status = 'TRANSISI';
      tone = 'warning';
      summary = 'Bot menyelesaikan posisi dan order strategi lama sebelum menerima entry baru.';
    } else if (!scalper.sideEnabled) {
      status = 'SISI NONAKTIF';
      tone = 'warning';
      summary = `${positionSide()} tidak diaktifkan pada konfigurasi scalper.`;
    } else if (scalper.paused || !scalper.tradingEnabled) {
      status = 'ENTRY DIJEDA';
      tone = 'warning';
      summary = scalper.pauseReason || 'Entry baru sedang dijeda. Posisi terbuka tetap dilindungi.';
    } else if (cooldownMinutes > 0) {
      status = 'COOLDOWN';
      tone = 'warning';
      summary = `Bot menunggu ${cooldownMinutes} menit sebelum entry berikutnya.`;
    } else if (signal.available && signal.allow) {
      status = 'SINYAL ENTRY';
      tone = 'positive';
      summary = `Volume delta dan pantulan harga memenuhi syarat entry ${positionSide()}.`;
    } else if (signal.available) {
      status = 'MENUNGGU SINYAL';
      tone = 'accent';
      summary = `Belum ada sinyal entry ${positionSide()} pada candle terakhir.`;
    }
    return {
      available: Boolean(signal.available),
      allowed: Boolean(signal.available && signal.allow && scalper.tradingEnabled && cooldownMinutes === 0),
      status,
      tone,
      summary,
      flowPct,
      momentumPct: nullable(signal.momentumPct),
      atrPct: nullable(signal.atrPct),
      candleTimestamp: signal.candleTimestamp || null,
      value: flowPct === null ? 'Data belum tersedia' : `Delta ${signed(flowPct, 2)}%`,
      reason: signal.exit ? 'Volume delta memberi sinyal keluar.' : summary,
    };
  }

  function setAllocationSegment(id, value) {
    const element = byId(id);
    if (!element) return;
    const share = clamp(num(value), 0, 100);
    element.style.flex = `0 0 ${share}%`;
    element.setAttribute('aria-label', `${element.title} ${percent(share, 0)}`);
  }

  function renderPlainOverview() {
    const data = state.data;
    const allocation = data.exposureAllocation || {};
    const scalper = data.scalper || {};
    const selectedSide = positionSide();
    const position = data.futures?.position;
    const protection = scalper.protection || {};
    const exitProtected = !position || protection.status === 'PROTECTED';
    const botReady = Boolean(data.running && scalper.enabled && scalper.handoffActive);
    const healthState = !botReady || (position && !exitProtected) ? 'attention' : 'safe';

    byId('health-mark').dataset.state = healthState;
    text('plain-title', !scalper.handoffActive
      ? 'Menyelesaikan strategi lama'
      : scalper.paused
        ? 'Entry baru sedang dijeda'
        : position && !exitProtected
          ? 'TP atau SL perlu diperiksa'
          : position
            ? 'Posisi aktif dan terlindungi'
            : 'Bot aktif, menunggu sinyal');
    text('health-copy', !scalper.handoffActive
      ? 'Bot menjaga exit lama sampai pair kosong. Scalper mulai otomatis setelah transisi selesai.'
      : scalper.paused
        ? `${scalper.pauseReason || 'Entry baru dijeda.'} Posisi yang sudah terbuka tetap dipantau.`
        : !position
          ? `Pair ${data.selectedSymbol} belum memiliki posisi ${selectedSide}. Bot menunggu sinyal volume delta.`
          : exitProtected
            ? `Posisi ${selectedSide} memiliki take profit dan stop loss aktif di Binance.`
            : 'Posisi aktif belum terdeteksi memiliki take profit dan stop loss lengkap.');
    text('health-long', scalper.longEnabled ? 'Aktif' : 'Nonaktif');
    text('health-short', scalper.shortEnabled ? 'Aktif' : 'Nonaktif');
    text('health-exit', !position
      ? 'Tidak diperlukan'
      : protection.status === 'UNKNOWN'
        ? 'Belum dapat diperiksa'
        : exitProtected ? 'TP dan SL lengkap' : 'Perlu perhatian');

    const scalperPlan = Boolean(data.scalper?.enabled);
    const longTarget = scalperPlan
      ? clamp(num(data.scalper.longAllocationPct), 0, 100)
      : clamp(num(allocation.LONG?.configuredSidePct ?? allocation.longPct), 0, 100);
    const shortTarget = scalperPlan
      ? clamp(num(data.scalper.shortAllocationPct), 0, 100)
      : clamp(num(allocation.SHORT?.configuredSidePct ?? allocation.shortPct), 0, 100);
    const plannedBuffer = clamp(100 - longTarget - shortTarget, 0, 100);
    const planTotal = longTarget + shortTarget + plannedBuffer;

    text('plan-long-pct', percent(longTarget, 0));
    text('plan-short-pct', percent(shortTarget, 0));
    text('plan-buffer-pct', percent(plannedBuffer, 0));
    text('portfolio-status', Math.abs(planTotal - 100) < .01 ? 'Total 100%' : `Total ${percent(planTotal, 0)}`);
    setAllocationSegment('segment-long', longTarget);
    setAllocationSegment('segment-short', shortTarget);
    setAllocationSegment('segment-buffer', plannedBuffer);

    const pairCount = num(scalper.pairCount) || Math.max(num(allocation.LONG?.pairCount), num(allocation.SHORT?.pairCount));
    text('ramp-message', `LONG dan SHORT berjalan independen. Masing-masing jatah dibagi rata ke ${pairCount || 'semua'} pair. Buffer ${percent(plannedBuffer, 0)} tidak dipakai untuk entry.`);
  }

  function renderStrategySummary() {
    const scalper = state.data?.scalper || {};
    const panel = byId('strategy-summary');
    if (!panel) return;
    const active = Boolean(scalper.handoffActive);
    panel.dataset.state = active ? 'active' : 'waiting';
    text('strategy-title', active ? 'Scalper volume delta aktif' : 'Posisi lama sedang diselesaikan');
    text('strategy-copy', active
      ? `Bot membaca candle ${scalper.timeframe || '15m'}. LONG dan SHORT boleh berjalan bersamaan dan setiap posisi memiliki TP serta SL sendiri.`
      : 'Grid lama tidak menerima entry baru. Bot tetap menjaga exit lama, lalu berpindah ke scalper setelah pair kosong.');
    text('strategy-mode', 'LONG + SHORT');
    text('strategy-risk', `${percent(scalper.takeProfitPct, 1)} / ${percent(scalper.stopLossPct, 1)}`);
    text('strategy-hold', `${num(scalper.maxHoldMinutes) || 240} menit`);
    text('strategy-allocation', `${percent(scalper.longAllocationPct, 0)} + ${percent(scalper.shortAllocationPct, 0)}`);
  }

  function allocationPairCard(symbol, budget, side) {
    const article = document.createElement('article');
    article.className = 'allocation-pair';
    article.setAttribute('aria-label', `Alokasi ${side} ${symbol}`);

    const head = document.createElement('div'); head.className = 'allocation-pair-head';
    const identity = document.createElement('div');
    const indexLabel = document.createElement('span'); indexLabel.textContent = 'Pair terpilih';
    const title = document.createElement('strong'); title.textContent = symbol;
    identity.append(indexLabel, title);
    const status = document.createElement('span'); status.className = `allocation-state ${budget.status.tone}`.trim(); status.textContent = budget.status.label;
    head.append(identity, status);

    const values = document.createElement('dl'); values.className = 'allocation-pair-budget';
    for (const [label, main, note] of [
      [`Jatah margin ${side}`, percent(budget.marginPct, 2), `Dari saldo wallet, dibagi rata ke ${budget.pairCount} pair`],
      ['Batas posisi pair', `${money(budget.targetNotional, 2)} ${quote()}`, `Terpakai ${money(budget.currentExposure, 2)} ${quote()}`],
    ]) {
      const row = document.createElement('div');
      const term = document.createElement('dt'); term.textContent = label;
      const description = document.createElement('dd');
      const mainValue = document.createElement('strong'); mainValue.textContent = main;
      const noteValue = document.createElement('small'); noteValue.textContent = note;
      description.append(mainValue, noteValue); row.append(term, description); values.append(row);
    }
    article.append(head, values);
    return article;
  }

  function renderAllocation() {
    const allocation = state.data.exposureAllocation || {};
    const scalper = state.data.scalper || {};
    const side = positionSide();
    const sidePct = clamp(num(side === 'LONG' ? scalper.longAllocationPct : scalper.shortAllocationPct), 0, 100);
    const bufferPct = clamp(100 - num(scalper.longAllocationPct) - num(scalper.shortAllocationPct), 0, 100);
    const pairCount = Math.max(1, Math.trunc(num(scalper.pairCount)) || 1);
    const perPairPct = sidePct / pairCount;
    const targetNotional = num(allocation.walletBalance) * sidePct / 100 * num(allocation.leverage) / pairCount;
    const currentExposure = num(state.data.comparison?.[side]?.exposure);
    const usagePct = targetNotional > 0 ? currentExposure / targetNotional * 100 : 0;
    text('allocation-title', `Jatah ${side} untuk pair terpilih`);
    text('allocation-mode', scalper.sideEnabled ? `${side} aktif` : `${side} nonaktif`);
    text('allocation-buffer-pct', percent(bufferPct, 0));
    text('allocation-active-pct', percent(sidePct, 0));
    text('allocation-ramp-limit', percent(perPairPct, 2));
    text('allocation-copy', `Jatah ${side} ${percent(sidePct, 0)} dibagi rata ke ${pairCount} pair. Pair ini mendapat ${percent(perPairPct, 2)} dari margin wallet.`);
    text('allocation-wallet', `${money(allocation.walletBalance, 2)} ${quote()}`);
    text('allocation-leverage', `${money(allocation.leverage, 0)}x`);
    text('allocation-pair-count', `${pairCount} pair`);
    const list = byId('allocation-pair-list');
    list.replaceChildren();
    const symbol = state.data.selectedSymbol;
    if (!symbol) {
      const empty = document.createElement('div'); empty.className = 'allocation-empty'; empty.textContent = `Belum ada pair ${side} yang dipilih.`; list.append(empty); return;
    }
    list.append(allocationPairCard(symbol, {
      status: {
        label: scalper.paused ? 'Entry dijeda' : currentExposure > 0 ? 'Posisi aktif' : 'Menunggu sinyal',
        tone: scalper.paused ? 'warning' : currentExposure > 0 ? 'positive' : '',
      },
      marginPct: perPairPct,
      targetNotional,
      currentExposure,
      usagePct,
      pairCount,
    }, side));
  }

  function renderOverview() {
    const data = state.data;
    const side = positionSide();
    const scalper = data.scalper || {};
    const signal = signalView(scalper);
    const targetPct = side === 'LONG' ? num(scalper.longAllocationPct) : num(scalper.shortAllocationPct);
    const pairCount = Math.max(1, num(scalper.pairCount));
    const targetNotional = num(data.exposureAllocation?.walletBalance) * targetPct / 100 *
      num(data.exposureAllocation?.leverage) / pairCount;
    const currentExposure = num(data.comparison?.[side]?.exposure);
    text('source-label', data.source || 'Binance');
    text('overview-title', `${data.selectedSymbol || 'Pair belum dipilih'} · ${side}`);
    text('overview-copy', signal.summary);
    text('market-price', `${data.market?.priceText || price(data.market?.price)} ${quote()}`);
    text('market-change', `Perubahan 24 jam: ${signed(data.market?.changePercent, 2)}%`);
    text('entry-signal-label', `Sinyal ${scalper.timeframe || '15m'}`);
    text('entry-signal-status', signal.status);
    text('entry-signal-value', signal.value);
    byId('entry-signal-status').className = `metric-value ${signal.tone}`.trim();
    text('exposure-label', 'Posisi terhadap jatah pair');
    text('exposure-value', targetNotional > 0 ? percent(currentExposure / targetNotional * 100, 0) : 'N/A');
    text('exposure-note', targetNotional > 0
      ? `${money(currentExposure, 2)} dari ${money(targetNotional, 2)} ${quote()}`
      : 'Batas pair belum tersedia');
    text('pnl-label', `Hasil ${side}`);
    text('net-pnl', `${signed(data.profit?.net, 4)} ${quote()}`);
    pnlTone(byId('net-pnl'), data.profit?.net);
  }

  function renderFlow() {
    const data = state.data;
    const side = positionSide();
    byId('flow-map').dataset.running = String(Boolean(data.running));
    const scalper = data.scalper || {};
    const signal = signalView(scalper);
    const position = data.futures?.position;
    const protection = scalper.protection || {};
    const selectedEntrySide = entrySide();
    const selectedExitSide = exitSide();
    const marketAvailable = Boolean(data.running && num(data.market?.price) > 0);
    const volumeAvailable = Boolean(signal.available);
    const positionAvailable = Boolean(data.running && position && num(position.contracts) > 0);
    const protectionReady = Boolean(positionAvailable && protection.status === 'PROTECTED');
    const protectionError = Boolean(positionAvailable && ['INCOMPLETE', 'UNKNOWN'].includes(protection.status));
    text('flow-title', `Dari candle ${scalper.timeframe || '15m'} sampai posisi ditutup`);
    text('supervisor-node-title', `Sinyal ${side}`);
    text('entry-node-title', `Market ${selectedEntrySide}`);
    text('position-node-title', side);
    text('exit-node-title', 'Take profit dan stop loss');
    setNode('market', 'accent', String(data.mode || 'LIVE').toUpperCase(), `${data.market?.priceText || price(data.market?.price)} ${quote()}`, `${signed(data.market?.changePercent, 2)}% dalam 24 jam`);
    setNode('fibonacci', volumeAvailable ? 'positive' : 'accent', volumeAvailable ? 'TERBACA' : 'MENUNGGU', signal.value, `Candle selesai ${time(signal.candleTimestamp)}`);
    setNode('supervisor', signal.tone, signal.status, signal.allowed ? `Entry ${side}` : 'Belum entry', signal.reason);
    setNode('buy', positionAvailable ? 'positive' : 'accent', positionAvailable ? 'SELESAI' : 'MENUNGGU', `${selectedEntrySide} market`, positionAvailable ? `Entry ${price(position.entryPrice)} ${quote()}` : 'Dikirim hanya saat sinyal valid');
    setNode('position', position ? (num(data.profit?.unrealizedPnl) >= 0 ? 'positive' : 'negative') : 'accent', position ? `${side} AKTIF` : 'KOSONG', position ? compact(position.contracts) : '0', position ? `PnL ${signed(data.profit?.unrealizedPnl, 4)} ${quote()}` : 'Menunggu entry');
    setNode('sell', protectionError ? 'negative' : protectionReady ? 'positive' : 'accent', !position ? 'TIDAK PERLU' : protectionReady ? 'LENGKAP' : 'PERLU CEK', !position ? 'Belum ada posisi' : `TP ${price(protection.takeProfit?.triggerPrice)} / SL ${price(protection.stopLoss?.triggerPrice)}`, !position ? 'Proteksi dipasang setelah entry' : protectionReady ? `Keduanya menutup posisi ${side}` : `Periksa ${selectedExitSide} conditional order`);
    setFlowNodeState('market', marketAvailable ? 'active' : 'waiting');
    setFlowNodeState('fibonacci', volumeAvailable ? 'active' : 'waiting');
    setFlowNodeState('supervisor', signal.allowed ? 'active' : 'waiting');
    setFlowNodeState('buy', positionAvailable ? 'active' : 'waiting');
    setFlowNodeState('position', positionAvailable ? 'active' : 'waiting');
    setFlowNodeState('sell', protectionError ? 'error' : protectionReady ? 'active' : 'waiting');
    setFlowEdge('market', 'fibonacci', volumeAvailable ? 'active' : 'waiting');
    setFlowEdge('fibonacci', 'supervisor', signal.available ? 'active' : 'waiting');
    setFlowEdge('supervisor', 'buy', positionAvailable ? 'active' : 'waiting');
    setFlowEdge('buy', 'position', positionAvailable ? 'active' : 'waiting');
    setFlowEdge('position', 'sell', protectionError ? 'error' : protectionReady ? 'active' : 'waiting');
    queueFlowLayout();
  }

  function inspectorModel() {
    const data = state.data;
    const side = positionSide();
    const scalper = data.scalper || {};
    const signal = signalView(scalper);
    const position = data.futures?.position;
    const protection = scalper.protection || {};
    const selectedEntrySide = entrySide();
    const selectedExitSide = exitSide();
    return ({
      market: {
        title: 'Harga Binance', status: String(data.mode || 'LIVE').toUpperCase(), summary: 'Harga live yang dipakai bot.',
        tags: data.market?.timeframe ? [data.market.timeframe] : [],
        details: [['Harga', `${data.market?.priceText || price(data.market?.price)} ${quote()}`], ['24 jam', `${signed(data.market?.changePercent, 2)}%`], ['High', `${data.market?.highText || price(data.market?.high)} ${quote()}`], ['Low', `${data.market?.lowText || price(data.market?.low)} ${quote()}`]],
      },
      fibonacci: {
        title: 'Volume delta', status: signal.available ? 'TERBACA' : 'MENUNGGU', summary: 'Perbandingan tekanan beli dan jual pada candle yang sudah selesai.', tags: [scalper.timeframe || '15m'],
        details: [['Delta', signal.flowPct === null ? 'N/A' : signed(signal.flowPct, 2) + '%'], ['Momentum', signal.momentumPct === null ? 'N/A' : signed(signal.momentumPct, 2) + '%'], ['ATR', signal.atrPct === null ? 'N/A' : percent(signal.atrPct, 2)], ['Candle', time(signal.candleTimestamp)]],
      },
      supervisor: {
        title: `Sinyal ${side}`, status: signal.status, summary: signal.summary,
        tags: signal.available ? [signal.value] : [],
        details: [['Strategi', 'Volume delta reversal'], ['Timeframe', scalper.timeframe || '15m'], ['Keputusan', signal.status], ['Cooldown sampai', scalper.cooldownUntil ? time(scalper.cooldownUntil) : 'Tidak ada']],
      },
      buy: {
        title: `Entry market ${selectedEntrySide}`, status: position ? 'SELESAI' : 'MENUNGGU', summary: position ? 'Order market sudah menjadi posisi aktif.' : 'Bot mengirim order market hanya setelah sinyal valid.', tags: [signal.status],
        details: [['Sisi order', selectedEntrySide], ['Status posisi', position ? 'Aktif' : 'Kosong'], ['Harga entry', position ? `${price(position.entryPrice)} ${quote()}` : 'N/A'], ['Jumlah', position ? compact(position.contracts) : '0']],
      },
      position: {
        title: `Posisi ${side}`, status: position ? 'AKTIF' : 'KOSONG', summary: position ? 'Posisi dipantau sampai TP, SL, sinyal keluar, atau batas waktu.' : `Tidak ada posisi ${side}.`,
        tags: position ? [`${data.futures?.leverage || 0}x`, `Maks ${num(scalper.maxHoldMinutes)} menit`] : [],
        details: [['Kontrak', position ? compact(position.contracts) : '0'], ['Entry', position ? price(position.entryPrice) : 'N/A'], ['Mark', position ? price(position.markPrice) : 'N/A'], ['Likuidasi', position?.liquidationPrice > 0 ? price(position.liquidationPrice) : 'N/A'], ['PnL berjalan', `${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`], ['Mulai', scalper.trackedPosition?.enteredAt ? time(scalper.trackedPosition.enteredAt) : 'N/A']],
      },
      sell: {
        title: `Proteksi ${selectedExitSide}`, status: !position ? 'TIDAK PERLU' : protection.status === 'PROTECTED' ? 'LENGKAP' : 'PERLU CEK',
        summary: !position ? 'Proteksi akan dipasang setelah entry.' : protection.status === 'PROTECTED' ? 'Take profit dan stop loss aktif di Binance.' : 'Take profit atau stop loss belum terdeteksi lengkap.',
        tags: position ? [protection.status || 'UNKNOWN'] : [],
        details: [['Take profit', protection.takeProfit?.triggerPrice ? `${price(protection.takeProfit.triggerPrice)} ${quote()}` : 'N/A'], ['Stop loss', protection.stopLoss?.triggerPrice ? `${price(protection.stopLoss.triggerPrice)} ${quote()}` : 'N/A'], ['Jumlah order', num(protection.count)], ['Close position', protection.covered ? 'Ya' : 'Belum lengkap']],
      },
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
    const side = positionSide();
    text('ledger-title', `${state.data.selectedSymbol || 'Pair'} · ${side}`);
    text('grid-profit-label', 'Hasil akun pair');
    const realized = profit.accounting?.ready ? profit.accounting.realized : profit.realized;
    const accountNet = profit.accounting?.ready ? profit.accountNet : profit.net;
    for (const [id, value] of [['realized-pnl', realized], ['funding-pnl', profit.accounting?.ready ? profit.funding : null], ['unrealized-pnl', profit.unrealizedPnl], ['grid-profit', accountNet], ['ledger-net', accountNet]]) { text(id, `${signed(value, 4)} ${quote()}`); pnlTone(byId(id), value); }
    text('fees-value', `${money(profit.fees, 4)} ${quote()}`);
  }
  function renderRisk() {
    const data = state.data; const position = data.futures?.position; const scalper = data.scalper || {}; const side = positionSide();
    const sidePct = num(side === 'LONG' ? scalper.longAllocationPct : scalper.shortAllocationPct);
    const pairCount = Math.max(1, num(scalper.pairCount));
    const target = num(data.exposureAllocation?.walletBalance) * sidePct / 100 * num(data.exposureAllocation?.leverage) / pairCount;
    const current = num(data.comparison?.[side]?.exposure);
    const exposure = target > 0 ? current / target * 100 : 0;
    const threshold = 100;
    text('risk-title', `Jatah ${data.selectedSymbol || 'pair'}`);
    text('risk-exposure', target > 0 ? percent(exposure, 0) : 'N/A');
    text('risk-caption', target > 0
      ? `${money(current, 2)} dari jatah posisi ${money(target, 2)} ${quote()}`
      : 'Jatah pair belum tersedia.');
    byId('exposure-fill').style.width = `${clamp(exposure, 0, 100)}%`; byId('exposure-fill').style.background = exposure >= threshold ? 'var(--warning)' : 'var(--accent)';
    byId('exposure-limit').style.left = `${clamp(threshold, 0, 100)}%`; byId('exposure-meter').setAttribute('aria-valuenow', String(clamp(exposure, 0, 100)));
    const mark = num(position?.markPrice); const liquidation = num(position?.liquidationPrice); const distance = mark > 0 && liquidation > 0 ? Math.abs(mark - liquidation) / mark * 100 : null;
    renderDefinitionList(byId('risk-facts'), [['Posisi sekarang', `${money(current, 2)} ${quote()}`], ['Jatah posisi pair', target > 0 ? `${money(target, 2)} ${quote()}` : 'N/A'], ['Saldo tersedia', `${money(data.futures?.availableBalance, 2)} ${quote()}`], ['Jarak likuidasi', distance == null ? 'N/A' : percent(distance, 2)]]);
  }

  function renderOrders() {
    const orders = state.data.orders?.active || [];
    text('buy-count', `BUY ${num(state.data.orders?.buyCount)}`); text('sell-count', `SELL ${num(state.data.orders?.sellCount)}`);
    text('orders-copy', `Order aktif untuk posisi ${positionSide()}, termasuk take profit dan stop loss.`);
    const body = byId('orders-body'); const cards = byId('order-cards'); body.replaceChildren(); cards.replaceChildren();
    if (!orders.length) {
      const row = document.createElement('tr'); row.className = 'empty-row'; const cell = document.createElement('td'); cell.colSpan = 7; cell.textContent = state.loading ? 'Mengambil order aktif dari Binance.' : 'Tidak ada order aktif. Saat posisi kosong, kondisi ini normal.'; row.append(cell); body.append(row);
      const empty = document.createElement('div'); empty.className = 'order-empty'; empty.textContent = state.loading ? 'Memuat order aktif.' : 'Tidak ada order aktif. Saat posisi kosong, kondisi ini normal.'; cards.append(empty); return;
    }
    for (const order of [...orders].sort((a, b) => b.price - a.price || String(a.side).localeCompare(String(b.side)))) {
      const row = document.createElement('tr');
      const type = order.orderType === 'TAKE_PROFIT' ? 'TP' : order.orderType === 'STOP_LOSS' ? 'SL' : order.level == null ? 'REGULAR' : `L${order.level}`;
      const values = [{ value: String(order.side || '').toUpperCase(), className: `side-label ${order.side}` }, { value: type }, { value: order.priceText || price(order.price) }, { value: order.amountText || compact(order.amount) }, { value: order.remainingText || compact(order.remaining) }, { value: order.entryComparison || 'Order aktif' }, { value: order.id }];
      for (const item of values) { const cell = document.createElement('td'); if (item.className) { const span = document.createElement('span'); span.className = item.className; span.textContent = item.value; cell.append(span); } else cell.textContent = item.value; row.append(cell); } body.append(row);
      const card = document.createElement('article'); card.className = 'order-card';
      const side = document.createElement('span'); side.className = `side-label ${order.side}`; side.textContent = String(order.side || '').toUpperCase();
      const level = document.createElement('small'); level.textContent = type;
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
    const width = box.width; const height = box.height; const padding = { left: 10, right: Math.min(86, width * .25), top: 12, bottom: 24 };
    const position = state.data.futures?.position;
    const protection = state.data.scalper?.protection || {};
    const markers = [
      { value: num(position?.entryPrice), color: '#f3f7f5', label: 'ENTRY' },
      { value: num(protection.takeProfit?.triggerPrice), color: '#91d4aa', label: 'TP' },
      { value: num(protection.stopLoss?.triggerPrice), color: '#ff8d86', label: 'SL' },
    ];
    const values = candles.flatMap(candle => [num(candle.high), num(candle.low)]).concat(markers.filter(item => item.value > 0).map(item => item.value)); const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
    const plotWidth = width - padding.left - padding.right; const plotHeight = height - padding.top - padding.bottom; const x = index => padding.left + index * plotWidth / Math.max(candles.length - 1, 1); const y = value => padding.top + (max - value) * plotHeight / span;
    context.clearRect(0, 0, width, height); context.font = '10px ui-monospace, monospace'; context.fillStyle = '#aab5c2'; context.strokeStyle = '#25313e'; context.lineWidth = 1;
    for (let index = 0; index < 5; index += 1) { const gridY = padding.top + index * plotHeight / 4; const value = max - index * span / 4; context.beginPath(); context.moveTo(padding.left, gridY); context.lineTo(width - padding.right, gridY); context.stroke(); context.fillText(price(value), width - padding.right + 9, gridY + 4); }
    markers.forEach(item => { if (!(item.value > 0)) return; const lineY = y(item.value); context.setLineDash([6, 5]); context.strokeStyle = item.color; context.beginPath(); context.moveTo(padding.left, lineY); context.lineTo(width - padding.right, lineY); context.stroke(); context.setLineDash([]); context.fillStyle = item.color; context.fillText(item.label, padding.left + 4, lineY - 5); });
    const gradient = context.createLinearGradient(0, padding.top, 0, height - padding.bottom); gradient.addColorStop(0, 'rgba(198,243,111,.22)'); gradient.addColorStop(1, 'rgba(198,243,111,0)');
    context.beginPath(); candles.forEach((candle, index) => index ? context.lineTo(x(index), y(num(candle.close))) : context.moveTo(x(index), y(num(candle.close)))); context.lineTo(x(candles.length - 1), height - padding.bottom); context.lineTo(x(0), height - padding.bottom); context.closePath(); context.fillStyle = gradient; context.fill();
    context.beginPath(); candles.forEach((candle, index) => index ? context.lineTo(x(index), y(num(candle.close))) : context.moveTo(x(index), y(num(candle.close)))); context.strokeStyle = '#c6f36f'; context.lineWidth = 2; context.stroke();
  }
  function renderChartMeta() { const position = state.data.futures?.position; text('range-copy', position ? 'Garis menunjukkan harga entry, take profit, dan stop loss.' : 'Grafik harga pair. Garis proteksi muncul setelah entry.'); text('timeframe-label', state.data.market?.timeframe || 'N/A'); requestAnimationFrame(drawChart); }
  function renderRuntime() {
    const data = state.data; const side = positionSide(); text('status-text', state.loading ? 'Memperbarui' : !data.running ? `${side} · Bot offline` : data.tradingEnabled ? `${side} · Trading aktif` : `${side} · Order dijeda`); byId('status-mark').dataset.state = state.loading ? '' : data.tradingEnabled ? 'active' : data.running ? 'paused' : 'error';
    text('updated-at', `Diperbarui ${time(data.generatedAt)}`); text('runtime-label', `${String(data.mode || '').toUpperCase()} · ${data.source || 'Binance'} · refresh ${num(data.refreshSeconds) || 5} detik`); byId('logout-form').hidden = !data.dashboardAuthEnabled;
  }
  function renderPositionSwitch() {
    document.querySelectorAll('[data-position-side]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.positionSide === state.positionSide));
    });
  }
  function render() { renderPositionSwitch(); renderStrategySummary(); renderPlainOverview(); renderAllocation(); renderOverview(); renderFlow(); renderInspector(); renderLedger(); renderRisk(); renderOrders(); renderChartMeta(); renderRuntime(); }
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
      const requestedSide = normalizePositionSide(options.positionSide || state.positionSide);
      const selected = options.symbol ?? (requestedSide === state.positionSide ? byId('symbol-select').value : savedSelectedSymbol(requestedSide));
      const query = new URLSearchParams({ positionSide: requestedSide });
      if (selected) query.set('symbol', selected);
      const response = await fetch(`/api/dashboard?${query.toString()}`, { signal: state.controller.signal, cache: 'no-store' });
      if (response.status === 401) { window.location.assign('/login'); return; }
      if (!response.ok) throw new Error('Binance atau bot belum memberikan snapshot dashboard.');
      const data = await response.json(); if (requestId !== state.requestId) return; state.positionSide = normalizePositionSide(data.selectedPositionSide || requestedSide); state.data = data; renderSymbols(data.symbols || [], data.selectedSymbol); persistSelectedSymbol(data.selectedSymbol, state.positionSide); persistPositionSide(state.positionSide); setLoading(false); render(); state.timer = setTimeout(() => load(), Math.max(2, num(data.refreshSeconds) || 5) * 1000);
    } catch (error) {
      if (error.name === 'AbortError') return; setLoading(false); text('error-text', error.message || 'Data dashboard tidak tersedia.'); byId('error-notice').hidden = false; text('status-text', 'Offline · mencoba lagi'); byId('status-mark').dataset.state = 'error'; state.timer = setTimeout(() => load(), 5000);
    }
  }
  function bindEvents() {
    document.querySelectorAll('.flow-node').forEach(node => node.addEventListener('click', () => { state.activeNode = node.dataset.node; if (state.data) renderInspector(); }));
    document.querySelectorAll('[data-position-side]').forEach(button => button.addEventListener('click', () => {
      const nextSide = normalizePositionSide(button.dataset.positionSide);
      if (nextSide === state.positionSide) return;
      state.positionSide = nextSide;
      persistPositionSide(nextSide);
      renderPositionSwitch();
      load({ positionSide: nextSide, symbol: savedSelectedSymbol(nextSide), announced: true });
    }));
    byId('symbol-select').addEventListener('change', event => { persistSelectedSymbol(event.target.value, state.positionSide); load({ symbol: event.target.value, announced: true }); }); byId('refresh-button').addEventListener('click', () => { spinRefreshButton(); load({ announced: true }); }); byId('retry-button').addEventListener('click', () => load({ announced: true }));
    byId('motion-select').addEventListener('change', event => applyMotionPreference(event.target.value, { persist: true }));
    byId('technical-details').addEventListener('toggle', event => {
      if (!event.target.open) return;
      queueFlowLayout();
      requestAnimationFrame(drawChart);
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
  state.positionSide = savedPositionSide(); applyMotionPreference(savedMotionPreference()); renderPositionSwitch(); bindEvents(); load({ positionSide: state.positionSide, symbol: savedSelectedSymbol(state.positionSide) });
})();
