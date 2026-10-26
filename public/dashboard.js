(() => {
  'use strict';

  const state = { data: null, positionSide: 'LONG', activeNode: 'supervisor', timer: null, controller: null, requestId: 0, loading: true, refreshSpinTimer: null, flowLayoutFrame: null, motionPreference: 'on' };
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
      return ['on', 'system', 'off'].includes(value) ? value : 'on';
    } catch { return 'on'; }
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
    const preference = ['on', 'system', 'off'].includes(value) ? value : 'on';
    state.motionPreference = preference; document.documentElement.dataset.motion = preference;
    byId('motion-select').value = preference;
    const description = preference === 'on' ? 'Animasi dashboard aktif.' : preference === 'off' ? 'Animasi dashboard dimatikan.' : `Animasi mengikuti sistem dan saat ini ${reducedMotion.matches ? 'mati' : 'aktif'}.`;
    text('motion-state', description); byId('motion-control').title = description;
    if (persist) { try { localStorage.setItem(MOTION_STORAGE_KEY, preference); } catch {} }
  }
  function priceMomentumView(momentum) {
    const side = normalizePositionSide(momentum.positionSide || positionSide());
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

  function reversalInventoryView(reversal) {
    if (!reversal.enabled) {
      return {
        label: 'REVERSAL MATI',
        management: 'Tidak aktif',
        rescue: 'Tidak aktif',
        summary: 'Pengelolaan reversal tidak aktif.',
      };
    }
    const labels = {
      MONITORING: 'MONITORING',
      RESCUE: 'RESCUE',
      PROFIT_BANK: 'PROFIT BANK',
      GRANDFATHERED: 'POSISI LAMA',
    };
    const management = reversal.grandfathered
      ? 'Menunggu transisi arah'
      : reversal.applyToExisting
        ? 'Dikelola langsung'
        : 'Dikelola setelah transisi';
    let rescue = 'Siap saat syarat terpenuhi';
    let summary = 'Posisi dipantau untuk reversal.';
    if (reversal.rescueStatus === 'FILLED') {
      rescue = 'Sudah terisi';
      summary = 'Rescue sudah terisi dan posisi tetap dipantau.';
    } else if (reversal.rescueStatus === 'PENDING') {
      rescue = reversal.rescueOrder?.price > 0
        ? `Menunggu di ${price(reversal.rescueOrder.price)} ${quote()}`
        : 'Menunggu terisi';
      summary = 'Order rescue sedang aktif.';
    } else if (reversal.rescueStatus === 'WAITING_BUDGET') {
      rescue = 'Menunggu kuota pair';
      summary = 'Kuota rescue pair dihitung otomatis dari balance.';
    } else if (reversal.rescueStatus === 'WAITING_BALANCE') {
      rescue = 'Menunggu saldo tersedia';
      summary = 'Saldo bebas belum cukup untuk memasang order rescue.';
    } else if (reversal.rescueStatus === 'WAITING_MINIMUM') {
      rescue = 'Menunggu ukuran minimum';
      summary = 'Kuota rescue belum cukup untuk memenuhi minimum order Binance.';
    } else if (reversal.rescueStatus === 'USED') {
      rescue = 'Menunggu sinkronisasi';
      summary = 'Order rescue lama tidak aktif dan jatahnya sedang dipulihkan.';
    } else if (reversal.grandfathered) {
      summary = 'Posisi lama menunggu transisi arah sebelum rescue aktif.';
    }
    return {
      label: labels[reversal.mode] || String(reversal.mode || 'MONITORING').replaceAll('_', ' '),
      management,
      rescue,
      summary,
    };
  }

  function entryGateView(momentum) {
    const selectedEntrySide = entrySide();
    if (momentum.enabled === undefined) {
      return {
        allowed: false, available: false, blocked: false, entrySide: selectedEntrySide,
        status: 'MENUNGGU', summary: 'Menunggu data Momentum.', tone: 'warning',
      };
    }
    const available = Boolean(state.data?.running && momentum.enabled);
    const blocked = momentum.allow === false;
    const tradingEnabled = Boolean(state.data?.tradingEnabled);
    const allowed = Boolean(available && tradingEnabled && !blocked);
    let status = 'MENUNGGU';
    let tone = 'accent';
    let summary = `Entry ${selectedEntrySide} menunggu Momentum.`;
    if (available && !blocked && !tradingEnabled) {
      status = 'ORDER DIJEDA';
      tone = 'warning';
      summary = `Momentum mendukung ${selectedEntrySide}, tetapi order baru sedang dijeda.`;
    } else if (available && blocked) {
      status = 'ENTRY DITAHAN';
      tone = 'negative';
      summary = `Momentum belum mendukung entry ${selectedEntrySide}.`;
    } else if (allowed) {
      status = 'ENTRY BOLEH';
      tone = 'positive';
      summary = `Momentum mendukung entry ${selectedEntrySide}.`;
    }
    return { allowed, available, blocked, entrySide: selectedEntrySide, status, summary, tone };
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

  function renderComparison() {
    const comparison = state.data.comparison || {};
    for (const side of ['LONG', 'SHORT']) {
      const metrics = comparison[side] || {};
      const key = side.toLowerCase();
      text(`${key}-exposure`, metrics.available ? `${money(metrics.exposure, 2)} ${quote()}` : 'Tidak dikelola');
      text(`${key}-pnl`, metrics.available ? `${signed(metrics.strategyPnl, 4)} ${quote()}` : 'N/A');
      text(`${key}-runtime`, !metrics.available ? 'Pair tidak aktif' : metrics.running ? 'Bot online' : 'Bot offline');
      pnlTone(byId(`${key}-pnl`), metrics.available ? metrics.strategyPnl : null);
    }
    document.querySelectorAll('[data-summary-side]').forEach(element => {
      element.dataset.selected = String(element.dataset.summarySide === positionSide());
    });
  }

  function allocationStatusView(budget) {
    if (!budget?.available) return { label: 'Data belum tersedia', tone: '' };
    if (budget.status === 'EXIT_ONLY' || budget.entryGridEnabled === false) {
      return { label: 'Exit-only', tone: 'warning' };
    }
    if (budget.status === 'DEFERRED') {
      return { label: 'Menunggu sisi kosong', tone: 'warning' };
    }
    if (budget.autoRampEnabled) {
      if (budget.autoRampAction === 'PROMOTED') return { label: 'Naik otomatis', tone: 'positive' };
      if (budget.autoRampAction === 'REDUCED') return { label: 'Cap dikurangi', tone: 'warning' };
      if (budget.autoRampAction === 'CONFIRMING') {
        return {
          label: `Konfirmasi ${num(budget.autoRampPromotionConfirmations)}/${num(budget.autoRampRequiredConfirmations)}`,
          tone: 'warning',
        };
      }
      if (num(budget.autoRampSafeMaximumPct) <= num(budget.sidePct)) {
        return { label: 'Ditahan batas aman', tone: 'warning' };
      }
      return { label: 'Auto-ramp aktif', tone: 'positive' };
    }
    if (budget.status === 'UNCHANGED' || budget.status === 'APPLIED') return { label: 'Aktif', tone: 'positive' };
    return { label: 'Menunggu', tone: '' };
  }

  function allocationPairCard(symbol, budget, side) {
    const article = document.createElement('article');
    article.className = 'allocation-pair';
    article.setAttribute('aria-label', `Alokasi ${side} ${symbol}`);

    const head = document.createElement('div'); head.className = 'allocation-pair-head';
    const identity = document.createElement('div');
    const indexLabel = document.createElement('span'); indexLabel.textContent = 'PAIR TERPILIH';
    const title = document.createElement('strong'); title.textContent = symbol;
    identity.append(indexLabel, title);
    const status = document.createElement('span'); status.className = `allocation-state ${budget.status.tone}`.trim(); status.textContent = budget.status.label;
    head.append(identity, status);

    const values = document.createElement('dl'); values.className = 'allocation-pair-budget';
    for (const [label, share, cap] of [
      [`Grid ${side}`, budget.gridPct, budget.gridCap],
      ['Rescue', budget.rescuePct, budget.rescueCap],
    ]) {
      const row = document.createElement('div');
      const term = document.createElement('dt'); term.textContent = label;
      const description = document.createElement('dd');
      const percentValue = document.createElement('strong'); percentValue.textContent = percent(share, 2);
      const capValue = document.createElement('small'); capValue.textContent = cap > 0 ? `Cap ${money(cap, 2)} ${quote()}` : 'Tidak dicadangkan';
      description.append(percentValue, capValue); row.append(term, description); values.append(row);
    }
    article.append(head, values);
    return article;
  }

  function renderAllocation() {
    const allocation = state.data.exposureAllocation || {};
    const side = positionSide();
    const sidePct = clamp(num(allocation[side]?.sidePct ?? allocation.sidePct), 0, 100);
    const bufferPct = clamp(num(allocation.bufferPct), 0, 100);
    const budget = allocation[side] || {};
    const rescue = allocation.rescue?.[side] || {};
    const pairCount = Math.max(0, Math.trunc(num(budget.pairCount)));
    const gridPerPairPct = pairCount > 0 ? sidePct / pairCount : 0;
    const rescuePerPairPct = pairCount > 0 ? rescue.marginPct / pairCount : 0;
    const targetPct = clamp(num(budget.configuredSidePct || budget.sidePct), 0, 100);
    const safePct = budget.autoRampEnabled
      ? clamp(num(budget.autoRampSafeMaximumPct), 0, 100)
      : targetPct;
    text('allocation-title', `Modal ${side} pair terpilih`);
    text('allocation-mode', !allocation.enabled ? 'NONAKTIF' : budget.autoRampEnabled ? 'AUTO-RAMP' : `${side} AKTIF`);
    text('allocation-buffer-pct', percent(bufferPct, 0));
    text('allocation-active-pct', percent(sidePct, 0));
    text('allocation-ramp-limit', budget.autoRampEnabled
      ? `${percent(targetPct, 0)} / ${percent(safePct, 0)}`
      : percent(targetPct, 0));
    const rampCopy = budget.autoRampEnabled
      ? ` Auto-ramp aktif ${percent(sidePct, 0)} dari target ${percent(targetPct, 0)}; batas aman saat ini ${percent(safePct, 0)} dan konfirmasi ${num(budget.autoRampPromotionConfirmations)}/${num(budget.autoRampRequiredConfirmations)}.`
      : '';
    text('allocation-copy', pairCount > 0
      ? `Pair terpilih mendapat ${percent(gridPerPairPct, 2)} margin grid + ${percent(rescuePerPairPct, 2)} margin rescue dari ${pairCount} pair. Cap USDT sudah termasuk leverage.${rampCopy}`
      : 'Menunggu pair dan pembagian modal.');
    text('allocation-wallet', `${money(allocation.walletBalance, 2)} ${quote()}`);
    text('allocation-leverage', `${money(allocation.leverage, 0)}x`);
    text('allocation-pair-count', pairCount > 0 ? `${pairCount} pair` : 'N/A');
    const view = allocationStatusView(budget);
    const list = byId('allocation-pair-list');
    list.replaceChildren();
    const symbol = state.data.selectedSymbol;
    if (!symbol) {
      const empty = document.createElement('div'); empty.className = 'allocation-empty'; empty.textContent = `Belum ada pair ${side} yang dipilih.`; list.append(empty); return;
    }
    list.append(allocationPairCard(symbol, {
      status: view,
      gridPct: gridPerPairPct,
      gridCap: budget.entryGridEnabled === false ? 0 : num(budget.symbolCap),
      rescuePct: rescue.active ? rescuePerPairPct : 0,
      rescueCap: rescue.active ? num(rescue.symbolCap) : 0,
    }, side));
  }

  function renderOverview() {
    const data = state.data;
    const side = positionSide();
    const adaptive = intel().adaptive || {};
    const momentum = intel().priceMomentum || {};
    const signal = priceMomentumView(momentum);
    const gate = entryGateView(momentum);
    text('source-label', data.source || 'Binance');
    text('overview-title', `${data.selectedSymbol || 'Pair belum dipilih'} · ${side}`);
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
    text('pnl-label', `PnL ${data.selectedSymbol || 'pair'} ${side}`);
    text('net-pnl', `${signed(data.profit?.net, 4)} ${quote()}`);
    pnlTone(byId('net-pnl'), data.profit?.net);
  }

  function renderFlow() {
    const data = state.data;
    const side = positionSide();
    byId('flow-map').dataset.running = String(Boolean(data.running));
    const execution = intel().execution || {};
    const momentum = intel().priceMomentum || {};
    const reversal = reversalInventoryView(intel().reversalInventory || {});
    const signal = priceMomentumView(momentum);
    const range = data.range || {};
    const position = data.futures?.position;
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const selectedEntrySide = entrySide();
    const selectedExitSide = exitSide();
    const entryCount = num(execution.entryCount ?? data.orders?.[`${selectedEntrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${selectedExitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${selectedEntrySide.toLowerCase()}Value`]);
    const marketAvailable = Boolean(data.running && num(data.market?.price) > 0);
    const fibonacciAvailable = Boolean(marketAvailable && num(range.lower) > 0 && num(range.upper) > 0);
    const gate = entryGateView(momentum);
    const positionAvailable = Boolean(data.running && position && num(position.contracts) > 0);
    const exitNeedsAttention = Boolean(positionAvailable && num(execution.uncovered) > 0);
    const exitAvailable = Boolean(positionAvailable && !exitNeedsAttention && coverage !== null && coverage !== undefined && num(coverage) >= 99.999);
    const entryView = entryOrderView(gate, entryCount, selectedEntrySide);
    text('flow-title', `Harga ke exit ${selectedExitSide}`);
    text('supervisor-node-title', `Entry ${side}`);
    text('entry-node-title', `Grid ${selectedEntrySide}`);
    text('position-node-title', side);
    text('exit-node-title', `Exit ${selectedExitSide}`);
    setNode('market', 'accent', String(data.mode || 'LIVE').toUpperCase(), `${data.market?.priceText || price(data.market?.price)} ${quote()}`, `${signed(data.market?.changePercent, 2)}% dalam 24 jam`);
    setNode('fibonacci', fibonacciAvailable ? 'positive' : 'accent', fibonacciAvailable ? 'SIAP' : 'MENUNGGU', fibonacciAvailable ? `${price(range.lower)}–${price(range.upper)}` : 'Range belum tersedia', 'Level grid final');
    setNode('supervisor', gate.tone, gate.status, signal.value, signal.reason);
    setNode('buy', entryView.tone, entryView.status, `${money(entryValue, 2)} ${quote()}`, entryView.meta);
    setNode('position', position ? (num(data.profit?.unrealizedPnl) >= 0 ? 'positive' : 'negative') : 'accent', position ? `${side} AKTIF` : 'TIDAK ADA POSISI', position ? compact(position.contracts) : '0', position ? `${reversal.label} · PnL ${signed(data.profit?.unrealizedPnl, 4)} ${quote()}` : 'Reversal menunggu posisi');
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
    const side = positionSide();
    const adaptive = intel().adaptive || {};
    const execution = intel().execution || {};
    const momentum = intel().priceMomentum || {};
    const reversal = reversalInventoryView(intel().reversalInventory || {});
    const momentumView = priceMomentumView(momentum);
    const gate = entryGateView(momentum);
    const position = data.futures?.position;
    const selectedEntrySide = entrySide();
    const selectedExitSide = exitSide();
    const entryCount = num(execution.entryCount ?? data.orders?.[`${selectedEntrySide.toLowerCase()}Count`]);
    const exitCount = num(execution.exitCount ?? data.orders?.[`${selectedExitSide.toLowerCase()}Count`]);
    const entryValue = num(data.orders?.[`${selectedEntrySide.toLowerCase()}Value`]);
    const coverage = execution.exitCoveragePct ?? execution.sellCoveragePct;
    const entryView = entryOrderView(gate, entryCount, selectedEntrySide);
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
        title: `Entry ${side}`, status: gate.status, summary: gate.summary,
        tags: momentum.available ? [momentumView.value] : [],
        details: [['Momentum 12J', momentumView.value], ['Arah', momentum.direction || 'N/A'], ['Candle', momentum.enabled ? time(momentum.candleTimestamp) : 'N/A'], ['Keputusan', gate.status]],
      },
      buy: {
        title: `Grid ${selectedEntrySide}`, status: entryView.status, summary: entryView.summary, tags: [gate.status],
        details: [['Order aktif', entryCount], ['Nilai pending', `${money(entryValue, 4)} ${quote()}`], ['Jumlah level', num(execution.gridCount) || 'N/A'], ['Exposure pair', `${money(adaptive.allocatedInvestment, 4)} ${quote()}`], ['Cap pair', adaptive.symbolExposureCap > 0 ? `${money(adaptive.symbolExposureCap, 2)} ${quote()}` : 'N/A'], ['Sisi entry', selectedEntrySide]],
      },
      position: {
        title: `Posisi ${side}`, status: position ? 'AKTIF' : 'KOSONG', summary: position ? reversal.summary : `Tidak ada posisi ${side}.`,
        tags: position ? [`${data.futures?.leverage || 0}x`, reversal.label] : [],
        details: [['Kontrak', position ? compact(position.contracts) : '0'], ['Entry', position ? price(position.entryPrice) : 'N/A'], ['Mark', position ? price(position.markPrice) : 'N/A'], ['Likuidasi', position?.liquidationPrice > 0 ? price(position.liquidationPrice) : 'N/A'], ['PnL berjalan', `${signed(data.profit?.unrealizedPnl, 4)} ${quote()}`], ['Kelola reversal', reversal.management], ['Rescue', reversal.rescue]],
      },
      sell: {
        title: `Exit ${selectedExitSide}`, status: !position ? 'TIDAK PERLU' : execution.uncovered > 0 ? 'PERLU CEK' : 'TERLINDUNGI',
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
    const side = positionSide();
    text('ledger-title', `${state.data.selectedSymbol || 'Pair'} · ${side}`);
    text('grid-profit-label', `Profit grid ${side}`);
    for (const [id, value] of [['realized-pnl', profit.realized], ['funding-pnl', profit.accounting?.ready ? profit.funding : null], ['unrealized-pnl', profit.unrealizedPnl], ['grid-profit', profit.gridPairProfit], ['ledger-net', profit.net]]) { text(id, `${signed(value, 4)} ${quote()}`); pnlTone(byId(id), value); }
    text('fees-value', `${money(profit.fees, 4)} ${quote()}`);
  }
  function renderRisk() {
    const data = state.data; const adaptive = intel().adaptive || {}; const position = data.futures?.position;
    const exposure = num(adaptive.exposurePct); const threshold = num(adaptive.exposureWarningPct ?? adaptive.riskExposurePct) || 90;
    text('risk-title', `Exposure ${data.selectedSymbol || 'pair'}`);
    const exitOnly = adaptive.entryGridEnabled === false;
    text('risk-exposure', exitOnly ? 'EXIT-ONLY' : percent(adaptive.exposurePct));
    text('risk-caption', exitOnly
      ? `Exposure posisi lama ${money(adaptive.allocatedInvestment, 4)} ${quote()}; cap entry 0 ${quote()}.`
      : adaptive.investmentCap > 0
        ? `${money(adaptive.allocatedInvestment, 4)} dari cap pair ${money(adaptive.investmentCap, 2)} ${quote()}`
        : 'Batas exposure belum tersedia.');
    byId('exposure-fill').style.width = `${clamp(exposure, 0, 100)}%`; byId('exposure-fill').style.background = exposure >= threshold ? 'var(--warning)' : 'var(--accent)';
    byId('exposure-limit').style.left = `${clamp(threshold, 0, 100)}%`; byId('exposure-meter').setAttribute('aria-valuenow', String(clamp(exposure, 0, 100)));
    const mark = num(position?.markPrice); const liquidation = num(position?.liquidationPrice); const distance = mark > 0 && liquidation > 0 ? Math.abs(mark - liquidation) / mark * 100 : null;
    renderDefinitionList(byId('risk-facts'), [['Exposure', `${money(adaptive.allocatedInvestment, 2)} ${quote()}`], ['Cap entry pair', exitOnly ? `0 ${quote()}` : adaptive.investmentCap > 0 ? `${money(adaptive.investmentCap, 2)} ${quote()}` : 'N/A'], ['Saldo tersedia', `${money(data.futures?.availableBalance, 2)} ${quote()}`], ['Jarak likuidasi', distance == null ? 'N/A' : percent(distance, 2)]]);
  }

  function renderOrders() {
    const orders = state.data.orders?.active || [];
    text('buy-count', `BUY ${num(state.data.orders?.buyCount)}`); text('sell-count', `SELL ${num(state.data.orders?.sellCount)}`);
    text('orders-copy', `Order grid ${positionSide()} yang aktif.`);
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
    const data = state.data; const side = positionSide(); text('status-text', state.loading ? 'Memperbarui' : !data.running ? `${side} · Bot offline` : data.tradingEnabled ? `${side} · Trading aktif` : `${side} · Order dijeda`); byId('status-mark').dataset.state = state.loading ? '' : data.tradingEnabled ? 'active' : data.running ? 'paused' : 'error';
    text('updated-at', `Diperbarui ${time(data.generatedAt)}`); text('runtime-label', `${String(data.mode || '').toUpperCase()} · ${data.source || 'Binance'} · refresh ${num(data.refreshSeconds) || 5} detik`); byId('logout-form').hidden = !data.dashboardAuthEnabled;
  }
  function renderPositionSwitch() {
    document.querySelectorAll('[data-position-side]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.positionSide === state.positionSide));
    });
  }
  function render() { renderPositionSwitch(); renderComparison(); renderAllocation(); renderOverview(); renderFlow(); renderInspector(); renderLedger(); renderRisk(); renderOrders(); renderChartMeta(); renderRuntime(); }
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
