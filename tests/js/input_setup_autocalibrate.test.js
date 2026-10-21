// input_setup/screen.js: the onboarding flow passes autoCalibrate so the
// note_detect Calibration Wizard launches by itself once the input test
// passed (desktop) or the Calibrate button is shown (web) — no click needed.
// While that wizard runs (it minimizes to a transparent layer over the song
// highway for its play-along test), a song:play listener keeps the input-setup
// overlay hidden for the whole song, so nothing input-setup ever renders
// behind the diagnostic. Settings re-entry stays manual.
//
// Source contracts are checked on plugins/input_setup/screen.js
// (LF-normalized — the worktree checks out CRLF on Windows).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INPUT_SETUP_JS = path.join(__dirname, '..', '..', 'plugins', 'input_setup', 'screen.js');

function readInputSetup() {
    return fs.readFileSync(INPUT_SETUP_JS, 'utf8').replace(/\r\n/g, '\n');
}

test('the input-calibration run handler forwards payload.autoCalibrate', () => {
    const src = readInputSetup();
    assert.ok(src.includes('const autoCalibrate = !!((ctx.payload || {}).autoCalibrate);'),
        'the run handler reads autoCalibrate from the command payload');
    assert.ok(src.includes('launch(instruments, { autoCalibrate })'),
        'the overlay launch carries the flag');
});

test('launch/mount/_runWizard thread the autoCalibrate option', () => {
    const src = readInputSetup();
    assert.ok(src.includes('function launch(instruments, opts) {'), 'launch takes opts');
    assert.ok(src.includes('autoCalibrate: !!(opts && opts.autoCalibrate)'), 'launch threads the flag');
    assert.ok(src.includes('autoCalibrate: !!options.autoCalibrate'), 'mount threads the flag');
    assert.ok(src.includes('const autoCalibrate = !!opts.autoCalibrate;'), '_runWizard reads the flag');
    assert.ok(src.includes('renderPanel(queue[idx], autoCalibrate);'), 'panels receive the flag');
    assert.ok(src.includes('renderAudioPanel(inst, autoCalibrate)'), 'the audio panel receives the flag');
});

test('autoCalibrate waits (bounded) for the detector, then launches by itself', () => {
    const src = readInputSetup();
    assert.ok(src.includes('function maybeAutoCalibrate()'), 'the auto-launch helper exists');
    assert.ok(src.includes('if (!autoCalibrate || autoCalFired || !detectorReady) return;'),
        'only fires once, only when the detector is ready');
    assert.ok(src.includes("if (!host.querySelector('[data-is-cal]')) return;"),
        'only fires when a Calibrate button is on screen');
    assert.ok(src.includes('if (autoCalibrate && !detectorReady) {'), 'bounded wait arms only when needed');
    assert.ok(src.includes('autoCalTimer = setInterval('), 'the wait is a bounded interval');
    assert.ok(src.includes('Date.now() - t0 >= 10000'), 'the wait is bounded to 10s');
    assert.ok(src.includes('onCalibrateClick();'), 'fires the same path as the button click');
    // Call sites: detector-ready poll, the autoCal interval, the picker (web), the ready panel (desktop).
    assert.equal((src.match(/maybeAutoCalibrate\(\);/g) || []).length, 4, 'all four trigger points call it');
    // Cleaned up with the panel.
    const cleanup = src.indexOf('_activeCleanup = () => {');
    assert.ok(cleanup !== -1);
    const cleanupBlock = src.slice(cleanup, cleanup + 300);
    assert.ok(cleanupBlock.includes('if (autoCalTimer) { clearInterval(autoCalTimer); autoCalTimer = null; }'),
        'the panel cleanup clears the autoCal timer');
});

test('while the calibration wizard runs, song:play keeps the overlay hidden', () => {
    const src = readInputSetup();
    const start = src.indexOf('function onCalibrateClick() {');
    assert.ok(start !== -1);
    const end = src.indexOf('// Onboarding auto-calibrate', start);
    assert.ok(end !== -1);
    const block = src.slice(start, end);
    assert.ok(block.includes("bus.on('song:play', keepHiddenOnPlay)"), 'the song:play listener is attached');
    assert.ok(block.includes("bus.off('song:play', keepHiddenOnPlay)"), 'the listener is detached on restore');
    assert.ok(block.includes("if (o) o.style.display = 'none';"), 'a playing song forces the overlay hidden');
    // The listener only lives while the wizard runs: restore (done/cancel) detaches it.
    assert.ok(block.indexOf("bus.on('song:play'") < block.indexOf('window.noteDetect.launchCalibration({'),
        'the listener is attached before the wizard launches');
    assert.ok(block.includes('onDone: () => { restore(); advance(inst, true); }'),
        'done restores (and detaches)');
    assert.ok(block.includes('onCancel: () => { restore();'),
        'cancel restores (and detaches)');
});

test('Settings re-entry stays manual (no autoCalibrate)', () => {
    const src = readInputSetup();
    const start = src.indexOf('window._inputSetupRelaunch = async function () {');
    assert.ok(start !== -1);
    const block = src.slice(start);
    assert.ok(block.includes('launch(instruments);'), 'Settings re-launch passes no options');
    assert.ok(!block.includes('autoCalibrate'), 'no auto-launch from Settings');
});
