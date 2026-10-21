/*
 * input_setup — per-instrument input-device selection & calibration.
 *
 * Bundled core plugin (constitution P-II vanilla JS). It:
 *  1. supplies a Web-MIDI source provider to the core `midi-input` domain;
 *  2. owns the `input-calibration` capability domain (run / status / inspect);
 *  3. renders the onboarding input-setup wizard (one pass per instrument):
 *       - guitar/bass → pick via `audio-input`, then launch note_detect's
 *         Calibration Wizard (note-detection is a deferred surface — JS API);
 *       - keys/drums  → pick via `midi-input`, then a live "play a note /
 *         hit a pad" confirmation.
 *
 * Idempotent (plugin-runtime-idempotent.v1): re-hydration is a no-op.
 */
(function () {
    'use strict';

    window.feedBack = window.feedBack || {};
    if (window.feedBackInputSetup && window.feedBackInputSetup.version === 1) return;

    const capabilities = window.feedBack.capabilities;
    const DONE_KEY = (inst) => `input_setup.done.${inst}`;
    const INSTRUMENTS = {
        guitar: { label: 'Guitar', mode: 'audio' },
        bass: { label: 'Bass', mode: 'audio' },
        keys: { label: 'Keys / Piano', mode: 'midi' },
        piano: { label: 'Keys / Piano', mode: 'midi' },
        drums: { label: 'Drums', mode: 'midi' },
    };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function _isDone(inst) { try { return window.localStorage.getItem(DONE_KEY(inst)) === '1'; } catch (_) { return false; } }
    function _markDone(inst, v) { try { if (v) window.localStorage.setItem(DONE_KEY(inst), '1'); else window.localStorage.removeItem(DONE_KEY(inst)); } catch (_) { /* private mode */ } }

    // The Web-MIDI source provider now ships built-in with the core midi-input
    // domain (static/capabilities/midi-input.js), so input_setup is a pure
    // consumer — it just discovers/selects/opens through `window.feedBack.midiInput`.

    // ── audio-input helper (guitar/bass device context) ─────────────────────
    async function _audioSources() {
        if (!capabilities || typeof capabilities.command !== 'function') return { sources: [], selected: null };
        try {
            const r = await capabilities.command('audio-input', 'list-sources', { requester: 'input_setup' });
            const p = (r && r.payload) || {};
            let sources = Array.isArray(p.sources) ? p.sources : [];
            // Exclude MIDI devices some plugins export into audio-input
            // (e.g. keys-highway-3d's pseudonymized 'midi-input-N'): they aren't
            // audio inputs and the cryptic labels confuse this guitar/bass picker.
            sources = sources.filter((s) => s
                && !/midi/i.test(String(s.providerId || ''))
                && !/^midi-input/i.test(String(s.label || '')));
            // No label de-dupe here. The audio-input capability already
            // collapses exact duplicates by logicalSourceKey
            // (_visibleInputSources), so nothing it returns shares a key. A
            // device that enumerates under several driver types (ASIO / Windows
            // Audio / DirectSound) has a DISTINCT key per type and is now
            // labelled with its driver type (e.g. "Focusrite (ASIO)") — each is
            // a real, separately-selectable input the user must be able to see.
            // The old bare-label collapse also kept whichever variant sorted
            // first, which could silently drop the one that was actually
            // `selected` below.
            const selected = sources.find((s) => s && s.selected) || null;
            return { sources, selected };
        } catch (_) { return { sources: [], selected: null }; }
    }

    // Fill a <select> with the device's supported sample rates (unique,
    // ascending). Keeps the current selection when still offered, else
    // `preferred`, else 48000 when available, else the lowest rate.
    function _renderRateOptions(sel, rates, preferred) {
        if (!sel) return;
        const previous = sel.value;
        const values = Array.from(new Set((Array.isArray(rates) ? rates : [])
            .map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
        if (!values.length) values.push(48000);
        sel.innerHTML = '';
        values.forEach((r) => {
            const opt = document.createElement('option');
            opt.value = String(r);
            opt.textContent = r + ' Hz';
            sel.appendChild(opt);
        });
        const pref = Number(preferred);
        sel.value = (previous !== '' && values.includes(Number(previous))) ? previous
            : (Number.isFinite(pref) && values.includes(pref)) ? String(pref)
            : String(values.includes(48000) ? 48000 : values[0]);
    }

    // Fill a <select> with the device's supported buffer sizes (unique,
    // ascending). Mirrors _renderRateOptions: keeps the current selection
    // when still offered, else `preferred`, else 256 when available, else
    // the lowest size. The pick is the user's choice — persisted and
    // applied as picked, no floor, no clamp.
    function _renderBufferOptions(sel, bufs, preferred) {
        if (!sel) return;
        const previous = sel.value;
        const values = Array.from(new Set((Array.isArray(bufs) ? bufs : [])
            .map(Number).filter(Number.isFinite))).sort((a, b) => a - b);
        if (!values.length) values.push(256);
        sel.innerHTML = '';
        values.forEach((b) => {
            const opt = document.createElement('option');
            opt.value = String(b);
            opt.textContent = b + ' samples';
            sel.appendChild(opt);
        });
        const pref = Number(preferred);
        sel.value = (previous !== '' && values.includes(Number(previous))) ? previous
            : (Number.isFinite(pref) && values.includes(pref)) ? String(pref)
            : String(values.includes(256) ? 256 : values[0]);
    }

    // Fill a <select> with the device's input channels, mirroring the
    // audio_engine panel's semantics: -1 = "Default pair (Mono Mix)" (or
    // "Default input" for a single channel), then 0-based channels named
    // `<name> (Input N, Ch N)`. Keeps the current selection when still
    // valid, else `preferred`, else -1.
    function _renderChannelOptions(sel, names, preferred) {
        if (!sel) return;
        const previous = sel.value;
        const list = Array.isArray(names) ? names.map(String) : [];
        const count = list.length > 0 ? list.length : 2;
        const choices = [{ value: '-1', label: count > 1 ? 'Default pair (Mono Mix)' : 'Default input' }];
        for (let i = 0; i < count; i++) {
            const name = (list[i] || '').trim();
            const ch = i + 1;
            choices.push({
                value: String(i),
                label: name ? name + ' (Input ' + ch + ', Ch ' + ch + ')' : 'Input ' + ch + ' (Ch ' + ch + ')',
            });
        }
        sel.innerHTML = '';
        choices.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c.value;
            opt.textContent = c.label;
            sel.appendChild(opt);
        });
        // NB: Number('') === 0, so an empty previous value must be rejected
        // explicitly or it would count as the valid channel 0.
        const isValid = (v) => v === '-1'
            || (v !== '' && Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) < count);
        sel.value = isValid(previous) ? previous : (isValid(preferred) ? String(preferred) : '-1');
    }

    // ── Wizard UI ────────────────────────────────────────────────────────────
    // Renders sequential per-instrument panels into `host`. Resolves the
    // returned promise to { completed:[...], skipped:[...] } when finished.
    function _runWizard(opts) {
        opts = opts || {};
        const autoCalibrate = !!opts.autoCalibrate;
        const instruments = (Array.isArray(opts.instruments) ? opts.instruments : [])
            .map((i) => String(i).toLowerCase()).filter((i) => INSTRUMENTS[i]);
        // De-dupe keys/piano (same MIDI flow under one label).
        const seen = new Set();
        const queue = instruments.filter((i) => { const k = INSTRUMENTS[i].label; if (seen.has(k)) return false; seen.add(k); return true; });

        const completed = [];
        const skipped = [];
        let idx = 0;

        return new Promise((resolve) => {
            const host = opts.host;
            if (!host) { resolve({ completed, skipped }); return; }

            function finish() {
                _emitOwner('calibration-done', { completed: completed.slice(), skipped: skipped.slice() });
                if (typeof opts.onComplete === 'function') { try { opts.onComplete({ completed, skipped }); } catch (_) {} }
                resolve({ completed, skipped });
            }
            // Per-panel teardown run on EVERY exit (Continue or the generic "Skip
            // for now"), so an opened MIDI session/listener never leaks past the
            // panel that opened it.
            let _activeCleanup = null;
            function next() {
                if (idx >= queue.length) { finish(); return; }
                renderPanel(queue[idx], autoCalibrate);
            }
            function advance(inst, didComplete) {
                if (_activeCleanup) { try { _activeCleanup(); } catch (_) {} _activeCleanup = null; }
                if (didComplete) { _markDone(inst, true); if (!completed.includes(inst)) completed.push(inst); }
                else { if (!skipped.includes(inst)) skipped.push(inst); }
                idx += 1;
                next();
            }

            function shell(inst, bodyHtml, footHtml) {
                const meta = INSTRUMENTS[inst];
                host.innerHTML =
                    '<div class="space-y-4">' +
                    '<div><div class="text-xs uppercase tracking-wider text-fb-textDim">Input setup — step ' + (idx + 1) + ' of ' + queue.length + '</div>' +
                    '<h3 class="text-lg font-bold text-fb-text mt-0.5">Set up your ' + esc(meta.label) + '</h3></div>' +
                    '<div data-is-body>' + bodyHtml + '</div>' +
                    '<div class="flex justify-between items-center pt-1">' +
                    '<button type="button" data-is-skip class="text-sm text-fb-textDim hover:text-fb-text">Skip for now</button>' +
                    '<div data-is-foot>' + (footHtml || '') + '</div></div></div>';
                host.querySelector('[data-is-skip]').addEventListener('click', () => advance(inst, false));
            }

            // ── per-instrument panels ───────────────────────────────────────
            async function renderPanel(inst, autoCalibrate) {
                const meta = INSTRUMENTS[inst];
                if (meta.mode === 'audio') return renderAudioPanel(inst, autoCalibrate);
                return renderMidiPanel(inst);
            }

            // Guitar/bass: pick the audio source (audio-input), APPLY it to the
            // native engine on desktop (device + rate + buffer + monitoring prefs,
            // persisted), confirm the guitar is audible (live meter), then launch
            // the note_detect Calibration Wizard for the deep work (noise
            // floor / signal level / open-string detection / timing).
            async function renderAudioPanel(inst, autoCalibrate) {
                const { sources, selected } = await _audioSources();
                const desktopApi = (window.feedBackDesktop && window.feedBackDesktop.audio) || null;
                const canDriveEngine = !!(desktopApi
                    && typeof desktopApi.setDevice === 'function'
                    && typeof desktopApi.startAudio === 'function');
                // The note detector plugin registers late (its screen.js is a huge
                // deferred surface), so don't test it once at render time: wait
                // (bounded) and upgrade the button in place when it lands.
                let detectorReady = !!(window.noteDetect && typeof window.noteDetect.launchCalibration === 'function');

                const sourceLabel = (key) => {
                    const s = sources.find((x) => (x.logicalSourceKey || x.sourceId) === key);
                    return s ? (s.label || 'Input') : 'Input';
                };
                const commitAudio = (key) => {
                    if (!capabilities || !key) return;
                    capabilities.command('audio-input', 'select-source', { requester: 'input_setup', payload: { logicalSourceKey: key } }).catch(() => {});
                };
                // Tell the tuner tables / note_detect which instrument this is.
                try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instrument: inst }) }); } catch (_) {}

                const normKeyPart = (s) => String(s || 'default')
                    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
                // Resolve a logical source key to the concrete driver type and
                // input/output device names, probe what that device supports
                // (sample rates, buffer sizes, input channels), and load the
                // persisted settings (flagging whether they describe THIS
                // input). Shared by the engine bind (applySourceToEngine) and
                // the fine-tune selects (refreshFineTune).
                async function _resolveSourceForKey(key) {
                    if (!canDriveEngine || !key) return null;
                    const nameMatch = /^desktop-audio:([^:]+):input:name:(.+)$/.exec(key);
                    const indexMatch = nameMatch ? null : /^desktop-audio:([^:]+):input:(\d+)$/.exec(key);
                    if (!nameMatch && !indexMatch) return null;
                    const typeKey = nameMatch ? nameMatch[1] : indexMatch[1];
                    let types = [];
                    try { types = (await desktopApi.getDeviceTypes()) || []; } catch (_) { return null; }
                    const typeInfo = types.find((t) => t && normKeyPart(t.name) === typeKey) || null;
                    if (!typeInfo || !typeInfo.name) return null;
                    const inputs = Array.isArray(typeInfo.inputs) ? typeInfo.inputs : [];
                    let inputDevice = '';
                    if (nameMatch) {
                        let decoded = '';
                        try { decoded = decodeURIComponent(nameMatch[2]); } catch (_) { decoded = ''; }
                        inputDevice = inputs.find((n) => String(n).trim() === decoded) || '';
                    } else {
                        const i = Number(indexMatch[2]);
                        inputDevice = (i >= 0 && i < inputs.length) ? inputs[i] : '';
                    }
                    if (!inputDevice) return null;
                    // Duplex on the same physical device when the driver type
                    // exposes an output under the same name.
                    const outputs = Array.isArray(typeInfo.outputs) ? typeInfo.outputs : [];
                    const outputDevice = outputs.find((n) => String(n).trim() === String(inputDevice).trim())
                        || outputs[0] || '';
                    let probe = null;
                    try {
                        probe = await desktopApi.probeDeviceOptions(typeInfo.name, inputDevice, typeInfo.name, outputDevice);
                    } catch (_) { probe = null; }
                    const rates = (probe && Array.isArray(probe.sampleRates) && probe.sampleRates.length)
                        ? probe.sampleRates.map(Number).filter(Number.isFinite) : [48000];
                    const bufs = (probe && Array.isArray(probe.bufferSizes) && probe.bufferSizes.length)
                        ? probe.bufferSizes.map(Number).filter(Number.isFinite) : [256];
                    let saved = null;
                    try { saved = await desktopApi.loadDeviceSettings(); } catch (_) { saved = null; }
                    const savedMatches = !!(saved
                        && typeof saved.input === 'string'
                        && saved.input.trim() === String(inputDevice).trim()
                        && String(saved.inputType || saved.type || '') === String(typeInfo.name));
                    return { typeInfo, inputDevice, outputDevice, probe, rates, bufs, saved, savedMatches };
                }
                // ── desktop: bind the picked source to the native engine ─────
                // Mirrors the audio_engine panel's Apply: probe the supported
                // rates/buffers, open at 48 kHz / the picked buffer size
                // (reusing the persisted rate/buffer/channel when the saved
                // config describes the same input), make monitoring audible
                // unless a saved pref says otherwise, start the engine, and
                // PERSIST so the Audio screen and every later open converge on
                // this config. `opts` carries the wizard's fine-tune picks
                // (sampleRate / bufferSize / inputChannel) and wins over the
                // saved config for this run.
                async function applySourceToEngine(key, opts) {
                    opts = opts || {};
                    const resolved = await _resolveSourceForKey(key);
                    if (!resolved) return false;
                    const { typeInfo, inputDevice, outputDevice, rates, bufs, saved, savedMatches } = resolved;
                    let sampleRate = rates.includes(48000) ? 48000 : rates[0];
                    // The buffer size is the user's explicit choice (wizard
                    // fine-tune select, Audio panel, or a persisted value) —
                    // applied and persisted as picked, no floor, no clamp.
                    // The default only kicks in when nothing valid is known.
                    let bufferSize = bufs.includes(256) ? 256 : bufs[0];
                    if (savedMatches) {
                        if (rates.includes(Number(saved.sampleRate))) sampleRate = Number(saved.sampleRate);
                        const savedBuf = Number(saved.bufferSize);
                        if (Number.isFinite(savedBuf) && bufs.includes(savedBuf)) bufferSize = savedBuf;
                    }
                    if (Number.isFinite(Number(opts.bufferSize)) && bufs.includes(Number(opts.bufferSize))) {
                        bufferSize = Number(opts.bufferSize);
                    }
                    if (Number.isFinite(Number(opts.sampleRate)) && rates.includes(Number(opts.sampleRate))) {
                        sampleRate = Number(opts.sampleRate);
                    }
                    let inputChannel = savedMatches && Number.isFinite(Number(saved.inputChannel))
                        ? Number(saved.inputChannel) : -1;
                    if (Number.isFinite(Number(opts.inputChannel))) inputChannel = Number(opts.inputChannel);
                    // Fresh profile → monitoring AUDIBLE (the native engine boots
                    // muted); a saved preference always wins.
                    const monitorMute = saved && typeof saved.monitorMute === 'boolean' ? saved.monitorMute : false;
                    const monitorKill = saved && typeof saved.monitorKill === 'boolean' ? saved.monitorKill : false;
                    const settings = {
                        type: typeInfo.name,
                        inputType: typeInfo.name,
                        outputType: typeInfo.name,
                        input: inputDevice,
                        output: outputDevice,
                        sampleRate: String(sampleRate),
                        bufferSize: String(bufferSize),
                        inputChannel: String(inputChannel),
                        monitorMute,
                        monitorKill,
                        savedAt: Date.now(),
                    };
                    const persist = async () => {
                        try {
                            if (typeof desktopApi.saveDeviceSettings === 'function') {
                                await desktopApi.saveDeviceSettings(settings);
                            }
                        } catch (_) {}
                    };
                    // If the engine already runs with exactly this device, don't
                    // tear it down (a redundant setDevice stops/starts the stream);
                    // converge the monitoring prefs and persist what is ACTUALLY
                    // bound — ASIO drivers ignore buffer changes while open.
                    try {
                        const running = typeof desktopApi.isAudioRunning === 'function'
                            ? await desktopApi.isAudioRunning() : false;
                        if (running && typeof desktopApi.getCurrentDevice === 'function') {
                            const cur = await desktopApi.getCurrentDevice();
                            const curInput = cur && cur.input ? String(cur.input) : '';
                            const curType = cur && (cur.inputType || cur.type) ? String(cur.inputType || cur.type) : '';
                            if (curInput && curInput.trim() === String(inputDevice).trim()
                                && (!curType || curType === String(typeInfo.name))) {
                                try { if (typeof desktopApi.setMonitorMute === 'function') await desktopApi.setMonitorMute(monitorMute); } catch (_) {}
                                try { if (typeof desktopApi.setMonitorKill === 'function') await desktopApi.setMonitorKill(monitorKill); } catch (_) {}
                                if (cur.output) settings.output = String(cur.output);
                                settings.input = curInput;
                                if (cur.sampleRate > 0) settings.sampleRate = String(cur.sampleRate);
                                if (cur.blockSize > 0) settings.bufferSize = String(cur.blockSize);
                                await persist();
                                return true;
                            }
                        }
                    } catch (_) { /* fall through to the full (re)bind */ }
                    let res = null;
                    try {
                        res = await desktopApi.setDevice({
                            inputType: typeInfo.name,
                            inputDevice,
                            outputType: typeInfo.name,
                            outputDevice,
                            sampleRate,
                            bufferSize,
                        });
                    } catch (_) { return false; }
                    const ok = typeof res === 'boolean' ? res : !!(res && res.ok);
                    if (!ok) return false;
                    try {
                        if (Number.isFinite(inputChannel) && typeof desktopApi.setInputChannel === 'function') {
                            await desktopApi.setInputChannel(inputChannel);
                        }
                    } catch (_) {}
                    try { if (typeof desktopApi.setMonitorMute === 'function') await desktopApi.setMonitorMute(monitorMute); } catch (_) {}
                    try { if (typeof desktopApi.setMonitorKill === 'function') await desktopApi.setMonitorKill(monitorKill); } catch (_) {}
                    try { await desktopApi.startAudio(); } catch (_) {}
                    await persist();
                    return true;
                }

                // ── sound test: live input meter + audible confirmation ──────
                let meterTimer = null;
                const stopMeter = () => { if (meterTimer) { clearInterval(meterTimer); meterTimer = null; } };
                function startMeter(barEl, msgEl) {
                    stopMeter();
                    meterTimer = setInterval(() => {
                        (async () => {
                            if (!barEl.isConnected) { stopMeter(); return; }
                            let lv = null;
                            try { lv = await desktopApi.getLevels(); } catch (_) { lv = null; }
                            const level = lv && Number.isFinite(Number(lv.inputLevel)) ? Number(lv.inputLevel) : 0;
                            barEl.style.width = Math.max(0, Math.min(100, Math.round(level * 100))) + '%';
                            if (msgEl && msgEl.isConnected) {
                                msgEl.textContent = level > 0.02
                                    ? 'Signal detected — do you hear your guitar?'
                                    : 'Play a note on your guitar…';
                            }
                        })();
                    }, 150);
                }

                // Bounded wait for the note detector; upgrades the Calibrate
                // button in place when it registers (boot load-order race).
                let detectTimer = null;
                let autoCalTimer = null;
                if (!detectorReady) {
                    const t0 = Date.now();
                    detectTimer = setInterval(() => {
                        if (window.noteDetect && typeof window.noteDetect.launchCalibration === 'function') {
                            detectorReady = true;
                            if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
                            const b = host.querySelector('[data-is-cal]');
                            if (b) b.textContent = 'Calibrate';
                            const n = host.querySelector('[data-is-detector-note]');
                            if (n) n.remove();
                            maybeAutoCalibrate();
                        } else if (Date.now() - t0 >= 10000) {
                            if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
                        }
                    }, 100);
                }
                _activeCleanup = () => {
                    if (autoCalTimer) { clearInterval(autoCalTimer); autoCalTimer = null; }
                    if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
                    stopMeter();
                };

                function onCalibrateClick() {
                    if (detectorReady && window.noteDetect && typeof window.noteDetect.launchCalibration === 'function') {
                        // Hide our own full-screen overlay while note_detect's
                        // Calibration Wizard runs on top. That wizard goes
                        // transparent (pointer-events:none) when it minimizes to
                        // expose the song highway (play-along); if our overlay
                        // stayed up it would show through — covering the highway
                        // with the still-mounted "select your input" card and
                        // looking like a second wizard at the input step. Restore
                        // it on done/cancel (one of which always fires when that
                        // wizard closes).
                        const ov = document.getElementById('input-setup-overlay');
                        const prevDisplay = ov ? ov.style.display : '';
                        if (ov) ov.style.display = 'none';
                        // Defensive: the calibration wizard minimizes to a
                        // transparent layer over the song highway for its
                        // play-along test, so while it runs a song must never
                        // render behind this overlay — keep it hidden for the
                        // whole song, not just until the wizard reports back.
                        const bus = window.feedBack;
                        const keepHiddenOnPlay = () => {
                            const o = document.getElementById('input-setup-overlay');
                            if (o) o.style.display = 'none';
                        };
                        if (bus && typeof bus.on === 'function') bus.on('song:play', keepHiddenOnPlay);
                        const restore = () => {
                            if (bus && typeof bus.off === 'function') bus.off('song:play', keepHiddenOnPlay);
                            const o = document.getElementById('input-setup-overlay');
                            if (o) o.style.display = prevDisplay;
                        };
                        window.noteDetect.launchCalibration({
                            instrument: inst,
                            onDone: () => { restore(); advance(inst, true); },
                            onCancel: () => { restore(); /* stay on this panel; user can skip or retry */ },
                        });
                    } else {
                        advance(inst, true);
                    }
                }

                // Onboarding auto-calibrate: when the caller asks for it
                // (first-run onboarding flow), start the note_detect
                // Calibration Wizard by itself as soon as the detector is
                // ready and a Calibrate button is on screen (the ready panel
                // on desktop, the picker on web). Bounded 10s wait on the
                // detector; cleaned up with the panel.
                let autoCalFired = false;
                function maybeAutoCalibrate() {
                    if (!autoCalibrate || autoCalFired || !detectorReady) return;
                    if (!host.querySelector('[data-is-cal]')) return;
                    autoCalFired = true;
                    if (autoCalTimer) { clearInterval(autoCalTimer); autoCalTimer = null; }
                    onCalibrateClick();
                }
                if (autoCalibrate && !detectorReady) {
                    const t0 = Date.now();
                    autoCalTimer = setInterval(() => {
                        if (window.noteDetect && typeof window.noteDetect.launchCalibration === 'function') {
                            detectorReady = true;
                        }
                        maybeAutoCalibrate();
                        if (autoCalFired || Date.now() - t0 >= 10000) {
                            if (autoCalTimer) { clearInterval(autoCalTimer); autoCalTimer = null; }
                        }
                    }, 100);
                }

                // Last source tried in the sound test, so the picker re-opens on
                // that choice instead of falling back to the original default.
                let lastTriedKey = null;

                // Generation guard for the async fine-tune refresh: a slow
                // probe must not fill the selects of a panel the user already
                // left (or a newer device pick).
                let fineTuneGen = 0;
                // Populate the sample-rate / buffer-size / input-channel
                // selects for the picked device. Keeps the current selection
                // when still offered; otherwise the saved value when it
                // describes this same device; otherwise 48000 Hz / 256
                // samples / the default channel.
                async function refreshFineTune(key) {
                    const gen = ++fineTuneGen;
                    const rateSel = host.querySelector('[data-is-rate]');
                    const bufSel = host.querySelector('[data-is-buffer]');
                    const chSel = host.querySelector('[data-is-channel]');
                    if (!rateSel || !bufSel || !chSel || !key) return;
                    const resolved = await _resolveSourceForKey(key);
                    if (gen !== fineTuneGen || !host.contains(rateSel) || !host.contains(bufSel) || !host.contains(chSel)) return;
                    if (!resolved) return;
                    const { probe, rates, bufs, saved, savedMatches } = resolved;
                    let preferredRate = rates.includes(48000) ? 48000 : rates[0];
                    if (savedMatches && rates.includes(Number(saved.sampleRate))) {
                        preferredRate = Number(saved.sampleRate);
                    }
                    _renderRateOptions(rateSel, rates, preferredRate);
                    let preferredBuffer = bufs.includes(256) ? 256 : bufs[0];
                    if (savedMatches && bufs.includes(Number(saved.bufferSize))) {
                        preferredBuffer = Number(saved.bufferSize);
                    }
                    _renderBufferOptions(bufSel, bufs, preferredBuffer);
                    const names = (probe && Array.isArray(probe.inputChannels)) ? probe.inputChannels : [];
                    let preferredChannel = -1;
                    if (savedMatches && Number.isFinite(Number(saved.inputChannel))) {
                        preferredChannel = Number(saved.inputChannel);
                    }
                    _renderChannelOptions(chSel, names, preferredChannel);
                }

                function renderPicker() {
                    const fallbackKey = selected ? (selected.logicalSourceKey || selected.sourceId || '') : '';
                    const shownKey = lastTriedKey || fallbackKey;
                    const opts2 = sources.map((s) => {
                        const k = s.logicalSourceKey || s.sourceId || '';
                        return '<option value="' + esc(k) + '"' + (k && k === shownKey ? ' selected' : '') + '>' + esc(s.label || 'Input') + '</option>';
                    }).join('');
                    // Desktop: the picker is a real step. Choose the interface,
                    // then test it (binds the native engine + live meter) before
                    // calibrating. Web (no native engine): keep the old flow,
                    // pick + Continue straight into the calibration wizard.
                    const testable = canDriveEngine && sources.length > 0;
                    // Fine-tune controls (sample rate + buffer size + input
                    // channel) only make sense when we can drive the native
                    // engine. The buffer size is the user's pick, persisted
                    // as chosen — no floor, no clamp.
                    const fineTuneHtml = testable
                        ? '<div class="grid grid-cols-3 gap-2 mt-2">' +
                          '<div><label class="block text-xs uppercase tracking-wider text-fb-textDim mb-1">Sample rate</label>' +
                          '<select data-is-rate class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none"></select></div>' +
                          '<div><label class="block text-xs uppercase tracking-wider text-fb-textDim mb-1">Buffer size</label>' +
                          '<select data-is-buffer class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none"></select></div>' +
                          '<div><label class="block text-xs uppercase tracking-wider text-fb-textDim mb-1">Input channel</label>' +
                          '<select data-is-channel class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none"></select></div>' +
                          '</div>'
                        : '';
                    const body =
                        '<p class="text-sm text-fb-textDim">Pick your audio input, then run the calibration to set levels, channel and latency.</p>' +
                        (sources.length
                            ? '<label class="block text-xs uppercase tracking-wider text-fb-textDim mt-3 mb-1">Audio input</label>' +
                              '<select data-is-audio class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none">' + opts2 + '</select>' +
                              fineTuneHtml
                            : '<p class="text-sm text-fb-accent mt-2">No audio input detected yet — plug in your interface, or skip and set this up later.</p>') +
                        (!detectorReady ? '<p data-is-detector-note class="text-xs text-fb-textDim mt-3">The note detector isn’t loaded here — you can calibrate later from the player.</p>' : '');
                    const foot = testable
                        ? '<button type="button" data-is-test class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">Test input</button>'
                        : '<button type="button" data-is-cal class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">' +
                          (detectorReady ? 'Calibrate' : 'Continue') + '</button>';
                    shell(inst, body, foot);

                    const sel = host.querySelector('[data-is-audio]');
                    if (sel) {
                        // Changing the dropdown only commits the choice; the
                        // "Test input" button binds the engine and starts the
                        // sound test, so a wrong pick never half-applies. The
                        // fine-tune selects follow the new device.
                        sel.addEventListener('change', () => {
                            commitAudio(sel.value);
                            refreshFineTune(sel.value);
                        });
                        // The <select> shows its first option by default, but no `change`
                        // fires for that implicit pick — so on a first run with nothing yet
                        // selected, audio-input would calibrate against the wrong/no source.
                        // Commit the shown option up-front so the displayed device is the
                        // one calibrated (idempotent if it was already selected).
                        if (!selected && !lastTriedKey) commitAudio(sel.value);
                    }
                    if (testable && sel) refreshFineTune(sel.value);
                    const testBtn = host.querySelector('[data-is-test]');
                    if (testBtn) {
                        testBtn.addEventListener('click', () => {
                            const key = sel ? sel.value : '';
                            if (!key) return;
                            commitAudio(key);
                            const rateSel = host.querySelector('[data-is-rate]');
                            const bufSel = host.querySelector('[data-is-buffer]');
                            const chSel = host.querySelector('[data-is-channel]');
                            enterTest(key, {
                                sampleRate: rateSel && rateSel.value !== '' ? Number(rateSel.value) : NaN,
                                bufferSize: bufSel && bufSel.value !== '' ? Number(bufSel.value) : NaN,
                                inputChannel: chSel && chSel.value !== '' ? Number(chSel.value) : NaN,
                            }).catch(() => {});
                        });
                    } else {
                        host.querySelector('[data-is-cal]').addEventListener('click', onCalibrateClick);
                    }
                    // Onboarding: no click needed — auto-launch as soon as a
                    // Calibrate button is on screen and the detector is ready.
                    maybeAutoCalibrate();
                }

                async function enterTest(key, opts) {
                    if (!key) { renderPicker(); return; }
                    lastTriedKey = key;
                    stopMeter();
                    commitAudio(key);
                    const body =
                        '<p class="text-sm text-fb-textDim">Testing input: <span class="text-fb-text font-medium">' + esc(sourceLabel(key)) + '</span></p>' +
                        '<p data-is-test-msg class="text-sm text-fb-textDim mt-3">Configuring the audio engine…</p>' +
                        '<div class="mt-2 h-2 rounded bg-gray-800/70 overflow-hidden"><div data-is-meter-bar class="h-full bg-fb-primary" style="width:0%"></div></div>' +
                        '<div class="mt-4"><button type="button" data-is-nosound class="text-sm text-fb-textDim hover:text-fb-text">No sound — pick another input</button></div>';
                    const foot =
                        '<button type="button" data-is-hear class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">I hear it</button>';
                    shell(inst, body, foot);
                    const msgEl = host.querySelector('[data-is-test-msg]');
                    const barEl = host.querySelector('[data-is-meter-bar]');
                    host.querySelector('[data-is-nosound]').addEventListener('click', () => { stopMeter(); renderPicker(); });
                    host.querySelector('[data-is-hear]').addEventListener('click', () => { stopMeter(); renderReady(key); });
                    const applied = await applySourceToEngine(key, opts);
                    if (!host.contains(msgEl)) return; // user moved on while applying
                    if (!applied) {
                        msgEl.innerHTML = '<span class="text-fb-accent">Couldn’t open this device — make sure it isn’t in use by another app.</span> Check the meter, then answer below.';
                    } else {
                        msgEl.textContent = 'Play a note on your guitar…';
                    }
                    if (barEl.isConnected) startMeter(barEl, applied ? msgEl : null);
                }

                function renderReady(key) {
                    const body =
                        '<p class="text-sm text-fb-textDim"><span class="text-fb-primary font-semibold">Input configured and working</span> — ' + esc(sourceLabel(key)) + ' is set as your audio input.</p>' +
                        '<p class="text-sm text-fb-textDim mt-2">Next, run the calibration: it tunes your guitar, measures the noise floor and sets levels, channel and latency.</p>' +
                        (!detectorReady ? '<p data-is-detector-note class="text-xs text-fb-textDim mt-3">The note detector isn’t loaded here — you can calibrate later from the player.</p>' : '');
                    const foot =
                        '<button type="button" data-is-cal class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">' +
                        (detectorReady ? 'Calibrate' : 'Continue') + '</button>';
                    shell(inst, body, foot);
                    host.querySelector('[data-is-cal]').addEventListener('click', onCalibrateClick);
                    maybeAutoCalibrate();
                }

                renderPicker();
            }

            // Keys/drums: pick a MIDI device via midi-input and confirm a live hit.
            async function renderMidiPanel(inst) {
                const mi = window.feedBack.midiInput;
                // Availability is the midi-input DOMAIN being present, not the
                // Web-MIDI browser API — the domain coordinates providers (the
                // built-in Web-MIDI one, plus any native/desktop adapter), so
                // gating on navigator.requestMIDIAccess would hide a usable
                // non-Web-MIDI provider before discover() is ever called.
                const midiAvailable = !!(mi && mi.version === 1);
                if (!midiAvailable) {
                    shell(inst,
                        '<p class="text-sm text-fb-accent">MIDI input isn’t available here. Connect a MIDI keyboard/e-kit in a supported environment, or skip for now.</p>',
                        '<button type="button" data-is-skip2 class="bg-fb-primary hover:bg-fb-primaryHi text-white px-5 py-2 rounded-md font-medium">Continue</button>');
                    host.querySelector('[data-is-skip2]').addEventListener('click', () => advance(inst, false));
                    return;
                }
                const verb = inst === 'drums' ? 'hit a pad' : 'play a note';
                shell(inst,
                    '<p class="text-sm text-fb-textDim">Connect your MIDI device, pick it below, then ' + verb + ' to confirm it’s working.</p>' +
                    '<div class="mt-3 flex items-center gap-2">' +
                    '<button type="button" data-is-scan class="text-sm text-fb-primary hover:text-fb-primaryHi">Scan for MIDI devices</button></div>' +
                    '<div data-is-midi-wrap class="hidden mt-2">' +
                    '<select data-is-midi class="w-full bg-gray-800/50 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-fb-text outline-none"></select>' +
                    '<p data-is-test class="text-sm text-fb-textDim mt-2">Waiting for input…</p></div>',
                    '<button type="button" data-is-next disabled class="bg-fb-primary disabled:opacity-40 text-white px-5 py-2 rounded-md font-medium">Continue</button>');

                const wrap = host.querySelector('[data-is-midi-wrap]');
                const select = host.querySelector('[data-is-midi]');
                const testEl = host.querySelector('[data-is-test]');
                const nextBtn = host.querySelector('[data-is-next]');
                let activeKey = null;
                let listener = null;
                let activeHandle = null;
                let openSeq = 0;

                async function openSelected() {
                    // Tear down the previous device + RESET the confirmation
                    // state, so a hit on a prior device can't leave Continue
                    // enabled for a newly-selected device that hasn't been heard.
                    const myGen = ++openSeq;
                    if (activeHandle && listener) { try { activeHandle.removeListener(listener); } catch (_) {} }
                    if (activeKey) { try { mi.close({ requester: 'input_setup', logicalSourceKey: activeKey }); } catch (_) {} }
                    activeHandle = null;
                    listener = null;
                    nextBtn.disabled = true;
                    _markDone(inst, false);
                    // Capture the requested key in a local: a newer openSelected()
                    // overwrites the shared `activeKey`, so comparing it after the
                    // awaits would let a stale open bind the wrong device.
                    const requestedKey = select.value;
                    activeKey = requestedKey;
                    if (!requestedKey) { testEl.textContent = ''; return; }
                    testEl.textContent = 'Waiting for input…';
                    await mi.select(requestedKey);
                    const res = await mi.open({ requester: 'input_setup', logicalSourceKey: requestedKey });
                    // Discard a stale open if a newer openSelected() superseded us.
                    if (myGen !== openSeq) { try { if (res) mi.close({ requester: 'input_setup', logicalSourceKey: requestedKey }); } catch (_) {} return; }
                    if (!res || !res.handle) { testEl.textContent = 'Could not open this device.'; activeKey = null; return; }
                    activeHandle = res.handle;
                    listener = (data) => {
                        // 0x90 = note-on (any channel); velocity > 0.
                        if (data && (data[0] & 0xf0) === 0x90 && data[2] > 0) {
                            testEl.innerHTML = '<span class="text-fb-primary font-semibold">✓ Got it</span> — device is working.';
                            nextBtn.disabled = false;
                            _markDone(inst, true);
                        }
                    };
                    activeHandle.addListener(listener);
                }

                host.querySelector('[data-is-scan]').addEventListener('click', async () => {
                    await mi.discover();
                    // Show every source the midi-input domain surfaces — not just
                    // the built-in Web-MIDI provider — so a native/desktop MIDI
                    // adapter registered with the domain is selectable too.
                    const sources = window.feedBack.midiInput.listSources() || [];
                    if (!sources.length) { testEl && (testEl.textContent = ''); wrap.classList.remove('hidden'); select.innerHTML = '<option>No MIDI devices found</option>'; select.disabled = true; return; }
                    wrap.classList.remove('hidden');
                    select.disabled = false;
                    select.innerHTML = sources.map((s) => '<option value="' + esc(s.logicalSourceKey) + '"' + (s.selected ? ' selected' : '') + '>' + esc(s.label) + '</option>').join('');
                    openSelected();
                });
                select.addEventListener('change', openSelected);
                // Close the open session/listener on ANY exit (Continue or the
                // generic Skip), so a scanned+selected device doesn't keep its
                // Web-MIDI input live after the panel advances.
                _activeCleanup = () => {
                    if (activeHandle && listener) { try { activeHandle.removeListener(listener); } catch (_) {} }
                    if (activeKey) { try { mi.close({ requester: 'input_setup', logicalSourceKey: activeKey }); } catch (_) {} }
                    activeHandle = null; listener = null; activeKey = null;
                };
                nextBtn.addEventListener('click', () => advance(inst, true));
            }

            _emitOwner('calibration-started', { instruments: queue.slice() });
            next();
        });
    }

    function _emitOwner(event, detail) {
        try { capabilities && capabilities.emitEvent && capabilities.emitEvent('input-calibration', event, detail || {}); } catch (_) {}
    }

    // ── input-calibration owner domain ───────────────────────────────────────
    function _statusPayload(instruments) {
        const list = (Array.isArray(instruments) && instruments.length ? instruments : Object.keys(INSTRUMENTS))
            .map((i) => String(i).toLowerCase());
        const status = {};
        list.forEach((i) => { if (INSTRUMENTS[i]) status[i] = _isDone(i) ? 'done' : 'needs-setup'; });
        return status;
    }

    if (capabilities && typeof capabilities.registerOwner === 'function') {
        capabilities.registerOwner('input-calibration', {
            pluginId: 'input_setup',
            kind: 'command',
            safety: 'safe',
            commands: ['run', 'status', 'inspect'],
            events: ['calibration-started', 'calibration-done', 'calibration-skipped'],
            description: 'Per-instrument input-setup wizard workflow (audio via audio-input + note_detect; MIDI via midi-input).',
            handlers: {
                inspect: () => ({ outcome: 'handled', payload: { available: true, status: _statusPayload() } }),
                status: (ctx) => ({ outcome: 'handled', payload: { status: _statusPayload((ctx.payload || {}).instruments) } }),
                // `run` is fire-and-launch: an interactive wizard far exceeds the
                // ~250ms handler timeout, so it starts the overlay and returns
                // immediately. Completion is signaled by the `calibration-done`
                // event (mirrors audio-monitoring `start`). A second `run` while
                // one is open is a no-op (single overlay).
                run: (ctx) => {
                    const instruments = ((ctx.payload || {}).instruments) || [];
                    // Onboarding passes autoCalibrate so the calibration
                    // wizard launches by itself once the input is tested;
                    // Settings re-entry never does.
                    const autoCalibrate = !!((ctx.payload || {}).autoCalibrate);
                    if (!document.getElementById('input-setup-overlay')) launch(instruments, { autoCalibrate });
                    return { outcome: 'handled', payload: { started: true, instruments } };
                },
            },
        });
    }

    // ── public surface (onboarding + Settings re-entry) ──────────────────────
    function mount(container, options) {
        options = options || {};
        return _runWizard({ host: container, instruments: options.instruments || [], autoCalibrate: !!options.autoCalibrate, onComplete: options.onComplete, onSkip: options.onSkip });
    }

    function launch(instruments, opts) {
        const overlay = document.createElement('div');
        overlay.id = 'input-setup-overlay';
        overlay.className = 'fixed inset-0 z-[210] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4';
        overlay.innerHTML = '<div class="bg-fb-card rounded-xl border border-fb-border/50 w-full max-w-lg p-6" data-is-host></div>';
        document.body.appendChild(overlay);
        const host = overlay.querySelector('[data-is-host]');
        return _runWizard({ host, instruments: instruments || [], autoCalibrate: !!(opts && opts.autoCalibrate) }).then((r) => { overlay.remove(); return r; });
    }

    window.feedBackInputSetup = {
        version: 1,
        mount,
        launch,
        status: (instruments) => _statusPayload(instruments),
    };

    // Settings-panel re-entry (settings.html "Set up input devices" button).
    // Re-runs the wizard for the player's selected instrument paths, falling
    // back to all instruments when progression isn't available.
    window._inputSetupRelaunch = async function () {
        let instruments = [];
        try {
            const r = await fetch('/api/progression');
            if (r.ok) {
                const d = await r.json();
                const paths = Array.isArray(d.paths) ? d.paths : [];
                instruments = paths.map((p) => (typeof p === 'string' ? p : (p && p.id))).filter(Boolean);
            }
        } catch (_) { /* offline — fall back below */ }
        if (!instruments.length) instruments = ['guitar', 'bass', 'keys', 'drums'];
        launch(instruments);
    };
})();
