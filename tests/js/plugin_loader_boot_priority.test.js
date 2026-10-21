// Guards the boot-load priority in static/js/plugin-loader.js: at startup the
// sequential screen/script injection loop must hydrate the plugins the user
// needs first — input_setup, input_settings (reserved), note_detect,
// rig_builder, highway_3d — before everything else, while the nav dropdown
// and the settings panels keep their alphabetical order.
//
// The injection loop is one large async closure (it depends on loadedScripts,
// the DOM-wipe reconciliation, and per-plugin awaits), so a faithful
// behavioural harness would need to stub the whole loader. Like
// plugin_loader_script_type.test.js, this asserts the *structural* contract
// in source: the priority list exists with the right ids in the right order,
// the load order is derived from it via a stable non-mutating sort, the
// injection loop iterates over it, and the alphabetical sort feeding the nav
// is untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_LOADER_JS = path.join(__dirname, '..', '..', 'static', 'js', 'plugin-loader.js');
const src = fs.readFileSync(PLUGIN_LOADER_JS, 'utf8');

// Parse the BOOT_LOAD_PRIORITY array literal out of the source so the test
// fails if the list is edited without updating the expectation.
function bootPriorityList() {
    const m = src.match(/const BOOT_LOAD_PRIORITY = \[([\s\S]*?)\];/);
    assert.ok(m, 'BOOT_LOAD_PRIORITY array not found — loader moved?');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('BOOT_LOAD_PRIORITY lists the startup-critical plugins in priority order', () => {
    assert.deepEqual(bootPriorityList(), [
        'input_setup',
        'input_settings',
        'note_detect',
        'rig_builder',
        'highway_3d',
    ]);
});

test('_bootLoadOrder is a stable, non-mutating sort keyed on the priority rank', () => {
    assert.match(src, /function _bootLoadOrder\(plugins\) \{/);
    const body = src.slice(src.indexOf('function _bootLoadOrder(plugins)'));
    // slice() before sort(): the incoming (nav-source) array is never mutated.
    assert.match(body, /plugins\.slice\(\)\.sort\(/);
    // unknown ids rank after every prioritized plugin
    assert.match(body, /BOOT_LOAD_PRIORITY\.length/);
});

test('the injection loop iterates over the prioritized load order', () => {
    // loadOrder is derived from the alphabetically-sorted `plugins`…
    assert.match(src, /const loadOrder = _bootLoadOrder\(plugins\);/);
    // …and the screen/script injection loop follows it (not `plugins`).
    assert.match(src, /for \(const plugin of loadOrder\) \{/);
    assert.equal(src.includes('for (const plugin of plugins) {'), false,
        'the injection loop must not iterate over the alphabetical array anymore');
});

test('the nav keeps its alphabetical order (built from `plugins`, not loadOrder)', () => {
    // The alphabetical sort feeding `plugins` is still in place…
    assert.match(src, /plugins = fetchedPlugins\.slice\(\)\.sort\(\(a, b\) => \{/);
    // …and the nav dropdown is built from `plugins`.
    assert.match(src, /const navPlugins = plugins\.map\(plugin => \(\{ plugin, nav: _pluginNav\(plugin\) \}\)\)/);
    // loadOrder is computed AFTER the alphabetical sort so the fallback group
    // stays alphabetical.
    const sortAt = src.indexOf('plugins = fetchedPlugins.slice().sort((a, b) => {');
    const orderAt = src.indexOf('const loadOrder = _bootLoadOrder(plugins);');
    assert.ok(orderAt > sortAt, 'loadOrder must be derived after the alphabetical sort');
});
