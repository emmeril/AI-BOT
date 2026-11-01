const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicFile = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('dashboard pipeline shows the active volume-delta scalper flow', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.equal((html.match(/data-edge=/g) || []).length, 10);
  assert.doesNotMatch(html, /data-node="gemini"/);
  assert.doesNotMatch(html, /data-node="trust"/);
  assert.doesNotMatch(html, /class="panel learning-panel"/);
  assert.match(script, /const FLOW_EDGES = \[/);
  assert.match(script, /ResizeObserver\(queueFlowLayout\)/);
  assert.match(script, /\['market', 'fibonacci'\], \['fibonacci', 'supervisor'\]/);
  assert.doesNotMatch(script, /flowBounce|flow-node-bounce/);
  assert.doesNotMatch(css, /flow-travel/);
  assert.doesNotMatch(script, /translateY\(-5px\) scale\(1\.01\)/);
  assert.doesNotMatch(css, /@media\(max-width:1180px\)[^}]*\.flow-lines\{display:none\}/);
  assert.doesNotMatch(css, /data-state=safety/);
  assert.match(css, /\.flow-signal path\[data-state=error\]\{stroke:var\(--negative\)/);
  assert.match(css, /\.flow-signal path\[data-state=active\]\{stroke:var\(--accent\);opacity:\.9\}/);
  assert.match(script, /setFlowEdge\('fibonacci', 'supervisor', signal\.available/);
  assert.match(script, /setFlowEdge\('supervisor', 'buy', positionAvailable/);
  assert.match(script, /setFlowEdge\('position', 'sell', protectionError/);
  assert.match(css, /\.flow-grid\{[^}]*grid-template-columns:repeat\(6/);
  assert.match(html, /Volume delta/);
  assert.match(html, /Take profit dan stop loss/);
  assert.match(script, /function signalView\(scalper = \{\}\)/);
  assert.match(script, /protection\.status === 'PROTECTED'/);
});

test('dashboard explains the safe migration from legacy exits to dual scalper', () => {
  const html = publicFile('dashboard.html');
  const script = publicFile('dashboard.js');
  assert.match(html, /Strategi production/);
  assert.match(script, /Posisi lama sedang diselesaikan/);
  assert.match(script, /Grid lama tidak menerima entry baru/);
  assert.match(script, /Scalper volume delta aktif/);
});

test('futures dashboard switches between LONG and SHORT operating surfaces', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /<header class="topbar">[\s\S]*<div class="brand">[\s\S]*<div class="top-actions">/);
  assert.match(html, /class="position-switch" role="group" aria-label="Pilih cara trading yang ingin dilihat"/);
  assert.match(html, /data-position-side="LONG" aria-pressed="true"/);
  assert.match(html, /data-position-side="SHORT" aria-pressed="false"/);
  assert.match(css, /\.position-switch-button\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.position-switch-button\[aria-pressed=true\]/);
  assert.match(css, /\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(230px, 1fr\) auto/);
  assert.match(html, /id="plain-title"/);
  assert.match(html, /id="health-exit"/);
  assert.match(html, /id="portfolio-track"/);
  assert.match(html, /id="plan-long-pct">35%/);
  assert.match(html, /id="plan-short-pct">35%/);
  assert.doesNotMatch(html, /Rescue LONG|Rescue SHORT/);
  assert.match(html, /id="plan-buffer-pct">30%/);
  assert.match(html, /<details class="technical-details" id="technical-details">/);
  assert.match(html, /id="allocation-pair-list"/);
  assert.match(html, /id="allocation-pair-count"/);
  assert.match(html, /id="allocation-active-pct"/);
  assert.match(html, /id="allocation-ramp-limit"/);
  assert.doesNotMatch(html, /class="comparison-board"/);
  assert.match(html, /<strong>Lihat rincian<\/strong>/);
  assert.match(html, /<details class="technical-details"[\s\S]*<section class="panel allocation-panel"/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.command-strip \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(script, /const POSITION_SIDE = 'LONG'/);
  assert.match(script, /const positionSide = \(\) => normalizePositionSide/);
  assert.match(script, /new URLSearchParams\(\{ positionSide: requestedSide \}\)/);
  assert.match(script, /document\.querySelectorAll\('\[data-position-side\]'\)/);
  assert.match(script, /localStorage\.setItem\(POSITION_SIDE_STORAGE_KEY/);
  assert.doesNotMatch(script, /function renderComparison\(\)/);
  assert.match(script, /function renderPlainOverview\(\)/);
  assert.match(script, /function setAllocationSegment\(id, value\)/);
  assert.match(script, /function renderAllocation\(\)/);
  assert.match(script, /function allocationPairCard\(symbol, budget, side\)/);
  assert.match(script, /const symbol = state\.data\.selectedSymbol/);
  assert.match(script, /const SYMBOL_STORAGE_KEY = 'grid-flow-futures-symbol'/);
  assert.match(script, /function savedSelectedSymbol\(side = state\.positionSide\)/);
  assert.match(script, /persistSelectedSymbol\(event\.target\.value, state\.positionSide\)/);
  assert.match(script, /persistSelectedSymbol\(data\.selectedSymbol, state\.positionSide\)/);
  assert.match(script, /load\(\{ positionSide: state\.positionSide, symbol: savedSelectedSymbol\(state\.positionSide\) \}\)/);
  assert.match(script, /const perPairPct = sidePct \/ pairCount/);
  assert.match(script, /Jatah margin \$\{side\}/);
  assert.match(script, /Batas posisi pair/);
  assert.match(css, /\.allocation-pair-list\s*\{\s*margin-top:\s*14px/);
  assert.match(html, /id="entry-signal-status"/);
  assert.match(script, /function signalView\(scalper = \{\}\)/);
  assert.doesNotMatch(script, /function priceMomentumView|function reversalInventoryView|Kelola reversal|Jatah rescue/);
  assert.match(script, /status = 'SINYAL ENTRY'/);
  assert.match(script, /status = 'MENUNGGU SINYAL'/);
  assert.match(html, /Funding Binance/);
  assert.match(html, /Jatah per pair/i);
  assert.match(script, /Saldo tersedia/);
  assert.match(script, /protection\.status === 'PROTECTED' \? 'LENGKAP' : 'PERLU CEK'/);
  assert.match(script, /status = 'ENTRY DIJEDA'/);
  assert.match(script, /setFlowNodeState\('buy', positionAvailable/);
  assert.match(script, /positionSide\(\) === 'SHORT' \? 'SELL' : 'BUY'/);
  assert.match(script, /LONG dan SHORT berjalan independen/);
});

test('dashboard motion preference can override or follow reduced motion', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /<html lang="id" data-motion="system">/);
  assert.match(html, /id="motion-select"/);
  assert.match(html, /value="on">Aktif/);
  assert.match(html, /value="system" selected>Ikuti perangkat/);
  assert.match(html, /value="off">Mati/);
  assert.match(css, /\.motion-control option\{color:var\(--text\);background:var\(--surface\)\}/);
  assert.match(css, /html:not\(\[data-motion=on\]\) \.flow-signal\{display:none\}/);
  assert.match(css, /html\[data-motion=on\] \.refresh-icon\.fa-spin\s*\{\s*animation:\s*refresh-turn/);
  assert.match(script, /localStorage\.setItem\(MOTION_STORAGE_KEY, preference\)/);
  assert.match(script, /\? value : 'system'/);
});

test('dashboard refresh has Font Awesome and a visible loading state', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /fa-solid fa-rotate-right refresh-icon/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.match(css, /\.refresh-icon\.fa-spin\s*\{\s*animation:\s*refresh-turn/);
  assert.match(css, /#refresh-button\.is-refreshing/);
  assert.match(script, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(script, /button\.setAttribute\('aria-busy', 'false'\)/);
});

test('dashboard pages declare an empty favicon instead of requesting a missing asset', () => {
  assert.match(publicFile('dashboard.html'), /<link rel="icon" href="data:,">/);
  assert.match(publicFile('dashboard-login.html'), /<link rel="icon" href="data:,">/);
});

test('dashboard omits inactive Gemini and learning surfaces from the operator view', () => {
  const html = publicFile('dashboard.html');
  const login = publicFile('dashboard-login.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.doesNotMatch(html, /Gemini|Adaptive learning|learning-panel/);
  assert.doesNotMatch(login, /Gemini/);
  assert.match(login, /sinyal volume delta/);
  assert.match(login, /Sinyal LONG \/ SHORT/);
  assert.doesNotMatch(html, /Adaptive supervisor|Profil BUY|profil adaptive/i);
  assert.doesNotMatch(login, /Adaptive Supervisor|Adaptive decision/i);
  assert.doesNotMatch(script, /renderLearning|trustPolicyView|setNode\('gemini'|setNode\('trust'/);
  assert.doesNotMatch(css, /\.node-gemini|\.node-trust|\.learning-panel|\.learning-body/);
});
