const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicFile = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('dashboard pipeline keeps seven responsive animated connections', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.equal((html.match(/data-edge=/g) || []).length, 14);
  assert.match(script, /const FLOW_EDGES = \[/);
  assert.match(script, /ResizeObserver\(queueFlowLayout\)/);
  assert.match(script, /const FLOW_STAGES = \[\['market'\]/);
  assert.match(script, /animation\.id = 'flow-node-bounce'/);
  assert.match(script, /node\.dataset\.flowState === 'safety'/);
  assert.doesNotMatch(script, /translateY\(-5px\) scale\(1\.01\)/);
  assert.doesNotMatch(css, /@media\(max-width:1180px\)[^}]*\.flow-lines\{display:none\}/);
  assert.match(css, /\.flow-signal path\[data-state=safety\]\{stroke:var\(--warning\)/);
  assert.match(css, /\.flow-signal path\[data-state=error\]\{stroke:var\(--negative\)/);
  assert.match(css, /\.flow-map\[data-running=true\] \.flow-signal path\[data-state=active\]/);
  assert.match(script, /setFlowEdge\('supervisor', 'buy', safetyOverride/);
  assert.match(script, /setFlowEdge\('position', 'sell', sellNeedsAttention/);
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

test('dashboard presents adaptive learning evidence and safe empty states', () => {
  const html = publicFile('dashboard.html');
  const css = publicFile('dashboard.css');
  const script = publicFile('dashboard.js');

  assert.match(html, /id="learning-status">MENUNGGU/);
  assert.match(html, /id="learning-meter" role="progressbar"/);
  assert.match(html, /Akurasi di panel ini mengukur arah harga, bukan profit atau PnL/);
  assert.match(script, /function renderLearning\(\)/);
  assert.match(script, /confidence_below_learned_threshold/);
  assert.match(script, /\['Threshold konflik', confidence\(policy\.conflictMinConfidence\)\]/);
  assert.match(script, /\['Komposisi episode'/);
  assert.match(script, /\['Akurasi arah 4 jam'/);
  assert.match(script, /\['Monitor rollback', rollbackLabel\(learning\)\]/);
  assert.match(script, /renderOverview\(\); renderFlow\(\); renderLearning\(\)/);
  assert.match(css, /\.learning-body\{display:grid/);
  assert.match(css, /@media\(max-width:900px\)\{\.learning-body\{grid-template-columns:1fr\}\}/);
});
