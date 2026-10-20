// Verify the onboarding calibration challenge waits for its plugins before
// launching the song: plugins register their routes on a background thread
// at startup, so the challenge step must block (bounded) on note_detect and
// rig_builder being loaded AND active before calling window.playSong.
//
// Source contracts are checked on static/v3/profile.js (LF-normalized — the
// worktree checks out CRLF on Windows); waitForChallengePlugins is also
// exercised in a vm sandbox with stubbed fetch/timers so the poll loop,
// the readiness predicate, and the timeout are all covered.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROFILE_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'profile.js');

function readProfile() {
    return fs.readFileSync(PROFILE_JS, 'utf8').replace(/\r\n/g, '\n');
}

test('profile.js declares waitForChallengePlugins with the required plugin ids', () => {
    const src = readProfile();
    assert.match(src, /function waitForChallengePlugins\(timeoutMs\)/);
    assert.match(
        src,
        /const REQUIRED = \['note_detect', 'rig_builder'\];/,
        'the challenge requires note_detect and rig_builder',
    );
});

test('readiness requires status ready and not disabled for every required plugin', () => {
    const src = readProfile();
    assert.match(src, /fetch\('\/api\/plugins'\)/);
    assert.match(
        src,
        /p\.status === 'ready' && p\.enabled !== false/,
        'a plugin counts as ready only when status is ready and enabled is not false',
    );
});

test('waitForChallengePlugins is awaited exactly once, at the challenge step', () => {
    const src = readProfile();
    const calls = src.match(/await waitForChallengePlugins\(/g) || [];
    assert.equal(calls.length, 1, 'exactly one challenge-plugin wait call');
});

test('challenge step: disable + label, wait, restore, finish, note-detector wait, then playSong', () => {
    const src = readProfile();
    // Anchor on the unique loading label, then assert the full ordering
    // inside a window around it (other steps reuse submit.disabled/textContent).
    const anchor = src.indexOf("submit.textContent = 'Loading plugins…';");
    assert.ok(anchor !== -1, 'challenge step must label the submit button while plugins load');
    const win = src.slice(Math.max(0, anchor - 200), anchor + 1200);

    const iDisable = win.indexOf('submit.disabled = true;');
    const iLabel = win.indexOf("submit.textContent = 'Loading plugins…';");
    const iWait = win.indexOf('await waitForChallengePlugins(20000);');
    const iRestore = win.indexOf("submit.textContent = 'Play it now';");
    const iFinish = win.indexOf('await finish({ launchingSong: !!target });');
    const iNd = win.indexOf('await waitForNoteDetector(10000);');
    const iPlay = win.indexOf('window.playSong(target)');

    for (const [name, idx] of [
        ['disable', iDisable], ['label', iLabel], ['plugin wait', iWait],
        ['restore', iRestore], ['finish', iFinish], ['note-detector wait', iNd],
        ['playSong', iPlay],
    ]) {
        assert.ok(idx !== -1, `challenge step must contain the ${name} step`);
    }
    assert.ok(
        iDisable < iLabel && iLabel < iWait && iWait < iRestore
            && iRestore < iFinish && iFinish < iNd && iNd < iPlay,
        'plugins must be awaited (bounded) before finish/note-detector/playSong',
    );
});

// Brace-balanced extraction so the function body survives a naive regex
// stopping at the first `}` (same technique as alpha_warning_banner.test.js).
function extractFunctionSource(src, name) {
    const sig = `function ${name}`;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `function declaration '${name}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${name}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in function '${name}'`);
    return src.slice(start, i);
}

// Manual timer queue: setInterval callbacks are captured, never auto-run,
// so the poll loop is driven deterministically by the test.
function setupSandbox({ respond }) {
    const timers = [];
    const urls = [];
    let now = 0;
    const sandbox = {
        fetch: (url) => { urls.push(url); return respond(url); },
        setInterval: (fn) => { timers.push(fn); return timers.length; },
        clearInterval: (id) => { if (id >= 1 && id <= timers.length) timers[id - 1] = null; },
        Date: { now: () => now },
    };
    vm.createContext(sandbox);
    const fnSrc = extractFunctionSource(readProfile(), 'waitForChallengePlugins');
    vm.runInContext(`${fnSrc}\nglobalThis.__wait = waitForChallengePlugins;`, sandbox);
    return {
        wait: sandbox.__wait,
        urls,
        tick: async () => {
            const fn = timers.find((f) => typeof f === 'function');
            assert.ok(fn, 'expected a pending interval timer');
            await fn();
        },
        advance: (ms) => { now += ms; },
        pendingTimers: () => timers.filter((f) => typeof f === 'function').length,
    };
}

// Flush the microtask queue so the initial ready() check inside the
// Promise executor has run before the test drives the interval manually.
const flush = () => new Promise((r) => setTimeout(r, 0));

const READY_ROWS = [
    { id: 'note_detect', status: 'ready', enabled: true },
    { id: 'rig_builder', status: 'ready', enabled: true },
];

test('resolves true when note_detect and rig_builder are ready and enabled', async () => {
    const { wait, pendingTimers } = setupSandbox({
        respond: async () => ({ ok: true, json: async () => READY_ROWS }),
    });
    const p = wait(20000);
    await flush();
    assert.equal(await p, true);
    assert.equal(pendingTimers(), 0, 'interval must be cleared once settled');
});

test('polls /api/plugins until a late plugin turns ready', async () => {
    let calls = 0;
    const { wait, tick, urls, pendingTimers } = setupSandbox({
        respond: async () => {
            calls++;
            const ready = calls >= 3;
            return {
                ok: true,
                json: async () => ([
                    { id: 'note_detect', status: ready ? 'ready' : 'installing', enabled: true },
                    { id: 'rig_builder', status: 'ready', enabled: true },
                ]),
            };
        },
    });
    const p = wait(20000);
    await flush();
    assert.ok(urls.length >= 1 && urls.every((u) => u === '/api/plugins'));
    await tick(); // second poll: still installing
    await tick(); // third poll: ready
    assert.equal(await p, true);
    assert.equal(pendingTimers(), 0);
});

test('a disabled required plugin is not ready — bounded timeout resolves false', async () => {
    const { wait, tick, advance, pendingTimers } = setupSandbox({
        respond: async () => ({
            ok: true,
            json: async () => ([
                { id: 'note_detect', status: 'ready', enabled: true },
                { id: 'rig_builder', status: 'ready', enabled: false },
            ]),
        }),
    });
    const p = wait(1000);
    let settled = null;
    p.then((v) => { settled = v; });
    await flush();
    await tick(); // t=0: disabled plugin is not ready, still pending
    assert.equal(settled, null, 'must not settle before the timeout');
    advance(1001);
    await tick(); // t>timeout: gives up so onboarding is not stuck
    assert.equal(await p, false);
    assert.equal(settled, false);
    assert.equal(pendingTimers(), 0);
});

test('a required plugin still installing times out', async () => {
    const { wait, tick, advance } = setupSandbox({
        respond: async () => ({
            ok: true,
            json: async () => ([
                { id: 'note_detect', status: 'installing', enabled: true },
                { id: 'rig_builder', status: 'ready', enabled: true },
            ]),
        }),
    });
    const p = wait(1000);
    await flush();
    await tick();
    advance(1001);
    await tick();
    assert.equal(await p, false);
});

test('a missing required plugin times out', async () => {
    const { wait, tick, advance } = setupSandbox({
        respond: async () => ({
            ok: true,
            json: async () => ([{ id: 'note_detect', status: 'ready', enabled: true }]),
        }),
    });
    const p = wait(1000);
    await flush();
    await tick();
    advance(1001);
    await tick();
    assert.equal(await p, false);
});

test('a failed /api/plugins response keeps polling and times out', async () => {
    const { wait, tick, advance } = setupSandbox({
        respond: async () => ({ ok: false, json: async () => [] }),
    });
    const p = wait(1000);
    await flush();
    await tick();
    advance(1001);
    await tick();
    assert.equal(await p, false);
});

test('a throwing fetch keeps polling and times out', async () => {
    const { wait, tick, advance } = setupSandbox({
        respond: async () => { throw new Error('network down'); },
    });
    const p = wait(1000);
    await flush();
    await tick();
    advance(1001);
    await tick();
    assert.equal(await p, false);
});

test('a non-array payload counts as not ready and times out', async () => {
    const { wait, tick, advance } = setupSandbox({
        respond: async () => ({ ok: true, json: async () => ({ error: 'nope' }) }),
    });
    const p = wait(1000);
    await flush();
    await tick();
    advance(1001);
    await tick();
    assert.equal(await p, false);
});
