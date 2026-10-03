import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePanelState, clampPanelGeometry, dockPanelGeometry, movePanelGeometry, resizePanelGeometry,
  serializePanelLayout, parsePanelLayout, panelIsVisible, PANEL_COLLAPSED_HEIGHT } from '../src/panels.js';

const bounds = { width: 1280, height: 720 };
const initial = normalizePanelState({ x: 100, y: 90, width: 360, height: 260 });

test('Panel layout survives persistence with manual placement, lock, visibility and appearance', () => {
  const state = { ...initial, x: 400, y: 220, width: 510, height: 350, dock: 'right', visible: false,
    locked: true, collapsed: true, manualPosition: true, fontScale: 1.3, opacity: .7, lineSpacing: 1.8, offsetX: 44, offsetY: -20 };
  const restored = parsePanelLayout(JSON.stringify(serializePanelLayout({ caption: state }, true)));
  assert.deepEqual(restored.panels.caption, normalizePanelState(state));
  assert.equal(restored.allHidden, true);
  assert.equal('content' in restored.panels.caption, false, 'Stage text is independent of layout');
  assert.equal('camera' in restored.panels.caption, false, 'Layout cannot mutate camera/model state');
});

test('Viewport clamping keeps panels reachable at every acceptance resolution and tiny windows', () => {
  for (const b of [bounds, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 180, height: 80 }]) {
    const state = clampPanelGeometry({ ...initial, x: 2000, y: -400, width: 2400, height: 1500 }, b);
    assert.ok(state.x >= 0 && state.y >= 0);
    assert.ok(state.x + state.width <= b.width && state.y + state.height <= b.height);
    assert.ok(state.width > 0 && state.height > 0);
  }
});

test('Docking remains attached to its viewport edge after resize, while dragging explicitly floats', () => {
  for (const dock of ['left', 'right', 'top', 'bottom']) {
    const s = dockPanelGeometry(initial, dock, bounds);
    if (dock === 'left') assert.equal(s.x, 0);
    if (dock === 'right') assert.equal(s.x + s.width, bounds.width);
    if (dock === 'top') assert.equal(s.y, 0);
    if (dock === 'bottom') assert.equal(s.y + s.height, bounds.height);
    const resized = resizePanelGeometry(s, 'se', 90, 60, bounds);
    if (dock === 'right') assert.equal(resized.x + resized.width, bounds.width);
    if (dock === 'bottom') assert.equal(resized.y + resized.height, bounds.height);
    const moved = movePanelGeometry(s, 30, 40, bounds);
    assert.equal(moved.dock, 'free'); assert.equal(moved.manualPosition, true);
  }
});

test('Every edge/corner resize preserves bounds and opposite anchors, rather than changing experimental data', () => {
  for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
    const s = resizePanelGeometry(initial, edge, 40, 30, bounds);
    assert.equal(s.manualPosition, true);
    assert.ok(s.width >= 220 && s.height >= 100);
    assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.width <= bounds.width && s.y + s.height <= bounds.height);
    if (edge.includes('w')) assert.equal(s.x + s.width, initial.x + initial.width);
    if (edge.includes('n')) assert.equal(s.y + s.height, initial.y + initial.height);
  }
  const limited = resizePanelGeometry(initial, 'nw', 10000, 10000, bounds);
  assert.equal(limited.width, 220); assert.equal(limited.height, 100);
});

test('Hide-all restoration preserves each individually hidden panel instead of showing every overlay', () => {
  const shown = { ...initial, visible: true }, hidden = { ...initial, visible: false };
  assert.equal(panelIsVisible(shown, false), true); assert.equal(panelIsVisible(hidden, false), false);
  assert.equal(panelIsVisible(shown, true), false); assert.equal(panelIsVisible(hidden, true), false);
  const snapshot = parsePanelLayout(JSON.stringify(serializePanelLayout({ shown, hidden }, true)));
  assert.equal(panelIsVisible(snapshot.panels.shown, false), true);
  assert.equal(panelIsVisible(snapshot.panels.hidden, false), false);
});

test('Collapsed bottom-docked panels use their header height and expand back within the viewport', () => {
  const collapsed = dockPanelGeometry({ ...initial, collapsed: true, y: 900 }, 'bottom', bounds);
  assert.equal(collapsed.y + PANEL_COLLAPSED_HEIGHT, bounds.height);
  assert.equal(collapsed.height, initial.height, 'Expanded size is preserved while the header is collapsed');
  const expanded = dockPanelGeometry({ ...collapsed, collapsed: false }, 'bottom', bounds);
  assert.equal(expanded.y + expanded.height, bounds.height);
  const floating = clampPanelGeometry({ ...initial, collapsed: true, y: bounds.height - 10 }, bounds);
  assert.equal(floating.y + PANEL_COLLAPSED_HEIGHT, bounds.height);
  const reopened = clampPanelGeometry({ ...floating, collapsed: false }, bounds);
  assert.equal(reopened.y + reopened.height, bounds.height);
});

test('Corrupt and untrusted stored layouts are sanitized without disabling controls', () => {
  assert.deepEqual(parsePanelLayout('{bad json'), { version: 1, allHidden: false, panels: {} });
  assert.deepEqual(parsePanelLayout({ version: 2, panels: {} }), { version: 1, allHidden: false, panels: {} });
  const s = normalizePanelState({ x: Infinity, y: NaN, width: -4, height: 0, fontScale: 200, opacity: -3, lineSpacing: 1, dock: 'elsewhere', script: 'ignored' });
  assert.equal(s.x, 24); assert.equal(s.y, 88); assert.equal(s.fontScale, 2.2); assert.equal(s.opacity, .25); assert.equal(s.lineSpacing, 1.2); assert.equal(s.dock, 'free');
  assert.equal('script' in s, false);
  const parsed = parsePanelLayout('{"version":1,"panels":{"__proto__":{"x":9},"caption":{"x":28}}}');
  assert.equal(Object.hasOwn(parsed.panels, '__proto__'), false); assert.equal(parsed.panels.caption.x, 28);
});
