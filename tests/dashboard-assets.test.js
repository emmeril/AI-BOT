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
  assert.match(css, /\.flow-signal path\[data-state=safety\]\{stroke:var\(--warning\)/);
  assert.match(css, /\.flow-signal path\[data-state=error\]\{stroke:var\(--negative\)/);
  assert.match(css, /\.flow-signal path\[data-state=active\]\{stroke:var\(--accent\);opacity:\.9\}/);
  assert.match(script, /setFlowEdge\('fibonacci', 'supervisor', gate\.available/);
  assert.match(script, /setFlowEdge\('supervisor', 'buy', entryCount > 0/);
  assert.match(script, /setFlowEdge\('position', 'sell', exitNeedsAttention/);
  assert.match(css, /\.flow-grid\{[^}]*grid-template-columns:repeat\(6/);
});

test('futures dashboard combines LONG and SHORT with accessible side filters', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /role="tablist" aria-label="Filter sisi posisi"/);
  assert.match(html, /data-position-side="LONG"/);
  assert.match(html, /data-position-side="SHORT"/);
  assert.match(html, /<span>LONG<\/span><small>BUY → SELL<\/small>/);
  assert.match(html, /<span>SHORT<\/span><small>SELL → BUY<\/small>/);
  assert.match(html, /<header class="topbar">[\s\S]*<nav class="position-tabs"[\s\S]*<div class="top-actions">/);
  assert.match(css, /\.position-tabs\{[^}]*justify-self:center;[^}]*width:min\(100%,220px\);height:44px;margin:0/);
  assert.match(css, /\.position-tab\{[^}]*flex-direction:column;align-items:center;justify-content:center/);
  assert.match(html, /id="combined-exposure"/);
  assert.match(html, /id="allocation-track"/);
  assert.match(html, /id="long-allocation-status"/);
  assert.match(html, /id="short-allocation-status"/);
  assert.match(html, /id="long-pnl"/);
  assert.match(html, /id="short-pnl"/);
  assert.match(css, /\.comparison-board\{/);
  assert.match(css, /@media\(max-width:620px\).*\.comparison-board\{grid-template-columns:1fr\}/s);
  assert.match(script, /new URLSearchParams\(\{ positionSide \}\)/);
  assert.match(script, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(script, /function renderComparison\(\)/);
  assert.match(script, /function renderAllocation\(\)/);
  assert.match(script, /Kenaikan ditunda, exposure aktif/);
  assert.match(script, /Saldo belum berubah/);
  assert.match(css, /@media\(max-width:900px\).*\.allocation-body\{grid-template-columns:1fr\}/s);
  assert.match(html, /id="volume-delta-status"/);
  assert.match(html, /id="volume-delta-reason"/);
  assert.match(script, /function volumeDeltaView\(volumeDelta\)/);
  assert.match(script, /Tekanan taker \$\{opposingTaker\} terlalu kuat/);
  assert.match(script, /value: 'Filter tidak aktif'/);
  assert.match(script, /FUTURES_LONG_ENTRY_DIRECTION|requiredEntryDirection|Wajib \$\{gate\.requiredDirection\}/);
  assert.match(script, /RESTART DIPERLUKAN/);
  assert.match(html, /Funding Binance pair \(semua trade\)/);
  assert.match(html, /Ambang peringatan exposure/);
  assert.match(script, /Margin order akun/);
  assert.match(script, /Saldo tersedia akun/);
  assert.doesNotMatch(html, /Funding akun Binance|PnL berjalan sisi|PnL strategi sisi|Batas risk-off/);
  assert.doesNotMatch(script, /Risk-off threshold|Cap sisi /);
  assert.doesNotMatch(script, /Tidak diaktifkan setelah gagal OOS/);
  assert.match(script, /status: !position \? 'TIDAK DIPERLUKAN'/);
  assert.match(script, /status = 'ORDER DIJEDA'/);
  assert.match(script, /status = 'GATE LULUS'/);
  assert.match(script, /status: 'TIDAK ADA ORDER'/);
  assert.match(script, /cap exposure, minimum notional, level harga, atau kebijakan order/);
  assert.match(script, /setFlowNodeState\('buy', entryCount > 0/);
  assert.doesNotMatch(script, /status = 'ENTRY AKTIF'/);
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
  assert.match(login, /gate arah Fibonacci, filter Volume Delta/);
  assert.doesNotMatch(html, /Adaptive supervisor|Profil BUY|profil adaptive/i);
  assert.doesNotMatch(login, /Adaptive Supervisor|Adaptive decision/i);
  assert.doesNotMatch(script, /renderLearning|trustPolicyView|setNode\('gemini'|setNode\('trust'/);
  assert.doesNotMatch(css, /\.node-gemini|\.node-trust|\.learning-panel|\.learning-body/);
});
