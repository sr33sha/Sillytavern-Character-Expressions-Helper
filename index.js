// ST-Expressions-Helper — uses SillyTavern.getContext() exclusively, no named imports

const MODULE_NAME = 'expressions_helper';
const _scriptSrc = document.currentScript?.src ?? '';
const EXT_PATH = _scriptSrc
    ? _scriptSrc.replace(/^.*\/scripts\/extensions\//, '').replace(/\/index\.js$/, '')
    : 'third-party/Sillytavern-Character-Expressions-Helper';

let sendExpressionCall = null;
let lastMessage = null;
let lastSpriteUrl = null;
let keepaliveTimer = null;
let spriteObserver = null;
let expressionHolderEl = null;
let chatChangeSeq = 0; // incremented on every CHAT_CHANGED to invalidate stale async ops
let currentFormMap = {}; // { B: 'god_form', C: 'demon_form', ... } — rebuilt per chat open

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    extensionSettings[MODULE_NAME] ??= {};
    const s = extensionSettings[MODULE_NAME];
    s.enabled ??= true;
    s.perCharForms ??= {};
    return s;
}

function getCharAvatar() {
    const { characterId, characters } = SillyTavern.getContext();
    if (characterId === undefined) return null;
    return characters?.[characterId]?.avatar ?? null;
}

function getCharForms(avatar) {
    const s = getSettings();
    s.perCharForms[avatar] ??= { formB: '', formC: '', formD: '' };
    const f = s.perCharForms[avatar];
    f.formB ??= '';
    f.formC ??= '';
    f.formD ??= '';
    return f;
}

function updateFormInputs(avatar) {
    const f = avatar ? getCharForms(avatar) : { formB: '', formC: '', formD: '' };
    const bEl = document.getElementById('expressions_helper_form_b');
    const cEl = document.getElementById('expressions_helper_form_c');
    const dEl = document.getElementById('expressions_helper_form_d');
    if (bEl) bEl.value = f.formB;
    if (cEl) cEl.value = f.formC;
    if (dEl) dEl.value = f.formD;
}

function editDistance(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => {
        const row = new Array(n + 1).fill(0);
        row[0] = i;
        return row;
    });
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function fuzzyMatchLabel(raw, labels) {
    if (!raw || labels.length === 0) return null;
    // 1. Exact match
    if (labels.includes(raw)) return raw;
    // 2. Case-insensitive exact
    const lower = raw.toLowerCase();
    const ci = labels.find(l => l.toLowerCase() === lower);
    if (ci) return ci;
    // 3. Edit distance ≤ 2  OR  shared prefix ≥ 4 chars covering ≥ 60% of the shorter word
    //    Covers: anger→angry (dist 2), annoyance→annoyed (prefix "annoy" = 5/7 = 71%), surprise→surprised (dist 1)
    let best = null, bestDist = Infinity;
    for (const l of labels) {
        const ll = l.toLowerCase();
        const dist = editDistance(lower, ll);
        let lcp = 0;
        while (lcp < lower.length && lcp < ll.length && lower[lcp] === ll[lcp]) lcp++;
        const minLen = Math.min(lower.length, ll.length);
        const lcpMatch = lcp >= 4 && lcp / minLen >= 0.6;
        if (dist <= 2 || lcpMatch) {
            if (dist < bestDist) { bestDist = dist; best = l; }
        }
    }
    return best; // null if nothing qualifies
}

function getFallback() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings.expressions?.fallback_expression || 'neutral';
}

function getSpriteFolderName() {
    const { characterId, characters, name2, extensionSettings } = SillyTavern.getContext();
    if (characterId === undefined) return null;
    const char = characters[characterId];
    if (!char) return null;
    const avatarKey = char.avatar.replace(/\.[^/.]+$/, '');
    const override = extensionSettings.expressionOverrides?.find(e => e.name === avatarKey);
    return override?.path ?? name2;
}

async function getAvailableLabels(folder) {
    if (!folder) return [];
    try {
        const { getRequestHeaders } = SillyTavern.getContext();
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(folder)}`, {
            headers: getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        });
        if (!result.ok) return [];
        const sprites = await result.json();
        return sprites.map(s => s.label).filter(Boolean);
    } catch {
        return [];
    }
}

async function getAutoSubfolders(charFolder) {
    if (!charFolder) return [];
    try {
        const { getRequestHeaders } = SillyTavern.getContext();
        const result = await fetch(`/api/sprites/list-subfolders?name=${encodeURIComponent(charFolder)}`, {
            headers: getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
        });
        if (!result.ok) return [];
        return await result.json(); // e.g. ['god_form', 'demon_form']
    } catch {
        return [];
    }
}

function getSubfolder(charFolder, form) {
    const sub = currentFormMap[form];
    return sub ? `${charFolder}/${sub}` : charFolder;
}

async function buildAndInjectSpriteData(folder) {
    const { setExtensionPrompt } = SillyTavern.getContext();
    const avatar = getCharAvatar();
    const forms = avatar ? getCharForms(avatar) : { formB: '', formC: '', formD: '' };
    const [labels, autoSubs] = await Promise.all([
        getAvailableLabels(folder),
        getAutoSubfolders(folder),
    ]);
    if (labels.length === 0) {
        setExtensionPrompt(MODULE_NAME, '', 0, 1);
        return;
    }

    // Build form map: manual overrides take precedence, then auto-detected subfolders fill remaining slots
    const slots = ['B', 'C', 'D'];
    const manuals = [forms.formB.trim(), forms.formC.trim(), forms.formD.trim()];
    const newFormMap = {};
    let autoIdx = 0;
    for (let i = 0; i < slots.length; i++) {
        if (manuals[i]) {
            newFormMap[slots[i]] = manuals[i];
        } else if (autoIdx < autoSubs.length) {
            newFormMap[slots[i]] = autoSubs[autoIdx++];
        }
    }
    currentFormMap = newFormMap;

    // Update detected subfolders display in UI
    const detectedEl = document.getElementById('expressions_helper_detected');
    if (detectedEl) {
        const detected = autoSubs.length > 0 ? autoSubs.join(', ') : 'none';
        detectedEl.textContent = detected;
    }

    // Fetch labels for every subfolder in parallel
    const subLabelsMap = {};
    await Promise.all(
        Object.entries(newFormMap).map(([slot, sub]) =>
            getAvailableLabels(`${folder}/${sub}`).then(lbls => { subLabelsMap[slot] = lbls; })
        )
    );

    // Build per-form injection lines
    const hasSubforms = Object.keys(newFormMap).length > 0;
    const formLines = [];

    const aLabelsStr = labels.map(l => `"${l}"`).join(', ');
    if (hasSubforms) {
        formLines.push(`Form A — base sprites (fallback; choose only when none of the specific named forms below apply to this scene): ${aLabelsStr}`);
    } else {
        formLines.push(`Form A — default: ${aLabelsStr}`);
    }

    for (const slot of slots) {
        if (!newFormMap[slot]) continue;
        const subLabels = subLabelsMap[slot] || [];
        if (subLabels.length === 0) continue; // skip empty subfolders
        const name = newFormMap[slot];
        const subLabelsStr = subLabels.map(l => `"${l}"`).join(', ');
        formLines.push(`Form ${slot} — ${name} (use when the character is in ${name} form): ${subLabelsStr}`);
    }

    const instruction = hasSubforms
        ? 'These expression strings are exact and case-sensitive. Use only a string from the chosen form\'s list above, verbatim — do not rephrase, pluralize, shorten, or modify any name. Select the form matching the character\'s current physical state, then choose an expression from THAT form\'s list only.'
        : 'These expression strings are exact and case-sensitive. Use only a string from the list above, verbatim — do not rephrase, pluralize, shorten, or modify any name.';

    const injection = `<Sprite_Data>\n${formLines.join('\n')}\n${instruction}\n</Sprite_Data>`;
    setExtensionPrompt(MODULE_NAME, injection, 0, 1);
}

async function applySprite(mes, charFolder) {
    const expMatch = mes.match(/Expression:\s*(\w+)/i);
    const formMatch = mes.match(/Form:\s*([ABCD])\b/i);
    const expressionRaw = expMatch ? expMatch[1].toLowerCase() : null;
    const form = formMatch ? formMatch[1].toUpperCase() : 'A';
    if (!expressionRaw || expressionRaw === 'null') return false;
    const targetFolder = form === 'A' ? charFolder : getSubfolder(charFolder, form);
    const labels = await getAvailableLabels(form === 'A' ? charFolder : targetFolder);
    const expression = fuzzyMatchLabel(expressionRaw, labels) ?? getFallback();
    await sendExpressionCall(targetFolder, expression);
    // Capture the sprite URL so the observer can restore it when moduleWorker clears img.src.
    // sendExpressionCall may update img.src asynchronously, so check both now and next frame.
    const captureLastUrl = () => {
        const img = document.querySelector('#expression-holder img.expression');
        if (img?.getAttribute('src')) lastSpriteUrl = img.getAttribute('src');
    };
    captureLastUrl();
    requestAnimationFrame(captureLastUrl);
    const statusEl = document.getElementById('expressions_helper_last');
    if (statusEl) statusEl.textContent = `${expression}${form !== 'A' ? ` · ${form}` : ''}`;
    return true;
}

// ─── Observer management ─────────────────────────────────────────────────────

function detachSpriteObserver() {
    if (spriteObserver) spriteObserver.disconnect();
}

function attachSpriteObserver() {
    if (!spriteObserver || !expressionHolderEl) return;
    spriteObserver.disconnect();
    spriteObserver.observe(expressionHolderEl, {
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
        childList: true,
    });
}

// ─── Keepalive ────────────────────────────────────────────────────────────────

function startKeepalive() {
    if (keepaliveTimer) return;
    keepaliveTimer = setInterval(async () => {
        if (!lastSpriteUrl || !sendExpressionCall) return;
        const img = document.querySelector('#expression-holder img.expression');
        if (!img || img.getAttribute('src')) return;
        const folder = getSpriteFolderName();
        if (!folder || !lastMessage) return;
        try { await applySprite(lastMessage, folder); } catch { /* ignore */ }
    }, 2000);
}

function stopKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

function onSpriteApplied() {
    startKeepalive();
    attachSpriteObserver();
}

// ─── Chat events ──────────────────────────────────────────────────────────────

async function onChatChanged() {
    const seq = chatChangeSeq;

    lastMessage = null;
    lastSpriteUrl = null;
    stopKeepalive();

    const { setExtensionPrompt } = SillyTavern.getContext();
    const s = getSettings();

    // Always update form inputs to reflect the newly loaded character's saved values
    updateFormInputs(getCharAvatar());

    if (!s.enabled || !getSpriteFolderName()) {
        setExtensionPrompt(MODULE_NAME, '', 0, 1);
        currentFormMap = {};
        return;
    }

    await new Promise(r => setTimeout(r, 500));
    if (seq !== chatChangeSeq) return;

    const folder = getSpriteFolderName();
    if (!folder) {
        setExtensionPrompt(MODULE_NAME, '', 0, 1);
        currentFormMap = {};
        return;
    }
    await buildAndInjectSpriteData(folder);
    if (seq !== chatChangeSeq) return;
    if (!sendExpressionCall) return;
    const { chat } = SillyTavern.getContext();
    const lastAiMsg = chat?.slice().reverse().find(m => !m.is_user);
    if (lastAiMsg?.mes) {
        try {
            const applied = await applySprite(lastAiMsg.mes, folder);
            if (seq !== chatChangeSeq) return;
            if (applied) { lastMessage = lastAiMsg.mes; onSpriteApplied(); }
        } catch (err) {
            console.error('[expressions-helper] Chat open sprite set failed:', err);
        }
    }
}

async function onMessageReceived() {
    const seq = chatChangeSeq;
    const s = getSettings();
    if (!s.enabled || !sendExpressionCall) return;
    const { characterId } = SillyTavern.getContext();
    if (characterId === undefined) return;
    // If streaming isn't done yet, wait briefly and re-check rather than bailing outright.
    // MESSAGE_RECEIVED can fire before streamingProcessor.isFinished is set.
    {
        const { streamingProcessor } = SillyTavern.getContext();
        if (streamingProcessor && !streamingProcessor.isFinished) {
            await new Promise(r => setTimeout(r, 400));
            if (seq !== chatChangeSeq) return;
            const { streamingProcessor: sp2 } = SillyTavern.getContext();
            if (sp2 && !sp2.isFinished) return;
        }
    }
    const { chat } = SillyTavern.getContext();
    if (!chat?.length) return;
    const lastAiMsg = chat.slice().reverse().find(m => !m.is_user);
    if (!lastAiMsg?.mes || lastAiMsg.mes === lastMessage) return;
    const folder = getSpriteFolderName();
    if (!folder) return;
    try {
        const applied = await applySprite(lastAiMsg.mes, folder);
        if (seq !== chatChangeSeq) return;
        if (applied) {
            lastMessage = lastAiMsg.mes;
            onSpriteApplied();
            console.debug('[expressions-helper] Sprite applied from message');
        }
    } catch (err) {
        console.error('[expressions-helper] Message sprite set failed:', err);
    }
}

(async function init() {
    try {
        const mod = await import('/scripts/extensions/expressions/index.js');
        sendExpressionCall = mod.sendExpressionCall;
        console.log('[expressions-helper] Linked to built-in expressions module');
    } catch (err) {
        console.warn('[expressions-helper] Could not link to built-in expressions module:', err);
    }

    const { eventSource, event_types, renderExtensionTemplateAsync, saveSettingsDebounced } = SillyTavern.getContext();
    const html = await renderExtensionTemplateAsync(EXT_PATH, 'settings', {});

    const left = document.getElementById('extensions_settings');
    const right = document.getElementById('extensions_settings2');
    if (left) {
        let injected = false;
        for (const drawer of left.querySelectorAll('.inline-drawer')) {
            const headerText = drawer.querySelector('.inline-drawer-header')?.textContent || '';
            if (headerText.includes('Character Expressions')) {
                drawer.insertAdjacentHTML('afterend', html);
                injected = true;
                break;
            }
        }
        if (!injected) left.insertAdjacentHTML('beforeend', html);
    } else if (right) {
        right.insertAdjacentHTML('beforeend', html);
    }

    const s = getSettings();
    const enabledEl = document.getElementById('expressions_helper_enabled');
    if (enabledEl) enabledEl.checked = s.enabled;
    // Form B/C/D inputs are populated per-character when each chat opens (updateFormInputs in onChatChanged)

    $(document)
        .on('change', '#expressions_helper_enabled', function () {
            const { setExtensionPrompt, saveSettingsDebounced: save } = SillyTavern.getContext();
            const st = getSettings();
            st.enabled = !!$(this).prop('checked');
            if (!st.enabled) setExtensionPrompt(MODULE_NAME, '', 0, 1);
            save();
        })
        .on('input', '#expressions_helper_form_b', function () {
            const { saveSettingsDebounced: save } = SillyTavern.getContext();
            const av = getCharAvatar(); if (av) getCharForms(av).formB = String($(this).val()).trim();
            save();
            const f = getSpriteFolderName(); if (f) buildAndInjectSpriteData(f);
        })
        .on('input', '#expressions_helper_form_c', function () {
            const { saveSettingsDebounced: save } = SillyTavern.getContext();
            const av = getCharAvatar(); if (av) getCharForms(av).formC = String($(this).val()).trim();
            save();
            const f = getSpriteFolderName(); if (f) buildAndInjectSpriteData(f);
        })
        .on('input', '#expressions_helper_form_d', function () {
            const { saveSettingsDebounced: save } = SillyTavern.getContext();
            const av = getCharAvatar(); if (av) getCharForms(av).formD = String($(this).val()).trim();
            save();
            const f = getSpriteFolderName(); if (f) buildAndInjectSpriteData(f);
        });

    // makeFirst: runs before ALL other CHAT_CHANGED handlers.
    eventSource.makeFirst(event_types.CHAT_CHANGED, () => {
        ++chatChangeSeq;
        lastMessage = null;
        lastSpriteUrl = null;
        currentFormMap = {};
        stopKeepalive();
        detachSpriteObserver();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => { onChatChanged(); });
    eventSource.on(event_types.MESSAGE_RECEIVED, () => { onMessageReceived(); });
    // CHARACTER_MESSAGE_RENDERED fires after streaming is fully done and the message is in the DOM.
    // Acts as a reliable fallback when MESSAGE_RECEIVED fires too early during streaming.
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => { onMessageReceived(); });

    expressionHolderEl = document.getElementById('expression-holder');
    if (expressionHolderEl) {
        spriteObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'IMG') {
                            const src = node.getAttribute('src');
                            if (src) lastSpriteUrl = src;
                        }
                    }
                    continue;
                }
                const img = expressionHolderEl.querySelector('img.expression');
                if (!img) continue;
                const src = img.getAttribute('src');
                if (src) { lastSpriteUrl = src; continue; }
                if (!lastSpriteUrl || !getSpriteFolderName()) continue;
                const st = getSettings();
                if (!st.enabled) continue;
                img.setAttribute('src', lastSpriteUrl);
            }
        });
    }

    console.log('[expressions-helper] Character Expressions Helper v2 initialized');
    onChatChanged();
})();
