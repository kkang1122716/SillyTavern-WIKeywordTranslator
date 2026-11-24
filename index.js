// WI Keyword Translator — adds translated trigger keywords (green-light keys) to World Info entries.
// Free mode uses SillyTavern's built-in translate endpoints (Google/Bing, 0 LLM tokens).
// AI mode sends keywords + entry titles (+ optional content snippet, off by default) to the chosen connection.
// Chat finder (button only, never automatic) sends a recent-chat excerpt + entry titles/keywords to AI.

const MODULE = 'wi_keyword_translator';
const UNDO_KEY = 'wikt_undo_v1';
const MAX_UNDO = 10;

const LANGS = [
    { code: 'zh-CN', label: '중국어 간체', en: 'Simplified Chinese' },
    { code: 'zh-TW', label: '중국어 번체', en: 'Traditional Chinese' },
    { code: 'en', label: '영어', en: 'English' },
    { code: 'ja', label: '일본어', en: 'Japanese' },
    { code: 'ko', label: '한국어', en: 'Korean' },
];
const langLabel = (code) => (code === 'chat' ? '채팅 속 표기' : LANGS.find((l) => l.code === code)?.label ?? code);
const langEn = (code) => LANGS.find((l) => l.code === code)?.en ?? code;

const PROVIDERS = {
    google: 'Google 번역 (무료 · 토큰 0)',
    bing: 'Bing 번역 (무료 · 토큰 0)',
    ai: 'AI 번역 (토큰 소모)',
};

const DEFAULT_RULES = [
    '아래는 롤플레이 로어북(월드인포)의 트리거 키워드야. 롤플레이 본문에서 실제로 쓰일 표기로 번역해.',
    '- 인물·문파·지명·무공·물건 같은 고유명사는 소리만 옮기지 말고, 그 언어권에서 자연스럽게 쓰는 정식 표기(동아시아 이름은 알맞은 한자)로 써.',
    '- 엔트리 제목/내용은 뜻을 고르기 위한 참고용이야. 그 자체는 번역하지 마.',
    '- 가장 좋은 표기 하나만 주고, 흔히 쓰이는 다른 표기가 있을 때만 하나 더 줘.',
    '- 이미 목표 언어로 된 키워드는 그대로 돌려줘.',
].join('\n');

const AI_SYSTEM = 'You are a precise translation engine for roleplay lorebook keywords. Output only valid JSON.';

// Recommended speed values (safe for free translators and most API rate limits)
const SPEED_DEFAULTS = Object.freeze({
    freeBatch: 30,      // keywords per Google/Bing request
    freeDelay: 500,     // ms between Google/Bing requests
    aiBatch: 30,        // keywords per AI request
    aiDelay: 1500,      // ms between AI requests
    chatEntries: 60,    // entries per chat-finder request
});

const defaultSettings = Object.freeze({
    langs: ['zh-CN'],
    provider: 'google',
    includeSecondary: false,
    aiHint: '',
    aiProfile: '',      // '' = current connection
    aiRules: '',        // '' = DEFAULT_RULES
    contentChars: 0,    // 0 = don't send entry content
    verifyBack: false,
    backProvider: 'free', // 'free' (Google/Bing) | 'ai'
    verifyCompare: false,
    chatMsgs: 30,
    chatChars: 8000,
    diagMsgs: 100,      // recent messages checked by the diagnose tab
    diagScope: 'added', // 'added' (only keywords this extension added) | 'all'
    diagSecondary: false,
    ...SPEED_DEFAULTS,
    wiButton: true,
});

const ctx = () => SillyTavern.getContext();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clampInt(v, min, max, def) {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaultSettings);
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(defaultSettings[k]);
    }
    return s;
}
const save = () => ctx().saveSettingsDebounced();

// ---------- small DOM helper (textContent only, no innerHTML from data) ----------
function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k === 'value') n.value = v;
        else if (k === 'checked') n.checked = !!v;
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
        if (c == null || c === false) continue;
        n.append(c instanceof Node ? c : String(c));
    }
    return n;
}

// ---------- keyword helpers ----------
const RE_HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const RE_KANA = /[぀-ヿ]/;
const RE_HAN = /[㐀-䶿一-鿿豈-﫿]/;
const RE_LATIN = /[A-Za-z]/;
const RE_LETTER = /\p{L}/u;

const norm = (s) => String(s ?? '').trim().toLowerCase();
const normLoose = (s) => norm(s).replace(/[\s\-_'’·.]/g, '');
const isRegexKey = (k) => /^\/[\s\S]+\/[dgimsuvy]*$/.test(String(k).trim());

/** True when the keyword is already written in the target language, so translating it is pointless. */
function alreadyInLang(kw, lang) {
    switch (lang) {
        case 'ko': return RE_HANGUL.test(kw);
        case 'ja': return RE_KANA.test(kw);
        case 'en': return RE_LATIN.test(kw) && !RE_HANGUL.test(kw) && !RE_HAN.test(kw) && !RE_KANA.test(kw);
        default: return false; // zh: still run, so 華山派 → 华山派 (simplified/traditional) gets added
    }
}

/** Language of a source keyword, used as the back-translation target. */
function detectLang(kw) {
    if (RE_HANGUL.test(kw)) return 'ko';
    if (RE_KANA.test(kw)) return 'ja';
    if (RE_HAN.test(kw)) return 'zh-CN';
    return 'en';
}

function cleanResult(s) {
    return String(s ?? '')
        .replace(/^[\s"'“”‘’「」『』《》【】]+|[\s"'“”‘’「」『』《》【】。．.,，、!！?？]+$/g, '')
        .trim();
}

const splitInput = (s) => String(s ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const entryTitle = (e) => (e.comment || (e.key || [])[0] || `#${e.uid}`).toString();

// ---------- chat text ----------
function chatMessages() {
    return (ctx().chat || []).filter((m) => !m.is_system && m.mes).map((m) => String(m.mes));
}
/** Latest N messages, trimmed to a char budget (newest kept first). */
function chatExcerpt() {
    const s = getSettings();
    const msgs = chatMessages().slice(-clampInt(s.chatMsgs, 1, 500, 30));
    let budget = clampInt(s.chatChars, 500, 100000, 8000);
    const out = [];
    for (let i = msgs.length - 1; i >= 0 && budget > 0; i--) {
        const m = msgs[i].length > budget ? msgs[i].slice(-budget) : msgs[i];
        out.unshift(m);
        budget -= m.length;
    }
    return out.join('\n\n');
}
function countHits(hayLower, needle) {
    const n = norm(needle);
    if (!n || !hayLower) return 0;
    let c = 0, i = 0;
    while ((i = hayLower.indexOf(n, i)) !== -1) { c++; i += n.length; }
    return c;
}

// ---------- free translation (Google / Bing via ST server) ----------
async function freeTranslateOne(provider, text, lang) {
    const res = await fetch(`/api/translate/${provider}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ text, lang }),
    });
    if (!res.ok) throw new Error(`${provider === 'bing' ? 'Bing' : 'Google'} 번역 실패 (HTTP ${res.status}) — 너무 빨리 보냈을 수 있어요. 설정 탭에서 딜레이를 늘려 보세요.`);
    return await res.text();
}

/**
 * Translates many short texts with few requests: newline-joined batches, per-item fallback only when
 * the line count doesn't match. Waits between requests; on an error waits longer and retries once,
 * then gives up (no hammering). Writes into `out` (Map text → [result]) so partial results survive.
 */
async function freeTranslate(provider, texts, lang, progress, isCancelled, out = new Map()) {
    const s = getSettings();
    const batch = clampInt(s.freeBatch, 1, 50, SPEED_DEFAULTS.freeBatch);
    const delay = clampInt(s.freeDelay, 0, 30000, SPEED_DEFAULTS.freeDelay);
    const chunks = [];
    let cur = [], len = 0;
    for (const t of texts) {
        if (cur.length && (len + t.length > 1500 || cur.length >= batch)) { chunks.push(cur); cur = []; len = 0; }
        cur.push(t); len += t.length + 1;
    }
    if (cur.length) chunks.push(cur);

    let first = true;
    const call = async (text) => {
        if (!first) await sleep(delay);
        first = false;
        try {
            return await freeTranslateOne(provider, text, lang);
        } catch (e) {
            console.warn('[WIKT] request failed, retrying once', e);
            await sleep(Math.max(3000, delay * 4));
            if (isCancelled()) throw e;
            return await freeTranslateOne(provider, text, lang);
        }
    };

    for (const chunk of chunks) {
        if (isCancelled()) break;
        if (chunk.length === 1) {
            out.set(chunk[0], [await call(chunk[0])]);
        } else {
            const lines = (await call(chunk.join('\n'))).split(/\r?\n/).filter((l) => l.trim() !== '');
            if (lines.length === chunk.length) {
                chunk.forEach((t, i) => out.set(t, [lines[i]]));
            } else {
                for (const t of chunk) {
                    if (isCancelled()) break;
                    out.set(t, [await call(t)]);
                }
            }
        }
        progress(chunk.length);
    }
    return out;
}

/** need: Map(lang → Map(text → entry)); fills out: Map(`${lang}\0${text}` → string[]) */
async function freeTranslateNeed(provider, need, progress, isCancelled, out = new Map()) {
    for (const [l, m] of need) {
        const texts = [...m.keys()];
        if (!texts.length || isCancelled()) continue;
        const part = new Map();
        try {
            await freeTranslate(provider, texts, l, progress, isCancelled, part);
        } finally {
            for (const [t, v] of part) out.set(`${l}\0${t}`, v);
        }
    }
    return out;
}

// ---------- AI ----------
function getProfiles() {
    try {
        return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch {
        return []; // Connection Manager disabled
    }
}

/** Sends one request to the chosen connection profile, or the current connection when none is set. */
async function callAI(userPrompt, maxTokens, system = AI_SYSTEM) {
    const s = getSettings();
    const c = ctx();
    if (s.aiProfile) {
        const profile = getProfiles().find((p) => p.id === s.aiProfile);
        if (!profile) throw new Error('선택한 연결 프로필을 찾지 못했어요. 설정 탭에서 프로필을 다시 골라 주세요.');
        const res = await c.ConnectionManagerRequestService.sendRequest(
            s.aiProfile,
            [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
            maxTokens,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        return typeof res === 'string' ? res : String(res?.content ?? '');
    }
    return String(await c.generateRaw({ prompt: userPrompt, systemPrompt: system, responseLength: maxTokens }) ?? '');
}

function parseJsonLoose(s) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('AI 응답에서 JSON을 찾지 못했어요');
    return JSON.parse(s.slice(a, b + 1));
}

async function callAIJson(prompt, maxTokens, system) {
    const raw = await callAI(prompt, maxTokens, system);
    try { return parseJsonLoose(raw); } catch (e) {
        console.warn('[WIKT] AI raw output:', raw);
        throw e;
    }
}

/** Groups need-map keywords by entry and splits them into request-sized chunks. */
function buildAIChunks(need) {
    const limit = clampInt(getSettings().aiBatch, 5, 100, SPEED_DEFAULTS.aiBatch);
    const byText = new Map(); // text → entry (first one wins)
    for (const m of need.values()) for (const [t, e] of m) if (!byText.has(t)) byText.set(t, e);
    const groups = new Map(); // uid → {entry, texts}
    for (const [t, e] of byText) {
        if (!groups.has(e.uid)) groups.set(e.uid, { entry: e, texts: [] });
        groups.get(e.uid).texts.push(t);
    }
    const chunks = [];
    let cur = [], n = 0;
    for (const g of groups.values()) {
        // keep an entry's keywords together, but never let one huge entry blow past the limit
        for (let i = 0; i < g.texts.length; i += limit) {
            const piece = { entry: g.entry, texts: g.texts.slice(i, i + limit) };
            if (cur.length && n + piece.texts.length > limit) { chunks.push(cur); cur = []; n = 0; }
            cur.push(piece); n += piece.texts.length;
        }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

function buildAIPrompt(groups, langs) {
    const s = getSettings();
    const langDesc = langs.map((l) => `"${l}" (${langEn(l)})`).join(', ');
    const lines = [];
    const order = [];
    for (const g of groups) {
        lines.push('', `[Entry] ${entryTitle(g.entry).slice(0, 60)}`);
        if (s.contentChars > 0 && g.entry.content) {
            lines.push(`Content: ${String(g.entry.content).replace(/\s+/g, ' ').slice(0, s.contentChars)}`);
        }
        for (const t of g.texts) { order.push(t); lines.push(`${order.length}. ${t}`); }
    }
    const prompt = [
        `Target languages: ${langDesc}.`,
        '',
        (s.aiRules || DEFAULT_RULES).trim(),
        s.aiHint ? `\n세계관 메모: ${s.aiHint}` : '',
        '',
        'Return ONLY a JSON object, no commentary. Keys are the keyword numbers below; values map each target language code to an array of strings, like {"1": {"zh-CN": ["..."]}, "2": {...}}.',
        ...lines,
    ].join('\n');
    return { prompt, order };
}

/** need: Map(lang → Map(text → entry)); fills out: Map(`${lang}\0${text}` → string[]) */
async function aiTranslateNeed(need, progress, isCancelled, out = new Map()) {
    const delay = clampInt(getSettings().aiDelay, 0, 60000, SPEED_DEFAULTS.aiDelay);
    const langs = [...need.keys()].filter((l) => need.get(l).size);
    const chunks = buildAIChunks(need);
    for (let i = 0; i < chunks.length; i++) {
        if (isCancelled()) break;
        if (i > 0) await sleep(delay);
        const { prompt, order } = buildAIPrompt(chunks[i], langs);
        const json = await callAIJson(prompt, Math.min(8000, 400 + order.length * langs.length * 40));
        order.forEach((t, j) => {
            const row = json[String(j + 1)];
            if (!row || typeof row !== 'object') return;
            for (const l of langs) {
                if (!need.get(l).has(t)) continue;
                const v = row[l];
                out.set(`${l}\0${t}`, (Array.isArray(v) ? v : (v ? [v] : [])).map(String));
            }
        });
        progress(order.length);
    }
    return out;
}

/** Plain list translation by AI (used for back-translation). Returns Map(text → result). */
async function aiTranslateList(texts, lang, progress, isCancelled, out = new Map()) {
    const s = getSettings();
    const limit = clampInt(s.aiBatch, 5, 100, SPEED_DEFAULTS.aiBatch);
    const delay = clampInt(s.aiDelay, 0, 60000, SPEED_DEFAULTS.aiDelay);
    for (let i = 0; i < texts.length; i += limit) {
        if (isCancelled()) break;
        if (i > 0) await sleep(delay);
        const part = texts.slice(i, i + limit);
        const prompt = [
            `Translate each item literally into ${langEn(lang)} ("${lang}"). This is a back-translation check: give the plain meaning/reading a native speaker would understand, do not guess what the original was.`,
            s.aiHint ? `세계관 메모: ${s.aiHint}` : '',
            'Return ONLY a JSON object like {"1": "...", "2": "..."}.',
            '',
            ...part.map((t, j) => `${j + 1}. ${t}`),
        ].filter((x) => x !== '').join('\n');
        const json = await callAIJson(prompt, Math.min(4000, 200 + part.length * 30));
        part.forEach((t, j) => {
            const v = json[String(j + 1)];
            if (v != null) out.set(t, String(Array.isArray(v) ? v[0] : v));
        });
        progress(part.length);
    }
    return out;
}

// ---------- chat finder ----------
function buildChatPrompt(entries, excerpt) {
    const s = getSettings();
    const list = entries.map((e, i) => `E${i + 1}. ${entryTitle(e).slice(0, 60)} — keywords: ${(e.key || []).filter((k) => !isRegexKey(k)).join(', ')}`).join('\n');
    return [
        'Below is an excerpt of a roleplay and a list of lorebook entries.',
        'For each entry, list the exact strings that appear in the excerpt and refer to that entry (names, nicknames, titles, alternate spellings, or the same name in another language) but are NOT already among its keywords.',
        '- Copy each string exactly as written in the excerpt (same characters/script). Do not translate or invent.',
        '- Only clear references to that specific entry; skip generic words and pronouns.',
        '- Omit entries with nothing new.',
        s.aiHint ? `세계관 메모: ${s.aiHint}` : '',
        'Return ONLY a JSON object like {"E1": ["..."], "E4": ["..."]}.',
        '',
        'Entries:',
        list,
        '',
        'Excerpt:',
        '"""',
        excerpt,
        '"""',
    ].filter((x) => x !== '').join('\n');
}

// ---------- undo storage (only remembers which keywords were added) ----------
const lf = () => SillyTavern.libs?.localforage ?? window.localforage;
async function loadUndo() {
    try { return (await lf().getItem(UNDO_KEY)) || []; } catch { return []; }
}
async function pushUndo(rec) {
    const list = await loadUndo();
    list.unshift(rec);
    try { await lf().setItem(UNDO_KEY, list.slice(0, MAX_UNDO)); } catch (e) { console.warn('[WIKT] undo save failed', e); }
}
async function popUndo() {
    const list = await loadUndo();
    list.shift();
    try { await lf().setItem(UNDO_KEY, list); } catch { /* ignore */ }
}

// ---------- registry of keywords this extension added: { book: { "uid:field": [words] } } ----------
const ADDED_KEY = 'wikt_added_v1';
async function loadAdded() {
    try { return (await lf().getItem(ADDED_KEY)) || {}; } catch { return {}; }
}
async function updateAdded(book, words, add) {
    const reg = await loadAdded();
    const b = (reg[book] ??= {});
    for (const [uid, fields] of Object.entries(words)) {
        for (const [f, list] of Object.entries(fields)) {
            const k = `${uid}:${f}`;
            const cur = new Set(b[k] || []);
            for (const w of list) add ? cur.add(w) : cur.delete(w);
            if (cur.size) b[k] = [...cur]; else delete b[k];
        }
    }
    try { await lf().setItem(ADDED_KEY, reg); } catch (e) { console.warn('[WIKT] registry save failed', e); }
}

/** Counts matches of a /regex/ keyword (1 or 0), safely. */
function regexHit(k, text) {
    try {
        const m = String(k).trim().match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
        const flags = m[2].replace('g', '');
        return new RegExp(m[1], flags.includes('i') ? flags : `${flags}i`).test(text) ? 1 : 0;
    } catch { return 0; }
}

function syncOriginal(data, uid, field, value) {
    const oKey = field === 'key' ? 'keys' : 'secondary_keys';
    const o = data.originalData?.entries?.find?.((x) => x.uid == uid);
    if (o) o[oKey] = [...value];
}

async function saveBook(book, data) {
    const c = ctx();
    await c.saveWorldInfo(book, data, true);
    c.reloadWorldInfoEditor?.(book);
}

// ---------- main popup ----------
async function openTranslator(presetBook) {
    const c = ctx();
    const s = getSettings();
    const books = c.getWorldInfoNames();
    if (!books.length) { toastr.info('월드인포(로어북)가 하나도 없어요.'); return; }

    const state = { book: books.includes(presetBook) ? presetBook : books[0], data: null, scope: 'all', picked: new Set(), rows: [], busy: false, cancel: false, mode: 'translate' };
    const isCancelled = () => state.cancel;

    // ===== translate tab controls =====
    const bookSel = el('select', { class: 'text_pole' }, books.map((b) => el('option', { value: b, text: b })));
    bookSel.value = state.book;

    const scopeAll = el('input', { type: 'radio', name: 'wikt_scope', value: 'all', checked: true });
    const scopePick = el('input', { type: 'radio', name: 'wikt_scope', value: 'pick' });
    const filterInput = el('input', { class: 'text_pole', type: 'search', placeholder: '엔트리 검색' });
    const pickList = el('div', { class: 'wikt-picklist' });
    const pickCount = el('small', {});
    const pickBox = el('div', { class: 'wikt-pickbox', style: 'display:none' },
        el('div', { class: 'wikt-row' }, filterInput,
            el('div', { class: 'menu_button', text: '전체 선택', onclick: () => setAllPicked(true) }),
            el('div', { class: 'menu_button', text: '전체 해제', onclick: () => setAllPicked(false) }),
            pickCount),
        pickList);

    const langBoxes = LANGS.map((l) => {
        const cb = el('input', { type: 'checkbox', value: l.code, checked: s.langs.includes(l.code) });
        cb.addEventListener('change', () => { s.langs = langBoxes.filter((x) => x.checked).map((x) => x.value); save(); });
        return cb;
    });

    const provSel = el('select', { class: 'text_pole' }, Object.entries(PROVIDERS).map(([k, v]) => el('option', { value: k, text: v })));
    provSel.value = s.provider;

    const secCb = el('input', { type: 'checkbox', checked: s.includeSecondary });
    secCb.addEventListener('change', () => { s.includeSecondary = secCb.checked; save(); });

    const backCb = el('input', { type: 'checkbox', checked: s.verifyBack });
    backCb.addEventListener('change', () => { s.verifyBack = backCb.checked; save(); updateVisibility(); });
    const backSel = el('select', { class: 'text_pole wikt-inline-select' },
        el('option', { value: 'free', text: '무료 번역기로 (토큰 0)' }),
        el('option', { value: 'ai', text: 'AI로 (토큰 소모)' }));
    backSel.value = s.backProvider;
    backSel.addEventListener('change', () => { s.backProvider = backSel.value; save(); updateVisibility(); });

    const cmpCb = el('input', { type: 'checkbox', checked: s.verifyCompare });
    const cmpLabelText = el('span', {});

    const hintArea = el('textarea', { class: 'text_pole', rows: 2, placeholder: '예: 한국 무협 세계관(화산귀환풍). 인물·문파 이름은 한자 표기로.', value: s.aiHint });
    hintArea.addEventListener('input', () => { s.aiHint = hintArea.value; save(); });
    const hintBox = el('div', { class: 'wikt-hint' }, el('small', { text: 'AI에게 줄 세계관 메모 (선택)' }), hintArea);
    const aiInfo = el('small', { class: 'wikt-note' });

    const status = el('div', { class: 'wikt-status' });
    const runBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-magnifying-glass' }), el('span', { text: '스캔 & 번역' }));
    const chatBtn = el('div', { class: 'menu_button menu_button_icon', title: '현재 채팅에 실제로 나온 표기를 AI로 찾아서 키워드 후보로 보여줘요' }, el('i', { class: 'fa-solid fa-comments' }), el('span', { text: '채팅에서 실제 표기 찾기 (AI)' }));
    const stopBtn = el('div', { class: 'menu_button', text: '중지', style: 'display:none' });
    const undoBtn = el('div', { class: 'menu_button menu_button_icon', title: '마지막 작업(추가 또는 삭제)을 취소해요' }, el('i', { class: 'fa-solid fa-rotate-left' }), el('span', { text: '마지막 작업 되돌리기' }));

    const preview = el('div', { class: 'wikt-preview' });
    const applyBtn = el('div', { class: 'menu_button menu_button_icon wikt-apply', style: 'display:none' }, el('i', { class: 'fa-solid fa-check' }), el('span', { text: '체크한 항목 적용' }));

    function updateVisibility() {
        const otherIsAI = provSel.value !== 'ai';
        cmpLabelText.textContent = otherIsAI
            ? ' 교차 비교: AI 번역과 비교해서 다른 것만 ⚠️ (AI 토큰 소모)'
            : ' 교차 비교: Google 번역과 비교해서 다른 것만 ⚠️ (무료)';
        backSel.style.display = backCb.checked ? '' : 'none';
        const usesAI = provSel.value === 'ai' || (cmpCb.checked && otherIsAI) || (backCb.checked && backSel.value === 'ai');
        hintBox.style.display = usesAI ? '' : 'none';
        const prof = getProfiles().find((p) => p.id === s.aiProfile);
        aiInfo.textContent = usesAI ? `AI 연결: ${prof ? `프로필 "${prof.name}"` : '현재 연결'} · 바꾸려면 설정 탭` : '';
    }
    cmpCb.addEventListener('change', () => { s.verifyCompare = cmpCb.checked; save(); updateVisibility(); });
    provSel.addEventListener('change', () => { s.provider = provSel.value; save(); updateVisibility(); });

    const tabTranslate = el('div', { class: 'wikt-tab' },
        el('div', { class: 'wikt-row' }, el('b', { text: '로어북' }), bookSel),
        el('div', { class: 'wikt-row' }, el('b', { text: '범위' }),
            el('label', {}, scopeAll, ' 전체 엔트리'),
            el('label', {}, scopePick, ' 선택한 엔트리만')),
        pickBox,
        el('div', { class: 'wikt-row' }, el('b', { text: '추가할 언어' }),
            LANGS.map((l, i) => el('label', {}, langBoxes[i], ` ${l.label}`))),
        el('div', { class: 'wikt-row' }, el('b', { text: '번역 방식' }), provSel),
        el('div', { class: 'wikt-row' }, el('label', {}, secCb, ' 보조 키워드(Optional Filter)도 번역')),
        el('div', { class: 'wikt-row' }, el('b', { text: '검증' }),
            el('label', {}, backCb, ' 역번역 표시'), backSel),
        el('div', { class: 'wikt-row' }, el('b', { text: '' }), el('label', {}, cmpCb, cmpLabelText)),
        hintBox,
        aiInfo,
        el('small', { class: 'wikt-note', text: '항상 켜짐(파란불) 엔트리와 정규식(/.../) 키워드는 건너뛰어요.' }),
        el('div', { class: 'wikt-row' }, runBtn, chatBtn, stopBtn, undoBtn),
        status,
        preview,
        applyBtn,
    );

    // ===== settings tab controls =====
    const numInputs = {};
    function numField(label, key, min, max, step, help) {
        const inp = el('input', { class: 'text_pole wikt-num', type: 'number', min, max, step, value: s[key] });
        inp.addEventListener('input', () => { s[key] = clampInt(inp.value, min, max, defaultSettings[key]); save(); });
        inp.addEventListener('change', () => { inp.value = s[key]; });
        numInputs[key] = inp;
        return el('div', { class: 'wikt-setrow' }, el('span', { class: 'wikt-setlabel', text: label }), inp,
            help ? el('small', { class: 'wikt-note', text: help }) : null);
    }

    const profSel = el('select', { class: 'text_pole' });
    function fillProfiles() {
        const profiles = getProfiles();
        profSel.replaceChildren(
            el('option', { value: '', text: '현재 연결 (지금 채팅에 쓰는 API)' }),
            ...profiles.map((p) => el('option', { value: p.id, text: `프로필: ${p.name}` })));
        profSel.value = profiles.some((p) => p.id === s.aiProfile) ? s.aiProfile : '';
        profNote.style.display = profiles.length ? 'none' : '';
    }
    const profNote = el('small', { class: 'wikt-note', text: '저장된 연결 프로필이 없어서 현재 연결만 쓸 수 있어요. (API 연결 화면의 Connection Profile에서 저장 가능)' });
    profSel.addEventListener('change', () => { s.aiProfile = profSel.value; save(); updateVisibility(); });

    const rulesArea = el('textarea', { class: 'text_pole wikt-rules', rows: 6, value: s.aiRules || DEFAULT_RULES });
    rulesArea.addEventListener('input', () => { s.aiRules = rulesArea.value.trim() === DEFAULT_RULES ? '' : rulesArea.value; save(); });

    const wiCb = el('input', { type: 'checkbox', checked: s.wiButton });
    wiCb.addEventListener('change', () => { s.wiButton = wiCb.checked; save(); syncWIButton(); });

    const tabSettings = el('div', { class: 'wikt-tab', style: 'display:none' },
        el('h4', { text: 'AI 연결' }),
        el('div', { class: 'wikt-row' }, profSel),
        profNote,
        el('h4', { text: 'AI에 보내는 내용' }),
        numField('엔트리 본문 앞부분 (글자 수)', 'contentChars', 0, 2000, 50, '0 = 안 보냄(기본). 켜면 고유명사 정확도↑ 토큰↑. 본문은 AI로만 가고 구글/빙으로는 절대 안 가요.'),
        el('details', {},
            el('summary', { text: '번역 프롬프트 보기/수정' }),
            rulesArea,
            el('div', { class: 'wikt-row' },
                el('div', { class: 'menu_button', text: '기본값 복원', onclick: () => { rulesArea.value = DEFAULT_RULES; s.aiRules = ''; save(); } }),
                el('small', { class: 'wikt-note', text: '대상 언어, 세계관 메모, JSON 응답 형식, 키워드 목록은 자동으로 붙어요.' }))),
        el('h4', { text: '속도 · 묶음 (과부하/차단 방지)' }),
        numField('무료 번역: 한 번에 보내는 키워드 수', 'freeBatch', 1, 50, 1, `추천 ${SPEED_DEFAULTS.freeBatch}`),
        numField('무료 번역: 요청 사이 대기 (ms)', 'freeDelay', 0, 30000, 100, `추천 ${SPEED_DEFAULTS.freeDelay} · 1000ms = 1초`),
        numField('AI: 한 번에 보내는 키워드 수', 'aiBatch', 5, 100, 1, `추천 ${SPEED_DEFAULTS.aiBatch} · 크면 요청 수↓ 대신 응답이 잘리거나 형식이 깨질 수 있어요`),
        numField('AI: 요청 사이 대기 (ms)', 'aiDelay', 0, 60000, 100, `추천 ${SPEED_DEFAULTS.aiDelay}`),
        numField('채팅에서 찾기: 한 번에 보내는 엔트리 수', 'chatEntries', 5, 200, 5, `추천 ${SPEED_DEFAULTS.chatEntries} · 요청마다 채팅 발췌가 같이 가요`),
        el('div', { class: 'wikt-row' }, el('div', {
            class: 'menu_button', text: '속도 설정 추천값으로 복원',
            onclick: () => { for (const [k, v] of Object.entries(SPEED_DEFAULTS)) { s[k] = v; numInputs[k].value = v; } save(); toastr.info('추천값으로 되돌렸어요.'); },
        })),
        el('small', { class: 'wikt-note', text: '실패하면 잠깐(3초 이상) 쉬고 한 번만 다시 시도해요. 그래도 안 되면 거기서 멈추고, 그때까지 번역된 것만 보여줘요.' }),
        el('h4', { text: '채팅에서 실제 표기 찾기' }),
        numField('최근 메시지 수', 'chatMsgs', 1, 500, 5, '추천 30'),
        numField('최대 글자 수', 'chatChars', 500, 100000, 500, '추천 8000 · 넘으면 최신 메시지부터 잘라서 보내요'),
        el('h4', { text: '기타' }),
        el('label', { class: 'checkbox_label' }, wiCb, el('span', { text: '월드인포 편집창에 번역 버튼 표시' })),
    );
    fillProfiles();
    updateVisibility();

    // ===== diagnose tab: keywords that never showed up in the recent chat =====
    const diagScopeSel = el('select', { class: 'text_pole wikt-inline-select' },
        el('option', { value: 'added', text: '이 확장이 추가한 키워드만 (추천)' }),
        el('option', { value: 'all', text: '모든 키워드 (직접 넣은 것 포함)' }));
    diagScopeSel.value = s.diagScope;
    diagScopeSel.addEventListener('change', () => { s.diagScope = diagScopeSel.value; save(); refreshDiagBadge(); });
    const diagSecCb = el('input', { type: 'checkbox', checked: s.diagSecondary });
    diagSecCb.addEventListener('change', () => { s.diagSecondary = diagSecCb.checked; save(); refreshDiagBadge(); });
    const diagBookLabel = el('b', {});
    const diagStatus = el('div', { class: 'wikt-status' });
    const diagList = el('div', { class: 'wikt-preview' });
    const diagRunBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-stethoscope' }), el('span', { text: '진단 시작' }));
    const diagDelBtn = el('div', { class: 'menu_button menu_button_icon redWarningBG', style: 'display:none' }, el('i', { class: 'fa-solid fa-trash-can' }), el('span', { text: '체크한 키워드 삭제' }));
    const diagUndoBtn = el('div', { class: 'menu_button menu_button_icon', onclick: () => doUndo() }, el('i', { class: 'fa-solid fa-rotate-left' }), el('span', { text: '마지막 작업 되돌리기' }));

    const tabDiag = el('div', { class: 'wikt-tab', style: 'display:none' },
        el('div', { class: 'wikt-row' }, el('b', { text: '로어북' }), diagBookLabel, el('small', { class: 'wikt-note', text: '(번역 탭에서 바꿀 수 있어요)' })),
        el('div', { class: 'wikt-row' }, el('b', { text: '대상' }), diagScopeSel),
        numField('최근 메시지 수 (이 안에서 한 번도 안 나오면 표시)', 'diagMsgs', 10, 5000, 10, '추천 100'),
        el('div', { class: 'wikt-row' }, el('label', {}, diagSecCb, ' 보조 키워드도 점검')),
        el('small', { class: 'wikt-note', text: '지금 열린 채팅 기준이에요. 같은 엔트리의 다른 키워드는 나왔는데 이 키워드만 안 나왔으면 "삭제 추천"으로 미리 체크해요. 엔트리 자체가 안 나온 경우는 아직 판단하기 일러서 체크하지 않아요. 다른 언어로 채팅할 때 필요한 키워드일 수 있으니 확인 후 삭제하세요.' }),
        el('div', { class: 'wikt-row' }, diagRunBtn, diagDelBtn, diagUndoBtn),
        diagStatus,
        diagList,
    );

    /** Scans the current book against the recent chat. Returns { rows, recommended, recentCount, total } or null without a chat. */
    async function diagnose() {
        if (!state.data) return null;
        const msgs = chatMessages();
        if (!msgs.length) return null;
        const recent = msgs.slice(-clampInt(s.diagMsgs, 10, 5000, 100));
        const text = recent.join('\n');
        const hay = norm(text);
        const reg = (await loadAdded())[state.book] || {};
        const fields = s.diagSecondary ? ['key', 'keysecondary'] : ['key'];
        const rows = [];
        let recommended = 0;
        for (const e of entriesOf(state.data)) {
            if (e.constant) continue;
            const entryHits = (e.key || []).reduce((a, k) => a + (isRegexKey(k) ? regexHit(k, text) : countHits(hay, k)), 0);
            const items = [];
            for (const f of fields) {
                const mine = new Set(reg[`${e.uid}:${f}`] || []);
                for (const k0 of e[f] || []) {
                    const k = String(k0);
                    if (!k.trim() || isRegexKey(k)) continue;
                    if (s.diagScope === 'added' && !mine.has(k)) continue;
                    if (countHits(hay, k) > 0) continue;
                    const recommend = entryHits > 0;
                    if (recommend) recommended++;
                    items.push({ f, k, recommend, mine: mine.has(k) });
                }
            }
            if (items.length) rows.push({ uid: String(e.uid), title: entryTitle(e), entryHits, items });
        }
        return { rows, recommended, recentCount: recent.length, total: rows.reduce((a, r) => a + r.items.length, 0) };
    }

    async function refreshDiagBadge() {
        try {
            const d = await diagnose();
            tabBtnD.textContent = d?.recommended ? `진단 (${d.recommended})` : '진단';
        } catch (e) { console.warn('[WIKT] diag badge', e); }
    }

    function renderDiag(d) {
        diagList.replaceChildren();
        diagDelBtn.style.display = 'none';
        if (!d) { diagStatus.textContent = '열린 채팅이 없어요. 채팅을 연 뒤 다시 눌러 주세요.'; return; }
        const short = d.recentCount < s.diagMsgs ? ` · 채팅 메시지가 아직 ${d.recentCount}개뿐이라 판단이 이를 수 있어요` : '';
        if (!d.rows.length) {
            diagStatus.textContent = (s.diagScope === 'added'
                ? '최근 채팅에서 안 나온 "이 확장이 추가한 키워드"가 없어요.'
                : '최근 채팅에서 안 나온 키워드가 없어요.') + short;
            return;
        }
        diagStatus.textContent = `최근 ${d.recentCount}개 메시지에서 안 나온 키워드 ${d.total}개 (삭제 추천 ${d.recommended}개)${short}`;
        for (const r of d.rows) {
            const item = el('div', { class: 'wikt-item' },
                el('b', { text: r.title }),
                el('small', { class: r.entryHits ? 'wikt-ok' : 'wikt-src', text: r.entryHits
                    ? `이 엔트리는 다른 키워드로 ${r.entryHits}회 잡혔어요`
                    : '엔트리 자체가 아직 안 나왔어요 — 판단 보류' }));
            for (const it of r.items) {
                const cb = el('input', { type: 'checkbox', checked: it.recommend });
                it.cb = cb;
                item.append(el('label', { class: 'wikt-diagrow' }, cb, ' ', el('span', { text: it.k }),
                    it.f === 'keysecondary' ? el('small', { class: 'wikt-tag', text: '보조' }) : null,
                    it.mine ? el('small', { class: 'wikt-tag', text: '확장이 추가' }) : null,
                    el('small', { class: it.recommend ? 'wikt-bad' : 'wikt-src', text: it.recommend ? ' 삭제 추천' : ' 보류' })));
            }
            diagList.append(item);
        }
        state.diag = d;
        diagDelBtn.style.display = '';
    }

    diagRunBtn.addEventListener('click', async () => {
        if (state.busy) return;
        if (!state.data) await loadBook();
        const d = await diagnose();
        renderDiag(d);
        tabBtnD.textContent = d?.recommended ? `진단 (${d.recommended})` : '진단';
    });

    diagDelBtn.addEventListener('click', async () => {
        if (state.busy || !state.diag) return;
        const picked = [];
        for (const r of state.diag.rows) for (const it of r.items) if (it.cb?.checked) picked.push({ uid: r.uid, f: it.f, k: it.k });
        if (!picked.length) { toastr.info('체크한 키워드가 없어요.'); return; }
        const ok = await c.Popup.show.confirm('키워드 삭제', `키워드 ${picked.length}개를 삭제할까요? "마지막 작업 되돌리기"로 다시 넣을 수 있어요.`);
        if (!ok) return;
        const data = await c.loadWorldInfo(state.book);
        if (!data?.entries) { toastr.error('로어북을 불러오지 못했어요.'); return; }
        const removed = {};
        let count = 0, kept = 0;
        const byField = new Map();
        for (const p of picked) {
            const key = `${p.uid}\0${p.f}`;
            if (!byField.has(key)) byField.set(key, { uid: p.uid, f: p.f, words: new Set() });
            byField.get(key).words.add(p.k);
        }
        for (const { uid, f, words } of byField.values()) {
            const e = data.entries[uid];
            if (!e || !Array.isArray(e[f])) continue;
            const next = e[f].filter((k) => !words.has(k));
            if (f === 'key' && next.length === 0) { kept += words.size; continue; } // never leave an entry without keywords
            const gone = e[f].filter((k) => words.has(k));
            if (!gone.length) continue;
            e[f] = next;
            syncOriginal(data, uid, f, e[f]);
            (removed[uid] ??= {})[f] = gone;
            count += gone.length;
        }
        if (kept) toastr.warning(`키워드가 하나도 안 남게 되는 엔트리가 있어서 ${kept}개는 남겨뒀어요.`);
        if (!count) return;
        try {
            await saveBook(state.book, data);
            await pushUndo({ kind: 'remove', time: Date.now(), book: state.book, removed });
            state.data = data;
            toastr.success(`키워드 ${count}개를 삭제했어요.`, state.book);
            const d = await diagnose();
            renderDiag(d);
            tabBtnD.textContent = d?.recommended ? `진단 (${d.recommended})` : '진단';
            diagStatus.textContent = `삭제 완료! 잘못됐으면 "마지막 작업 되돌리기"를 눌러주세요. — ${diagStatus.textContent}`;
        } catch (e) {
            reportError(e, '삭제 실패');
        }
    });

    // ===== tabs =====
    const tabBtnT = el('div', { class: 'wikt-tabbtn active', text: '번역' });
    const tabBtnD = el('div', { class: 'wikt-tabbtn', text: '진단', title: '최근 채팅에서 안 나온 키워드 찾기' });
    const tabBtnS = el('div', { class: 'wikt-tabbtn', text: '설정' });
    const showTab = (which) => {
        tabTranslate.style.display = which === 't' ? '' : 'none';
        tabDiag.style.display = which === 'd' ? '' : 'none';
        tabSettings.style.display = which === 's' ? '' : 'none';
        tabBtnT.classList.toggle('active', which === 't');
        tabBtnD.classList.toggle('active', which === 'd');
        tabBtnS.classList.toggle('active', which === 's');
        if (which === 's') fillProfiles();
        else updateVisibility();
        if (which === 'd') diagBookLabel.textContent = state.book;
    };
    tabBtnT.addEventListener('click', () => showTab('t'));
    tabBtnD.addEventListener('click', () => showTab('d'));
    tabBtnS.addEventListener('click', () => showTab('s'));

    const root = el('div', { class: 'wikt-root' },
        el('h3', { text: '월드인포 키워드 번역' }),
        el('div', { class: 'wikt-tabs' }, tabBtnT, tabBtnD, tabBtnS),
        tabTranslate,
        tabDiag,
        tabSettings,
    );

    // --- entry picking ---
    async function loadBook() {
        state.data = await c.loadWorldInfo(state.book);
        state.picked.clear();
        state.rows = [];
        preview.replaceChildren();
        applyBtn.style.display = 'none';
        renderPickList();
        state.diag = null;
        diagList.replaceChildren();
        diagDelBtn.style.display = 'none';
        diagStatus.textContent = '';
        diagBookLabel.textContent = state.book;
        refreshDiagBadge();
    }
    function entriesOf(data) {
        return Object.values(data?.entries || {}).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
    }
    const matchesFilter = (e) => {
        const q = norm(filterInput.value);
        return !q || norm(`${entryTitle(e)} ${(e.key || []).join(' ')}`).includes(q);
    };
    function renderPickList() {
        pickList.replaceChildren();
        for (const e of entriesOf(state.data)) {
            if (!matchesFilter(e)) continue;
            const cb = el('input', { type: 'checkbox', checked: state.picked.has(String(e.uid)) });
            cb.addEventListener('change', () => { cb.checked ? state.picked.add(String(e.uid)) : state.picked.delete(String(e.uid)); updatePickCount(); });
            pickList.append(el('label', { class: 'wikt-pick' }, cb, ' ', el('span', { text: entryTitle(e) }),
                e.constant ? el('small', { class: 'wikt-tag', text: '항상켜짐' }) : null,
                el('small', { class: 'wikt-keys', text: (e.key || []).join(', ') })));
        }
        updatePickCount();
    }
    function setAllPicked(v) {
        for (const e of entriesOf(state.data)) {
            if (!matchesFilter(e)) continue;
            v ? state.picked.add(String(e.uid)) : state.picked.delete(String(e.uid));
        }
        renderPickList();
    }
    const updatePickCount = () => { pickCount.textContent = `${state.picked.size}개 선택`; };
    const onScope = () => { state.scope = scopePick.checked ? 'pick' : 'all'; pickBox.style.display = state.scope === 'pick' ? '' : 'none'; };
    scopeAll.addEventListener('change', onScope);
    scopePick.addEventListener('change', onScope);
    filterInput.addEventListener('input', renderPickList);
    bookSel.addEventListener('change', async () => { state.book = bookSel.value; await loadBook(); });

    // --- shared run helpers ---
    function setBusy(b) {
        state.busy = b;
        runBtn.classList.toggle('disabled', b);
        chatBtn.classList.toggle('disabled', b);
        applyBtn.classList.toggle('disabled', b);
        stopBtn.style.display = b ? '' : 'none';
    }
    stopBtn.addEventListener('click', () => { state.cancel = true; status.textContent = '중지하는 중… (지금 보내는 요청이 끝나면 멈춰요)'; });

    function phase(label, total) {
        let done = 0;
        status.textContent = `${label}… 0 / ${total}`;
        return (n) => { done += n; status.textContent = `${label}… ${Math.min(done, total)} / ${total}`; };
    }
    const reportError = (e, title) => {
        console.error('[WIKT]', e);
        toastr.error(String(e?.message || e) + (e?.cause ? ` (${e.cause.message || e.cause})` : ''), title);
    };
    function targetEntries() {
        return entriesOf(state.data).filter((e) =>
            !e.constant && (e.key || []).length && (state.scope === 'all' || state.picked.has(String(e.uid))));
    }
    /** Pause between phases too, so a new phase's first request doesn't follow the last one instantly. */
    const gap = (kind) => sleep(kind === 'ai'
        ? clampInt(s.aiDelay, 0, 60000, SPEED_DEFAULTS.aiDelay)
        : clampInt(s.freeDelay, 0, 30000, SPEED_DEFAULTS.freeDelay));
    const profileName = () => {
        const p = getProfiles().find((x) => x.id === s.aiProfile);
        return p ? `프로필 "${p.name}"` : '현재 연결';
    };

    // --- scan & translate ---
    runBtn.addEventListener('click', async () => {
        if (state.busy) return;
        const langs = langBoxes.filter((x) => x.checked).map((x) => x.value);
        if (!langs.length) { toastr.warning('추가할 언어를 하나 이상 골라주세요.'); return; }
        if (!state.data) await loadBook();
        const fields = s.includeSecondary ? ['key', 'keysecondary'] : ['key'];
        const targets = targetEntries();
        if (!targets.length) { toastr.info('번역할 엔트리가 없어요. (범위/선택을 확인해 주세요)'); return; }

        // unique (lang, keyword) jobs → first entry that uses it (for AI context)
        const need = new Map(langs.map((l) => [l, new Map()]));
        for (const e of targets) {
            for (const f of fields) {
                for (const kw of e[f] || []) {
                    const k = String(kw).trim();
                    if (!k || isRegexKey(k) || !RE_LETTER.test(k)) continue;
                    for (const l of langs) if (!alreadyInLang(k, l) && !need.get(l).has(k)) need.get(l).set(k, e);
                }
            }
        }
        const total = [...need.values()].reduce((a, m) => a + m.size, 0);
        if (!total) { toastr.info('번역이 필요한 키워드가 없어요. 이미 해당 언어로 되어 있어요.'); return; }

        const provider = provSel.value;
        const freeProv = provider === 'ai' ? 'google' : provider;
        const aiMain = provider === 'ai';
        const aiCompare = s.verifyCompare && !aiMain;
        const aiBack = s.verifyBack && s.backProvider === 'ai';
        if (aiMain || aiCompare || aiBack) {
            const uniq = new Set([...need.values()].flatMap((m) => [...m.keys()]));
            const langsUsed = [...need.keys()].filter((l) => need.get(l).size);
            const chunks = buildAIChunks(need);
            const chars = chunks.reduce((a, g) => a + AI_SYSTEM.length + buildAIPrompt(g, langsUsed).prompt.length, 0);
            const uses = [aiMain ? '번역' : null, aiCompare ? '교차 비교' : null, aiBack ? '역번역' : null].filter(Boolean).join(' + ');
            const what = s.contentChars > 0 ? `키워드 ${uniq.size}개 + 엔트리 제목 + 본문 앞 ${s.contentChars}자` : `키워드 ${uniq.size}개 + 엔트리 제목 (본문 X)`;
            const msg = `${profileName()}로 AI ${uses}을 해요.\n번역 단계: ${what}, 요청 ${chunks.length}번 · 약 ${chars.toLocaleString()}자` +
                (aiBack ? '\n역번역 단계: 번역 결과 개수만큼 추가 요청' : '') + '\n진행할까요?';
            const ok = await c.Popup.show.confirm('AI 사용 확인', msg);
            if (!ok) return;
        }

        setBusy(true);
        state.cancel = false;
        state.mode = 'translate';
        const results = new Map();
        let other = null;
        const back = new Map();
        try {
            if (aiMain) await aiTranslateNeed(need, phase('AI 번역 중', total), isCancelled, results);
            else await freeTranslateNeed(provider, need, phase('번역 중', total), isCancelled, results);

            if (s.verifyCompare && !state.cancel) {
                await gap(aiMain ? 'free' : 'ai');
                other = new Map();
                if (aiMain) await freeTranslateNeed('google', need, phase('비교용 Google 번역 중', total), isCancelled, other);
                else await aiTranslateNeed(need, phase('비교용 AI 번역 중', total), isCancelled, other);
            }
        } catch (e) {
            reportError(e, '번역 중단');
        }

        // build proposals
        state.rows = [];
        for (const e of targets) {
            const row = { uid: String(e.uid), title: entryTitle(e), adds: {} };
            for (const f of fields) {
                const seen = new Set((e[f] || []).map(norm));
                const adds = [];
                for (const kw of e[f] || []) {
                    const src = String(kw).trim();
                    for (const l of langs) {
                        for (const t0 of results.get(`${l}\0${src}`) || []) {
                            const t = cleanResult(t0);
                            if (!t || seen.has(norm(t))) continue;
                            seen.add(norm(t));
                            const alt = other ? (other.get(`${l}\0${src}`) || []).map(cleanResult).filter(Boolean) : null;
                            adds.push({ t, src, lang: l, alt });
                        }
                    }
                }
                if (adds.length) row.adds[f] = adds;
            }
            if (Object.keys(row.adds).length) state.rows.push(row);
        }

        // back-translation of every proposed keyword into its source keyword's language
        if (s.verifyBack && !state.cancel && state.rows.length) {
            const byLang = new Map();
            for (const r of state.rows) for (const adds of Object.values(r.adds)) for (const a of adds) {
                const bl = detectLang(a.src);
                if (!byLang.has(bl)) byLang.set(bl, new Set());
                byLang.get(bl).add(a.t);
            }
            const n = [...byLang.values()].reduce((x, set) => x + set.size, 0);
            const prog = phase(aiBack ? 'AI 역번역 중' : '역번역 중', n);
            try {
                for (const [bl, set] of byLang) {
                    if (state.cancel) break;
                    await gap(aiBack ? 'ai' : 'free');
                    const part = new Map();
                    try {
                        if (aiBack) await aiTranslateList([...set], bl, prog, isCancelled, part);
                        else await freeTranslate(freeProv, [...set], bl, prog, isCancelled, part);
                    } finally {
                        for (const [t, v] of part) back.set(`${bl}\0${t}`, cleanResult(Array.isArray(v) ? v[0] : v));
                    }
                }
            } catch (e) { reportError(e, '역번역 중단'); }
            for (const r of state.rows) for (const adds of Object.values(r.adds)) for (const a of adds) {
                a.back = back.get(`${detectLang(a.src)}\0${a.t}`) ?? null;
            }
        }
        setBusy(false);
        finishRun(state.cancel
            ? `중지됨 — 지금까지 번역된 것: 엔트리 ${state.rows.length}개`
            : `완료 — 새 키워드가 생긴 엔트리 ${state.rows.length}개`);
    });

    // --- chat finder: find real surface forms used in the current chat ---
    chatBtn.addEventListener('click', async () => {
        if (state.busy) return;
        if (!state.data) await loadBook();
        const excerpt = chatExcerpt();
        if (!excerpt.trim()) { toastr.info('열려 있는 채팅에 메시지가 없어요. 채팅을 연 뒤 다시 눌러 주세요.'); return; }
        const targets = targetEntries();
        if (!targets.length) { toastr.info('찾을 엔트리가 없어요. (범위/선택을 확인해 주세요)'); return; }

        const per = clampInt(s.chatEntries, 5, 200, SPEED_DEFAULTS.chatEntries);
        const chunks = [];
        for (let i = 0; i < targets.length; i += per) chunks.push(targets.slice(i, i + per));
        const chars = chunks.reduce((a, ch) => a + AI_SYSTEM.length + buildChatPrompt(ch, excerpt).length, 0);
        const ok = await c.Popup.show.confirm('채팅에서 실제 표기 찾기',
            `${profileName()}로 최근 채팅 발췌(${excerpt.length.toLocaleString()}자) + 엔트리 ${targets.length}개의 제목·키워드를 보내요.\n요청 ${chunks.length}번 · 약 ${chars.toLocaleString()}자. 진행할까요?`);
        if (!ok) return;

        setBusy(true);
        state.cancel = false;
        state.mode = 'chat';
        const hay = norm(chatMessages().join('\n'));
        const found = new Map(); // uid → [strings]
        const prog = phase('채팅 분석 중', targets.length);
        const delay = clampInt(s.aiDelay, 0, 60000, SPEED_DEFAULTS.aiDelay);
        try {
            for (let i = 0; i < chunks.length; i++) {
                if (state.cancel) break;
                if (i > 0) await sleep(delay);
                const ch = chunks[i];
                const json = await callAIJson(buildChatPrompt(ch, excerpt), Math.min(8000, 300 + ch.length * 60));
                ch.forEach((e, j) => {
                    const v = json[`E${j + 1}`];
                    const arr = (Array.isArray(v) ? v : (v ? [v] : [])).map((x) => cleanResult(x)).filter(Boolean);
                    if (arr.length) found.set(String(e.uid), arr);
                });
                prog(ch.length);
            }
        } catch (e) {
            reportError(e, '채팅 분석 중단');
        }

        state.rows = [];
        let dropped = 0;
        for (const e of targets) {
            const cand = found.get(String(e.uid));
            if (!cand) continue;
            const seen = new Set((e.key || []).map(norm));
            const adds = [];
            for (const t of cand) {
                // anti-hallucination: keep only strings that literally appear in the chat
                if (t.length > 40 || seen.has(norm(t))) continue;
                if (!hay.includes(norm(t))) { dropped++; continue; }
                seen.add(norm(t));
                adds.push({ t, src: '채팅', lang: 'chat', alt: null });
            }
            if (adds.length) state.rows.push({ uid: String(e.uid), title: entryTitle(e), adds: { key: adds } });
        }
        setBusy(false);
        finishRun((state.cancel ? '중지됨 — ' : '완료 — ') + `채팅에서 새 표기를 찾은 엔트리 ${state.rows.length}개` +
            (dropped ? ` (채팅에 실제로 없는 AI 답변 ${dropped}개는 버렸어요)` : ''));
    });

    function finishRun(prefix) {
        const hay = norm(chatMessages().join('\n'));
        for (const r of state.rows) for (const a of Object.values(r.adds).flat()) a.hits = hay ? countHits(hay, a.t) : null;
        renderPreview();
        const warn = state.rows.reduce((x, r) => x + Object.values(r.adds).flat().filter(isSuspicious).length, 0);
        status.textContent = `${prefix}${warn ? `, 확인이 필요한 키워드 ⚠️ ${warn}개` : ''}.${state.rows.length ? " 확인 후 '적용'을 눌러주세요." : ''}`;
    }

    const backOk = (a) => a.back != null && normLoose(a.back) === normLoose(a.src);
    const cmpOk = (a) => a.alt != null && a.alt.some((x) => norm(x) === norm(a.t));
    // Cross-check beats back-translation: if both methods agree, a mismatching back-translation
    // (e.g. romanized names like Cheongmyeong → 清明 → Qingming) is not a warning.
    function isSuspicious(a) {
        if (a.alt != null) return !cmpOk(a);
        if (a.orig != null) return false;
        return a.back != null && !backOk(a);
    }

    function replaceInInput(inp, from, to) {
        const parts = splitInput(inp.value).map((x) => (x === from ? to : x));
        inp.value = [...new Set(parts)].join(', ');
    }

    function renderChecks(adds, inp) {
        const anyCheck = adds.some((a) => a.back != null || a.alt != null || a.hits != null || a.lang === 'chat');
        if (!anyCheck) return null;
        const box = el('div', { class: 'wikt-checks' });
        const refreshWarn = () => box.closest('.wikt-item')?.classList.toggle('has-warn', adds.some(isSuspicious));
        // swap to an alternative, remembering the first original so it can always be restored
        const swapTo = (a, chip, to) => {
            if (a.orig == null) a.orig = a.t;
            replaceInInput(inp, a.t, to);
            a.t = to;
            if (a.t === a.orig) delete a.orig;
            chip.replaceWith(makeChip(a));
            refreshWarn();
        };
        const makeChip = (a) => {
            const bad = isSuspicious(a);
            const parts = [el('b', { text: a.t }),
                el('small', { class: 'wikt-src', text: a.lang === 'chat' ? ' ← 채팅 속 표기' : ` ← ${a.src} · ${langLabel(a.lang)}` })];
            if (a.hits != null) parts.push(el('small', { class: a.hits ? 'wikt-ok' : 'wikt-src', text: ` · 채팅 ${a.hits}회` }));
            // back-translation belongs to the original text; hide it while a swapped value is shown
            if (a.back != null && a.orig == null) parts.push(el('small', { class: backOk(a) ? 'wikt-ok' : (bad ? 'wikt-bad' : 'wikt-src'), text: ` · 역번역: ${a.back || '(없음)'}` }));
            let chip;
            if (a.alt != null) {
                const label = provSel.value === 'ai' ? 'Google' : 'AI';
                if (cmpOk(a)) parts.push(el('small', { class: 'wikt-ok', text: ` · ${label}도 같음` }));
                else {
                    parts.push(el('small', { class: 'wikt-bad', text: ` · ${label}: ${a.alt.join(' / ') || '(없음)'}` }));
                    for (const alt of a.alt.slice(0, 2)) {
                        parts.push(el('span', { class: 'menu_button wikt-swap', text: `→ ${alt} 사용`, onclick: () => swapTo(a, chip, alt) }));
                    }
                }
            }
            if (a.orig != null) {
                parts.push(el('small', { class: 'wikt-src', text: ` · 원래: ${a.orig}` }));
                parts.push(el('span', { class: 'menu_button wikt-swap', text: `↩ 원래대로 (${a.orig})`, onclick: () => swapTo(a, chip, a.orig) }));
            }
            chip = el('div', { class: `wikt-chip ${bad ? 'is-bad' : 'is-ok'}` }, bad ? '⚠️ ' : '✔ ', parts);
            return chip;
        };
        for (const a of adds) box.append(makeChip(a));
        return box;
    }

    function renderPreview() {
        preview.replaceChildren();
        if (!state.rows.length) { applyBtn.style.display = 'none'; return; }
        const master = el('input', { type: 'checkbox', checked: true });
        master.addEventListener('change', () => preview.querySelectorAll('.wikt-item > label > input[type=checkbox]').forEach((x) => { x.checked = master.checked; }));
        preview.append(el('label', { class: 'wikt-master' }, master, ' 전체 체크'));
        for (const r of state.rows) {
            const e = state.data.entries[r.uid];
            const cb = el('input', { type: 'checkbox', checked: true });
            r.cb = cb;
            r.inputs = {};
            const item = el('div', { class: 'wikt-item' },
                el('label', {}, cb, ' ', el('b', { text: r.title })),
                el('small', { class: 'wikt-keys', text: `기존: ${(e?.key || []).join(', ')}` }));
            for (const [f, adds] of Object.entries(r.adds)) {
                const inp = el('input', { class: 'text_pole', type: 'text', value: adds.map((a) => a.t).join(', ') });
                r.inputs[f] = inp;
                item.append(el('div', { class: 'wikt-addrow' }, el('small', { text: f === 'key' ? '+ 추가 키워드' : '+ 보조 키워드' }), inp));
                const checks = renderChecks(adds, inp);
                if (checks) item.append(checks);
            }
            if (Object.values(r.adds).flat().some(isSuspicious)) item.classList.add('has-warn');
            preview.append(item);
        }
        applyBtn.style.display = '';
    }

    // --- apply ---
    applyBtn.addEventListener('click', async () => {
        if (state.busy || !state.rows.length) return;
        const data = await c.loadWorldInfo(state.book); // fresh copy in case the editor changed it
        if (!data?.entries) { toastr.error('로어북을 불러오지 못했어요.'); return; }
        const undo = { time: Date.now(), book: state.book, added: {} };
        let count = 0, entries = 0;
        for (const r of state.rows) {
            if (!r.cb.checked) continue;
            const e = data.entries[r.uid];
            if (!e) continue;
            let touched = false;
            for (const [f, inp] of Object.entries(r.inputs)) {
                if (!Array.isArray(e[f])) e[f] = [];
                const seen = new Set(e[f].map(norm));
                const add = splitInput(inp.value).filter((t) => { const n = norm(t); if (seen.has(n)) return false; seen.add(n); return true; });
                if (!add.length) continue;
                e[f].push(...add);
                syncOriginal(data, r.uid, f, e[f]);
                (undo.added[r.uid] ??= {})[f] = add;
                count += add.length; touched = true;
            }
            if (touched) entries++;
        }
        if (!count) { toastr.info('추가할 키워드가 없어요.'); return; }
        try {
            await saveBook(state.book, data);
            await pushUndo(undo);
            await updateAdded(state.book, undo.added, true);
            state.data = data;
            toastr.success(`엔트리 ${entries}개에 키워드 ${count}개를 추가했어요.`, state.book);
            state.rows = [];
            renderPreview();
            status.textContent = '적용 완료! 잘못됐으면 "마지막 작업 되돌리기"를 눌러주세요.';
            refreshDiagBadge();
        } catch (e) {
            reportError(e, '저장 실패');
        }
    });

    // Undo the last action: an "add" (translate/chat finder) removes what was added,
    // a "remove" (diagnose tab) puts the deleted keywords back.
    async function doUndo() {
        if (state.busy) return;
        const rec = (await loadUndo())[0];
        if (!rec) { toastr.info('되돌릴 기록이 없어요.'); return; }
        const isRemove = rec.kind === 'remove';
        const words = isRemove ? rec.removed : rec.added;
        const n = Object.values(words).reduce((a, x) => a + Object.values(x).reduce((b, y) => b + y.length, 0), 0);
        const when = new Date(rec.time).toLocaleString();
        const ok = await c.Popup.show.confirm('되돌리기', isRemove
            ? `[${rec.book}] ${when}에 진단 탭에서 삭제한 키워드 ${n}개를 다시 넣을까요?`
            : `[${rec.book}] ${when}에 추가한 키워드 ${n}개를 지울까요? (그 뒤에 직접 넣은 키워드는 그대로 둬요)`);
        if (!ok) return;
        const data = await c.loadWorldInfo(rec.book);
        if (!data?.entries) { toastr.error(`로어북 "${rec.book}"을 찾지 못했어요.`); await popUndo(); return; }
        let changed = 0;
        for (const [uid, fields] of Object.entries(words)) {
            const e = data.entries[uid];
            if (!e) continue;
            for (const [f, list] of Object.entries(fields)) {
                if (!Array.isArray(e[f])) e[f] = [];
                const before = e[f].length;
                if (isRemove) {
                    const seen = new Set(e[f].map(norm));
                    e[f].push(...list.filter((k) => !seen.has(norm(k))));
                } else {
                    const del = new Set(list);
                    e[f] = e[f].filter((k) => !del.has(k));
                }
                changed += Math.abs(e[f].length - before);
                syncOriginal(data, uid, f, e[f]);
            }
        }
        await saveBook(rec.book, data);
        await popUndo();
        if (!isRemove) await updateAdded(rec.book, rec.added, false);
        if (rec.book === state.book) { state.data = data; renderPickList(); refreshDiagBadge(); }
        toastr.success(isRemove ? `키워드 ${changed}개를 다시 넣었어요.` : `키워드 ${changed}개를 지웠어요.`, rec.book);
    }
    undoBtn.addEventListener('click', doUndo);

    await loadBook();
    await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, okButton: '닫기',
        onClosing: () => { state.cancel = true; return true; },
    });
}

// ---------- entry points ----------
function currentEditorBook() {
    const t = $('#world_editor_select').find(':selected');
    return t.val() !== '' ? t.text() : undefined;
}

function addWIButton() {
    if (document.getElementById('wikt_wi_button')) return;
    const anchor = document.getElementById('world_backfill_memos') || document.getElementById('world_popup_new');
    if (!anchor) return;
    const btn = el('div', {
        id: 'wikt_wi_button',
        class: 'menu_button fa-solid fa-language',
        title: '키워드 번역 (WI Keyword Translator)',
        onclick: () => openTranslator(currentEditorBook()),
    });
    anchor.after(btn);
}
function syncWIButton() {
    const s = getSettings();
    if (s.wiButton) addWIButton();
    const b = document.getElementById('wikt_wi_button');
    if (b) b.style.display = s.wiButton ? '' : 'none';
}

function addSettingsPanel() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host || document.getElementById('wikt_settings')) return;
    const panel = el('div', { id: 'wikt_settings', class: 'inline-drawer' },
        el('div', { class: 'inline-drawer-toggle inline-drawer-header' },
            el('b', { text: '월드인포 키워드 번역' }),
            el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
        el('div', { class: 'inline-drawer-content' },
            el('div', { class: 'menu_button menu_button_icon', onclick: () => openTranslator(currentEditorBook()) },
                el('i', { class: 'fa-solid fa-language' }), el('span', { text: '키워드 번역기 열기' })),
            el('small', { text: '세부 설정(AI 연결, 프롬프트, 속도·묶음)은 번역기 안의 "설정" 탭에 있어요.' })));
    host.append(panel);

    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('wikt_menu_item')) {
        menu.append(el('div', { id: 'wikt_menu_item', class: 'list-group-item flex-container flexGap5', onclick: () => openTranslator(currentEditorBook()) },
            el('div', { class: 'fa-solid fa-language extensionsMenuExtensionButton' }),
            '월드인포 키워드 번역'));
    }
}

function registerSlash() {
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'wi-translate',
            callback: async (_args, value) => { openTranslator(String(value || '').trim() || currentEditorBook()); return ''; },
            helpString: '월드인포 키워드 번역기를 열어요. 예: /wi-translate 로어북이름',
        }));
    } catch (e) { console.warn('[WIKT] slash command not registered', e); }
}

(function init() {
    const { eventSource, event_types } = ctx();
    let started = false;
    const start = () => {
        if (started) return;
        started = true;
        getSettings(); addSettingsPanel(); syncWIButton(); registerSlash();
    };
    if (document.getElementById('extensions_settings')) start();
    else eventSource.once(event_types.APP_READY, start);
})();
