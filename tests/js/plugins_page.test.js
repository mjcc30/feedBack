// Verify the v3 Pedalboard Plugins page (static/v3/plugins-page.js) pure
// helpers: category resolution (manifest override > curated > derive > other),
// thumbnail URL building, click-target selection (settings vs screen vs none),
// drag clamping, default-flow slots, and the localStorage layout round-trip.
//
// The page exposes these helpers on window.v3PluginsPage._test, so we load the
// IIFE in a vm sandbox with a minimal window/document and read them back —
// no brace-extraction needed.

const { test } = require('node:test');
// Non-strict assert on purpose: helpers return objects created inside the vm
// realm, whose Object.prototype differs from this realm's — strict deepEqual
// would fail the prototype check even when the structure matches.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'static', 'v3', 'plugins-page.js');

function loadPage(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const win = { feedBack: null };
    win.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { if (opts.throwOnSet) throw new Error('quota'); store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
    win.addEventListener = () => {};
    win.matchMedia = () => ({ matches: false });
    const doc = {
        readyState: 'complete',
        getElementById: () => null,          // render() bails: no #v3-plugins
        querySelector: () => null,
        addEventListener: () => {},
    };
    const ctx = {
        window: win, document: doc, console,
        fetch: () => Promise.reject(new Error('no fetch in test')),
        requestAnimationFrame: () => 0,
        setTimeout: () => 0, clearTimeout: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'plugins-page.js' });
    return { api: win.v3PluginsPage, t: win.v3PluginsPage._test, store, win };
}

test('categoryOf: manifest category is authoritative (lowercased)', () => {
    const { t } = loadPage();
    assert.equal(t.categoryOf({ id: 'whatever', category: 'Audio' }), 'audio');
    // Even an unknown manifest category wins over the curated map.
    assert.equal(t.categoryOf({ id: 'nam_tone', category: 'Custom' }), 'custom');
});

test('categoryOf: curated map, then type-derive, then other', () => {
    const { t } = loadPage();
    assert.equal(t.categoryOf({ id: 'nam_tone' }), 'audio');
    assert.equal(t.categoryOf({ id: 'flappy_bend' }), 'game');
    assert.equal(t.categoryOf({ id: 'editor' }), 'tools');
    assert.equal(t.categoryOf({ id: 'unknown_x', type: 'visualization' }), 'creation');
    assert.equal(t.categoryOf({ id: 'unknown_x' }), 'other');
    assert.equal(t.categoryOf(null), 'other');
});

test('thumbUrl: manifest icon routes through the asset endpoint; else default', () => {
    const { t } = loadPage();
    assert.equal(t.thumbUrl({ id: 'flappy_bend', icon: 'assets/thumb.png' }),
        '/api/plugins/flappy_bend/assets/thumb.png');
    // Leading assets/ is stripped (route path is relative to assets/).
    assert.equal(t.thumbUrl({ id: 'x', icon: 'assets/img/p.svg' }), '/api/plugins/x/assets/img/p.svg');
    assert.equal(t.thumbUrl({ id: 'x' }), '/static/v3/pedal-default.svg');
    assert.equal(t.thumbUrl({ id: 'x', icon: '' }), '/static/v3/pedal-default.svg');
});

test('settingsTarget: screen > settings > none', () => {
    const { t } = loadPage();
    // A screen wins even when the plugin also has settings (e.g. audio_engine):
    // the pedal opens the plugin's page, not its settings panel.
    assert.deepEqual(t.settingsTarget({ id: 'a', has_settings: true, nav: true }), { kind: 'screen', id: 'a' });
    assert.deepEqual(t.settingsTarget({ id: 'b', has_settings: false, nav: true }), { kind: 'screen', id: 'b' });
    assert.deepEqual(t.settingsTarget({ id: 'c', has_settings: false, has_screen: true }), { kind: 'screen', id: 'c' });
    // Settings-only plugin (no screen) falls back to its settings panel.
    assert.deepEqual(t.settingsTarget({ id: 'e', has_settings: true }), { kind: 'settings', id: 'e' });
    assert.deepEqual(t.settingsTarget({ id: 'd' }), { kind: 'none', id: 'd' });
});

test('clampToBoard: x clamped to [0, boardW-pedalW]; y floored at 0', () => {
    const { t } = loadPage();
    assert.deepEqual(t.clampToBoard({ x: 999, y: 50 }, 800, 150), { x: 650, y: 50 });
    assert.deepEqual(t.clampToBoard({ x: -40, y: -10 }, 800, 150), { x: 0, y: 0 });
    // Board narrower than a pedal → maxX floors at 0.
    assert.deepEqual(t.clampToBoard({ x: 30, y: 5 }, 100, 150), { x: 0, y: 5 });
});

test('defaultSlot: padding origin; column count adapts to board width', () => {
    const { t } = loadPage();
    const s0 = t.defaultSlot(0, 1200);
    assert.equal(s0.x, 24);
    assert.equal(s0.y, 24);
    // 2nd pedal is to the right on the same row (≥2 columns at this width).
    const s1 = t.defaultSlot(1, 1200);
    assert.ok(s1.x > s0.x);
    assert.equal(s1.y, s0.y);
    // Number of columns = index where the row first wraps. Wider board → more.
    const cols = (bw) => { const y0 = t.defaultSlot(0, bw).y; let i = 1; while (i < 50 && t.defaultSlot(i, bw).y === y0) i++; return i; };
    assert.ok(cols(2200) > cols(700), 'more columns on a wider board');
    assert.ok(cols(700) >= 1);
});

test('loadLayout/saveLayout: round-trip + corruption tolerance', () => {
    const { t, store } = loadPage();
    assert.deepEqual(t.loadLayout(), {});
    t.saveLayout({ audio: { nam_tone: { x: 10, y: 20 } } });
    assert.deepEqual(t.loadLayout(), { audio: { nam_tone: { x: 10, y: 20 } } });
    assert.ok(store[t.LS_KEY]);
    // Corrupt JSON → empty object, no throw.
    store[t.LS_KEY] = '{not json';
    assert.deepEqual(t.loadLayout(), {});
});

test('saveLayout: swallows storage exceptions (quota / private mode)', () => {
    const { t } = loadPage({ throwOnSet: true });
    assert.doesNotThrow(() => t.saveLayout({ a: 1 }));
});

test('frameFor: assigns a pool skin, persists it, and sticks across calls', () => {
    const { t } = loadPage();
    const frames = {};
    const f1 = t.frameFor('alpha', frames);
    assert.ok(t.PEDAL_FRAMES.includes(f1), 'assigned skin is from the pool');
    assert.equal(frames.alpha, f1, 'assignment recorded for persistence');
    assert.equal(t.frameFor('alpha', frames), f1, 'same plugin keeps the same skin');
    // A stale/invalid saved skin (e.g. removed from the pool) is re-picked.
    frames.beta = 'gone.png';
    const f3 = t.frameFor('beta', frames);
    assert.ok(t.PEDAL_FRAMES.includes(f3), 're-picked a valid skin');
    assert.ok(t.frameUrl('pedal-002.png').startsWith('/static/v3/pedals/pedal-002.png'));
});

test('loadCollapsed/saveCollapsed: round-trip + corruption tolerance', () => {
    const { t, store } = loadPage();
    assert.deepEqual(t.loadCollapsed(), {});
    t.saveCollapsed({ audio: true });
    assert.deepEqual(t.loadCollapsed(), { audio: true });
    store[t.COLLAPSE_KEY] = '{bad';
    assert.deepEqual(t.loadCollapsed(), {});
});

test('statusInfo: ready=Installed, installing, failed, off', () => {
    const { t } = loadPage();
    assert.deepEqual(t.statusInfo({ id: 'a' }), { key: 'ready', label: 'Installed', cls: 'v3-pill-ok' });
    assert.deepEqual(t.statusInfo({ id: 'a', status: 'ready' }), { key: 'ready', label: 'Installed', cls: 'v3-pill-ok' });
    assert.deepEqual(t.statusInfo({ id: 'a', status: 'installing' }), { key: 'installing', label: 'Installing', cls: 'v3-pill-wait' });
    assert.deepEqual(t.statusInfo({ id: 'a', status: 'failed' }), { key: 'failed', label: 'Failed', cls: 'v3-pill-bad' });
    assert.deepEqual(t.statusInfo({ id: 'a', enabled: false }), { key: 'off', label: 'Off', cls: 'v3-pill-off' });
    // failed wins over enabled:false (a broken plugin is not merely "off")
    assert.equal(t.statusInfo({ id: 'a', status: 'failed', enabled: false }).key, 'failed');
    // null/undefined plugin is treated as ready, never throws
    assert.equal(t.statusInfo(null).key, 'ready');
});

test('statusSummaryText: counts every state, singular/plural, omits zero counts', () => {
    const { t } = loadPage();
    assert.equal(t.statusSummaryText([]), '0 plugins — 0 installed');
    assert.equal(t.statusSummaryText([{ id: 'a' }]), '1 plugin — 1 installed');
    assert.equal(
        t.statusSummaryText([
            { id: 'a' },
            { id: 'b', status: 'installing' },
            { id: 'c', status: 'failed' },
            { id: 'd', enabled: false },
        ]),
        '4 plugins — 1 installed — 1 installing — 1 failed — 1 off',
    );
});

test('_sortedForStatus: priority plugins first, stable within groups', () => {
    const { t } = loadPage();
    const input = [
        { id: 'zzz' }, { id: 'highway_3d' }, { id: 'aaa' },
        { id: 'input_setup' }, { id: 'note_detect' }, { id: 'mmm' },
    ];
    const out = t._sortedForStatus(input).map((p) => p.id);
    // priority plugins first (in STATUS_PRIORITY order), the rest keep their
    // incoming order (stable sort — alphabetical sorting happens upstream)
    assert.deepEqual(out, ['input_setup', 'note_detect', 'highway_3d', 'zzz', 'aaa', 'mmm']);
    // input array is not mutated
    assert.deepEqual(input.map((p) => p.id), ['zzz', 'highway_3d', 'aaa', 'input_setup', 'note_detect', 'mmm']);
});

test('statusRowsHtml: one row per plugin, priority first, empty state', () => {
    const { t } = loadPage();
    const html = t.statusRowsHtml([
        { id: 'b_plugin', name: 'B Plugin' },
        { id: 'input_setup', name: 'Input Setup', bundled: true },
    ]);
    assert.ok(html.indexOf('data-status-id="input_setup"') !== -1);
    assert.ok(html.indexOf('data-status-id="input_setup"') < html.indexOf('data-status-id="b_plugin"'));
    assert.ok(html.indexOf('>Installed<') !== -1);
    assert.ok(html.indexOf('v3-pedal-bundled-inline') !== -1);
    assert.ok(t.statusRowsHtml([]).indexOf('No plugins installed.') !== -1);
});

test('statusSectionHtml: wraps rows in a details section with a summary', () => {
    const { t } = loadPage();
    const html = t.statusSectionHtml([{ id: 'a', name: 'A' }]);
    assert.ok(html.indexOf('<details class="v3-plugin-status" id="v3-plugin-status">') !== -1);
    assert.ok(html.indexOf('1 plugin — 1 installed') !== -1);
    assert.ok(html.indexOf('<tbody>') !== -1);
});

test('DRAG_THRESHOLD is a small positive pixel budget', () => {
    const { t } = loadPage();
    assert.equal(typeof t.DRAG_THRESHOLD, 'number');
    assert.ok(t.DRAG_THRESHOLD > 0 && t.DRAG_THRESHOLD < 20);
});
