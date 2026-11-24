// WI Keyword Translator — adds translated trigger keywords (green-light keys) to World Info entries.
// Free mode uses SillyTavern's built-in translate endpoints (Google/Bing, 0 LLM tokens).
// AI mode sends keywords + entry titles (+ optional content snippet, off by default) to the chosen connection.
// Diagnose tab: free hit-count check, and an AI check (button only) that reads a chosen chat range.
// Undo history and the "added by this extension" registry live in extension settings (server-side),
// so they survive reloads, other browsers and other devices.

const MODULE = 'wi_keyword_translator';
const MAX_UNDO = 15;

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
    '아래는 롤플레이 로어북(월드인포)의 트리거 키워드야. 롤플레이 본문에 실제로 등장할 표기로 번역해.',
    '- 한국어 키워드는 소리만 적혀 있어서 한자가 여러 개일 수 있어(예: 청명 → 清明/晴明/青冥). 같은 엔트리의 제목·다른 키워드·내용을 근거로 가장 맞는 뜻을 골라.',
    '- 인물·문파·지명·무공·물건 같은 고유명사는 소리만 옮기지 말고, 그 작품/장르에서 쓰는 정식 표기로 써. 유명 작품의 고유명사면 원작 표기를 따라.',
    '- 일반 명사는 그 언어 원어민이 본문에서 실제로 쓰는 단어로 써.',
    '- 가장 좋은 표기 하나만 주고, 흔히 쓰이는 다른 표기가 있을 때만 하나 더 줘.',
    '- 근거가 부족해서 확신이 없으면 후보를 2개까지 주고 그 항목에 "unsure": true를 붙여.',
    '- 엔트리 제목/내용은 뜻을 고르기 위한 참고용이야. 그 자체는 번역하지 마.',
    '- 이미 목표 언어로 된 키워드는 그대로 돌려줘.',
].join('\n');
/** Default prompt of 1.0.0–1.0.6; a saved copy of it is treated as "default" so users get the new one. */
const OLD_DEFAULT_RULES = [
    '아래는 롤플레이 로어북(월드인포)의 트리거 키워드야. 롤플레이 본문에서 실제로 쓰일 표기로 번역해.',
    '- 인물·문파·지명·무공·물건 같은 고유명사는 소리만 옮기지 말고, 그 언어권에서 자연스럽게 쓰는 정식 표기(동아시아 이름은 알맞은 한자)로 써.',
    '- 엔트리 제목/내용은 뜻을 고르기 위한 참고용이야. 그 자체는 번역하지 마.',
    '- 가장 좋은 표기 하나만 주고, 흔히 쓰이는 다른 표기가 있을 때만 하나 더 줘.',
    '- 이미 목표 언어로 된 키워드는 그대로 돌려줘.',
].join('\n');
const AI_CONTEXTS = {
    keywords: '키워드만 (제목 + 같은 엔트리의 다른 키워드)',
    snippet: '본문 일부',
    full: '월드인포 전문',
};

const AI_SYSTEM = 'You are a precise translation engine for roleplay lorebook keywords. Output only valid JSON.';
const AI_SYSTEM_DIAG = 'You analyze roleplay text against lorebook entries. Output only valid JSON.';

// Recommended speed values (safe for free translators and most API rate limits)
const SPEED_DEFAULTS = Object.freeze({
    freeBatch: 30,       // keywords per Google/Bing request
    freeDelay: 500,      // ms between Google/Bing requests
    aiBatch: 30,         // keywords per AI request
    aiDelay: 1500,       // ms between AI requests
    chatEntries: 60,     // entries per AI diagnosis request
    diagChunkChars: 8000, // chat chars per AI diagnosis request
    aiChunkChars: 12000, // max prompt chars per AI translation request (matters with content sent)
});

const defaultSettings = Object.freeze({
    langs: ['zh-CN'],
    provider: 'google',
    includeSecondary: false,
    aiHint: '',
    aiProfile: '',      // '' = current connection
    aiRules: '',        // '' = DEFAULT_RULES
    aiContext: 'keywords', // what AI translation sees: 'keywords' | 'snippet' | 'full'
    contentChars: 300,  // snippet length for aiContext 'snippet'
    verifyBack: false,
    backProvider: 'free', // 'free' (Google/Bing) | 'ai'
    verifyCompare: false,
    // diagnose
    diagRange: 'recent', // 'recent' | 'range' | 'all'
    diagMsgs: 100,
    diagFrom: 0,
    diagTo: 100,
    diagHidden: false,
    diagScope: 'added', // 'added' (only keywords this extension added) | 'all'
    diagSecondary: false,
    // language cleanup
    cleanLangs: [],
    cleanScope: 'added',
    ...SPEED_DEFAULTS,
    wiButton: true,
    // server-side data
    undoLog: [],        // [{time, book, added:{uid:{f:[w]}}, removed:{uid:{f:[w]}}}]
    addedReg: {},       // {book: {"uid:f": {word: lang}}}
    migratedLF: false,
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
    // 1.0.7 migration: "content chars > 0" used to mean "send a snippet"
    if (!Object.hasOwn(s, 'aiContext')) {
        s.aiContext = Number(s.contentChars) > 0 ? 'snippet' : 'keywords';
        if (!(Number(s.contentChars) > 0)) s.contentChars = defaultSettings.contentChars;
    }
    if (s.aiRules && s.aiRules.trim() === OLD_DEFAULT_RULES) s.aiRules = '';
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(defaultSettings[k]);
    }
    if (!Array.isArray(s.undoLog)) s.undoLog = [];
    if (!s.addedReg || typeof s.addedReg !== 'object') s.addedReg = {};
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

/** Writing system of a keyword: keywords are only compared with mentions in the same script. */
function scriptOf(kw) {
    if (RE_HANGUL.test(kw)) return 'hangul';
    if (RE_KANA.test(kw)) return 'kana';
    if (RE_HAN.test(kw)) return 'han';
    if (RE_LATIN.test(kw)) return 'latin';
    return 'other';
}

/** Does a keyword look like it is in one of these languages (script based; zh-CN/zh-TW can't be told apart)? */
function looksLike(kw, langs) {
    const sc = scriptOf(kw);
    return langs.some((l) => (l === 'ko' && sc === 'hangul') || (l === 'ja' && sc === 'kana') ||
        ((l === 'zh-CN' || l === 'zh-TW') && sc === 'han') || (l === 'en' && sc === 'latin'));
}

function cleanResult(s) {
    return String(s ?? '')
        .replace(/^[\s"'“”‘’「」『』《》【】]+|[\s"'“”‘’「」『』《》【】。．.,，、!！?？]+$/g, '')
        .trim();
}

const splitInput = (s) => String(s ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const entryTitle = (e) => (e.comment || (e.key || [])[0] || `#${e.uid}`).toString();

function countHits(hayLower, needle) {
    const n = norm(needle);
    if (!n || !hayLower) return 0;
    let c = 0, i = 0;
    while ((i = hayLower.indexOf(n, i)) !== -1) { c++; i += n.length; }
    return c;
}
/** Matches of a /regex/ keyword (1 or 0), safely. */
function regexHit(k, text) {
    try {
        const m = String(k).trim().match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
        const flags = m[2].replace('g', '');
        return new RegExp(m[1], flags.includes('i') ? flags : `${flags}i`).test(text) ? 1 : 0;
    } catch { return 0; }
}

// ---------- chat text ----------
/** All visible (not hidden) chat messages, for the "채팅 N회" counts in the translate preview. */
function chatMessages() {
    return (ctx().chat || []).filter((m) => !m.is_system && m.mes).map((m) => String(m.mes));
}
/** Hidden messages (/hide) are stored with is_system = true; ST's own UI notices carry another extra.type. */
const isHiddenMsg = (m) => !!m.is_system && !(m.extra?.type && m.extra.type !== 'narrator');

/** Messages for the diagnose tab, following its range + hidden settings. */
function rangeMessages() {
    const s = getSettings();
    const chat = ctx().chat || [];
    let list = chat.map((m, id) => ({ id, m })).filter(({ m }) => m.mes && (!m.is_system || (s.diagHidden && isHiddenMsg(m))));
    if (s.diagRange === 'recent') list = list.slice(-clampInt(s.diagMsgs, 1, 100000, 100));
    else if (s.diagRange === 'range') {
        const a = clampInt(s.diagFrom, 0, 1e7, 0), b = clampInt(s.diagTo, 0, 1e7, chat.length - 1);
        list = list.filter((x) => x.id >= Math.min(a, b) && x.id <= Math.max(a, b));
    }
    return list.map(({ id, m }) => ({ id, name: String(m.name || ''), text: String(m.mes) }));
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

/** Entry content sent with AI translation, per the "보낼 정보" choice ('' for keywords only). */
function entryContext(e) {
    const s = getSettings();
    const text = String(e.content || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || s.aiContext === 'keywords') return '';
    if (s.aiContext === 'snippet') return text.slice(0, clampInt(s.contentChars, 50, 5000, 300));
    // full: cap so a single giant entry still fits into one request
    const cap = Math.max(1000, clampInt(s.aiChunkChars, 3000, 100000, SPEED_DEFAULTS.aiChunkChars) - 2000);
    return text.length > cap ? `${text.slice(0, cap)} …(이하 생략)` : text;
}

/** Groups need-map keywords by entry and splits them into request-sized chunks (by keyword count and size). */
function buildAIChunks(need) {
    const s = getSettings();
    const limit = clampInt(s.aiBatch, 5, 100, SPEED_DEFAULTS.aiBatch);
    const maxChars = clampInt(s.aiChunkChars, 3000, 100000, SPEED_DEFAULTS.aiChunkChars);
    const byText = new Map(); // text → entry (first one wins)
    for (const m of need.values()) for (const [t, e] of m) if (!byText.has(t)) byText.set(t, e);
    const groups = new Map(); // uid → {entry, texts}
    for (const [t, e] of byText) {
        if (!groups.has(e.uid)) groups.set(e.uid, { entry: e, texts: [] });
        groups.get(e.uid).texts.push(t);
    }
    const chunks = [];
    let cur = [], n = 0, size = 0;
    for (const g of groups.values()) {
        const ctxSize = entryContext(g.entry).length + 200;
        // keep an entry's keywords together, but never let one huge entry blow past the limit
        for (let i = 0; i < g.texts.length; i += limit) {
            const piece = { entry: g.entry, texts: g.texts.slice(i, i + limit) };
            const pieceSize = ctxSize + piece.texts.join('').length + piece.texts.length * 6;
            if (cur.length && (n + piece.texts.length > limit || size + pieceSize > maxChars)) { chunks.push(cur); cur = []; n = 0; size = 0; }
            cur.push(piece); n += piece.texts.length; size += pieceSize;
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
        const others = (g.entry.key || []).concat(g.entry.keysecondary || []).filter((k) => !isRegexKey(k));
        if (others.length > 1) lines.push(`All keywords of this entry: ${others.join(', ')}`);
        const content = entryContext(g.entry);
        if (content) lines.push(`Content: ${content}`);
        for (const t of g.texts) { order.push(t); lines.push(`${order.length}. ${t}`); }
    }
    const prompt = [
        `Target languages: ${langDesc}.`,
        '',
        (s.aiRules || DEFAULT_RULES).trim(),
        s.aiHint ? `\n세계관 메모: ${s.aiHint}` : '',
        '',
        'Return ONLY a JSON object, no commentary. Keys are the numbers of the keywords below; each value maps target language codes to arrays of strings, plus optional "unsure": true, like {"1": {"zh-CN": ["..."]}, "2": {"zh-CN": ["...", "..."], "unsure": true}}.',
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
            if (row.unsure === true || row.unsure === 'true') out.set(`?\0${t}`, true); // AI wasn't sure about this keyword
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

// ---------- AI diagnosis prompt ----------
function buildDiagPrompt(entries, text) {
    const s = getSettings();
    const list = entries.map((e, i) => `E${i + 1}. ${entryTitle(e).slice(0, 60)} — keywords: ${(e.key || []).filter((k) => !isRegexKey(k)).join(', ')}`).join('\n');
    return [
        'Below is part of a roleplay (numbered messages) and a list of lorebook entries.',
        'For each entry that is mentioned in this text, list EVERY exact string in the text that refers to it: names, nicknames, titles, alternate spellings, or the same name in another language. Include strings that are already keywords.',
        '- Copy each string exactly as written in the text (same characters/script). Do not translate or invent.',
        '- Only clear references to that specific entry; skip generic words and pronouns.',
        '- Omit entries that are not mentioned.',
        s.aiHint ? `세계관 메모: ${s.aiHint}` : '',
        'Return ONLY a JSON object like {"E1": ["..."], "E4": ["..."]}.',
        '',
        'Entries:',
        list,
        '',
        'Text:',
        '"""',
        text,
        '"""',
    ].filter((x) => x !== '').join('\n');
}

/** Splits messages into text blocks of at most maxChars (a single long message is trimmed). */
function chunkMessages(msgs, maxChars) {
    const out = [];
    let cur = '';
    for (const m of msgs) {
        let line = `#${m.id} ${m.name}: ${m.text.replace(/\s+\n/g, '\n')}`;
        if (line.length > maxChars) line = line.slice(0, maxChars);
        if (cur && cur.length + line.length + 2 > maxChars) { out.push(cur); cur = ''; }
        cur += (cur ? '\n\n' : '') + line;
    }
    if (cur) out.push(cur);
    return out;
}

// ---------- server-side undo log + registry ----------
function pushUndo(rec) {
    const s = getSettings();
    s.undoLog.unshift(rec);
    s.undoLog.splice(MAX_UNDO);
    save();
}
function peekUndo() { return getSettings().undoLog[0] ?? null; }
function popUndo() { getSettings().undoLog.shift(); save(); }

/** words: {uid: {field: [w]}}; langOf(word) → lang code when adding */
function regAdd(book, words, langOf) {
    const s = getSettings();
    const b = (s.addedReg[book] ??= {});
    for (const [uid, fields] of Object.entries(words || {})) {
        for (const [f, list] of Object.entries(fields)) {
            const m = (b[`${uid}:${f}`] ??= {});
            for (const w of list) m[w] = langOf(uid, f, w);
        }
    }
    save();
}
function regRemove(book, words) {
    const b = getSettings().addedReg[book];
    if (!b) return;
    for (const [uid, fields] of Object.entries(words || {})) {
        for (const [f, list] of Object.entries(fields)) {
            const m = b[`${uid}:${f}`];
            if (!m) continue;
            for (const w of list) delete m[w];
            if (!Object.keys(m).length) delete b[`${uid}:${f}`];
        }
    }
    save();
}
/** {word: lang} of keywords this extension added to one entry field */
const regGet = (book, uid, f) => getSettings().addedReg[book]?.[`${uid}:${f}`] ?? {};

/** One-time import of the old browser-only storage (1.0.0–1.0.4). */
async function migrateFromBrowser() {
    const s = getSettings();
    if (s.migratedLF) return;
    try {
        const lf = SillyTavern.libs?.localforage ?? window.localforage;
        if (lf) {
            const oldUndo = (await lf.getItem('wikt_undo_v1')) || [];
            for (const r of oldUndo.reverse()) {
                s.undoLog.unshift(r.kind === 'remove' ? { time: r.time, book: r.book, removed: r.removed } : { time: r.time, book: r.book, added: r.added });
            }
            s.undoLog.sort((a, b) => b.time - a.time).splice(MAX_UNDO);
            const oldReg = (await lf.getItem('wikt_added_v1')) || {};
            for (const [book, fields] of Object.entries(oldReg)) {
                const b = (s.addedReg[book] ??= {});
                for (const [k, list] of Object.entries(fields)) {
                    const m = (b[k] ??= {});
                    for (const w of list || []) m[w] ??= detectLang(w);
                }
            }
        }
    } catch (e) { console.warn('[WIKT] migration skipped', e); }
    s.migratedLF = true;
    save();
}

// ---------- last results cache: one small JSON file per book in the user's ST files folder ----------
// (server-side so it survives reloads/devices; kept out of settings.json so settings stay small)
function hashName(str) {
    let h = 0x811c9dc5;
    for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}
const cacheFile = (book) => `wikt-cache-${hashName(book)}.json`;
function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
async function loadCache(book) {
    try {
        const res = await fetch(`/user/files/${cacheFile(book)}`, { cache: 'no-store' });
        if (!res.ok) return {};
        const data = await res.json();
        return data && data.book === book ? data : {};
    } catch { return {}; }
}
async function writeCache(book, cache) {
    const c = ctx();
    try {
        if (!cache.translate && !cache.diag) {
            await fetch('/api/files/delete', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ path: `user/files/${cacheFile(book)}` }) });
            return;
        }
        await fetch('/api/files/upload', {
            method: 'POST', headers: c.getRequestHeaders(),
            body: JSON.stringify({ name: cacheFile(book), data: toBase64Utf8(JSON.stringify({ ...cache, book })) }),
        });
    } catch (e) { console.warn('[WIKT] cache save failed', e); }
}
const cacheTimers = new Map();
function writeCacheSoon(book, getCache) {
    clearTimeout(cacheTimers.get(book));
    cacheTimers.set(book, setTimeout(() => { cacheTimers.delete(book); writeCache(book, getCache()); }, 1200));
}

// ---------- background job (one at a time, keeps running after the popup closes) ----------
let currentJob = null; // { book, kind, text, cancel, done, popupOpen }
const jobRunning = () => !!currentJob && !currentJob.done;

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

/**
 * Applies keyword additions/removals to a book in one go and records one undo step.
 * ops: [{uid, f, op:'add'|'remove', k, lang?}]. Never leaves an entry without primary keywords.
 */
async function applyOps(book, ops) {
    const c = ctx();
    const data = await c.loadWorldInfo(book); // fresh copy in case the editor changed it
    if (!data?.entries) throw new Error('로어북을 불러오지 못했어요.');
    const rec = { time: Date.now(), book, added: {}, removed: {} };
    const langs = new Map();
    let added = 0, removed = 0, kept = 0;
    const groups = new Map();
    for (const o of ops) {
        const key = `${o.uid}\0${o.f}`;
        if (!groups.has(key)) groups.set(key, { uid: o.uid, f: o.f, add: [], del: new Set() });
        const g = groups.get(key);
        if (o.op === 'add') { g.add.push(o.k); langs.set(`${o.uid}\0${o.f}\0${o.k}`, o.lang || detectLang(o.k)); } else g.del.add(o.k);
    }
    for (const { uid, f, add, del } of groups.values()) {
        const e = data.entries[uid];
        if (!e) continue;
        if (!Array.isArray(e[f])) e[f] = [];
        let next = e[f].filter((k) => !del.has(k));
        const seen = new Set(next.map(norm));
        const addNow = [];
        for (const k of add) { const n = norm(k); if (!n || seen.has(n)) continue; seen.add(n); addNow.push(k); }
        next = next.concat(addNow);
        if (f === 'key' && next.length === 0) { kept += del.size; continue; }
        const gone = e[f].filter((k) => del.has(k));
        if (!gone.length && !addNow.length) continue;
        e[f] = next;
        syncOriginal(data, uid, f, e[f]);
        if (gone.length) { (rec.removed[uid] ??= {})[f] = gone; removed += gone.length; }
        if (addNow.length) { (rec.added[uid] ??= {})[f] = addNow; added += addNow.length; }
    }
    if (added || removed) {
        await saveBook(book, data);
        pushUndo(rec);
        regAdd(book, rec.added, (uid, f, w) => langs.get(`${uid}\0${f}\0${w}`) || detectLang(w));
    }
    return { data, added, removed, kept, entries: new Set([...Object.keys(rec.added), ...Object.keys(rec.removed)]).size };
}

/** Reverts the latest undo step (removes what it added, puts back what it removed). */
async function undoLast() {
    const c = ctx();
    const rec = peekUndo();
    if (!rec) { toastr.info('되돌릴 기록이 없어요.'); return null; }
    const count = (w) => Object.values(w || {}).reduce((a, x) => a + Object.values(x).reduce((b, y) => b + y.length, 0), 0);
    const nAdd = count(rec.added), nDel = count(rec.removed);
    const parts = [nAdd ? `추가한 키워드 ${nAdd}개 지우기` : null, nDel ? `삭제한 키워드 ${nDel}개 다시 넣기` : null].filter(Boolean).join(', ');
    const ok = await c.Popup.show.confirm('되돌리기', `[${rec.book}] ${new Date(rec.time).toLocaleString()} 작업을 되돌려요: ${parts}. (그 뒤에 직접 바꾼 키워드는 그대로 둬요)`);
    if (!ok) return null;
    const data = await c.loadWorldInfo(rec.book);
    if (!data?.entries) { toastr.error(`로어북 "${rec.book}"을 찾지 못했어요. 이 기록은 건너뛸게요.`); popUndo(); return null; }
    let changed = 0;
    const uids = new Set([...Object.keys(rec.added || {}), ...Object.keys(rec.removed || {})]);
    for (const uid of uids) {
        const e = data.entries[uid];
        if (!e) continue;
        const fields = new Set([...Object.keys(rec.added?.[uid] || {}), ...Object.keys(rec.removed?.[uid] || {})]);
        for (const f of fields) {
            if (!Array.isArray(e[f])) e[f] = [];
            const before = e[f].length;
            const del = new Set(rec.added?.[uid]?.[f] || []);
            e[f] = e[f].filter((k) => !del.has(k));
            const seen = new Set(e[f].map(norm));
            for (const k of rec.removed?.[uid]?.[f] || []) if (!seen.has(norm(k))) { e[f].push(k); seen.add(norm(k)); }
            changed += Math.abs(e[f].length - before);
            syncOriginal(data, uid, f, e[f]);
        }
    }
    await saveBook(rec.book, data);
    popUndo();
    regRemove(rec.book, rec.added);
    toastr.success(`되돌렸어요. (${parts})`, rec.book);
    return { book: rec.book, data };
}

// ---------- main popup ----------
async function openTranslator(presetBook) {
    const c = ctx();
    const s = getSettings();
    const books = c.getWorldInfoNames();
    if (!books.length) { toastr.info('월드인포(로어북)가 하나도 없어요.'); return; }

    const state = { book: books.includes(presetBook) ? presetBook : books[0], data: null, scope: 'all', picked: new Set(), rows: [], busy: false, job: null, cache: {} };
    const isCancelled = () => !!state.job?.cancel;

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
    // what the AI gets to see when translating
    const ctxRadios = Object.entries(AI_CONTEXTS).map(([k, label]) => {
        const r = el('input', { type: 'radio', name: 'wikt_ctx', value: k, checked: s.aiContext === k });
        r.addEventListener('change', () => { if (r.checked) { s.aiContext = k; save(); updateVisibility(); } });
        return el('label', {}, r, ` ${label}`);
    });
    const snippetNum = el('input', { class: 'text_pole wikt-num', type: 'number', min: 50, max: 5000, step: 50, value: s.contentChars });
    snippetNum.addEventListener('input', () => { s.contentChars = clampInt(snippetNum.value, 50, 5000, 300); save(); });
    snippetNum.addEventListener('change', () => { snippetNum.value = s.contentChars; });
    const snippetBox = el('span', { class: 'wikt-inline' }, '앞 ', snippetNum, '자');
    const ctxNote = el('small', { class: 'wikt-note' });
    const ctxBox = el('div', { class: 'wikt-ctxbox' },
        el('div', { class: 'wikt-row' }, el('b', { text: 'AI에게 보낼 정보' }), ctxRadios[0], ctxRadios[1], snippetBox, ctxRadios[2]),
        ctxNote);
    const hintBox = el('div', { class: 'wikt-hint' }, el('small', { text: 'AI에게 줄 세계관 메모 (선택)' }), hintArea);
    const aiInfo = el('small', { class: 'wikt-note' });

    const status = el('div', { class: 'wikt-status' });
    const runBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-magnifying-glass' }), el('span', { text: '스캔 & 번역' }));
    const stopBtn = el('div', { class: 'menu_button', text: '중지', style: 'display:none' });
    const undoBtn = el('div', { class: 'menu_button menu_button_icon', title: '마지막 작업(추가/삭제)을 취소해요. 창을 닫거나 새로고침해도 기록이 남아요.' }, el('i', { class: 'fa-solid fa-rotate-left' }), el('span', { text: '마지막 작업 되돌리기' }));

    const preview = el('div', { class: 'wikt-preview' });
    const applyBtn = el('div', { class: 'menu_button menu_button_icon wikt-apply', style: 'display:none' }, el('i', { class: 'fa-solid fa-check' }), el('span', { text: '체크한 항목 적용' }));
    const clearTransBtn = el('div', { class: 'menu_button menu_button_icon', style: 'display:none', title: '저장된 번역 결과(미리보기)를 지워요. 로어북은 안 바뀌어요.' }, el('i', { class: 'fa-solid fa-eraser' }), el('span', { text: '결과 지우기' }));

    function updateVisibility() {
        const otherIsAI = provSel.value !== 'ai';
        cmpLabelText.textContent = otherIsAI
            ? ' 교차 비교: AI 번역과 비교해서 다른 것만 ⚠️ (AI 토큰 소모)'
            : ' 교차 비교: Google 번역과 비교해서 다른 것만 ⚠️ (무료)';
        backSel.style.display = backCb.checked ? '' : 'none';
        const usesAI = provSel.value === 'ai' || (cmpCb.checked && otherIsAI) || (backCb.checked && backSel.value === 'ai');
        hintBox.style.display = usesAI ? '' : 'none';
        aiInfo.textContent = usesAI ? `AI 연결: ${profileName()} · 바꾸려면 설정 탭` : '';
        snippetBox.style.display = s.aiContext === 'snippet' ? '' : 'none';
        const aiTranslates = provSel.value === 'ai' || (cmpCb.checked && otherIsAI);
        ctxBox.classList.toggle('wikt-dim', !aiTranslates);
        ctxNote.textContent = !aiTranslates
            ? 'Google/Bing은 키워드를 한 단어씩 따로 번역해서 이 선택이 적용되지 않아요. 고유명사가 중요하면 번역 방식을 AI로 바꾸거나 교차 비교(AI)를 켜 주세요.'
            : ({
                keywords: '가장 저렴해요. 제목과 같은 엔트리의 다른 키워드로만 뜻을 추측해서, 소리만 같은 한자(청명 → 清明/晴明)를 헷갈릴 수 있어요.',
                snippet: '엔트리 설명 앞부분을 근거로 써요. 보통 이 정도면 고유명사를 잘 잡아요. 토큰은 키워드만보다 몇 배 늘어요.',
                full: '엔트리 내용 전체를 보내요. 가장 정확하지만 토큰이 가장 많이 들어요. (본문은 AI 연결로만 가고 구글/빙으로는 절대 안 가요)',
            })[s.aiContext];
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
        ctxBox,
        hintBox,
        aiInfo,
        el('small', { class: 'wikt-note', text: '항상 켜짐(파란불) 엔트리와 정규식(/.../) 키워드는 건너뛰어요. 로어북과 범위(전체/선택)는 진단 탭에도 똑같이 적용돼요.' }),
        el('div', { class: 'wikt-row' }, runBtn, stopBtn, undoBtn),
        status,
        preview,
        el('div', { class: 'wikt-row' }, applyBtn, clearTransBtn),
    );

    // ===== settings tab =====
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
    const profNote = el('small', { class: 'wikt-note', text: '저장된 연결 프로필이 없어서 현재 연결만 쓸 수 있어요. (API 연결 화면의 Connection Profile에서 저장 가능)' });
    function fillProfiles() {
        const profiles = getProfiles();
        profSel.replaceChildren(
            el('option', { value: '', text: '현재 연결 (지금 채팅에 쓰는 API)' }),
            ...profiles.map((p) => el('option', { value: p.id, text: `프로필: ${p.name}` })));
        profSel.value = profiles.some((p) => p.id === s.aiProfile) ? s.aiProfile : '';
        profNote.style.display = profiles.length ? 'none' : '';
    }
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
        el('small', { class: 'wikt-note', text: '키워드만 / 본문 일부 / 월드인포 전문 선택은 번역 탭에 있어요. 본문은 AI 연결로만 가고 구글/빙으로는 절대 안 가요.' }),
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
        numField('AI 번역: 한 번에 보내는 최대 글자 수', 'aiChunkChars', 3000, 100000, 1000, `추천 ${SPEED_DEFAULTS.aiChunkChars} · 본문/전문을 보낼 때 이 크기를 넘으면 나눠서 보내요`),
        numField('AI 진단: 한 번에 보내는 채팅 글자 수', 'diagChunkChars', 1000, 60000, 500, `추천 ${SPEED_DEFAULTS.diagChunkChars} · 범위가 길면 이 크기로 나눠서 보내요`),
        numField('AI 진단: 한 번에 보내는 엔트리 수', 'chatEntries', 5, 200, 5, `추천 ${SPEED_DEFAULTS.chatEntries}`),
        el('div', { class: 'wikt-row' }, el('div', {
            class: 'menu_button', text: '속도 설정 추천값으로 복원',
            onclick: () => { for (const [k, v] of Object.entries(SPEED_DEFAULTS)) { s[k] = v; numInputs[k].value = v; } save(); toastr.info('추천값으로 되돌렸어요.'); },
        })),
        el('small', { class: 'wikt-note', text: '실패하면 잠깐(3초 이상) 쉬고 한 번만 다시 시도해요. 그래도 안 되면 거기서 멈추고, 그때까지 된 것만 보여줘요.' }),
        el('h4', { text: '기타' }),
        el('label', { class: 'checkbox_label' }, wiCb, el('span', { text: '월드인포 편집창에 번역 버튼 표시' })),
        el('small', { class: 'wikt-note', text: `되돌리기 기록(최근 ${MAX_UNDO}개)과 "확장이 추가한 키워드" 기록은 실리태번 설정에 저장돼서, 새로고침·다른 기기에서도 유지돼요.` }),
    );
    fillProfiles();

    // ===== diagnose tab =====
    const diagBookLabel = el('b', {});
    const diagRangeSel = el('select', { class: 'text_pole wikt-inline-select' },
        el('option', { value: 'recent', text: '최근 N개 메시지' }),
        el('option', { value: 'range', text: '메시지 번호 지정' }),
        el('option', { value: 'all', text: '채팅 전체' }));
    diagRangeSel.value = s.diagRange;
    const recentRow = numField('최근 메시지 수', 'diagMsgs', 1, 100000, 10, '추천 100');
    const rangeRow = el('div', { class: 'wikt-row' },
        numField('시작 #', 'diagFrom', 0, 10000000, 1), numField('끝 #', 'diagTo', 0, 10000000, 1),
        el('small', { class: 'wikt-note', text: '메시지 위에 보이는 #번호 기준' }));
    const updateRangeUI = () => {
        recentRow.style.display = s.diagRange === 'recent' ? '' : 'none';
        rangeRow.style.display = s.diagRange === 'range' ? '' : 'none';
    };
    diagRangeSel.addEventListener('change', () => { s.diagRange = diagRangeSel.value; save(); updateRangeUI(); });
    const diagHiddenCb = el('input', { type: 'checkbox', checked: s.diagHidden });
    diagHiddenCb.addEventListener('change', () => { s.diagHidden = diagHiddenCb.checked; save(); });
    const diagScopeSel = el('select', { class: 'text_pole wikt-inline-select' },
        el('option', { value: 'added', text: '이 확장이 추가한 키워드만 (추천)' }),
        el('option', { value: 'all', text: '모든 키워드 (직접 넣은 것 포함)' }));
    diagScopeSel.value = s.diagScope;
    diagScopeSel.addEventListener('change', () => { s.diagScope = diagScopeSel.value; save(); refreshDiagBadge(); });
    const diagSecCb = el('input', { type: 'checkbox', checked: s.diagSecondary });
    diagSecCb.addEventListener('change', () => { s.diagSecondary = diagSecCb.checked; save(); refreshDiagBadge(); });

    const diagStatus = el('div', { class: 'wikt-status' });
    const diagList = el('div', { class: 'wikt-preview' });
    const quickBtn = el('div', { class: 'menu_button menu_button_icon', title: '키워드 글자가 채팅에 나왔는지만 세요. 토큰 0' }, el('i', { class: 'fa-solid fa-stethoscope' }), el('span', { text: '빠른 진단 (무료)' }));
    const aiDiagBtn = el('div', { class: 'menu_button menu_button_icon', title: 'AI가 채팅을 읽고 엔트리 언급을 찾아요. 실제 표기 학습 + 잘못된 키워드 찾기' }, el('i', { class: 'fa-solid fa-brain' }), el('span', { text: 'AI 정밀 진단' }));
    const diagStopBtn = el('div', { class: 'menu_button', text: '중지', style: 'display:none' });
    const diagApplyBtn = el('div', { class: 'menu_button menu_button_icon', style: 'display:none' }, el('i', { class: 'fa-solid fa-check' }), el('span', { text: '체크한 항목 적용' }));
    const diagUndoBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-rotate-left' }), el('span', { text: '마지막 작업 되돌리기' }));
    const clearDiagBtn = el('div', { class: 'menu_button menu_button_icon', style: 'display:none', title: '저장된 진단 결과를 지워요. 로어북은 안 바뀌어요.' }, el('i', { class: 'fa-solid fa-eraser' }), el('span', { text: '결과 지우기' }));

    // language cleanup (before re-translating)
    const cleanLangBoxes = LANGS.map((l) => {
        const cb = el('input', { type: 'checkbox', value: l.code, checked: s.cleanLangs.includes(l.code) });
        cb.addEventListener('change', () => { s.cleanLangs = cleanLangBoxes.filter((x) => x.checked).map((x) => x.value); save(); });
        return cb;
    });
    const cleanChatCb = el('input', { type: 'checkbox', value: 'chat', checked: s.cleanLangs.includes('chat') });
    cleanChatCb.addEventListener('change', () => {
        s.cleanLangs = s.cleanLangs.filter((x) => x !== 'chat').concat(cleanChatCb.checked ? ['chat'] : []); save();
    });
    const cleanScopeSel = el('select', { class: 'text_pole wikt-inline-select' },
        el('option', { value: 'added', text: '이 확장이 추가한 키워드만 (언어 기록으로 정확히)' }),
        el('option', { value: 'all', text: '모든 키워드 (글자 종류로 추정)' }));
    cleanScopeSel.value = s.cleanScope;
    cleanScopeSel.addEventListener('change', () => { s.cleanScope = cleanScopeSel.value; save(); });
    const cleanBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-broom' }), el('span', { text: '지울 키워드 미리보기' }));

    const tabDiag = el('div', { class: 'wikt-tab', style: 'display:none' },
        el('div', { class: 'wikt-row' }, el('b', { text: '로어북' }), diagBookLabel, el('small', { class: 'wikt-note', text: '(로어북·엔트리 범위는 번역 탭에서 바꿔요)' })),
        el('h4', { text: '읽을 채팅 범위' }),
        el('div', { class: 'wikt-row' }, diagRangeSel, el('label', {}, diagHiddenCb, ' 숨긴 메시지도 포함')),
        recentRow,
        rangeRow,
        el('h4', { text: '점검할 키워드' }),
        el('div', { class: 'wikt-row' }, diagScopeSel, el('label', {}, diagSecCb, ' 보조 키워드도')),
        el('small', { class: 'wikt-note', text: '빠른 진단: 같은 글자 종류(한자/한글/라틴/가나)의 다른 키워드는 걸렸는데 이 키워드만 안 걸렸으면 삭제 추천. 토큰 0.' }),
        el('small', { class: 'wikt-note', text: 'AI 정밀 진단: AI가 채팅을 읽고 엔트리가 어떻게 불렸는지 찾아요 → ① 실제로 쓰인 표기를 키워드로 추가(학습) ② 언급은 됐는데 안 걸린 같은 글자 종류의 키워드는 삭제 추천. 채팅 범위만큼 토큰이 들어요.' }),
        el('div', { class: 'wikt-row' }, quickBtn, aiDiagBtn, diagStopBtn, diagUndoBtn),
        diagStatus,
        diagList,
        el('div', { class: 'wikt-row' }, diagApplyBtn, clearDiagBtn),
        el('details', { class: 'wikt-clean' },
            el('summary', { text: '언어별 키워드 지우기 (다시 번역하기 전에)' }),
            el('div', { class: 'wikt-row' }, el('b', { text: '지울 언어' }),
                LANGS.map((l, i) => el('label', {}, cleanLangBoxes[i], ` ${l.label}`)),
                el('label', {}, cleanChatCb, ' 채팅에서 학습한 표기')),
            el('div', { class: 'wikt-row' }, el('b', { text: '대상' }), cleanScopeSel),
            el('small', { class: 'wikt-note', text: '"모든 키워드"는 글자 종류로 추정해서 간체/번체를 구분하지 못하고, 한자만 있는 일본어 키워드는 중국어로 잡혀요. 미리보기에서 꼭 확인하세요. 키워드가 하나도 안 남는 엔트리는 하나를 남겨둬요.' }),
            el('div', { class: 'wikt-row' }, cleanBtn)),
    );
    updateRangeUI();

    // ===== tabs =====
    const tabBtnT = el('div', { class: 'wikt-tabbtn active', text: '번역' });
    const tabBtnD = el('div', { class: 'wikt-tabbtn', text: '진단', title: '채팅에서 안 걸리는 키워드 정리, 실제 표기 학습' });
    const tabBtnS = el('div', { class: 'wikt-tabbtn', text: '설정' });
    const showTab = (which) => {
        tabTranslate.style.display = which === 't' ? '' : 'none';
        tabDiag.style.display = which === 'd' ? '' : 'none';
        tabSettings.style.display = which === 's' ? '' : 'none';
        tabBtnT.classList.toggle('active', which === 't');
        tabBtnD.classList.toggle('active', which === 'd');
        tabBtnS.classList.toggle('active', which === 's');
        if (which === 's') fillProfiles();
        updateVisibility();
        diagBookLabel.textContent = state.book + (state.scope === 'pick' ? ` · 선택한 엔트리 ${state.picked.size}개` : ' · 전체 엔트리');
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
        clearTransBtn.style.display = 'none';
        status.textContent = '';
        renderPickList();
        clearDiag();
        refreshDiagBadge();
        await restoreFromCache();
        if (jobRunning() && currentJob.book === state.book) attachToJob(currentJob);
    }

    // --- last results cache (per book, server file) ---
    const plainRows = () => state.rows.map((r) => ({ uid: r.uid, title: r.title, adds: r.adds, checked: r.checked !== false, value: r.value || null }));
    const plainDiag = (d) => ({ rows: (d?.rows || []).map((r) => ({ ...r, items: r.items.map(({ cb, ...it }) => it) })) });
    const stamp = (t) => new Date(t).toLocaleString();
    function persistTranslate() {
        if (!state.cache.translate) return;
        state.cache.translate.rows = plainRows();
        const book = state.book, cache = state.cache;
        writeCacheSoon(book, () => cache);
    }
    function persistDiag() {
        if (!state.cache.diag) return;
        state.cache.diag.rows = plainDiag(state.diag).rows;
        const book = state.book, cache = state.cache;
        writeCacheSoon(book, () => cache);
    }

    /** Drops cached suggestions the book no longer needs (already added, removed, entry gone). */
    function reconcileTranslate(rows) {
        const out = [];
        for (const r of rows || []) {
            const e = state.data?.entries?.[r.uid];
            if (!e) continue;
            const adds = {};
            const value = {};
            for (const [f, list] of Object.entries(r.adds || {})) {
                const have = new Set((e[f] || []).map(norm));
                const keep = list.filter((a) => !have.has(norm(a.t)));
                const v = r.value?.[f] != null ? splitInput(r.value[f]).filter((w) => !have.has(norm(w))).join(', ') : null;
                if (keep.length || v) { adds[f] = keep.length ? keep : list.filter((a) => splitInput(v).includes(a.t)); if (v != null) value[f] = v; }
            }
            if (Object.keys(adds).length) out.push({ ...r, adds, value: Object.keys(value).length ? value : null });
        }
        return out;
    }
    function reconcileDiag(rows) {
        const out = [];
        for (const r of rows || []) {
            const e = state.data?.entries?.[r.uid];
            if (!e) continue;
            const items = r.items.filter((it) => {
                const has = (e[it.f] || []).some((k) => norm(k) === norm(it.k));
                return it.op === 'add' ? !has : has;
            });
            if (items.length) out.push({ ...r, items });
        }
        return out;
    }

    async function restoreFromCache() {
        const book = state.book;
        const cache = await loadCache(book);
        if (state.book !== book) return; // book switched meanwhile
        state.cache = cache;
        if (cache.translate) {
            state.rows = reconcileTranslate(cache.translate.rows);
            if (state.rows.length) {
                renderPreview();
                status.textContent = `📌 마지막 결과를 불러왔어요 (${stamp(cache.translate.time)}) — 엔트리 ${state.rows.length}개. ${cache.translate.status || ''}`;
            } else delete cache.translate;
        }
        if (cache.diag) {
            const rows = reconcileDiag(cache.diag.rows);
            if (rows.length) renderDiag({ rows }, `📌 마지막 진단 결과를 불러왔어요 (${stamp(cache.diag.time)}). ${cache.diag.summary || ''}`);
            else delete cache.diag;
        }
        if (!cache.translate && !cache.diag && (cache.book)) writeCache(book, cache); // nothing left → remove the file
    }

    // --- background jobs ---
    function beginJob(kind) {
        currentJob = { book: state.book, kind, text: '', cancel: false, done: false, popupOpen: true };
        state.job = currentJob;
        setBusy(true);
        return currentJob;
    }
    function endJob(job, doneText) {
        job.done = true;
        job.text = doneText;
        if (!job.popupOpen) toastr.success(`${doneText} — 번역기를 다시 열면 결과가 있어요.`, `${job.book} · 백그라운드 작업 완료`, { timeOut: 10000 });
        if (state.job === job) setBusy(false);
    }
    /** Re-opened while a job is running: show its progress and load the results once it finishes. */
    function attachToJob(job) {
        state.job = job;
        job.popupOpen = true;
        setBusy(true);
        const target = job.kind === 'translate' ? status : diagStatus;
        if (job.kind !== 'translate') showTab('d');
        const tick = async () => {
            if (state.closed) { clearInterval(timer); return; }
            if (!job.done) { target.textContent = `⏳ 백그라운드에서 진행 중 — ${job.text || '준비 중'}`; return; }
            clearInterval(timer);
            setBusy(false);
            await restoreFromCache();
        };
        const timer = setInterval(tick, 500);
        tick();
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

    // --- shared helpers ---
    function setBusy(b) {
        state.busy = b;
        for (const x of [runBtn, applyBtn, quickBtn, aiDiagBtn, diagApplyBtn, cleanBtn, undoBtn, diagUndoBtn, clearTransBtn, clearDiagBtn]) x.classList.toggle('disabled', b);
        bookSel.disabled = b;
        const isJob = b && state.job && !state.job.done;
        stopBtn.style.display = isJob ? '' : 'none';
        diagStopBtn.style.display = isJob ? '' : 'none';
    }
    /** Blocks a new action while something runs; explains when another book's job is running. */
    function blocked() {
        if (jobRunning() && currentJob.book !== state.book) {
            toastr.warning(`다른 로어북("${currentJob.book}")에서 작업이 진행 중이에요. 끝난 뒤에 해 주세요.`);
            return true;
        }
        return state.busy || jobRunning();
    }
    const onStop = () => {
        if (state.job) state.job.cancel = true;
        status.textContent = diagStatus.textContent = '중지하는 중… (지금 보내는 요청이 끝나면 멈춰요)';
    };
    stopBtn.addEventListener('click', onStop);
    diagStopBtn.addEventListener('click', onStop);

    function phase(label, total, target = status) {
        let done = 0;
        const set = (t) => { target.textContent = t; if (state.job) state.job.text = t; };
        set(`${label}… 0 / ${total}`);
        return (n) => { done += n; set(`${label}… ${Math.min(done, total)} / ${total}`); };
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
    function profileName() {
        const p = getProfiles().find((x) => x.id === s.aiProfile);
        return p ? `프로필 "${p.name}"` : '현재 연결';
    }

    // ===== translate =====
    runBtn.addEventListener('click', async () => {
        if (blocked()) return;
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
            const what = `키워드 ${uniq.size}개 + 엔트리 제목` + ({ keywords: ' (본문 X)', snippet: ` + 본문 앞 ${s.contentChars}자`, full: ' + 월드인포 전문' })[s.aiContext];
            const msg = `${profileName()}로 AI ${uses}을 해요.\n번역 단계: ${what}, 요청 ${chunks.length}번 · 약 ${chars.toLocaleString()}자` +
                (aiBack ? '\n역번역 단계: 번역 결과 개수만큼 추가 요청' : '') + '\n진행할까요?';
            const ok = await c.Popup.show.confirm('AI 사용 확인', msg);
            if (!ok) return;
        }

        const job = beginJob('translate');
        const book = state.book, cache = state.cache;
        const results = new Map();
        let other = null;
        const back = new Map();
        try {
            if (aiMain) await aiTranslateNeed(need, phase('AI 번역 중', total), isCancelled, results);
            else await freeTranslateNeed(provider, need, phase('번역 중', total), isCancelled, results);

            if (s.verifyCompare && !isCancelled()) {
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
                            adds.push({ t, src, lang: l, alt, unsure: results.has(`?\0${src}`) || undefined });
                        }
                    }
                }
                if (adds.length) row.adds[f] = adds;
            }
            if (Object.keys(row.adds).length) state.rows.push(row);
        }

        // back-translation of every proposed keyword into its source keyword's language
        if (s.verifyBack && !isCancelled() && state.rows.length) {
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
                    if (isCancelled()) break;
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
        const hay = norm(chatMessages().join('\n'));
        for (const r of state.rows) for (const a of Object.values(r.adds).flat()) a.hits = hay ? countHits(hay, a.t) : null;
        const warn = state.rows.reduce((x, r) => x + Object.values(r.adds).flat().filter(isSuspicious).length, 0);
        const summary = `${job.cancel ? '중지됨 — 지금까지 된 것: ' : '완료 — '}새 키워드가 생긴 엔트리 ${state.rows.length}개` +
            `${warn ? `, 확인이 필요한 키워드 ⚠️ ${warn}개` : ''}.${state.rows.length ? " 확인 후 '적용'을 눌러주세요." : ''}`;
        // save first, so a re-opened window (or another device) can load it as soon as the job is done
        if (state.rows.length) cache.translate = { time: Date.now(), rows: plainRows(), status: summary };
        else delete cache.translate;
        await writeCache(book, cache);
        renderPreview();
        status.textContent = summary;
        endJob(job, summary.split('.')[0]);
    });

    const backOk = (a) => a.back != null && normLoose(a.back) === normLoose(a.src);
    const cmpOk = (a) => a.alt != null && a.alt.some((x) => norm(x) === norm(a.t));
    // Cross-check beats back-translation: if both methods agree, a mismatching back-translation
    // (e.g. romanized names like Cheongmyeong → 清明 → Qingming) is not a warning.
    function isSuspicious(a) {
        if (a.alt != null) return !cmpOk(a);
        if (a.orig != null) return false;
        if (a.unsure) return true;
        return a.back != null && !backOk(a);
    }

    function replaceInInput(inp, from, to) {
        const parts = splitInput(inp.value).map((x) => (x === from ? to : x));
        inp.value = [...new Set(parts)].join(', ');
    }

    function renderChecks(adds, inp, onChange) {
        const anyCheck = adds.some((a) => a.back != null || a.alt != null || a.hits != null || a.unsure);
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
            onChange();
        };
        const makeChip = (a) => {
            const bad = isSuspicious(a);
            const parts = [el('b', { text: a.t }), el('small', { class: 'wikt-src', text: ` ← ${a.src} · ${langLabel(a.lang)}` })];
            if (a.hits != null) parts.push(el('small', { class: a.hits ? 'wikt-ok' : 'wikt-src', text: ` · 채팅 ${a.hits}회` }));
            if (a.unsure && a.orig == null) parts.push(el('small', { class: 'wikt-bad', text: ' · AI가 확신 못함 — 후보 중 맞는 것만 남기세요' }));
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
        const has = state.rows.length > 0;
        applyBtn.style.display = has ? '' : 'none';
        clearTransBtn.style.display = has ? '' : 'none';
        if (!has) return;
        const master = el('input', { type: 'checkbox', checked: state.rows.every((r) => r.checked !== false) });
        master.addEventListener('change', () => {
            for (const r of state.rows) { r.checked = master.checked; r.cb.checked = master.checked; }
            persistTranslate();
        });
        preview.append(el('label', { class: 'wikt-master' }, master, ' 전체 체크'));
        for (const r of state.rows) {
            const e = state.data.entries[r.uid];
            const cb = el('input', { type: 'checkbox', checked: r.checked !== false });
            cb.addEventListener('change', () => { r.checked = cb.checked; persistTranslate(); });
            r.cb = cb;
            r.inputs = {};
            const item = el('div', { class: 'wikt-item' },
                el('label', {}, cb, ' ', el('b', { text: r.title })),
                el('small', { class: 'wikt-keys', text: `기존: ${(e?.key || []).join(', ')}` }));
            for (const [f, adds] of Object.entries(r.adds)) {
                const inp = el('input', { class: 'text_pole', type: 'text', value: r.value?.[f] ?? adds.map((a) => a.t).join(', ') });
                const remember = () => { (r.value ??= {})[f] = inp.value; persistTranslate(); };
                inp.addEventListener('input', remember);
                r.inputs[f] = inp;
                item.append(el('div', { class: 'wikt-addrow' }, el('small', { text: f === 'key' ? '+ 추가 키워드' : '+ 보조 키워드' }), inp));
                const checks = renderChecks(adds, inp, remember);
                if (checks) item.append(checks);
            }
            if (Object.values(r.adds).flat().some(isSuspicious)) item.classList.add('has-warn');
            preview.append(item);
        }
    }

    clearTransBtn.addEventListener('click', () => {
        if (blocked()) return;
        state.rows = [];
        delete state.cache.translate;
        writeCache(state.book, state.cache);
        renderPreview();
        status.textContent = '저장된 번역 결과를 지웠어요.';
    });

    applyBtn.addEventListener('click', async () => {
        if (blocked() || !state.rows.length) return;
        const ops = [];
        for (const r of state.rows) {
            if (!r.cb.checked) continue;
            for (const [f, inp] of Object.entries(r.inputs)) {
                const langByWord = new Map((r.adds[f] || []).map((a) => [a.t, a.lang]));
                for (const k of splitInput(inp.value)) ops.push({ uid: r.uid, f, op: 'add', k, lang: langByWord.get(k) || detectLang(k) });
            }
        }
        if (!ops.length) { toastr.info('추가할 키워드가 없어요.'); return; }
        setBusy(true);
        try {
            const res = await applyOps(state.book, ops);
            state.data = res.data;
            if (!res.added) { toastr.info('새로 추가할 키워드가 없어요. (이미 다 있어요)'); return; }
            toastr.success(`엔트리 ${res.entries}개에 키워드 ${res.added}개를 추가했어요.`, state.book);
            state.rows = [];
            delete state.cache.translate;
            writeCache(state.book, state.cache);
            renderPreview();
            renderPickList();
            status.textContent = '적용 완료! 잘못됐으면 "마지막 작업 되돌리기"를 눌러주세요. (창을 닫거나 새로고침해도 돼요)';
            refreshDiagBadge();
        } catch (e) {
            reportError(e, '저장 실패');
        } finally {
            setBusy(false);
        }
    });

    async function onUndo() {
        if (blocked()) return;
        const r = await undoLast();
        if (r && r.book === state.book) { state.data = r.data; renderPickList(); clearDiag(); refreshDiagBadge(); }
    }
    undoBtn.addEventListener('click', onUndo);
    diagUndoBtn.addEventListener('click', onUndo);

    // ===== diagnose =====
    function clearDiag() {
        state.diag = null;
        diagList.replaceChildren();
        diagApplyBtn.style.display = 'none';
        clearDiagBtn.style.display = 'none';
        diagStatus.textContent = '';
    }
    /** Saves a diagnose/cleanup result as this book's last diag result (or removes it when empty). */
    async function saveDiagResult(book, cache, d, summary) {
        if (d?.rows?.length) cache.diag = { time: Date.now(), rows: plainDiag(d).rows, summary };
        else delete cache.diag;
        await writeCache(book, cache);
    }
    clearDiagBtn.addEventListener('click', () => {
        if (blocked()) return;
        delete state.cache.diag;
        writeCache(state.book, state.cache);
        clearDiag();
        diagStatus.textContent = '저장된 진단 결과를 지웠어요.';
    });

    /** Free check: zero-hit keywords whose entry matched through another keyword in the same script. */
    function quickDiagnose() {
        const msgs = rangeMessages();
        if (!msgs.length) return null;
        const text = msgs.map((m) => m.text).join('\n');
        const hay = norm(text);
        const fields = s.diagSecondary ? ['key', 'keysecondary'] : ['key'];
        const rows = [];
        let recommended = 0;
        for (const e of targetEntries()) {
            const hitScripts = new Map(); // script → hits of primary keywords
            let entryHits = 0;
            for (const k of e.key || []) {
                const h = isRegexKey(k) ? regexHit(k, text) : countHits(hay, k);
                entryHits += h;
                if (h && !isRegexKey(k)) hitScripts.set(scriptOf(k), (hitScripts.get(scriptOf(k)) || 0) + h);
            }
            const items = [];
            for (const f of fields) {
                const mine = regGet(state.book, e.uid, f);
                for (const k0 of e[f] || []) {
                    const k = String(k0);
                    if (!k.trim() || isRegexKey(k)) continue;
                    if (s.diagScope === 'added' && !(k in mine)) continue;
                    if (countHits(hay, k) > 0) continue;
                    const sameScript = hitScripts.get(scriptOf(k)) || 0;
                    if (sameScript) {
                        recommended++;
                        items.push({ op: 'remove', f, k, checked: true, mine: k in mine, note: `같은 글자 종류의 다른 키워드는 ${sameScript}회 걸렸는데 이건 0회 → 삭제 추천` });
                    } else if (!entryHits) {
                        items.push({ op: 'remove', f, k, checked: false, mine: k in mine, note: '엔트리 자체가 아직 안 나옴 → 보류' });
                    }
                }
            }
            if (items.length) rows.push({ uid: String(e.uid), title: entryTitle(e), info: entryHits ? `이 엔트리는 범위 안에서 ${entryHits}회 걸렸어요` : '이 엔트리는 범위 안에서 안 걸렸어요', items });
        }
        return { rows, recommended, msgCount: msgs.length };
    }

    async function refreshDiagBadge() {
        try {
            const d = state.data ? quickDiagnose() : null;
            tabBtnD.textContent = d?.recommended ? `진단 (${d.recommended})` : '진단';
        } catch (e) { console.warn('[WIKT] diag badge', e); }
    }

    function renderDiag(d, summary) {
        diagList.replaceChildren();
        diagApplyBtn.style.display = 'none';
        clearDiagBtn.style.display = 'none';
        state.diag = d;
        diagStatus.textContent = summary;
        if (!d?.rows?.length) return;
        const master = el('input', { type: 'checkbox' });
        master.addEventListener('change', () => {
            for (const r of d.rows) for (const it of r.items) { it.cb.checked = master.checked; it.picked = master.checked; }
            persistDiag();
        });
        diagList.append(el('label', { class: 'wikt-master' }, master, ' 전체 체크/해제'));
        for (const r of d.rows) {
            const item = el('div', { class: 'wikt-item' }, el('b', { text: r.title }), r.info ? el('small', { class: 'wikt-src', text: r.info }) : null);
            for (const it of r.items) {
                // it.checked = recommendation (drives the color); it.picked = the user's current tick
                const cb = el('input', { type: 'checkbox', checked: it.picked ?? it.checked });
                cb.addEventListener('change', () => { it.picked = cb.checked; persistDiag(); });
                it.cb = cb;
                item.append(el('label', { class: 'wikt-diagrow' }, cb, ' ',
                    el('span', { class: it.op === 'add' ? 'wikt-op-add' : 'wikt-op-del', text: it.op === 'add' ? '+ 추가' : '− 삭제' }), ' ',
                    el('b', { text: it.k }),
                    it.f === 'keysecondary' ? el('small', { class: 'wikt-tag', text: '보조' }) : null,
                    it.mine ? el('small', { class: 'wikt-tag', text: '확장이 추가' }) : null,
                    el('small', { class: it.checked ? (it.op === 'add' ? 'wikt-ok' : 'wikt-bad') : 'wikt-src', text: ` ${it.note || ''}` })));
            }
            diagList.append(item);
        }
        diagApplyBtn.style.display = '';
        clearDiagBtn.style.display = '';
    }

    const rangeLabel = (msgs) => `${msgs.length}개 메시지 (#${msgs[0].id} ~ #${msgs[msgs.length - 1].id}${s.diagHidden ? ', 숨김 포함' : ''})`;

    quickBtn.addEventListener('click', async () => {
        if (blocked()) return;
        if (!state.data) await loadBook();
        const d = quickDiagnose();
        if (!d) { renderDiag(null, '선택한 범위에 메시지가 없어요. 채팅을 열었는지, 범위 설정을 확인해 주세요.'); return; }
        const msgs = rangeMessages();
        const total = d.rows.reduce((a, r) => a + r.items.length, 0);
        const summary = d.rows.length
            ? `빠른 진단: ${rangeLabel(msgs)}에서 안 걸린 키워드 ${total}개 (삭제 추천 ${d.recommended}개)`
            : `${rangeLabel(msgs)}에서 정리할 키워드가 없어요.` + (s.diagScope === 'added' ? ' (대상: 이 확장이 추가한 키워드만 — 직접 넣은 키워드도 보려면 "모든 키워드")' : '');
        renderDiag(d, summary);
        await saveDiagResult(state.book, state.cache, d, summary);
        tabBtnD.textContent = d.recommended ? `진단 (${d.recommended})` : '진단';
    });

    aiDiagBtn.addEventListener('click', async () => {
        if (blocked()) return;
        if (!state.data) await loadBook();
        const msgs = rangeMessages();
        if (!msgs.length) { diagStatus.textContent = '선택한 범위에 메시지가 없어요. 채팅을 열었는지, 범위 설정을 확인해 주세요.'; return; }
        const targets = targetEntries();
        if (!targets.length) { toastr.info('점검할 엔트리가 없어요. (번역 탭의 범위/선택을 확인해 주세요)'); return; }

        const textChunks = chunkMessages(msgs, clampInt(s.diagChunkChars, 1000, 60000, SPEED_DEFAULTS.diagChunkChars));
        const per = clampInt(s.chatEntries, 5, 200, SPEED_DEFAULTS.chatEntries);
        const entryChunks = [];
        for (let i = 0; i < targets.length; i += per) entryChunks.push(targets.slice(i, i + per));
        const nReq = textChunks.length * entryChunks.length;
        let chars = 0;
        for (const t of textChunks) for (const ec of entryChunks) chars += AI_SYSTEM_DIAG.length + buildDiagPrompt(ec, t).length;
        const ok = await c.Popup.show.confirm('AI 정밀 진단',
            `${profileName()}로 채팅 ${rangeLabel(msgs)} + 엔트리 ${targets.length}개의 제목·키워드를 보내요.\n요청 ${nReq}번 · 약 ${chars.toLocaleString()}자 (대략 그만큼의 입력 토큰). 진행할까요?`);
        if (!ok) return;

        const job = beginJob('diag');
        const book = state.book, cache = state.cache;
        const fullText = msgs.map((m) => m.text).join('\n');
        const hay = norm(fullText);
        const forms = new Map(); // uid → Map(form → hits)
        let dropped = 0, done = 0;
        const prog = phase('AI가 채팅 읽는 중', nReq, diagStatus);
        const delay = clampInt(s.aiDelay, 0, 60000, SPEED_DEFAULTS.aiDelay);
        try {
            outer:
            for (const t of textChunks) {
                const chunkHay = norm(t);
                for (const ec of entryChunks) {
                    if (isCancelled()) break outer;
                    if (done++ > 0) await sleep(delay);
                    const json = await callAIJson(buildDiagPrompt(ec, t), Math.min(8000, 300 + ec.length * 60), AI_SYSTEM_DIAG);
                    ec.forEach((e, j) => {
                        const v = json[`E${j + 1}`];
                        for (const x of (Array.isArray(v) ? v : (v ? [v] : []))) {
                            const form = cleanResult(x);
                            if (!form || form.length > 40) continue;
                            // anti-hallucination: keep only strings that literally appear in this text
                            if (!chunkHay.includes(norm(form))) { dropped++; continue; }
                            const m = forms.get(String(e.uid)) ?? new Map();
                            m.set(form, countHits(hay, form));
                            forms.set(String(e.uid), m);
                        }
                    });
                    prog(1);
                }
            }
        } catch (e) {
            reportError(e, 'AI 진단 중단');
        }

        const fields = s.diagSecondary ? ['key', 'keysecondary'] : ['key'];
        const rows = [];
        let nAdd = 0, nDel = 0;
        for (const e of targets) {
            const fm = forms.get(String(e.uid));
            if (!fm?.size) continue;
            const items = [];
            const keySet = new Set((e.key || []).map(norm));
            const formScripts = new Set([...fm.keys()].map(scriptOf));
            const formList = [...fm.entries()].sort((a, b) => b[1] - a[1]);
            // ① learn: forms the chat actually used that aren't keywords yet
            for (const [form, hits] of formList) {
                if (keySet.has(norm(form))) continue;
                items.push({ op: 'add', f: 'key', k: form, checked: true, lang: 'chat', note: `채팅에 ${hits}회 — 이 엔트리를 이렇게 불렀어요` });
                nAdd++;
            }
            // ② wrong keywords: entry was mentioned, but this same-script keyword never matched
            for (const f of fields) {
                const mine = regGet(state.book, e.uid, f);
                for (const k0 of e[f] || []) {
                    const k = String(k0);
                    if (!k.trim() || isRegexKey(k)) continue;
                    if (s.diagScope === 'added' && !(k in mine)) continue;
                    if (countHits(hay, k) > 0 || !formScripts.has(scriptOf(k))) continue;
                    const example = formList.find(([x]) => scriptOf(x) === scriptOf(k))?.[0];
                    items.push({ op: 'remove', f, k, checked: true, mine: k in mine, lang: mine[k], note: `채팅에선 "${example}"(으)로 나왔는데 이 키워드는 0회 → 잘못 들어간 키워드일 수 있어요` });
                    nDel++;
                }
            }
            if (items.length) rows.push({ uid: String(e.uid), title: entryTitle(e), info: `채팅 속 표기: ${formList.map(([x, h]) => `${x}(${h})`).join(', ')}`, items });
        }
        const summary = `AI 정밀 진단 ${job.cancel ? '중지됨 — 지금까지: ' : '완료 — '}언급된 엔트리 ${forms.size}개, 추가 후보 ${nAdd}개, 삭제 후보 ${nDel}개` +
            (dropped ? ` (채팅에 실제로 없는 AI 답변 ${dropped}개는 버렸어요)` : '') + (rows.length ? ". 확인 후 '적용'을 눌러주세요." : '.');
        await saveDiagResult(book, cache, { rows }, summary);
        renderDiag({ rows }, summary);
        endJob(job, `AI 정밀 진단 ${job.cancel ? '중지됨' : '완료'} — 추가 후보 ${nAdd}개, 삭제 후보 ${nDel}개`);
    });

    cleanBtn.addEventListener('click', async () => {
        if (blocked()) return;
        if (!state.data) await loadBook();
        const langs = s.cleanLangs;
        if (!langs.length) { toastr.warning('지울 언어를 하나 이상 골라주세요.'); return; }
        const realLangs = langs.filter((l) => l !== 'chat');
        const fields = ['key', 'keysecondary'];
        const rows = [];
        let total = 0;
        for (const e of targetEntries()) {
            const items = [];
            for (const f of fields) {
                const mine = regGet(state.book, e.uid, f);
                for (const k0 of e[f] || []) {
                    const k = String(k0);
                    if (!k.trim() || isRegexKey(k)) continue;
                    let lang = null;
                    if (k in mine) {
                        if (langs.includes(mine[k])) lang = mine[k];
                    } else if (s.cleanScope === 'all' && looksLike(k, realLangs)) {
                        lang = 'guess';
                    }
                    if (!lang) continue;
                    items.push({ op: 'remove', f, k, checked: true, mine: k in mine, lang, note: lang === 'guess' ? '글자 종류로 추정' : `${langLabel(lang)} (기록됨)` });
                    total++;
                }
            }
            if (items.length) rows.push({ uid: String(e.uid), title: entryTitle(e), info: `현재 키워드: ${(e.key || []).join(', ')}`, items });
        }
        const summary = rows.length
            ? `언어별 지우기: 지울 키워드 ${total}개 — 확인 후 '적용'을 누르면 삭제돼요. (되돌리기 가능)`
            : (s.cleanScope === 'added' ? '이 확장이 추가한 기록 중 해당 언어 키워드가 없어요. (1.0.4 이전에 넣은 키워드는 "모든 키워드"로 찾아요)' : '해당 언어로 보이는 키워드가 없어요.');
        renderDiag({ rows }, summary);
        await saveDiagResult(state.book, state.cache, { rows }, summary);
    });

    diagApplyBtn.addEventListener('click', async () => {
        if (blocked() || !state.diag?.rows?.length) return;
        const ops = [];
        for (const r of state.diag.rows) for (const it of r.items) if (it.cb?.checked) ops.push({ uid: r.uid, f: it.f, op: it.op, k: it.k, lang: it.lang });
        if (!ops.length) { toastr.info('체크한 항목이 없어요.'); return; }
        const nAdd = ops.filter((o) => o.op === 'add').length, nDel = ops.length - nAdd;
        const ok = await c.Popup.show.confirm('적용', `키워드 ${[nAdd ? `${nAdd}개 추가` : null, nDel ? `${nDel}개 삭제` : null].filter(Boolean).join(', ')}를 할까요? "마지막 작업 되돌리기"로 한 번에 되돌릴 수 있어요.`);
        if (!ok) return;
        setBusy(true);
        try {
            const res = await applyOps(state.book, ops);
            state.data = res.data;
            if (res.kept) toastr.warning(`키워드가 하나도 안 남게 되는 엔트리가 있어서 ${res.kept}개는 남겨뒀어요.`);
            if (res.added || res.removed) toastr.success(`추가 ${res.added}개, 삭제 ${res.removed}개 적용했어요.`, state.book);
            renderPickList();
            clearDiag();
            delete state.cache.diag;
            writeCache(state.book, state.cache);
            diagStatus.textContent = '적용 완료! 잘못됐으면 "마지막 작업 되돌리기"를 눌러주세요. (창을 닫거나 새로고침해도 돼요)';
            refreshDiagBadge();
        } catch (e) {
            reportError(e, '적용 실패');
        } finally {
            setBusy(false);
        }
    });

    await loadBook();
    updateVisibility();
    await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true, leftAlign: true, okButton: '닫기',
        // Closing while a job runs: ask whether to keep it going in the background or stop it.
        onClosing: async () => {
            const job = state.job;
            if (!job || job.done) return true;
            const what = job.kind === 'translate' ? '번역' : 'AI 진단';
            const answer = await c.callGenericPopup(
                `${what}이 아직 진행 중이에요. (${job.text || '준비 중'})<br><br>백그라운드에서 계속하면 창을 닫아도 진행되고, 끝나면 알림이 떠요. 다시 열면 결과가 그대로 있어요.`,
                c.POPUP_TYPE.TEXT, '', { okButton: '백그라운드에서 계속', cancelButton: '취소', customButtons: ['중지하고 닫기'] });
            if (answer === c.POPUP_RESULT.AFFIRMATIVE) { job.popupOpen = false; return true; }
            if (answer === 2) { job.cancel = true; job.popupOpen = false; return true; }
            return false;
        },
        onClose: () => {
            state.closed = true;
            if (state.job && !state.job.done) state.job.popupOpen = false;
        },
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
        migrateFromBrowser();
    };
    if (document.getElementById('extensions_settings')) start();
    else eventSource.once(event_types.APP_READY, start);
})();
