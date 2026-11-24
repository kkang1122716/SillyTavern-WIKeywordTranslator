// WI Keyword Translator — adds translated trigger keywords (green-light keys) to World Info entries.
// Free mode uses SillyTavern's built-in translate endpoints (Google/Bing, 0 LLM tokens).
// AI mode sends keywords + entry titles (+ optional content snippet, off by default) to the chosen connection.

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
const langLabel = (code) => LANGS.find((l) => l.code === code)?.label ?? code;

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

const defaultSettings = Object.freeze({
    langs: ['zh-CN'],
    provider: 'google',
    includeSecondary: false,
    aiHint: '',
    aiProfile: '',      // '' = current connection
    aiRules: '',        // '' = DEFAULT_RULES
    contentChars: 0,    // 0 = don't send entry content
    verifyBack: false,
    verifyCompare: false,
    wiButton: true,
});

const ctx = () => SillyTavern.getContext();

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

// ---------- free translation (Google / Bing via ST server) ----------
async function freeTranslateOne(provider, text, lang) {
    const res = await fetch(`/api/translate/${provider}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ text, lang }),
    });
    if (!res.ok) throw new Error(`${provider} 번역 실패 (HTTP ${res.status})`);
    return await res.text();
}

/** Translates many short texts with few requests: newline-joined batches, per-item fallback. Returns Map(text → [result]). */
async function freeTranslate(provider, texts, lang, progress, isCancelled) {
    const out = new Map();
    const chunks = [];
    let cur = [], len = 0;
    for (const t of texts) {
        if (cur.length && (len + t.length > 800 || cur.length >= 30)) { chunks.push(cur); cur = []; len = 0; }
        cur.push(t); len += t.length + 1;
    }
    if (cur.length) chunks.push(cur);

    for (const chunk of chunks) {
        if (isCancelled()) break;
        let lines = null;
        try {
            const joined = await freeTranslateOne(provider, chunk.join('\n'), lang);
            lines = joined.split(/\r?\n/).filter((l) => l.trim() !== '');
        } catch (e) {
            console.warn('[WIKT] batch failed, falling back', e);
        }
        if (lines && lines.length === chunk.length) {
            chunk.forEach((t, i) => out.set(t, [lines[i]]));
        } else {
            for (const t of chunk) {
                if (isCancelled()) break;
                try { out.set(t, [await freeTranslateOne(provider, t, lang)]); } catch (e) { console.warn('[WIKT]', e); }
            }
        }
        progress(chunk.length);
    }
    return out;
}

/** need: Map(lang → Map(text → entry)) → Map(`${lang}\0${text}` → string[]) */
async function freeTranslateNeed(provider, need, progress, isCancelled) {
    const results = new Map();
    for (const [l, m] of need) {
        const texts = [...m.keys()];
        if (!texts.length || isCancelled()) continue;
        const r = await freeTranslate(provider, texts, l, progress, isCancelled);
        for (const [t, v] of r) results.set(`${l}\0${t}`, v);
    }
    return results;
}

// ---------- AI translation ----------
function getProfiles() {
    try {
        return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch {
        return []; // Connection Manager disabled
    }
}

/** Sends one request to the chosen connection profile, or the current connection when none is set. */
async function callAI(userPrompt, maxTokens) {
    const s = getSettings();
    const c = ctx();
    if (s.aiProfile) {
        const profile = getProfiles().find((p) => p.id === s.aiProfile);
        if (!profile) throw new Error('선택한 연결 프로필을 찾지 못했어요. 프로필을 다시 골라 주세요.');
        const res = await c.ConnectionManagerRequestService.sendRequest(
            s.aiProfile,
            [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: userPrompt }],
            maxTokens,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        return typeof res === 'string' ? res : String(res?.content ?? '');
    }
    return String(await c.generateRaw({ prompt: userPrompt, systemPrompt: AI_SYSTEM, responseLength: maxTokens }) ?? '');
}

function parseJsonLoose(s) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('AI 응답에서 JSON을 찾지 못했어요');
    return JSON.parse(s.slice(a, b + 1));
}

/** Groups need-map keywords by entry and splits them into request-sized chunks. */
function buildAIChunks(need) {
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
        if (cur.length && n + g.texts.length > 40) { chunks.push(cur); cur = []; n = 0; }
        cur.push(g); n += g.texts.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

function buildAIPrompt(groups, langs) {
    const s = getSettings();
    const langDesc = langs.map((l) => `"${l}" (${LANGS.find((x) => x.code === l)?.en})`).join(', ');
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

/** need: Map(lang → Map(text → entry)) → Map(`${lang}\0${text}` → string[]) */
async function aiTranslateNeed(need, progress, isCancelled) {
    const out = new Map();
    const langs = [...need.keys()].filter((l) => need.get(l).size);
    for (const groups of buildAIChunks(need)) {
        if (isCancelled()) break;
        const { prompt, order } = buildAIPrompt(groups, langs);
        const raw = await callAI(prompt, Math.min(8000, 400 + order.length * langs.length * 40));
        let json;
        try { json = parseJsonLoose(raw); } catch (e) {
            console.warn('[WIKT] AI raw output:', raw);
            throw e;
        }
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

/** Rough size of what AI mode will send, for the confirmation dialog. */
function estimateAIChars(need) {
    const langs = [...need.keys()].filter((l) => need.get(l).size);
    return buildAIChunks(need).reduce((a, g) => a + AI_SYSTEM.length + buildAIPrompt(g, langs).prompt.length, 0);
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

    const state = { book: books.includes(presetBook) ? presetBook : books[0], data: null, scope: 'all', picked: new Set(), rows: [], busy: false, cancel: false };

    // --- basic controls ---
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

    // --- AI settings ---
    const profiles = getProfiles();
    const profSel = el('select', { class: 'text_pole' },
        el('option', { value: '', text: '현재 연결 (지금 채팅에 쓰는 API)' }),
        profiles.map((p) => el('option', { value: p.id, text: `프로필: ${p.name}` })));
    profSel.value = profiles.some((p) => p.id === s.aiProfile) ? s.aiProfile : '';
    profSel.addEventListener('change', () => { s.aiProfile = profSel.value; save(); });

    const hintArea = el('textarea', { class: 'text_pole', rows: 2, placeholder: '예: 한국 무협 세계관(화산귀환풍). 인물·문파 이름은 한자 표기로.', value: s.aiHint });
    hintArea.addEventListener('input', () => { s.aiHint = hintArea.value; save(); });

    const contentNum = el('input', { class: 'text_pole wikt-num', type: 'number', min: 0, max: 2000, step: 50, value: s.contentChars });
    contentNum.addEventListener('input', () => { s.contentChars = Math.max(0, Math.min(2000, Number(contentNum.value) || 0)); save(); });

    const rulesArea = el('textarea', { class: 'text_pole wikt-rules', rows: 6, value: s.aiRules || DEFAULT_RULES });
    rulesArea.addEventListener('input', () => { s.aiRules = rulesArea.value.trim() === DEFAULT_RULES ? '' : rulesArea.value; save(); });
    const rulesReset = el('div', { class: 'menu_button', text: '기본값 복원', onclick: () => { rulesArea.value = DEFAULT_RULES; s.aiRules = ''; save(); } });

    const aiBox = el('div', { class: 'wikt-aibox' },
        el('div', { class: 'wikt-row' }, el('b', { text: 'AI 연결' }), profSel),
        profiles.length ? null : el('small', { class: 'wikt-note', text: '저장된 연결 프로필이 없어서 현재 연결만 쓸 수 있어요. (API 연결 화면의 Connection Profile에서 저장 가능)' }),
        el('small', { text: '세계관 메모 (선택)' }), hintArea,
        el('div', { class: 'wikt-row' },
            el('small', { text: '엔트리 본문 앞부분 함께 보내기 (글자 수, 0 = 안 보냄)' }), contentNum),
        el('small', { class: 'wikt-note', text: '본문을 보내면 고유명사 정확도가 올라가지만 토큰이 늘어요. 본문은 AI 연결로만 가고 구글/빙으로는 절대 안 가요.' }),
        el('details', {},
            el('summary', { text: '번역 프롬프트 보기/수정' }),
            rulesArea,
            el('div', { class: 'wikt-row' }, rulesReset,
                el('small', { class: 'wikt-note', text: '대상 언어, 세계관 메모, JSON 응답 형식, 키워드 목록은 자동으로 붙어요.' }))));

    // --- verification ---
    const backCb = el('input', { type: 'checkbox', checked: s.verifyBack });
    backCb.addEventListener('change', () => { s.verifyBack = backCb.checked; save(); });
    const cmpCb = el('input', { type: 'checkbox', checked: s.verifyCompare });
    const cmpLabelText = el('span', {});
    const updateVisibility = () => {
        const otherIsAI = provSel.value !== 'ai';
        cmpLabelText.textContent = otherIsAI
            ? ' 교차 비교: AI 번역과 비교해서 다른 것만 ⚠️ (AI 토큰 소모)'
            : ' 교차 비교: Google 번역과 비교해서 다른 것만 ⚠️ (무료)';
        aiBox.style.display = (provSel.value === 'ai' || (cmpCb.checked && otherIsAI)) ? '' : 'none';
    };
    cmpCb.addEventListener('change', () => { s.verifyCompare = cmpCb.checked; save(); updateVisibility(); });
    provSel.addEventListener('change', () => { s.provider = provSel.value; save(); updateVisibility(); });
    updateVisibility();

    const status = el('div', { class: 'wikt-status' });
    const runBtn = el('div', { class: 'menu_button menu_button_icon' }, el('i', { class: 'fa-solid fa-magnifying-glass' }), el('span', { text: '스캔 & 번역' }));
    const stopBtn = el('div', { class: 'menu_button', text: '중지', style: 'display:none' });
    const undoBtn = el('div', { class: 'menu_button menu_button_icon', title: '마지막으로 적용한 키워드 추가를 취소해요' }, el('i', { class: 'fa-solid fa-rotate-left' }), el('span', { text: '마지막 적용 되돌리기' }));

    const preview = el('div', { class: 'wikt-preview' });
    const applyBtn = el('div', { class: 'menu_button menu_button_icon wikt-apply', style: 'display:none' }, el('i', { class: 'fa-solid fa-check' }), el('span', { text: '체크한 항목 적용' }));

    const root = el('div', { class: 'wikt-root' },
        el('h3', { text: '월드인포 키워드 번역' }),
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
            el('label', {}, backCb, ' 역번역 표시 (무료)'),
            el('label', {}, cmpCb, cmpLabelText)),
        aiBox,
        el('small', { class: 'wikt-note', text: '항상 켜짐(파란불) 엔트리와 정규식(/.../) 키워드는 건너뛰어요.' }),
        el('div', { class: 'wikt-row' }, runBtn, stopBtn, undoBtn),
        status,
        preview,
        applyBtn,
    );

    // --- entry picking ---
    async function loadBook() {
        state.data = await c.loadWorldInfo(state.book);
        state.picked.clear();
        state.rows = [];
        preview.replaceChildren();
        applyBtn.style.display = 'none';
        renderPickList();
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

    // --- scan & translate ---
    function setBusy(b) {
        state.busy = b;
        runBtn.classList.toggle('disabled', b);
        applyBtn.classList.toggle('disabled', b);
        stopBtn.style.display = b ? '' : 'none';
    }
    stopBtn.addEventListener('click', () => { state.cancel = true; status.textContent = '중지하는 중…'; });

    function phase(label, total) {
        let done = 0;
        status.textContent = `${label}… 0 / ${total}`;
        return (n) => { done += n; status.textContent = `${label}… ${Math.min(done, total)} / ${total}`; };
    }

    runBtn.addEventListener('click', async () => {
        if (state.busy) return;
        const langs = langBoxes.filter((x) => x.checked).map((x) => x.value);
        if (!langs.length) { toastr.warning('추가할 언어를 하나 이상 골라주세요.'); return; }
        if (!state.data) await loadBook();
        const fields = s.includeSecondary ? ['key', 'keysecondary'] : ['key'];
        const targets = entriesOf(state.data).filter((e) =>
            !e.constant && (e.key || []).length && (state.scope === 'all' || state.picked.has(String(e.uid))));
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
        const useAI = provider === 'ai' || s.verifyCompare;
        if (useAI) {
            const uniq = new Set([...need.values()].flatMap((m) => [...m.keys()]));
            const chars = estimateAIChars(need);
            const who = s.aiProfile ? `프로필 "${profiles.find((p) => p.id === s.aiProfile)?.name ?? '?'}"` : '현재 연결';
            const what = s.contentChars > 0 ? `키워드 ${uniq.size}개 + 엔트리 제목 + 본문 앞 ${s.contentChars}자` : `키워드 ${uniq.size}개 + 엔트리 제목 (본문 X)`;
            const ok = await c.Popup.show.confirm('AI 번역', `${who}로 ${what}를 보내요. 보내는 양은 약 ${chars.toLocaleString()}자예요. 진행할까요?`);
            if (!ok) return;
        }

        setBusy(true);
        state.cancel = false;
        const isCancelled = () => state.cancel;
        let results = new Map(), other = null, back = new Map();
        try {
            results = provider === 'ai'
                ? await aiTranslateNeed(need, phase('AI 번역 중', total), isCancelled)
                : await freeTranslateNeed(provider, need, phase('번역 중', total), isCancelled);

            if (s.verifyCompare && !state.cancel) {
                other = provider === 'ai'
                    ? await freeTranslateNeed('google', need, phase('비교용 Google 번역 중', total), isCancelled)
                    : await aiTranslateNeed(need, phase('비교용 AI 번역 중', total), isCancelled);
            }
        } catch (e) {
            console.error('[WIKT]', e);
            toastr.error(String(e?.message || e) + (e?.cause ? ` (${e.cause.message || e.cause})` : ''), '번역 실패');
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

        // back-translation (free) of every proposed keyword into its source keyword's language
        if (s.verifyBack && !state.cancel && state.rows.length) {
            const byLang = new Map();
            for (const r of state.rows) for (const adds of Object.values(r.adds)) for (const a of adds) {
                const bl = detectLang(a.src);
                if (!byLang.has(bl)) byLang.set(bl, new Set());
                byLang.get(bl).add(a.t);
            }
            const n = [...byLang.values()].reduce((x, set) => x + set.size, 0);
            const prog = phase('역번역 중', n);
            try {
                for (const [bl, set] of byLang) {
                    if (state.cancel) break;
                    const r = await freeTranslate(freeProv, [...set], bl, prog, isCancelled);
                    for (const [t, v] of r) back.set(`${bl}\0${t}`, cleanResult(v[0]));
                }
            } catch (e) { console.warn('[WIKT] back-translation failed', e); }
            for (const r of state.rows) for (const adds of Object.values(r.adds)) for (const a of adds) {
                a.back = back.get(`${detectLang(a.src)}\0${a.t}`) ?? null;
            }
        }
        setBusy(false);

        renderPreview();
        const warn = state.rows.reduce((x, r) => x + Object.values(r.adds).flat().filter(isSuspicious).length, 0);
        status.textContent = state.cancel
            ? `중지됨 — 지금까지 번역된 것: 엔트리 ${state.rows.length}개`
            : `완료 — 새 키워드가 생긴 엔트리 ${state.rows.length}개${warn ? `, 확인이 필요한 키워드 ⚠️ ${warn}개` : ''}. 확인 후 '적용'을 눌러주세요.`;
    });

    const backOk = (a) => a.back != null && normLoose(a.back) === normLoose(a.src);
    const cmpOk = (a) => a.alt != null && a.alt.some((x) => norm(x) === norm(a.t));
    // Cross-check beats back-translation: if both methods agree, a mismatching back-translation
    // (e.g. romanized names like Cheongmyeong → 清明 → Qingming) is not a warning.
    function isSuspicious(a) {
        if (a.alt != null) return !cmpOk(a);
        return a.back != null && !backOk(a);
    }

    function replaceInInput(inp, from, to) {
        const parts = splitInput(inp.value).map((x) => (x === from ? to : x));
        inp.value = [...new Set(parts)].join(', ');
    }

    function renderChecks(adds, inp) {
        const anyCheck = adds.some((a) => a.back != null || a.alt != null);
        if (!anyCheck) return null;
        const box = el('div', { class: 'wikt-checks' });
        for (const a of adds) {
            const bad = isSuspicious(a);
            const parts = [el('b', { text: a.t }), el('small', { class: 'wikt-src', text: ` ← ${a.src} · ${langLabel(a.lang)}` })];
            if (a.back != null) parts.push(el('small', { class: backOk(a) ? 'wikt-ok' : (bad ? 'wikt-bad' : 'wikt-src'), text: ` · 역번역: ${a.back || '(없음)'}` }));
            if (a.alt != null) {
                const label = provSel.value === 'ai' ? 'Google' : 'AI';
                if (cmpOk(a)) parts.push(el('small', { class: 'wikt-ok', text: ` · ${label}도 같음` }));
                else {
                    parts.push(el('small', { class: 'wikt-bad', text: ` · ${label}: ${a.alt.join(' / ') || '(없음)'}` }));
                    for (const alt of a.alt.slice(0, 2)) {
                        parts.push(el('span', {
                            class: 'menu_button wikt-swap', text: `→ ${alt} 사용`,
                            onclick: () => { replaceInInput(inp, a.t, alt); a.t = alt; a.back = null; a.alt = null; chip.replaceWith(el('div', { class: 'wikt-chip', text: `✔ ${alt} (바꿈)` })); },
                        }));
                    }
                }
            }
            const chip = el('div', { class: `wikt-chip ${bad ? 'is-bad' : 'is-ok'}` }, bad ? '⚠️ ' : '✔ ', parts);
            box.append(chip);
        }
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
            state.data = data;
            toastr.success(`엔트리 ${entries}개에 키워드 ${count}개를 추가했어요.`, state.book);
            state.rows = [];
            renderPreview();
            status.textContent = '적용 완료! 잘못됐으면 "마지막 적용 되돌리기"를 눌러주세요.';
        } catch (e) {
            console.error('[WIKT]', e);
            toastr.error('저장에 실패했어요. 콘솔(F12)을 확인해 주세요.');
        }
    });

    undoBtn.addEventListener('click', async () => {
        if (state.busy) return;
        const rec = (await loadUndo())[0];
        if (!rec) { toastr.info('되돌릴 기록이 없어요.'); return; }
        const n = Object.values(rec.added).reduce((a, x) => a + Object.values(x).reduce((b, y) => b + y.length, 0), 0);
        const when = new Date(rec.time).toLocaleString();
        const ok = await c.Popup.show.confirm('되돌리기', `[${rec.book}] ${when}에 추가한 키워드 ${n}개를 지울까요? (그 뒤에 직접 넣은 키워드는 그대로 둬요)`);
        if (!ok) return;
        const data = await c.loadWorldInfo(rec.book);
        if (!data?.entries) { toastr.error(`로어북 "${rec.book}"을 찾지 못했어요.`); await popUndo(); return; }
        let removed = 0;
        for (const [uid, fields] of Object.entries(rec.added)) {
            const e = data.entries[uid];
            if (!e) continue;
            for (const [f, words] of Object.entries(fields)) {
                if (!Array.isArray(e[f])) continue;
                const del = new Set(words);
                const before = e[f].length;
                e[f] = e[f].filter((k) => !del.has(k));
                removed += before - e[f].length;
                syncOriginal(data, uid, f, e[f]);
            }
        }
        await saveBook(rec.book, data);
        await popUndo();
        if (rec.book === state.book) { state.data = data; renderPickList(); }
        toastr.success(`키워드 ${removed}개를 지웠어요.`, rec.book);
    });

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
    const s = getSettings();
    const wiCb = el('input', { type: 'checkbox', checked: s.wiButton });
    wiCb.addEventListener('change', () => { s.wiButton = wiCb.checked; save(); syncWIButton(); });
    const panel = el('div', { id: 'wikt_settings', class: 'inline-drawer' },
        el('div', { class: 'inline-drawer-toggle inline-drawer-header' },
            el('b', { text: '월드인포 키워드 번역' }),
            el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })),
        el('div', { class: 'inline-drawer-content' },
            el('div', { class: 'menu_button menu_button_icon', onclick: () => openTranslator(currentEditorBook()) },
                el('i', { class: 'fa-solid fa-language' }), el('span', { text: '키워드 번역기 열기' })),
            el('label', { class: 'checkbox_label' }, wiCb, el('span', { text: '월드인포 편집창에 번역 버튼 표시' })),
            el('small', { text: '무료 번역은 키워드만 실리태번 서버를 거쳐 Google/Bing으로 보내요. AI 번역은 키워드와 엔트리 제목(본문은 켰을 때만)을 고른 연결로 보내요.' })));
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
