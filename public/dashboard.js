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
  function priceMomentumView(momentum) {
    const side = String(momentum.positionSide || state.positionSide).toUpperCase();
    const windowHours = num(momentum.windowMinutes) / 60;
    const label = windowHours > 0 ? `Momentum ${money(windowHours, 0)}J` : 'Momentum';
    if (!momentum.enabled) return { label, status: 'MENUNGGU', tone: '', value: 'Belum aktif', reason: 'Data strategi belum tersedia.' };
    if (!momentum.available) {
      return {
        label,
        status: momentum.allow ? 'ENTRY BOLEH' : 'ENTRY DITAHAN',
        tone: momentum.allow ? 'positive' : 'negative',
        value: 'Data belum cukup',
        reason: 'Menunggu candle tertutup.',
      };
    }
    const returnPct = num(momentum.returnRatio) * 100;
    return {
      label,
      status: momentum.allow ? 'ENTRY BOLEH' : 'ENTRY DITAHAN',
      tone: momentum.allow ? 'positive' : 'negative',
      value: `${signed(returnPct, 2)}% · ${momentum.direction || 'NEUTRAL'}`,
      reason: momentum.allow
        ? `Momentum searah ${side}.`
        : `Momentum berlawanan dengan ${side}.`,
    };
  }

  function entryGateView(momentum) {
    const entrySide = isShort() ? 'SELL' : 'BUY';
    if (momentum.enabled === undefined) {
      return {
        allowed: false, available: false, blocked: false, entrySide,
        status: 'MENUNGGU', summary: 'Menunggu data Momentum.', tone: 'warning',
      };
    }
    const available = Boolean(state.data?.running && momentum.enabled);
    const blocked = momentum.allow === false;
    const tradingEnabled = Boolean(state.data?.tradingEnabled);
    const allowed = Boolean(available && tradingEnabled && !blocked);
    let status = 'MENUNGGU';
    let tone = 'accent';
    let summary = `Entry ${entrySide} menunggu Momentum.`;
    if (available && !blocked && !tradingEnabled) {
      status = 'ORDER DIJEDA';
      tone = 'warning';
      summary = `Momentum mendukung ${entrySide}, tetapi order baru sedang dijeda.`;
    } else if (available && blocked) {
      status = 'ENTRY DITAHAN';
      tone = 'negative';
      summary = `Momentum belum mendukung entry ${entrySide}.`;
    } else if (allowed) {
      status = 'ENTRY BOLEH';
      tone = 'positive';
      summary = `Momentum mendukung entry ${entrySide}.`;
    }
    return { allowed, available, blocked, entrySide, status, summary, tone };
  }

  function entryOrderView(gate, entryCount, entrySide) {
    if (entryCount > 0) {
      return {
        status: `${entryCount} ORDER AKTIF`,
        tone: entrySide === 'BUY' ? 'positive' : 'warning',
        summary: `${entryCount} order ${entrySide} entry sedang aktif di Binance.`,
        meta: 'Order entry sudah terpasang',
      };
    }
    if (gate.allowed) {
      return {
        status: 'TIDAK ADA ORDER',
        tone: 'warning',
        summary: `Momentum mendukung ${entrySide}, tetapi belum ada order aktif.`,
        meta: 'Menunggu siklus order',
      };
    }
    return {
      status: 'DITAHAN GATE',
      tone: 'accent',
      summary: `Belum ada order ${entrySide} karena gate sinyal saat ini belum mengizinkan entry.`,
      meta: 'Menunggu Momentum',
    };
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

  function allocationStatusView(budget) {
    if (!budget?.available) return { label: 'Data belum tersedia', tone: '' };
    if (budget.status === 'DEFERRED') {
      return { label: 'Menunggu sisi kosong', tone: 'warning' };
    }
    if (budget.status === 'UNCHANGED' || budget.status === 'APPLIED') return { label: 'Aktif', tone: 'positive' };
    return { label: 'Menunggu', tone: '' };
  }

  function renderAllocation() {
    const allocation = state.data.exposureAllocation || {};
    const sidePct = clamp(num(allocation.sidePct), 0, 50);
    const combinedPct = clamp(num(allocation.combinedPct) || sidePct * 2, 0, 100);
    const bufferPct = clamp(num(allocation.bufferPct) || 100 - combinedPct, 0, 100);
    const longPct = sidePct;
    const shortPct = Math.min(sidePct, Math.max(0, 100 - longPct));
    const track = byId('allocation-track');
    const segments = track.querySelectorAll('span');
    segments[0].style.width = `${longPct}%`;
    segments[1].style.width = `${shortPct}%`;
    segments[2].style.width = `${bufferPct}%`;
    track.setAttribute(
      'aria-label',
      `Alokasi exposure LONG ${money(longPct, 0)} persen, SHORT ${money(shortPct, 0)} persen, buffer ${money(bufferPct, 0)} persen`
    );
    text('allocation-mode', allocation.enabled ? 'AKTIF' : 'NONAKTIF');
    text('allocation-long-pct', `LONG ${percent(longPct, 0)}`);
    text('allocation-short-pct', `SHORT ${percent(shortPct, 0)}`);
    text('allocation-buffer-pct', `BUFFER ${percent(bufferPct, 0)}`);
    text('allocation-wallet', `${money(allocation.walletBalance, 2)} ${quote()}`);
    const budgets = [allocation.LONG || {}, allocation.SHORT || {}];
    const symbolCaps = budgets.map(budget => nullable(budget.symbolCap)).filter(value => value !== null);
    const commonSymbolCap = symbolCaps.length ? Math.min(...symbolCaps) : null;
    text('allocation-symbol-cap', commonSymbolCap === null ? 'N/A' : `${money(commonSymbolCap, 2)} ${quote()}`);
    for (const side of ['LONG', 'SHORT']) {
      const budget = allocation[side] || {};
      const prefix = side.toLowerCase();
      const view = allocationStatusView(budget);
      const status = byId(`${prefix}-allocation-status`);
      status.className = `allocation-state ${view.tone}`.trim();
      text(`${prefix}-allocation-status`, view.label);
      text(`${prefix}-allocation-cap`, budget.available
        ? `${money(budget.sideCap, 2)} ${quote()}`
        : 'Cap aktif N/A');
      text(`${prefix}-allocation-meta`, budget.available
        ? `Terpakai ${money(budget.currentExposure, 2)} · target ${money(budget.targetSideCap, 2)} ${quote()}`
        : 'Data belum tersedia');
    }
  }

  function renderOverview() {
    const data = state.data;
    const adaptive = intel().adaptive || {};
    const momentum = intel().priceMomentum || {};
    const signal = priceMomentumView(momentum);
    const gate = entryGateView(momentum);
    text('source-label', data.source || 'Binance');
    text('overview-title', `${data.selectedSymbol || 'Pair belum dipilih'} · ${state.positionSide}`);
    text('overview-copy', gate.summary);
    text('market-price', `${data.market?.priceText || price(data.market?.price)} ${quote()}`);
    text('market-change', `24 jam: ${signed(data.market?.changePercent, 2)}%`);
    text('entry-signal-label', signal.label);
    text('entry-signal-status', gate.status);
    text('entry-signal-value', signal.value);
    byId('entry-signal-status').className = `metric-value ${gate.tone}`.trim();
    text('exposure-label', `Exposure ${data.selectedSymbol || 'pair'}`);
    text('exposure-value', percent(adaptive.exposurePct));
    text('exposure-note', adaptive.investmentCap > 0
      ? `${money(adaptive.allocatedInvestment, 2)} / ${money(adaptive.investmentCap, 2)} ${quote()}`
      : 'Batas exposure belum tersedia');
    text('pnl-label', `PnL ${data.selectedSymbol || 'pair'} ${state.positionSide}`);
    text('net-pnl', `${signed(data.profit?.net, 4)} ${quote()}`);
    pnlTone(byId('net-pnl'), data.profit?.net);
  }

  function renderFlow() {
    const data = state.data;
    byId('flow-map').dataset.running = String(Boolean(data.running));
    const execution = intel().execution || {};
    const momentum = intel().priceMomentum || {};
    const signal = priceMomentumView(momentum);
    const range = data.range || {};
    const position = data.futures?.position;
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const entrySide = isShort() ? 'SELL' : 'BUY';
    const exitSide = isShort() ? 'BUY' : 'SELL';
    const entryCount = num(execution.entryCount ?? data.orders?.[`${entrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${exitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${entrySide.toLowerCase()}Value`]);
    const marketAvailable = Boolean(data.running && num(data.market?.price) > 0);
    const fibonacciAvailable = Boolean(marketAvailable && num(range.lower) > 0 && num(range.upper) > 0);
    const gate = entryGateView(momentum);
    const positionAvailable = Boolean(data.running && position && num(position.contracts) > 0);
    const exitNeedsAttention = Boolean(positionAvailable && num(execution.uncovered) > 0);
    const exitAvailable = Boolean(positionAvailable && !exitNeedsAttention && coverage !== null && coverage !== undefined && num(coverage) >= 99.999);
    const entryView = entryOrderView(gate, entryCount, entrySide);
    text('flow-title', `Harga ke exit ${exitSide}`);
    text('supervisor-node-title', `Entry ${state.positionSide}`);
    text('entry-node-title', `Grid ${entrySide}`);
    text('position-node-title', state.positionSide);
    text('exit-node-title', `Exit ${exitSide}`);
    setNode('market', 'accent', String(data.mode || 'LIVE').toUpperCase(), `${data.market?.priceText || price(data.market?.price)} ${quote()}`, `${signed(data.market?.changePercent, 2)}% dalam 24 jam`);
    setNode('fibonacci', fibonacciAvailable ? 'positive' : 'accent', fibonacciAvailable ? 'SIAP' : 'MENUNGGU', fibonacciAvailable ? `${price(range.lower)} – ${price(range.upper)}` : 'Range belum tersedia', 'Level grid final');
    setNode('supervisor', gate.tone, gate.status, signal.value, signal.reason);
    setNode('buy', entryView.tone, entryView.status, `${money(entryValue, 2)} ${quote()}`, entryView.meta);
    setNode('position', position ? (num(data.profit?.unrealizedPnl) >= 0 ? 'positive' : 'negative') : 'accent', position ? `${state.positionSide} AKTIF` : 'TIDAK ADA POSISI', position ? compact(position.contracts) : '0', `PnL berjalan ${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`);
    setNode('sell', coverage !== null && coverage !== undefined && coverage < 99.999 ? 'negative' : 'positive', `${exitCount} ORDER`, coverage == null ? 'Coverage N/A' : `Coverage ${percent(coverage, 0)}`, execution.uncovered > 0 ? `${compact(execution.uncovered)} kontrak belum tertutup` : 'Tidak ada posisi tanpa exit');
    setFlowNodeState('market', marketAvailable ? 'active' : 'waiting');
    setFlowNodeState('fibonacci', fibonacciAvailable ? 'active' : 'waiting');
    setFlowNodeState('supervisor', gate.allowed ? 'active' : gate.available && gate.blocked ? 'error' : 'waiting');
    setFlowNodeState('buy', entryCount > 0 ? 'active' : 'waiting');
    setFlowNodeState('position', positionAvailable ? 'active' : 'waiting');
    setFlowNodeState('sell', exitNeedsAttention ? 'error' : exitAvailable ? 'active' : 'waiting');
    setFlowEdge('market', 'fibonacci', fibonacciAvailable ? 'active' : 'waiting');
    setFlowEdge('fibonacci', 'supervisor', gate.available ? 'active' : 'waiting');
    setFlowEdge('supervisor', 'buy', entryCount > 0 ? 'active' : 'waiting');
    setFlowEdge('buy', 'position', positionAvailable ? 'active' : 'waiting');
    setFlowEdge('position', 'sell', exitNeedsAttention ? 'error' : exitAvailable ? 'active' : 'waiting');
    queueFlowLayout();
  }

  function inspectorModel() {
    const data = state.data;
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const momentum = intel().priceMomentum || {};
    const momentumView = priceMomentumView(momentum);
    const gate = entryGateView(momentum);
    const position = data.futures?.position;
    const entrySide = isShort() ? 'SELL' : 'BUY';
    const exitSide = isShort() ? 'BUY' : 'SELL';
    const entryCount = num(execution.entryCount ?? data.orders?.[`${entrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${exitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${entrySide.toLowerCase()}Value`]);
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const entryView = entryOrderView(gate, entryCount, entrySide);
    const rangeReady = num(data.range?.lower) > 0 && num(data.range?.upper) > 0;
    return ({
      market: {
        title: 'Harga Binance', status: String(data.mode || 'LIVE').toUpperCase(), summary: 'Harga live yang dipakai bot.',
        tags: data.market?.timeframe ? [data.market.timeframe] : [],
        details: [['Harga', `${data.market?.priceText || price(data.market?.price)} ${quote()}`], ['24 jam', `${signed(data.market?.changePercent, 2)}%`], ['High', `${data.market?.highText || price(data.market?.high)} ${quote()}`], ['Low', `${data.market?.lowText || price(data.market?.low)} ${quote()}`]],
      },
      fibonacci: {
        title: 'Level Fibonacci', status: rangeReady ? 'SIAP' : 'MENUNGGU', summary: rangeReady ? 'Range final untuk order grid.' : 'Range belum tersedia.', tags: [],
        details: [['Batas bawah', rangeReady ? `${price(data.range.lower)} ${quote()}` : 'N/A'], ['Batas atas', rangeReady ? `${price(data.range.upper)} ${quote()}` : 'N/A']],
      },
      supervisor: {
        title: `Entry ${state.positionSide}`, status: gate.status, summary: gate.summary,
        tags: momentum.available ? [momentumView.value] : [],
        details: [['Momentum 12J', momentumView.value], ['Arah', momentum.direction || 'N/A'], ['Candle', momentum.enabled ? time(momentum.candleTimestamp) : 'N/A'], ['Keputusan', gate.status]],
      },
      buy: {
        title: `Grid ${entrySide}`, status: entryView.status, summary: entryView.summary, tags: [gate.status],
        details: [['Order aktif', entryCount], ['Nilai pending', `${money(entryValue, 4)} ${quote()}`], ['Jumlah level', num(execution.gridCount) || 'N/A'], ['Exposure pair', `${money(adaptive.allocatedInvestment, 4)} ${quote()}`], ['Cap pair', adaptive.symbolExposureCap > 0 ? `${money(adaptive.symbolExposureCap, 2)} ${quote()}` : 'N/A'], ['Sisi entry', entrySide]],
      },
      position: {
        title: `Posisi ${state.positionSide}`, status: position ? 'AKTIF' : 'KOSONG', summary: position ? `Posisi ${state.positionSide} sedang terbuka.` : `Tidak ada posisi ${state.positionSide}.`,
        tags: position ? [`${data.futures?.leverage || 0}x`] : [],
        details: [['Kontrak', position ? compact(position.contracts) : '0'], ['Entry', position ? price(position.entryPrice) : 'N/A'], ['Mark', position ? price(position.markPrice) : 'N/A'], ['Likuidasi', position?.liquidationPrice > 0 ? price(position.liquidationPrice) : 'N/A'], ['PnL berjalan', `${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`]],
      },
      sell: {
        title: `Exit ${exitSide}`, status: !position ? 'TIDAK PERLU' : execution.uncovered > 0 ? 'PERLU CEK' : 'TERLINDUNGI',
        summary: !position ? 'Tidak ada posisi yang perlu ditutup.' : execution.uncovered > 0 ? 'Sebagian posisi belum memiliki exit.' : 'Posisi sudah memiliki order exit.',
        tags: data.futures?.exits?.nearestLabel ? [data.futures.exits.nearestLabel] : [],
        details: [['Order exit', exitCount], ['Kontrak', compact(execution.positionContracts)], ['Belum tertutup', compact(execution.uncovered)], ['Coverage', coverage == null ? 'N/A' : percent(coverage, 0)], ['Target terdekat', data.futures?.exits?.nearestPrice ? `${price(data.futures.exits.nearestPrice)} ${quote()}` : 'N/A']],
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
    text('ledger-title', `${state.data.selectedSymbol || 'Pair'} · ${state.positionSide}`);
    text('grid-profit-label', `Profit grid ${state.positionSide}`);
    for (const [id, value] of [['realized-pnl', profit.realized], ['funding-pnl', profit.accounting?.ready ? profit.funding : null], ['unrealized-pnl', profit.unrealizedPnl], ['grid-profit', profit.gridPairProfit], ['ledger-net', profit.net]]) { text(id, `${signed(value, 4)} ${quote()}`); pnlTone(byId(id), value); }
    text('fees-value', `${money(profit.fees, 4)} ${quote()}`);
  }
  function renderRisk() {
    const data = state.data; const adaptive = intel().adaptive || {}; const position = data.futures?.position;
    const exposure = num(adaptive.exposurePct); const threshold = num(adaptive.exposureWarningPct ?? adaptive.riskExposurePct) || 90;
    text('risk-title', `Exposure ${data.selectedSymbol || 'pair'}`);
    text('risk-exposure', percent(adaptive.exposurePct));
    text('risk-caption', adaptive.investmentCap > 0 ? `${money(adaptive.allocatedInvestment, 4)} dari cap pair ${money(adaptive.investmentCap, 2)} ${quote()}` : 'Batas exposure belum tersedia.');
    byId('exposure-fill').style.width = `${clamp(exposure, 0, 100)}%`; byId('exposure-fill').style.background = exposure >= threshold ? 'var(--warning)' : 'var(--accent)';
    byId('exposure-limit').style.left = `${clamp(threshold, 0, 100)}%`; byId('exposure-meter').setAttribute('aria-valuenow', String(clamp(exposure, 0, 100)));
    const mark = num(position?.markPrice); const liquidation = num(position?.liquidationPrice); const distance = mark > 0 && liquidation > 0 ? Math.abs(mark - liquidation) / mark * 100 : null;
    renderDefinitionList(byId('risk-facts'), [['Exposure', `${money(adaptive.allocatedInvestment, 2)} ${quote()}`], ['Cap pair', adaptive.investmentCap > 0 ? `${money(adaptive.investmentCap, 2)} ${quote()}` : 'N/A'], ['Saldo tersedia', `${money(data.futures?.availableBalance, 2)} ${quote()}`], ['Jarak likuidasi', distance == null ? 'N/A' : percent(distance, 2)]]);
  }

  function renderOrders() {
    const orders = state.data.orders?.active || [];
    text('buy-count', `BUY ${num(state.data.orders?.buyCount)}`); text('sell-count', `SELL ${num(state.data.orders?.sellCount)}`);
    text('orders-copy', `Order grid ${state.positionSide} yang aktif.`);
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
  function render() { renderPositionTabs(); renderComparison(); renderAllocation(); renderOverview(); renderFlow(); renderInspector(); renderLedger(); renderRisk(); renderOrders(); renderChartMeta(); renderRuntime(); }
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
