const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicFile = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('dashboard pipeline shows only the active deterministic execution flow', () => {
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
  assert.match(script, /setFlowEdge\('fibonacci', 'supervisor', gate\.available/);
  assert.match(script, /setFlowEdge\('supervisor', 'buy', entryCount > 0/);
  assert.match(script, /setFlowEdge\('position', 'sell', exitNeedsAttention/);
  assert.match(css, /\.flow-grid\{[^}]*grid-template-columns:repeat\(6/);
  assert.match(css, /\.node-fibonacci \.node-value\{[^}]*white-space:nowrap;overflow-wrap:normal/);
  assert.match(script, /`\$\{price\(range\.lower\)\}–\$\{price\(range\.upper\)\}`/);
});

test('futures dashboard switches between LONG and SHORT operating surfaces', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /<header class="topbar">[\s\S]*<div class="brand">[\s\S]*<div class="top-actions">/);
  assert.match(html, /class="position-switch" role="group" aria-label="Pilih sisi posisi"/);
  assert.match(html, /data-position-side="LONG" aria-pressed="true"/);
  assert.match(html, /data-position-side="SHORT" aria-pressed="false"/);
  assert.match(css, /\.position-switch-button\{[^}]*min-height:44px/);
  assert.match(css, /\.position-switch-button\[aria-pressed=true\]/);
  assert.match(css, /\.topbar\{[^}]*grid-template-columns:minmax\(230px,1fr\) auto/);
  assert.match(html, /id="long-exposure"/);
  assert.match(html, /id="short-exposure"/);
  assert.match(html, /id="long-pnl"/);
  assert.match(html, /id="short-pnl"/);
  assert.match(html, /id="allocation-pair-list"/);
  assert.match(html, /id="allocation-pair-count"/);
  assert.match(html, /id="allocation-active-pct"/);
  assert.match(html, /id="allocation-ramp-limit"/);
  assert.match(css, /\.comparison-board\{/);
  assert.match(css, /@media\(max-width:620px\).*\.comparison-board\{grid-template-columns:1fr\}/s);
  assert.doesNotMatch(script, /const POSITION_SIDE = 'LONG'/);
  assert.match(script, /const positionSide = \(\) => normalizePositionSide/);
  assert.match(script, /new URLSearchParams\(\{ positionSide: requestedSide \}\)/);
  assert.match(script, /document\.querySelectorAll\('\[data-position-side\]'\)/);
  assert.match(script, /localStorage\.setItem\(POSITION_SIDE_STORAGE_KEY/);
  assert.match(script, /function renderComparison\(\)/);
  assert.match(script, /function renderAllocation\(\)/);
  assert.match(script, /function allocationPairCard\(symbol, budget, side\)/);
  assert.match(script, /const symbol = state\.data\.selectedSymbol/);
  assert.match(script, /const SYMBOL_STORAGE_KEY = 'grid-flow-futures-symbol'/);
  assert.match(script, /function savedSelectedSymbol\(side = state\.positionSide\)/);
  assert.match(script, /persistSelectedSymbol\(event\.target\.value, state\.positionSide\)/);
  assert.match(script, /persistSelectedSymbol\(data\.selectedSymbol, state\.positionSide\)/);
  assert.match(script, /load\(\{ positionSide: state\.positionSide, symbol: savedSelectedSymbol\(state\.positionSide\) \}\)/);
  assert.match(script, /rescuePerPairPct/);
  assert.match(script, /Menunggu sisi kosong/);
  assert.match(script, /budget\.status === 'UNCHANGED' \|\| budget\.status === 'APPLIED'/);
  assert.match(script, /budget\.autoRampAction === 'PROMOTED'/);
  assert.match(script, /Ditahan batas aman/);
  assert.match(script, /autoRampPromotionConfirmations/);
  assert.match(css, /\.allocation-pair-list\{margin-top:14px\}/);
  assert.match(html, /id="entry-signal-status"/);
  assert.match(script, /function priceMomentumView\(momentum\)/);
  assert.match(script, /function reversalInventoryView\(reversal\)/);
  assert.match(script, /\['Kelola reversal', reversal\.management\]/);
  assert.match(script, /\['Rescue', reversal\.rescue\]/);
  assert.match(script, /Dikelola langsung/);
  assert.match(script, /Menunggu kuota pair/);
  assert.match(script, /Menunggu saldo tersedia/);
  assert.match(script, /function entryGateView\(momentum\)/);
  assert.doesNotMatch(script, /Volume Delta|EMA Trend|REPORT_ONLY|REPORT ONLY/);
  assert.doesNotMatch(html, /Volume Delta|EMA Trend|REPORT_ONLY|REPORT ONLY/);
  assert.match(script, /status = 'ENTRY BOLEH'/);
  assert.match(script, /status = 'ENTRY DITAHAN'/);
  assert.match(html, /Funding Binance/);
  assert.match(html, /Batas aman/);
  assert.match(script, /Saldo tersedia/);
  assert.match(script, /status: !position \? 'TIDAK PERLU'/);
  assert.match(script, /status = 'ORDER DIJEDA'/);
  assert.match(script, /status: 'TIDAK ADA ORDER'/);
  assert.match(script, /Menunggu siklus order/);
  assert.match(script, /setFlowNodeState\('buy', entryCount > 0/);
  assert.match(script, /positionSide\(\) === 'SHORT' \? 'SELL' : 'BUY'/);
});

test('dashboard motion preference can override or follow reduced motion', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /<html lang="id" data-motion="on">/);
  assert.match(html, /id="motion-select"/);
  assert.match(html, /value="on">Aktif/);
  assert.match(html, /value="system">Sistem/);
  assert.match(html, /value="off">Mati/);
  assert.match(css, /\.motion-control option\{color:var\(--text\);background:var\(--surface\)\}/);
  assert.match(css, /html:not\(\[data-motion=on\]\) \.flow-signal\{display:none\}/);
  assert.match(css, /html\[data-motion=on\] \.refresh-icon\.fa-spin\{animation:refresh-turn/);
  assert.match(script, /localStorage\.setItem\(MOTION_STORAGE_KEY, preference\)/);
});

test('dashboard refresh has Font Awesome and a visible loading state', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /fa-solid fa-rotate-right refresh-icon/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.match(css, /\.refresh-icon\.fa-spin\{animation:refresh-turn/);
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
  assert.match(login, /level Fibonacci, Price Momentum/);
  assert.doesNotMatch(html, /Adaptive supervisor|Profil BUY|profil adaptive/i);
  assert.doesNotMatch(login, /Adaptive Supervisor|Adaptive decision/i);
  assert.doesNotMatch(script, /renderLearning|trustPolicyView|setNode\('gemini'|setNode\('trust'/);
  assert.doesNotMatch(css, /\.node-gemini|\.node-trust|\.learning-panel|\.learning-body/);
});
