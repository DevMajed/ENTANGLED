/** Screen-space layout only. This module never touches the optical scene or event model. */
export const PANEL_DOCKS = Object.freeze(['free', 'left', 'right', 'top', 'bottom']);
export const PANEL_MIN_SIZE = Object.freeze({ width: 220, height: 100 });
export const PANEL_COLLAPSED_HEIGHT = 42;
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const limit = (value, min, max) => Math.max(min, Math.min(max, value));
const safeBounds = bounds => ({ width: Math.max(1, number(bounds?.width, 1440)), height: Math.max(1, number(bounds?.height, 900)) });

/** Whitelist stored fields; stage content and hardware coordinates never enter persistence. */
export function normalizePanelState(input = {}, defaults = {}) {
  const s = { ...defaults, ...input };
  return {
    x: number(s.x, 24), y: number(s.y, 88),
    width: Math.max(1, number(s.width, 360)), height: Math.max(1, number(s.height, 260)),
    dock: PANEL_DOCKS.includes(s.dock) ? s.dock : 'free',
    fontScale: limit(number(s.fontScale, 1), .7, 2.2),
    opacity: limit(number(s.opacity, .9), .25, 1),
    lineSpacing: limit(number(s.lineSpacing, 1.5), 1.2, 2.2),
    visible: s.visible !== false, collapsed: s.collapsed === true, locked: s.locked === true,
    manualPosition: s.manualPosition === true || s.manuallyPositioned === true,
    z: Math.max(1, Math.floor(number(s.z, 1))),
    offsetX: number(s.offsetX, 0), offsetY: number(s.offsetY, 0),
    leaderLine: s.leaderLine !== false,
  };
}

/** Keep the whole panel reachable, including on viewports smaller than its minimum size. */
export function clampPanelGeometry(input, bounds) {
  const b = safeBounds(bounds), s = normalizePanelState(input);
  const width = limit(s.width, Math.min(PANEL_MIN_SIZE.width, b.width), b.width);
  const height = limit(s.height, Math.min(PANEL_MIN_SIZE.height, b.height), b.height);
  const displayedHeight = s.collapsed ? Math.min(PANEL_COLLAPSED_HEIGHT, b.height) : height;
  return { ...s, width, height, x: limit(s.x, 0, b.width - width), y: limit(s.y, 0, b.height - displayedHeight) };
}

export function dockPanelGeometry(input, dock, bounds) {
  const b = safeBounds(bounds), s = clampPanelGeometry({ ...input, dock }, b);
  if (s.dock === 'left') s.x = 0;
  if (s.dock === 'right') s.x = b.width - s.width;
  if (s.dock === 'top') s.y = 0;
  if (s.dock === 'bottom') s.y = b.height - (s.collapsed ? Math.min(PANEL_COLLAPSED_HEIGHT, b.height) : s.height);
  return s;
}

export function movePanelGeometry(input, dx, dy, bounds) {
  return clampPanelGeometry({ ...input, x: input.x + number(dx, 0), y: input.y + number(dy, 0), dock: 'free', manualPosition: true }, bounds);
}

/** Edges preserve their opposite anchor while enforcing minimum size and viewport bounds. */
export function resizePanelGeometry(input, edge, dx, dy, bounds) {
  const b = safeBounds(bounds), s = clampPanelGeometry(input, b), next = { ...s, manualPosition: true };
  dx = number(dx, 0); dy = number(dy, 0);
  if (edge.includes('e') || edge.includes('w')) {
    const max = edge.includes('w') ? s.x + s.width : b.width - s.x;
    next.width = limit(s.width + (edge.includes('w') ? -dx : dx), Math.min(PANEL_MIN_SIZE.width, max), max);
    if (edge.includes('w')) next.x = s.x + s.width - next.width;
  }
  if (edge.includes('n') || edge.includes('s')) {
    const max = edge.includes('n') ? s.y + s.height : b.height - s.y;
    next.height = limit(s.height + (edge.includes('n') ? -dy : dy), Math.min(PANEL_MIN_SIZE.height, max), max);
    if (edge.includes('n')) next.y = s.y + s.height - next.height;
  }
  return dockPanelGeometry(next, next.dock, b);
}

export function panelIsVisible(state, allHidden = false) { return !allHidden && state.visible !== false; }

export function serializePanelLayout(panels, allHidden = false) {
  const entries = panels instanceof Map ? panels.entries() : Object.entries(panels ?? {});
  const saved = {};
  for (const [id, state] of entries) if (typeof id === 'string' && id && !['__proto__', 'constructor', 'prototype'].includes(id)) saved[id] = normalizePanelState(state);
  return { version: 1, allHidden: Boolean(allHidden), panels: saved };
}

export function parsePanelLayout(value) {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    if (!data || data.version !== 1 || !data.panels || typeof data.panels !== 'object' || Array.isArray(data.panels)) return { version: 1, allHidden: false, panels: {} };
    return serializePanelLayout(data.panels, data.allHidden);
  } catch { return { version: 1, allHidden: false, panels: {} }; }
}

const element = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const button = (text, label, handler) => {
  const el = element('button', '', text);
  el.type = 'button'; el.title = label; el.setAttribute('aria-label', label);
  el.addEventListener('click', handler);
  return el;
};
const isEditing = target => target?.closest?.('input, textarea, select, button, a, [contenteditable="true"]');

/**
 * All panels share one gesture/layout policy. Content updates do not reset geometry.
 * The restoration menu is intentionally outside hide-all, so controls remain reachable.
 */
export class FloatingPanels {
  constructor(container, { storageKey = 'entangled-measurement-panels-v1', onChange } = {}) {
    if (!container?.appendChild) throw new TypeError('FloatingPanels needs a DOM container');
    this.container = container;
    this.storageKey = storageKey;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.entries = new Map(); this.z = 10;
    this.saved = this._readStorage(); this.allHidden = this.saved.allHidden;
    // Panels may be registered one by one after reload; keep the other saved IDs intact.
    this._pendingLayouts = { ...this.saved.panels };
    this._destroyed = false;
    this._leaderLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._leaderLayer.classList.add('fp-leader-layer');
    Object.assign(this._leaderLayer.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' });
    this._leaderLayer.setAttribute('aria-hidden', 'true');
    container.appendChild(this._leaderLayer);
    this._menu = this._buildMenu();
    this._onResize = () => {
      for (const entry of this.entries.values()) {
        entry.state = dockPanelGeometry(entry.state, entry.state.dock, this.bounds());
        this._apply(entry);
      }
      this.persist(); this.onChange({ reason: 'viewport' });
    };
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver === 'function') {
      this._observer = new ResizeObserver(this._onResize);
      this._observer.observe(container);
    }
  }

  bounds() {
    const rect = this.container.getBoundingClientRect();
    return { width: rect.width || window.innerWidth || 1440, height: rect.height || window.innerHeight || 900 };
  }

  _readStorage() {
    try { return parsePanelLayout(window.localStorage.getItem(this.storageKey)); }
    catch { return parsePanelLayout(null); }
  }

  /** Returns the panel element. .panel-body is its sole mutable content area. */
  add(spec) {
    if (!spec?.id || typeof spec.id !== 'string') throw new TypeError('A panel needs a stable string id');
    if (this.entries.has(spec.id)) {
      if (spec.content !== undefined) this.setContent(spec.id, spec.content);
      if (spec.title !== undefined) this.setTitle(spec.id, spec.title);
      return this.get(spec.id);
    }
    const defaults = normalizePanelState({ ...spec, z: ++this.z });
    const stored = this._pendingLayouts[spec.id];
    const state = dockPanelGeometry(normalizePanelState(stored ?? {}, defaults), (stored ?? defaults).dock, this.bounds());
    this.z = Math.max(this.z, state.z);
    const panel = element('section', 'fp-panel');
    panel.dataset.panelId = spec.id; panel.style.position = 'absolute'; panel.style.pointerEvents = 'auto';
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', String(spec.title ?? spec.id));
    const header = element('header', 'fp-header');
    header.style.touchAction = 'none';
    const title = element('span', 'fp-title', spec.title ?? spec.id);
    const actions = element('div', 'fp-actions');
    const body = element('div', 'fp-body panel-body');
    const tools = element('div', 'fp-tools'); tools.hidden = true;
    header.append(title, actions); panel.append(header, body, tools);
    const entry = { id: spec.id, title: String(spec.title ?? spec.id), panel, header, body, tools, defaults, state, anchor: null, leader: null, controls: {} };
    this.entries.set(spec.id, entry); this.container.appendChild(panel);
    Object.defineProperty(panel, 'panelState', { get: () => ({ ...entry.state }) });
    actions.append(
      button('↗', 'Bring panel to front', () => this.bringToFront(spec.id)),
      button('⋯', 'Adjust docking, text and opacity', () => { tools.hidden = !tools.hidden; this.bringToFront(spec.id); }),
      entry.controls.collapse = button('−', 'Collapse panel', () => this.collapse(spec.id)),
      entry.controls.lock = button('◇', 'Lock panel position', () => this.lock(spec.id)),
      button('×', 'Hide panel', () => this.hide(spec.id)),
    );
    this._buildTools(entry);
    this._bindGesture(entry, header, 'move');
    for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      const handle = element('div', `fp-resize fp-resize-${edge}`);
      handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true'); handle.style.touchAction = 'none';
      this._placeHandle(handle, edge);
      panel.appendChild(handle); this._bindGesture(entry, handle, 'resize', edge);
    }
    // Panel interactions never reach the optical canvas. Scroll remains native within text.
    // Block camera gestures, but let clicks reach application-level delegated controls.
    // The optical canvas is a sibling, so a bubbling click cannot become a canvas click.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'contextmenu']) panel.addEventListener(type, event => event.stopPropagation());
    panel.addEventListener('pointerdown', () => this.bringToFront(spec.id, false));
    panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
    panel.addEventListener('keydown', event => { if (event.target.closest?.('input,textarea,select,[contenteditable="true"]')) event.stopPropagation(); });
    this.setContent(spec.id, spec.content ?? '');
    if (spec.annotation || spec.anchor) {
      panel.classList.add('fp-annotation');
      const anchor = spec.anchor ?? { x: defaults.x, y: defaults.y };
      entry.anchor = { x: number(anchor.x, defaults.x), y: number(anchor.y, defaults.y) };
      if (!stored) {
        entry.state.offsetX = entry.state.x - entry.anchor.x;
        entry.state.offsetY = entry.state.y - entry.anchor.y;
      }
      this._createLeader(entry);
    }
    this._apply(entry); this._updateMenu(); this.persist();
    return panel;
  }

  _placeHandle(handle, edge) {
    Object.assign(handle.style, { position: 'absolute', zIndex: '4' });
    const corner = edge.length === 2;
    handle.style.width = corner ? '14px' : edge === 'e' || edge === 'w' ? '8px' : 'calc(100% - 24px)';
    handle.style.height = corner ? '14px' : edge === 'n' || edge === 's' ? '8px' : 'calc(100% - 24px)';
    if (edge.includes('n')) handle.style.top = '-3px';
    if (edge.includes('s')) handle.style.bottom = '-3px';
    if (edge.includes('w')) handle.style.left = '-3px';
    if (edge.includes('e')) handle.style.right = '-3px';
    if (!corner && (edge === 'n' || edge === 's')) handle.style.left = '12px';
    if (!corner && (edge === 'e' || edge === 'w')) handle.style.top = '12px';
    handle.style.cursor = `${edge === 'n' || edge === 's' ? 'ns' : edge === 'e' || edge === 'w' ? 'ew' : edge === 'nw' || edge === 'se' ? 'nwse' : 'nesw'}-resize`;
  }

  _buildTools(entry) {
    const docking = element('label', 'fp-tool-label', 'Dock');
    const select = element('select');
    for (const dock of PANEL_DOCKS) { const option = element('option', '', dock === 'free' ? 'Float freely' : dock[0].toUpperCase() + dock.slice(1)); option.value = dock; select.appendChild(option); }
    select.addEventListener('change', () => this.dock(entry.id, select.value)); docking.appendChild(select); entry.tools.appendChild(docking); entry.controls.dock = select;
    const ranges = [ ['fontScale', 'Text size', .7, 2.2, .05], ['lineSpacing', 'Line spacing', 1.2, 2.2, .05], ['opacity', 'Panel opacity', .25, 1, .05] ];
    for (const [key, label, min, max, step] of ranges) {
      const row = element('label', 'fp-tool-label', label), output = element('output'), input = element('input');
      input.type = 'range'; input.min = min; input.max = max; input.step = step; input.setAttribute('aria-label', `${entry.title}: ${label}`);
      input.addEventListener('input', () => { entry.state[key] = Number(input.value); this._changed(entry, 'appearance'); });
      row.append(output, input); entry.tools.appendChild(row); entry.controls[key] = { input, output };
    }
    entry.tools.appendChild(button('Reset this panel', 'Reset this panel to its default layout', () => this.resetPanel(entry.id)));
  }

  _bindGesture(entry, handle, kind, edge = '') {
    let gesture = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || entry.state.locked || (kind === 'move' && isEditing(event.target))) return;
      event.preventDefault(); event.stopPropagation(); this.bringToFront(entry.id, false);
      gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, state: { ...entry.state }, moved: false };
      handle.setPointerCapture?.(event.pointerId); entry.panel.classList.add('fp-moving');
    });
    handle.addEventListener('pointermove', event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
      if (Math.abs(dx) + Math.abs(dy) < 1 && !gesture.moved) return;
      gesture.moved = true;
      entry.state = kind === 'move' ? movePanelGeometry(gesture.state, dx, dy, this.bounds()) : resizePanelGeometry(gesture.state, edge, dx, dy, this.bounds());
      this._updateAnchorOffset(entry); this._apply(entry);
      this.onChange({ id: entry.id, reason: kind, state: { ...entry.state } });
    });
    const finish = event => {
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      event.stopPropagation();
      handle.releasePointerCapture?.(event.pointerId); entry.panel.classList.remove('fp-moving');
      if (gesture.moved) this._changed(entry, kind); else this.persist();
      gesture = null;
    };
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', event => { if (gesture?.pointerId === event.pointerId) { gesture = null; entry.panel.classList.remove('fp-moving'); this.persist(); } });
  }

  _apply(entry) {
    const s = entry.state;
    const headerHeight = Math.max(PANEL_COLLAPSED_HEIGHT, entry.header.offsetHeight || PANEL_COLLAPSED_HEIGHT), viewport = this.bounds();
    Object.assign(entry.panel.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.width}px`, height: s.collapsed ? `${headerHeight}px` : `${s.height}px`, zIndex: String(s.z) });
    // Settings remain reachable for narrow panels and panels docked near the bottom.
    entry.tools.style.width = `${Math.max(100, Math.min(245, s.width - 18))}px`;
    entry.tools.style.overflowY = 'auto';
    const below = viewport.height - s.y - headerHeight - 8, above = s.y - 8;
    if (below >= 140 || below >= above) {
      entry.tools.style.top = `${headerHeight}px`; entry.tools.style.bottom = 'auto';
      entry.tools.style.maxHeight = `${Math.max(32, below)}px`;
    } else {
      entry.tools.style.top = 'auto'; entry.tools.style.bottom = `${(s.collapsed ? headerHeight : s.height) + 2}px`;
      entry.tools.style.maxHeight = `${Math.max(32, above)}px`;
    }
    entry.panel.style.setProperty('--fp-opacity', String(s.opacity));
    entry.panel.style.setProperty('--fp-font-scale', String(s.fontScale));
    entry.body.style.fontSize = `${20 * s.fontScale}px`; entry.body.style.lineHeight = String(s.lineSpacing);
    entry.panel.hidden = !panelIsVisible(s, this.allHidden); entry.body.hidden = s.collapsed;
    entry.panel.classList.toggle('fp-collapsed', s.collapsed); entry.panel.classList.toggle('fp-locked', s.locked);
    entry.panel.dataset.dock = s.dock;
    entry.controls.collapse.textContent = s.collapsed ? '+' : '−'; entry.controls.collapse.setAttribute('aria-label', s.collapsed ? 'Expand panel' : 'Collapse panel');
    entry.controls.lock.textContent = s.locked ? '◆' : '◇'; entry.controls.lock.setAttribute('aria-label', s.locked ? 'Unlock panel position' : 'Lock panel position'); entry.controls.lock.setAttribute('aria-pressed', String(s.locked));
    entry.controls.dock.value = s.dock; entry.controls.dock.disabled = s.locked;
    for (const key of ['fontScale', 'lineSpacing', 'opacity']) {
      entry.controls[key].input.value = s[key]; entry.controls[key].output.textContent = key === 'opacity' ? `${Math.round(s[key] * 100)}%` : `${s[key].toFixed(2)}×`;
    }
    for (const handle of entry.panel.querySelectorAll('.fp-resize')) handle.hidden = s.locked || s.collapsed;
    this._renderLeader(entry);
  }

  _changed(entry, reason) { this._apply(entry); this.persist(); this._updateMenu(); this.onChange({ id: entry.id, reason, state: { ...entry.state } }); }
  get(id) { return this.entries.get(id)?.panel ?? null; }
  getState(id) { const state = this.entries.get(id)?.state; return state ? { ...state } : null; }
  setContent(id, content) {
    const entry = this.entries.get(id); if (!entry) return null;
    if (typeof content === 'string') entry.body.innerHTML = content;
    else { entry.body.replaceChildren(); if (content?.nodeType) entry.body.appendChild(content); }
    return entry.body;
  }
  setTitle(id, title) { const entry = this.entries.get(id); if (!entry) return; entry.title = String(title); entry.header.querySelector('.fp-title').textContent = entry.title; entry.panel.setAttribute('aria-label', entry.title); this._updateMenu(); }
  show(id) { const entry = this.entries.get(id); if (!entry) return; entry.state.visible = true; this._changed(entry, 'visibility'); this.bringToFront(id); }
  hide(id) { const entry = this.entries.get(id); if (!entry) return; entry.state.visible = false; entry.tools.hidden = true; this._changed(entry, 'visibility'); }
  collapse(id, value) { const entry = this.entries.get(id); if (!entry) return; entry.state.collapsed = value === undefined ? !entry.state.collapsed : Boolean(value); entry.state = dockPanelGeometry(entry.state, entry.state.dock, this.bounds()); this._updateAnchorOffset(entry); entry.tools.hidden = true; this._changed(entry, 'collapse'); }
  lock(id, value) { const entry = this.entries.get(id); if (!entry) return; entry.state.locked = value === undefined ? !entry.state.locked : Boolean(value); this._changed(entry, 'lock'); }
  dock(id, dock) { const entry = this.entries.get(id); if (!entry || entry.state.locked) return; entry.state = dockPanelGeometry({ ...entry.state, manualPosition: true }, dock, this.bounds()); this._updateAnchorOffset(entry); this._changed(entry, 'dock'); }
  bringToFront(id, save = true) { const entry = this.entries.get(id); if (!entry) return; entry.state.z = ++this.z; entry.panel.style.zIndex = String(entry.state.z); if (save) this.persist(); }
  toggleAll() { this.allHidden = !this.allHidden; this._applyAll(); this.persist(); this._updateMenu(); this.onChange({ reason: 'overlays', allHidden: this.allHidden }); return this.allHidden; }
  _applyAll() { for (const entry of this.entries.values()) this._apply(entry); }
  resetPanel(id) { const entry = this.entries.get(id); if (!entry) return; entry.state = dockPanelGeometry({ ...entry.defaults, z: ++this.z }, entry.defaults.dock, this.bounds()); this._updateAnchorOffset(entry); this._changed(entry, 'reset-layout'); }
  resetLayout() { this.allHidden = false; this._pendingLayouts = {}; for (const entry of this.entries.values()) { entry.state = dockPanelGeometry({ ...entry.defaults, z: ++this.z }, entry.defaults.dock, this.bounds()); this._updateAnchorOffset(entry); } this._applyAll(); this._updateMenu(); this.persist(); this.onChange({ reason: 'reset-layout' }); }
  snapshot() { return serializePanelLayout({ ...this._pendingLayouts, ...Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.state])) }, this.allHidden); }
  restore(value) {
    const layout = parsePanelLayout(value); this.saved = layout; this._pendingLayouts = { ...layout.panels }; this.allHidden = layout.allHidden;
    for (const [id, entry] of this.entries) {
      entry.state = dockPanelGeometry(normalizePanelState(layout.panels[id] ?? {}, entry.defaults), (layout.panels[id] ?? entry.defaults).dock, this.bounds());
      this.z = Math.max(this.z, entry.state.z); this._apply(entry);
    }
    this._updateMenu(); this.persist(); this.onChange({ reason: 'restore-layout' });
  }
  persist() { const layout = this.snapshot(); this.saved = layout; try { window.localStorage.setItem(this.storageKey, JSON.stringify(layout)); } catch { /* An unavailable store must not disable presentation controls. */ } return layout; }

  _buildMenu() {
    const menu = element('div', 'fp-restore-menu'); menu.style.pointerEvents = 'auto';
    const details = element('details'), summary = element('summary', '', 'Panels ▾'); details.appendChild(summary);
    const list = element('div', 'fp-menu-list'), items = element('div', 'fp-menu-items'); list.appendChild(items);
    this._menuItems = items;
    this._toggleButton = button('Hide overlays · H', 'Hide or restore all overlays', () => this.toggleAll());
    list.append(this._toggleButton, button('Restore all panels', 'Show every panel', () => { this.allHidden = false; for (const entry of this.entries.values()) entry.state.visible = true; this._applyAll(); this.persist(); this._updateMenu(); }), button('Reset layout', 'Restore default panel positions without resetting the experiment', () => this.resetLayout()));
    details.appendChild(list); menu.appendChild(details);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'wheel']) menu.addEventListener(type, event => event.stopPropagation(), { passive: type === 'wheel' });
    return menu;
  }
  _updateMenu() {
    this._menuItems.replaceChildren();
    for (const entry of this.entries.values()) {
      const row = element('label', 'fp-menu-item'), check = element('input'); check.type = 'checkbox'; check.checked = entry.state.visible;
      check.addEventListener('change', () => check.checked ? this.show(entry.id) : this.hide(entry.id));
      row.append(check, document.createTextNode(entry.title)); this._menuItems.appendChild(row);
    }
    this._toggleButton.textContent = this.allHidden ? 'Restore overlays · H' : 'Hide overlays · H';
  }
  menuElement() { return this._menu; }

  /** Move only untouched free panels away from a focused screen point, never the hardware. */
  autoAvoid(center, radius = 90) {
    if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return;
    const b = this.bounds(); let changed = false;
    for (const entry of this.entries.values()) {
      const s = entry.state;
      if (s.manualPosition || s.locked || s.dock !== 'free' || !panelIsVisible(s, this.allHidden)) continue;
      const height = s.collapsed ? 42 : s.height;
      if (center.x + radius < s.x || center.x - radius > s.x + s.width || center.y + radius < s.y || center.y - radius > s.y + height) continue;
      const candidates = [ { ...s, x: center.x - radius - s.width - 16 }, { ...s, x: center.x + radius + 16 }, { ...s, y: center.y - radius - height - 16 }, { ...s, y: center.y + radius + 16 } ].map(candidate => clampPanelGeometry(candidate, b));
      candidates.sort((a, c) => {
        const overlap = q => center.x + radius >= q.x && center.x - radius <= q.x + q.width && center.y + radius >= q.y && center.y - radius <= q.y + height;
        return Number(overlap(a)) - Number(overlap(c)) || Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(c.x - s.x, c.y - s.y);
      });
      entry.state = { ...candidates[0], manualPosition: false }; this._updateAnchorOffset(entry); this._apply(entry); changed = true;
    }
    if (changed) { this.persist(); this.onChange({ reason: 'auto-avoid' }); }
  }

  _createLeader(entry) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.classList.add('fp-leader-line');
    line.setAttribute('stroke', '#7cc9df'); line.setAttribute('stroke-opacity', '.5'); line.setAttribute('stroke-width', '1');
    this._leaderLayer.appendChild(line); entry.leader = line;
  }
  _updateAnchorOffset(entry) { if (entry.anchor) { entry.state.offsetX = entry.state.x - entry.anchor.x; entry.state.offsetY = entry.state.y - entry.anchor.y; } }
  _renderLeader(entry) {
    if (!entry.leader || !entry.anchor) return;
    const s = entry.state, a = entry.anchor;
    entry.leader.style.display = panelIsVisible(s, this.allHidden) && s.leaderLine ? '' : 'none';
    const endX = limit(a.x, s.x, s.x + s.width), endY = limit(a.y, s.y, s.y + (s.collapsed ? 42 : s.height));
    entry.leader.setAttribute('x1', a.x); entry.leader.setAttribute('y1', a.y); entry.leader.setAttribute('x2', endX); entry.leader.setAttribute('y2', endY);
  }
  /** Camera projection updates this screen anchor; stored offsets preserve user label placement. */
  setAnchor(id, point, { leaderLine } = {}) {
    const entry = this.entries.get(id); if (!entry || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
    if (!entry.leader) { entry.panel.classList.add('fp-annotation'); this._createLeader(entry); }
    // First attaching an ordinary screen panel must preserve its saved placement,
    // rather than jumping the text directly over the component it describes.
    if (!entry.anchor) {
      entry.state.offsetX = entry.state.x - point.x;
      entry.state.offsetY = entry.state.y - point.y;
    }
    entry.anchor = { x: point.x, y: point.y };
    if (leaderLine !== undefined) entry.state.leaderLine = Boolean(leaderLine);
    entry.state = dockPanelGeometry({ ...entry.state, x: point.x + entry.state.offsetX, y: point.y + entry.state.offsetY }, entry.state.dock, this.bounds());
    this._apply(entry);
  }

  destroy() {
    if (this._destroyed) return; this.persist(); this._destroyed = true;
    window.removeEventListener('resize', this._onResize); this._observer?.disconnect();
    for (const entry of this.entries.values()) entry.panel.remove();
    this.entries.clear(); this._leaderLayer.remove(); this._menu.remove();
  }
}

export default FloatingPanels;
