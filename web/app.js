(function () {
"use strict";

const A = window.Android;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state ----

let state = null;
let selectMode = false;
const selected = new Set();
let saveTimer = null;
let aiBusy = false;

const DEFAULT_AI = { provider: "anthropic", url: "", key: "", model: "claude-haiku-4-5-20251001", lang: "English" };

function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }

function load() {
    try { const t = A.loadState(); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
}
function flush() {
    clearTimeout(saveTimer);
    try { A.saveState(JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function commit() { save(); render(); }

function newState() {
    return { v: 1, categories: [], items: [], unsortedCollapsed: false, launches: {}, ai: Object.assign({}, DEFAULT_AI) };
}

function catById(id) { return state.categories.find((c) => c.id === id); }
function itemById(id) { return state.items.find((i) => i.id === id); }
function catOf(i) { return i.catId ? catById(i.catId) : null; }

// ----------------------------------------------------------- app syncing ----

function installedApps() {
    try { return JSON.parse(A.listApps()); } catch (e) { return []; }
}

// Adds newly installed apps, drops uninstalled ones, refreshes labels.
function reconcile() {
    const apps = installedApps();
    if (!apps.length) return { added: 0, removed: 0 };
    const byPkg = new Map(apps.map((a) => [a.package, a]));
    let added = 0, removed = 0;
    state.items = state.items.filter((i) => {
        if (i.type !== "app" || byPkg.has(i.pkg)) return true;
        removed++;
        return false;
    });
    const have = new Set(state.items.filter((i) => i.type === "app").map((i) => i.pkg));
    for (const a of apps) {
        if (!have.has(a.package)) {
            state.items.push({ id: "a:" + a.package, type: "app", pkg: a.package, label: a.label, catId: null, page: 0 });
            added++;
        }
    }
    for (const i of state.items) {
        if (i.type === "app" && !i.customLabel) {
            const a = byPkg.get(i.pkg);
            if (a) i.label = a.label;
        }
    }
    return { added, removed };
}

// ------------------------------------------------------------- helpers ----

let toastTimer = null;
function toast(msg, ms) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms || 2800);
}

function letterIcon(label) {
    const s = (label || "?").trim();
    const ch = (s.charAt(0) || "?").toUpperCase();
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 360;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="hsl('
        + h + ',45%,48%)"/><text x="48" y="64" font-size="50" font-family="sans-serif" fill="#fff" text-anchor="middle">'
        + ch.replace(/[<>&]/g, "") + "</text></svg>";
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function iconSrc(i) {
    if (i.icon) return i.icon;
    if (i.type === "app") return "/icon/" + encodeURIComponent(i.pkg) + ".png";
    try { return "https://www.google.com/s2/favicons?domain=" + new URL(i.url).hostname + "&sz=128"; }
    catch (e) { return letterIcon(i.label); }
}

function fileToIcon(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const img = new Image();
            img.onload = () => {
                const k = Math.min(1, 128 / Math.max(img.width, img.height));
                const c = document.createElement("canvas");
                c.width = Math.max(1, Math.round(img.width * k));
                c.height = Math.max(1, Math.round(img.height * k));
                c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL("image/png"));
            };
            img.onerror = reject;
            img.src = fr.result;
        };
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}

function normUrl(u) {
    u = (u || "").trim();
    if (!u) return "";
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
    return u;
}

function normName(n) {
    return String(n || "").replace(/\s+/g, " ").trim().slice(0, 32);
}

// --------------------------------------------------------- press handling ----

function attachPress(el, tap, long) {
    let timer = null, sx = 0, sy = 0, fired = false;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener("pointerdown", (e) => {
        fired = false; sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => {
            timer = null; fired = true;
            if (navigator.vibrate) navigator.vibrate(15);
            long();
        }, 450);
    });
    el.addEventListener("pointermove", (e) => {
        if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("click", (e) => {
        if (fired) { fired = false; e.preventDefault(); return; }
        tap();
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// -------------------------------------------------------------- rendering ----

function tile(item) {
    const t = document.createElement("div");
    t.className = "tile" + (selected.has(item.id) ? " sel" : "");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = iconSrc(item);
    img.onerror = () => { img.onerror = null; img.src = letterIcon(item.label); };
    const l = document.createElement("div");
    l.className = "lbl";
    l.textContent = item.label;
    t.append(img, l);
    attachPress(t, () => onTap(item), () => onLong(item));
    return t;
}

function groupBlock(title, items, opts) {
    const g = document.createElement("div");
    g.className = "group";
    const h = document.createElement("div");
    h.className = "ghead" + (opts.unsorted ? " unsorted" : "");
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = opts.collapsed ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = title;
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = items.length;
    h.append(chev, name, cnt);
    attachPress(h, opts.toggle, opts.long || (() => {}));
    g.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "grid" + (opts.collapsed ? " collapsed" : "");
    if (!items.length) {
        if (!opts.collapsed) {
            const e = document.createElement("div");
            e.className = "empty";
            e.textContent = "Empty — move apps here from their long-press menu.";
            g.appendChild(e);
        }
    } else {
        items.forEach((i) => grid.appendChild(tile(i)));
    }
    g.appendChild(grid);
    return g;
}

// Screen 1: category cards.
function setAllCollapsed(c) {
    state.categories.forEach((x) => { x.collapsed = c; });
    state.unsortedCollapsed = c;
    commit();
}

function renderMain(el) {
    el.innerHTML = "";
    const items = state.items.filter((i) => !i.hidden);
    let any = false;
    if (state.categories.length) {
        const bar = document.createElement("div");
        bar.className = "cardbar";
        const mk = (label, c) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.onclick = () => setAllCollapsed(c);
            return b;
        };
        bar.append(mk("▸ Collapse all", true), mk("▾ Expand all", false));
        el.appendChild(bar);
    }
    for (const c of state.categories) {
        any = true;
        el.appendChild(groupBlock(c.name, items.filter((i) => i.catId === c.id), {
            collapsed: !!c.collapsed,
            toggle: () => { c.collapsed = !c.collapsed; commit(); },
            long: () => categorySheet(c)
        }));
    }
    const un = items.filter((i) => !catOf(i));
    if (un.length) {
        any = true;
        el.appendChild(groupBlock("Unsorted", un, {
            unsorted: true,
            collapsed: !!state.unsortedCollapsed,
            toggle: () => { state.unsortedCollapsed = !state.unsortedCollapsed; commit(); },
            long: () => unsortedSheet(un)
        }));
    }
    if (!any) {
        const e = document.createElement("div");
        e.className = "empty";
        e.style.cssText = "padding:40px 16px;text-align:center";
        e.textContent = "Nothing here yet. Tap ＋ to add a category or shortcut.";
        el.appendChild(e);
    }
}

// Screen 2: plain names only, most used first.
let usageMs = {};
let usageGranted = false;
const hasUsageApi = () => typeof A.usageAccess === "function";

function refreshUsage() {
    try {
        usageGranted = hasUsageApi() && !!A.usageAccess();
        usageMs = usageGranted ? JSON.parse(A.usageStats()) : {};
    } catch (e) { usageGranted = false; usageMs = {}; }
}

// Foreground time over the last 30 days (real usage, needs permission) plus launches made from here
// (each counted as one minute), so shortcuts and the no-permission case still rank sensibly.
function usageScore(i) {
    const ms = i.type === "app" ? (usageMs[i.pkg] || 0) : 0;
    return ms + ((state.launches || {})[i.id] || 0) * 60000;
}

function rankedItems() {
    return state.items.filter((i) => !i.hidden)
        .sort((a, b) => usageScore(b) - usageScore(a) || a.label.localeCompare(b.label));
}

function renderUsage(el) {
    el.innerHTML = "";
    if (hasUsageApi() && !usageGranted) {
        const n = document.createElement("div");
        n.className = "plainnote";
        const t = document.createElement("span");
        t.textContent = "Ranked by what you open from this launcher. For real usage across the phone, allow usage access.";
        const b = document.createElement("button");
        b.textContent = "Allow";
        b.onclick = () => { try { A.openUsageSettings(); } catch (e) { /* ignore */ } };
        n.append(t, b);
        el.appendChild(n);
    }
    const list = document.createElement("div");
    list.className = "plain";
    rankedItems().forEach((i) => {
        const r = document.createElement("div");
        r.className = "pl" + (selected.has(i.id) ? " sel" : "");
        r.textContent = i.label;
        attachPress(r, () => onTap(i), () => onLong(i));
        list.appendChild(r);
    });
    el.appendChild(list);
}

// Screen 0 (swipe right from the main screen): cloud of the AI keywords; tap a word to see everything related.
//
// Keeping the cloud small without touching the stored keywords (everything below is applied at display time,
// so it is reversible):
//   - automatic: plurals, accents and "... client / app / tool" variants count as one word (can be switched off)
//   - AI merge: true synonyms are folded together (state.kwAlias / state.kwLabel)
//   - manual: long-press a word to merge it into another, rename it or hide it
//   - per item: a keyword can be removed from one app (item.noKw stops the AI from adding it back)
let cloudSel = null;

const GENERIC_WORDS = new Set(["app", "apps", "application", "applications", "client", "clients", "tool", "tools",
    "manager", "service", "services", "software", "platform", "online", "mobile", "program", "programs"]);

function kwList(i) {
    return (i.kw || "").split(/[,;\n]/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 30);
}

function stem(w) {
    if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length > 3 && w.endsWith("ie")) return w.slice(0, -2) + "y";
    if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
    return w;
}

// The form of a keyword used to decide that two keywords are the same word.
function canonKey(w) {
    const f = fold(w).trim();
    let words = f.split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return f;
    if (state.autoMerge !== false) {
        const core = words.filter((x) => !GENERIC_WORDS.has(x));
        if (core.length) words = core;
        words = words.map(stem);
    }
    return words.join("");   // "e-mail", "e mail" and "email" are the same word
}

function resolveKey(k) {
    const a = state.kwAlias || {};
    for (let n = 0; n < 6 && a[k] && a[k] !== k; n++) k = a[k];
    return k;
}

// Keyword keys of one item after removals, merges and hidden words.
function itemKeys(i) {
    const no = new Set(i.noKw || []), hide = new Set(state.kwHide || []), out = new Set();
    for (const w of kwList(i)) {
        const k0 = canonKey(w);
        if (!k0 || no.has(fold(w)) || no.has(k0)) continue;
        const k = resolveKey(k0);
        if (no.has(k) || hide.has(k)) continue;
        out.add(k);
    }
    return out;
}

function cloudWords() {
    const m = new Map();
    const hide = new Set(state.kwHide || []);
    for (const i of state.items) {
        if (i.hidden) continue;
        const no = new Set(i.noKw || []), seen = new Set();
        for (const w of kwList(i)) {
            const k0 = canonKey(w);
            if (!k0 || no.has(fold(w)) || no.has(k0)) continue;
            const k = resolveKey(k0);
            if (hide.has(k) || no.has(k) || seen.has(k)) continue;
            seen.add(k);
            let e = m.get(k);
            if (!e) { e = { k, n: 0, forms: new Map() }; m.set(k, e); }
            e.n++;
            e.forms.set(w, (e.forms.get(w) || 0) + 1);
        }
    }
    const min = state.cloudMin || 1, out = [];
    for (const e of m.values()) {
        if (e.n < min) continue;
        const forms = [...e.forms.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
        out.push({ k: e.k, label: (state.kwLabel || {})[e.k] || forms[0][0], n: e.n, variants: forms.map((f) => f[0]) });
    }
    return out;
}

function relatedItems(k) {
    return state.items.filter((i) => !i.hidden && (itemKeys(i).has(k) || (k.length >= 4 && fold(i.label).includes(k))));
}

// Set an item's keywords, never re-adding ones the user removed from it.
function setKw(i, str) {
    const no = new Set(i.noKw || []);
    const kept = String(str || "").split(/[,;\n]/).map((s) => s.trim())
        .filter((s) => s.length > 1 && s.length < 30 && !no.has(fold(s)) && !no.has(canonKey(s)) && !no.has(resolveKey(canonKey(s))));
    i.kw = [...new Set(kept)].join(", ").slice(0, 200);
}

function removeKwFromItem(i, k) {
    const keep = [], no = new Set(i.noKw || []);
    for (const w of kwList(i)) {
        const k0 = canonKey(w);
        if (k0 && resolveKey(k0) === k) no.add(fold(w)); else keep.push(w);
    }
    no.add(k);                       // the word itself, whatever form the AI uses next time
    i.kw = keep.join(", ");
    i.noKw = [...no];
}

function editKeywords(i) {
    form("Keywords — " + i.label, [{ id: "kw", label: "Comma-separated. Removed words are not added back by the AI.", type: "textarea", rows: 5, value: i.kw || "" }],
        "Save", (v) => {
            const before = new Set(kwList(i).map(fold));
            const after = String(v.kw).split(/[,;\n]/).map((s) => s.trim()).filter((s) => s.length > 1 && s.length < 30);
            const afterSet = new Set(after.map(fold));
            const no = new Set(i.noKw || []);
            before.forEach((w) => { if (!afterSet.has(w)) no.add(w); });
            afterSet.forEach((w) => no.delete(w));
            i.noKw = [...no];
            i.kw = [...new Set(after)].join(", ").slice(0, 200);
            commit();
        });
}

// ---- merging, renaming, hiding ----

function mergeWords(from, into, intoLabel) {
    if (from === into) return;
    state.kwAlias = state.kwAlias || {};
    state.kwLabel = state.kwLabel || {};
    if (intoLabel && !state.kwLabel[into]) state.kwLabel[into] = intoLabel;   // the merged word keeps the target's name
    state.kwAlias[from] = into;
    for (const [k, v] of Object.entries(state.kwAlias)) if (v === from) state.kwAlias[k] = into;
    commit();
}

function splitWord(k) {
    const a = state.kwAlias || {};
    for (const key of Object.keys(a)) if (a[key] === k) delete a[key];
    commit();
}

function wordSheet(w) {
    const merged = Object.values(state.kwAlias || {}).filter((v) => v === w.k).length;
    const buttons = [
        { label: "Show apps (" + w.n + ")", run: () => { cloudSel = { k: w.k, label: w.label }; renderCloud($("pageCloud")); } },
        { label: "Merge into another word…", run: () => {
            const others = cloudWords().filter((x) => x.k !== w.k).sort((a, b) => a.label.localeCompare(b.label));
            if (!others.length) { toast("No other word to merge with"); return; }
            form("Merge “" + w.label + "” into", [{ id: "to", label: "Other word", type: "select", options: others.map((x) => ({ value: x.k, label: x.label + " (" + x.n + ")" })) }],
                "Merge", (v) => { mergeWords(w.k, v.to, (others.find((x) => x.k === v.to) || {}).label); toast("Merged"); });
        } },
        { label: "Rename…", run: () => form("Rename word", [{ id: "l", label: "Word", value: w.label }], "Rename", (v) => {
            if (!v.l.trim()) return false;
            state.kwLabel = state.kwLabel || {};
            state.kwLabel[w.k] = v.l.trim();
            commit();
        }) }
    ];
    if (merged) buttons.push({ label: "Split merged words (" + merged + ")", run: () => splitWord(w.k) });
    buttons.push({ label: "Hide this word", run: () => {
        state.kwHide = state.kwHide || [];
        if (!state.kwHide.includes(w.k)) state.kwHide.push(w.k);
        commit();
        toast("Hidden — undo via Condense… → Hidden words");
    } });
    sheet(w.label + (w.variants.length > 1 ? "  ·  " + w.variants.slice(0, 4).join(", ") : ""), buttons);
}

function condenseMenu() {
    const hidden = (state.kwHide || []).length;
    const buttons = [
        { label: "Merge synonyms with AI…", run: aiCondense },
        { label: "Auto-merge plurals and “… client/app”: " + (state.autoMerge === false ? "OFF" : "ON"), run: () => {
            state.autoMerge = state.autoMerge === false; commit();
        } },
        { label: "Only words used by 2+ items: " + ((state.cloudMin || 1) > 1 ? "ON" : "OFF"), run: () => {
            state.cloudMin = (state.cloudMin || 1) > 1 ? 1 : 2; commit();
        } }
    ];
    if (hidden) buttons.push({ label: "Hidden words (" + hidden + ")…", run: () => sheet("Hidden words — tap to show again",
        (state.kwHide || []).map((k) => ({ label: k, run: () => { state.kwHide = state.kwHide.filter((x) => x !== k); commit(); } }))) });
    buttons.push({ label: "Reset merges, renames and hidden words", danger: true, run: () => {
        state.kwAlias = {}; state.kwLabel = {}; state.kwHide = []; commit();
    } });
    sheet("Condense the cloud", buttons);
}

const CONDENSE_PROMPT =
    "You merge duplicate or near-synonym search keywords. The input is a list of keywords, one per line. " +
    "Find groups of words that mean the same thing: synonyms, plurals, translations, or variants such as 'email' and 'email client'. " +
    "Do NOT merge words that are merely related (bank and money are different). " +
    "Reply with plain text ONLY, one line per group of 2 or more words, in the form  Best word: other word, other word  " +
    "(the best word is the simplest and most common one). Words with no duplicate are left out. No explanations, no markdown.";

async function aiCondense() {
    if (!aiConfigured()) { toast("Set up the AI server first"); aiSettings(); return; }
    if (aiBusy) return;
    const words = cloudWords().sort((a, b) => b.n - a.n).slice(0, 250);
    if (words.length < 3) { toast("Not enough words to condense yet"); return; }
    aiBusy = true;
    const say = progressCard("Merging synonyms");
    const t0 = Date.now();
    const tick = setInterval(() => say("Asking the AI about " + words.length + " words…\n" + Math.round((Date.now() - t0) / 1000) + " s elapsed"), 1000);
    say("Asking the AI about " + words.length + " words…");
    try {
        lastAiReply = ""; lastRaw = "";
        const text = await aiAsk(CONDENSE_PROMPT, "Language: " + (state.ai.lang || "English") + "\nWORDS:\n" + words.map((w) => w.label).join("\n"), 3000);
        lastAiReply = text;
        const present = new Set(words.map((w) => w.k));
        state.kwAlias = state.kwAlias || {};
        state.kwLabel = state.kwLabel || {};
        let groups = 0, merged = 0;
        for (let line of text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "").split(/\r?\n/)) {
            line = line.trim().replace(/^([-*•]|\d+[.)])\s+/, "");
            const c = line.indexOf(":");
            if (c < 1) continue;
            const best = line.slice(0, c).trim().replace(/^["'*]+|["'*]+$/g, "");
            const kb = resolveKey(canonKey(best));
            if (!kb) continue;
            let did = false;
            for (const v of line.slice(c + 1).split(/[,;]/)) {
                const kv = resolveKey(canonKey(v.trim()));
                if (!kv || kv === kb || !present.has(kv)) continue;
                state.kwAlias[kv] = kb;
                did = true;
                merged++;
            }
            if (did) {
                groups++;
                const existing = words.find((x) => x.k === kb);   // keep the casing of a word that already exists
                if (!state.kwLabel[kb]) state.kwLabel[kb] = existing ? existing.label : best;
            }
        }
        clearInterval(tick);
        commit();
        if (!merged) {
            resultCard("Nothing to merge", "The AI found no synonyms to merge in these " + words.length + " words (or its answer could not be read). Its reply:", text.slice(0, 2500));
        } else {
            closeOverlay();
            toast("Merged " + merged + " words into " + groups + " groups", 5000);
        }
    } catch (e) {
        clearInterval(tick);
        resultCard("Could not merge words", String(e.message || e), lastAiReply ? "Last reply:\n" + lastAiReply.slice(0, 2500) : lastRaw ? lastRaw.slice(0, 1500) : "");
    } finally {
        clearInterval(tick);
        aiBusy = false;
    }
}

function renderCloud(el) {
    el.innerHTML = "";
    if (cloudSel) {
        const head = document.createElement("div");
        head.className = "cloudhead";
        const back = document.createElement("button");
        back.textContent = "← Cloud";
        back.onclick = () => { cloudSel = null; renderCloud(el); };
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = cloudSel.label;
        head.append(back, t);
        el.appendChild(head);
        const items = relatedItems(cloudSel.k);
        if (!items.length) {
            const e = document.createElement("div");
            e.className = "empty";
            e.textContent = "Nothing matches any more.";
            el.appendChild(e);
            return;
        }
        const hint = document.createElement("div");
        hint.className = "cloudnote";
        hint.textContent = "Long-press an app that doesn't belong → “Remove from this word”.";
        el.appendChild(hint);
        const card = document.createElement("div");
        card.className = "group";
        const grid = document.createElement("div");
        grid.className = "grid";
        items.forEach((i) => grid.appendChild(tile(i)));
        card.appendChild(grid);
        el.appendChild(card);
        return;
    }
    const words = cloudWords();
    if (!words.length && !(state.items.some((i) => i.kw))) {
        const e = document.createElement("div");
        e.className = "empty";
        e.style.cssText = "padding:40px 20px;text-align:center;white-space:pre-line";
        e.textContent = "The keyword cloud is built from the search keywords the AI writes for your apps.\n\n";
        const b = document.createElement("button");
        b.className = "ask";
        b.textContent = aiConfigured() ? "✨ Write keywords with AI" : "Set up the AI server…";
        b.onclick = () => (aiConfigured() ? aiIndexDialog() : aiSettings());
        el.append(e, b);
        return;
    }
    const bar = document.createElement("div");
    bar.className = "cloudbar";
    const note = document.createElement("span");
    note.textContent = words.length + " words · tap to open, long-press to merge or hide";
    const cb = document.createElement("button");
    cb.textContent = "Condense…";
    cb.onclick = condenseMenu;
    bar.append(note, cb);
    el.appendChild(bar);
    if (!words.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "No words left with the current filters.";
        el.appendChild(e);
        return;
    }
    const byCount = words.slice().sort((a, b) => b.n - a.n || a.k.localeCompare(b.k)).slice(0, 90);
    const max = byCount[0].n, min = byCount[byCount.length - 1].n;
    const top = byCount.sort((a, b) => a.k.localeCompare(b.k));
    const cloud = document.createElement("div");
    cloud.className = "cloud";
    for (const w of top) {
        let h = 0;
        for (let k = 0; k < w.k.length; k++) h = (h * 31 + w.k.charCodeAt(k)) % 360;
        const b = document.createElement("button");
        b.className = "kw";
        b.textContent = w.label;
        const f = max === min ? 0.4 : (w.n - min) / (max - min);
        b.style.fontSize = Math.round(15 + 21 * f) + "px";
        b.style.color = "hsl(" + h + ",62%,52%)";
        attachPress(b, () => { cloudSel = { k: w.k, label: w.label }; renderCloud(el); el.scrollTop = 0; }, () => wordSheet(w));
        cloud.appendChild(b);
    }
    el.appendChild(cloud);
}

function render() {
    renderCloud($("pageCloud"));
    renderMain($("page0"));
    renderUsage($("page1"));
    renderSelectBar();
    renderResults();
}

function renderSelectBar() {
    $("selbar").hidden = !selectMode;
    $("seln").textContent = selected.size + " selected";
}

// ---- search: name, package, AI-written keywords, category, site ----

function fold(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function hostOf(i) { return i.type === "link" ? safeHost(i.url) : ""; }

function searchItems(q) {
    const words = fold(q).split(/[\s,]+/).filter(Boolean);
    if (!words.length) return [];
    const res = [];
    for (const i of state.items) {
        if (i.hidden) continue;
        const lab = fold(i.label);
        const c = catOf(i);
        const hay = fold([i.label, i.pkg, i.kw, c && c.name, hostOf(i)].join(" "));
        let score = 0, all = true;
        for (const w of words) {
            if (lab.startsWith(w)) score += 5;
            else if (lab.includes(w)) score += 4;
            else if (hay.includes(w)) score += 2;
            else all = false;
        }
        if (all) res.push({ i, score: score + 10 });
        else if (score > 0) res.push({ i, score });
    }
    res.sort((a, b) => b.score - a.score || a.i.label.localeCompare(b.i.label));
    return res.map((r) => r.i);
}

let aiHits = { q: "", ids: [] };

function renderResults() {
    const raw = $("q").value.trim();
    const box = $("results");
    if (!raw) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    const addGrid = (items, title) => {
        if (title) {
            const s = document.createElement("div");
            s.className = "sect";
            s.textContent = title;
            box.appendChild(s);
        }
        const grid = document.createElement("div");
        grid.className = "grid";
        items.forEach((i) => grid.appendChild(tile(i)));
        box.appendChild(grid);
    };
    const suggested = aiHits.q === raw ? aiHits.ids.map(itemById).filter((i) => i && !i.hidden) : [];
    if (suggested.length) addGrid(suggested, "AI suggestions");
    const hits = searchItems(raw).filter((i) => !suggested.includes(i));
    if (hits.length) addGrid(hits, suggested.length ? "Other matches" : "");
    if (!hits.length && !suggested.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "No match.";
        box.appendChild(e);
    }
    if (aiConfigured() && aiHits.q !== raw) {
        const b = document.createElement("button");
        b.className = "ask";
        b.textContent = "✨ Ask AI to find “" + raw + "”";
        b.onclick = () => aiFind(raw);
        box.appendChild(b);
    }
}

// -------------------------------------------------------- tap / long press ----

function launch(item) {
    state.launches = state.launches || {};
    state.launches[item.id] = (state.launches[item.id] || 0) + 1;
    save();
    if (item.type === "app") {
        let ok = false;
        try { ok = A.launch(item.pkg); } catch (e) { /* ignore */ }
        if (!ok) toast("Could not open " + item.label);
    } else {
        try { A.openUrl(item.url); } catch (e) { toast("Could not open link"); }
    }
}

function onTap(item) {
    if (selectMode) { toggleSelect(item.id); return; }
    launch(item);
}

function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    render();
}

function enterSelect(firstId) {
    selectMode = true;
    selected.clear();
    if (firstId) selected.add(firstId);
    render();
}

function exitSelect() {
    selectMode = false;
    selected.clear();
    render();
}

function onLong(item) {
    if (selectMode) { toggleSelect(item.id); return; }
    itemSheet(item, cloudSel && pagerPage() === PAGE_CLOUD ? cloudSel : null);
}

// ----------------------------------------------------------------- overlay ----

function showCard(node) {
    const o = $("overlay");
    o.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    card.appendChild(node);
    o.appendChild(card);
    o.classList.add("open");
    o.onclick = (e) => { if (e.target === o) closeOverlay(); };
}

function closeOverlay() {
    const o = $("overlay");
    o.classList.remove("open");
    o.innerHTML = "";
}

function sheet(title, buttons) {
    const w = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    w.appendChild(h);
    buttons.forEach((b) => {
        const btn = document.createElement("button");
        btn.className = "sbtn" + (b.danger ? " danger" : "");
        btn.textContent = b.label;
        if (b.sub) { const s = document.createElement("small"); s.textContent = b.sub; btn.appendChild(s); }
        btn.onclick = () => { closeOverlay(); if (b.run) b.run(); };
        w.appendChild(btn);
    });
    const c = document.createElement("div");
    c.className = "row";
    const cb = document.createElement("button");
    cb.textContent = "Cancel";
    cb.onclick = closeOverlay;
    c.appendChild(cb);
    w.appendChild(c);
    showCard(w);
}

function form(title, fields, okLabel, onOk, extra) {
    const w = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    w.appendChild(h);
    const els = {};
    for (const f of fields) {
        const lab = document.createElement("label");
        let inp;
        if (f.type === "select") {
            inp = document.createElement("select");
            f.options.forEach((o) => {
                const op = document.createElement("option");
                op.value = o.value;
                op.textContent = o.label;
                inp.appendChild(op);
            });
            if (f.value !== undefined) inp.value = f.value;
        } else if (f.type === "textarea") {
            inp = document.createElement("textarea");
            inp.rows = f.rows || 6;
            inp.value = f.value || "";
        } else if (f.type === "checkbox") {
            inp = document.createElement("input");
            inp.type = "checkbox";
            inp.checked = !!f.value;
            lab.className = "chk";
        } else if (f.type === "file") {
            inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*";
            inp.onchange = async () => {
                if (!inp.files[0]) return;
                try { f._data = await fileToIcon(inp.files[0]); toast("Icon selected"); } catch (e) { toast("Could not read that image"); }
            };
        } else {
            inp = document.createElement("input");
            inp.type = f.type || "text";
            inp.value = f.value || "";
            if (f.placeholder) inp.placeholder = f.placeholder;
            inp.autocapitalize = "off";
            inp.autocomplete = "off";
        }
        els[f.id] = inp;
        if (f.type === "checkbox") { lab.appendChild(inp); lab.appendChild(document.createTextNode(f.label)); }
        else { lab.appendChild(document.createTextNode(f.label)); lab.appendChild(inp); }
        w.appendChild(lab);
    }
    const status = document.createElement("div");
    status.className = "note";
    w.appendChild(status);
    const gather = () => {
        const v = {};
        for (const f of fields) {
            const e = els[f.id];
            v[f.id] = f.type === "checkbox" ? e.checked : f.type === "file" ? f._data : e.value;
        }
        return v;
    };
    const row = document.createElement("div");
    row.className = "row";
    (extra || []).forEach((x) => {
        const b = document.createElement("button");
        b.textContent = x.label;
        b.onclick = () => x.run(gather(), (t) => { status.textContent = t; });
        row.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = closeOverlay;
    const ok = document.createElement("button");
    ok.className = "p";
    ok.textContent = okLabel || "Save";
    ok.onclick = () => {
        if (onOk(gather()) === false) return;
        closeOverlay();
    };
    row.append(cancel, ok);
    w.appendChild(row);
    showCard(w);
    const first = fields.length && els[fields[0].id];
    if (first && first.focus && fields[0].type !== "select" && fields[0].type !== "file") setTimeout(() => first.focus(), 60);
}

function confirmSheet(message, label, run) {
    sheet(message, [{ label, danger: true, run }]);
}

// --------------------------------------------------------------- categories ----

function ensureCat(name, created) {
    name = normName(name);
    if (!name) return null;
    const hit = state.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const c = { id: "c" + uid(), name, collapsed: false };
    state.categories.push(c);
    if (created) created.add(name);
    return c;
}

function addCategoryDialog(then) {
    form("New category", [{ id: "name", label: "Name", placeholder: "e.g. Music" }], "Create", (v) => {
        const n = normName(v.name);
        if (!n) { toast("Enter a name"); return false; }
        const c = ensureCat(n);
        commit();
        if (then) then(c);
    });
}

function chooseCategory(title, opts, cb) {
    const buttons = [];
    state.categories.forEach((c) => {
        if (opts.exclude && opts.exclude === c.id) return;
        const n = state.items.filter((i) => i.catId === c.id && !i.hidden).length;
        buttons.push({ label: c.name, sub: String(n), run: () => cb(c.id) });
    });
    if (opts.unsorted) buttons.push({ label: "Unsorted", run: () => cb(null) });
    if (opts.create !== false) buttons.push({ label: "＋ New category…", run: () => addCategoryDialog((c) => cb(c.id)) });
    sheet(title, buttons);
}

function categorySheet(c) {
    const idx = state.categories.indexOf(c);
    const n = state.items.filter((i) => i.catId === c.id).length;
    sheet(c.name, [
        { label: "Rename", run: () => form("Rename category", [{ id: "name", label: "Name", value: c.name }], "Rename", (v) => {
            const nn = normName(v.name);
            if (!nn) return false;
            const dup = state.categories.find((x) => x !== c && x.name.toLowerCase() === nn.toLowerCase());
            if (dup) { toast("A category with that name exists — use Merge"); return false; }
            c.name = nn; commit();
        }) },
        { label: "Move up", run: () => { if (idx > 0) { state.categories.splice(idx, 1); state.categories.splice(idx - 1, 0, c); commit(); } } },
        { label: "Move down", run: () => { if (idx < state.categories.length - 1) { state.categories.splice(idx, 1); state.categories.splice(idx + 1, 0, c); commit(); } } },
        { label: "Merge into…", run: () => {
            if (state.categories.length < 2) { toast("Need another category to merge with"); return; }
            chooseCategory("Merge “" + c.name + "” into", { exclude: c.id, create: false }, (to) => mergeCategory(c.id, to));
        } },
        { label: "Delete", danger: true, run: () => confirmSheet("Delete “" + c.name + "”? Its " + n + " items become Unsorted.", "Delete category", () => {
            state.items.forEach((i) => { if (i.catId === c.id) i.catId = null; });
            state.categories = state.categories.filter((x) => x !== c);
            commit();
        }) }
    ]);
}

function mergeCategory(fromId, toId) {
    const from = catById(fromId), to = catById(toId);
    if (!from || !to || from === to) return;
    state.items.forEach((i) => { if (i.catId === fromId) i.catId = toId; });
    state.categories = state.categories.filter((c) => c !== from);
    commit();
    toast("Merged “" + from.name + "” into “" + to.name + "”");
}

function unsortedSheet(items) {
    sheet("Unsorted (" + items.length + ")", [
        { label: "Sort with AI…", run: aiDialog },
        { label: "Select these", run: () => { selectMode = true; selected.clear(); items.forEach((i) => selected.add(i.id)); render(); } }
    ]);
}

// -------------------------------------------------------------------- items ----

function moveItems(ids, catId) {
    state.items.forEach((i) => { if (ids.has(i.id)) i.catId = catId; });
    commit();
}

function setHidden(ids, hidden) {
    state.items.forEach((i) => { if (ids.has(i.id)) i.hidden = hidden; });
    commit();
}

function itemSheet(item, word) {
    const ids = new Set([item.id]);
    const buttons = [];
    if (word) {
        buttons.push({ label: "Remove from “" + word.label + "”", run: () => {
            removeKwFromItem(item, word.k);
            commit();
            toast("“" + item.label + "” no longer matches “" + word.label + "”");
        } });
    }
    buttons.push(
        { label: "Move to category…", run: () => chooseCategory("Move “" + item.label + "” to", { unsorted: true }, (c) => moveItems(ids, c)) },
        { label: "Edit keywords…", run: () => editKeywords(item) },
        { label: "Select several…", run: () => enterSelect(item.id) }
    );
    if (item.type === "app") {
        buttons.push({ label: "Rename", run: () => form("Rename", [{ id: "label", label: "Name", value: item.label }], "Rename", (v) => {
            const l = v.label.trim();
            if (!l) return false;
            item.label = l; item.customLabel = true; commit();
        }) });
        buttons.push({ label: "App info", run: () => { try { A.appInfo(item.pkg); } catch (e) { /* ignore */ } } });
        buttons.push({ label: "Hide from launcher", run: () => { setHidden(ids, true); toast("Hidden — bring it back via ＋ → Hidden app"); } });
        buttons.push({ label: "Uninstall…", danger: true, run: () => { try { A.uninstall(item.pkg); } catch (e) { /* ignore */ } } });
    } else {
        buttons.push({ label: "Edit shortcut", run: () => shortcutForm(item) });
        buttons.push({ label: "Remove shortcut", danger: true, run: () => confirmSheet("Remove “" + item.label + "”?", "Remove", () => {
            state.items = state.items.filter((i) => i.id !== item.id);
            commit();
        }) });
    }
    sheet(item.label, buttons);
}

function shortcutForm(item) {
    const opts = [{ value: "", label: "Unsorted" }].concat(state.categories.map((c) => ({ value: c.id, label: c.name })));
    form(item ? "Edit shortcut" : "New shortcut", [
        { id: "label", label: "Name", value: item ? item.label : "" },
        { id: "url", label: "Address (URL)", type: "url", value: item ? item.url : "", placeholder: "https://example.com" },
        { id: "cat", label: "Category", type: "select", options: opts, value: item ? (item.catId || "") : "" },
        { id: "icon", label: "Icon (optional — otherwise the site's icon)", type: "file" }
    ], "Save", (v) => {
        const label = v.label.trim(), url = normUrl(v.url);
        if (!label || !url) { toast("Name and address are required"); return false; }
        if (item) {
            item.label = label; item.url = url; item.catId = v.cat || null;
            if (v.icon) item.icon = v.icon;
        } else {
            const n = { id: "s:" + uid(), type: "link", label, url, catId: v.cat || null, page: 0 };
            if (v.icon) n.icon = v.icon;
            state.items.push(n);
        }
        commit();
    });
}

// Web shortcuts carried over from the first Launcher app (bundled as legacy-shortcuts.json).
// Adds only what is missing, into categories of the same name (created if needed).
async function importLegacy(auto) {
    let list;
    try { list = await (await fetch("legacy-shortcuts.json")).json(); }
    catch (e) { if (!auto) toast("Could not read the bundled shortcuts"); return; }
    const urls = new Set(state.items.filter((i) => i.type === "link").map((i) => i.url.replace(/\/+$/, "").toLowerCase()));
    let added = 0;
    for (const e of list) {
        const id = "s:legacy-" + e.id;
        if (itemById(id) || urls.has(e.url.replace(/\/+$/, "").toLowerCase())) continue;
        const cat = ensureCat(e.cat);
        const it = { id, type: "link", label: e.name, url: e.url, catId: cat ? cat.id : null, page: 0 };
        if (e.icon) it.icon = e.icon;
        state.items.push(it);
        added++;
    }
    state.legacyImported = true;
    commit();
    if (!auto || added) toast(added ? "Added " + added + " web shortcuts from the old Launcher" : "All old shortcuts are already there", 4000);
}

function hiddenAppsSheet() {
    const hidden = state.items.filter((i) => i.hidden);
    if (!hidden.length) { toast("No hidden apps"); return; }
    sheet("Hidden apps — tap to bring back", hidden.map((i) => ({ label: i.label, run: () => { setHidden(new Set([i.id]), false); } })));
}

// -------------------------------------------------------------------- menus ----

function addMenu() {
    sheet("Add", [
        { label: "Category", run: () => addCategoryDialog() },
        { label: "Shortcut (web link)", run: () => shortcutForm(null) },
        { label: "App (from hidden)", run: hiddenAppsSheet }
    ]);
}

function mainMenu() {
    sheet("Menu", [
        { label: "Sort with AI…", run: aiDialog },
        { label: "Improve search with AI…", run: aiIndexDialog },
        { label: "Select several…", run: () => enterSelect(null) },
        { label: "Import old Launcher shortcuts", run: () => importLegacy(false) },
        { label: "Rescan installed apps", run: () => { const r = reconcile(); commit(); toast(r.added + " new, " + r.removed + " removed"); } },
        { label: "Settings & backup…", run: settingsMenu }
    ]);
}

function settingsMenu() {
    const buttons = [
        { label: "AI server…", run: aiSettings },
        { label: "Copy backup to clipboard", run: () => {
            const copy = JSON.parse(JSON.stringify(state));
            copy.ai.key = "";
            try { A.copyText(JSON.stringify(copy)); toast("Backup copied (without the AI key)"); } catch (e) { toast("Copy failed"); }
        } },
        { label: "Restore from pasted backup…", run: restoreForm },
        { label: "Reset all organisation", danger: true, run: () => confirmSheet("Delete all categories, shortcuts and settings and start over?", "Reset", () => {
            const ai = state.ai;
            state = newState();
            state.ai = ai;
            reconcile();
            commit();
            toast("Reset — all apps are unsorted again");
        }) }
    ];
    if (hasUsageApi()) {
        refreshUsage();
        buttons.splice(1, 0, { label: usageGranted ? "Usage access: allowed ✓" : "Allow usage access (most-used list)…",
            run: () => { try { A.openUsageSettings(); } catch (e) { /* ignore */ } } });
    }
    sheet("Settings", buttons);
}

function restoreForm() {
    form("Restore backup", [{ id: "text", label: "Paste the backup text here", type: "textarea", rows: 8 }], "Restore", (v) => {
        try {
            const s = JSON.parse(v.text);
            if (!s || !Array.isArray(s.categories) || !Array.isArray(s.items)) throw new Error("not a backup");
            s.ai = Object.assign({}, DEFAULT_AI, state.ai, { key: state.ai.key });
            state = s;
            reconcile();
            commit();
            toast("Backup restored");
        } catch (e) {
            toast("That doesn't look like a valid backup");
            return false;
        }
    });
}

// ----------------------------------------------------------- selection bar ----

function selectedIds() { return new Set(selected); }

function selectionMove() {
    if (!selected.size) { toast("Select something first"); return; }
    chooseCategory("Move " + selected.size + " items to", { unsorted: true }, (c) => { moveItems(selectedIds(), c); exitSelect(); });
}

function selectionHide() {
    if (!selected.size) { toast("Select something first"); return; }
    setHidden(selectedIds(), true);
    toast("Hidden — bring them back via ＋ → App (from hidden)");
    exitSelect();
}

// ---------------------------------------------------------------------- AI ----

function aiConfigured() {
    const a = state.ai;
    return a.provider === "anthropic" ? !!a.key : !!a.url;
}

const pending = {};
let httpSeq = 0;
window.__httpResult = function (id, status, text) {
    const p = pending[id];
    if (!p) return;
    delete pending[id];
    p.resolve({ status, text });
};

function httpPost(url, headers, body) {
    return new Promise((resolve) => {
        const id = ++httpSeq;
        pending[id] = { resolve };
        try { A.httpPost(id, url, JSON.stringify(headers), body); }
        catch (e) { delete pending[id]; resolve({ status: 0, text: String(e) }); }
    });
}

// A name without a tag means ":latest"; Open WebUI's /ollama proxy only knows the full name.
function ollamaModel(name) {
    const n = (name || "").trim();
    return n && !n.includes(":") ? n + ":latest" : n;
}

function endpoint(ai) {
    if (ai.provider === "ollama") return ai.url.trim().replace(/\/+$/, "") + "/api/chat";
    if (ai.provider === "anthropic") {
        return (ai.url || "https://api.anthropic.com").replace(/\/+$/, "") + "/v1/messages";
    }
    const u = ai.url.trim().replace(/\/+$/, "");
    if (/\/chat\/completions$/.test(u)) return u;        // full endpoint given
    if (/\/api$/.test(u)) return u + "/chat/completions"; // Open WebUI: http://host:3000/api
    return u.replace(/\/v1$/, "") + "/v1/chat/completions"; // Ollama, LM Studio, llama.cpp...
}

const THINKING_ERROR = "The model only produced its reasoning and no answer (a \"thinking\" model, even with thinking switched off). " +
    "Use a non-thinking model instead, e.g. in Ollama `qwen3:4b-instruct`, `llama3.2` or `gemma3`, or turn thinking off for this model in Open WebUI " +
    "(Admin → Settings → Models → qwen3:4b → Advanced Params).";

// One request. Returns {text, thinkingOnly}; throws on HTTP/format errors.
async function aiOnce(system, user, tokens, extra) {
    const ai = state.ai;
    let headers, body;
    if (ai.provider === "anthropic") {
        headers = { "content-type": "application/json", "x-api-key": ai.key, "anthropic-version": "2023-06-01" };
        body = { model: ai.model, max_tokens: tokens, system, messages: [{ role: "user", content: user }] };
    } else if (ai.provider === "ollama") {
        headers = { "content-type": "application/json" };
        if (ai.key) headers.authorization = "Bearer " + ai.key;
        const msg = /qwen3/i.test(ai.model) ? user + " /no_think" : user;
        body = Object.assign({ model: ollamaModel(ai.model), stream: false,
                 options: { temperature: 0.2, num_predict: tokens },
                 messages: [{ role: "system", content: system }, { role: "user", content: msg }] }, extra || {});
    } else {
        headers = { "content-type": "application/json" };
        if (ai.key) headers.authorization = "Bearer " + ai.key;
        // Qwen3 "thinks" first by default; /no_think is its soft switch to skip that.
        const msg = /qwen3/i.test(ai.model) ? user + " /no_think" : user;
        body = Object.assign({ model: ai.model, temperature: 0.2, max_tokens: tokens,
                 messages: [{ role: "system", content: system }, { role: "user", content: msg }] }, extra || {});
    }
    const r = await httpPost(endpoint(ai), headers, JSON.stringify(body));
    lastRaw = String(r.text);
    if (r.status < 200 || r.status >= 300) {
        const e = new Error((r.status || "network") + " " + String(r.text).slice(0, 160));
        e.status = r.status;
        throw e;
    }
    let data;
    try { data = JSON.parse(r.text); } catch (e) { throw new Error("The server did not return JSON (is the URL right?)"); }
    let text = "", reasoning = false;
    if (ai.provider === "anthropic") {
        text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    } else if (ai.provider === "ollama") {
        const m = data.message;
        text = (m && m.content) || "";
        reasoning = !!(m && (m.thinking || m.reasoning));
    } else {
        const m = data.choices && data.choices[0] && data.choices[0].message;
        text = (m && m.content) || "";
        reasoning = !!(m && (m.reasoning_content || m.reasoning));
    }
    if (/<think>/i.test(text) && !String(text).replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim()) { reasoning = true; text = ""; }
    return { text: String(text), thinkingOnly: !String(text).trim() && reasoning };
}

async function aiAsk(system, user, maxTokens) {
    const ai = state.ai;
    // Thinking models spend tokens before answering, so never run them on a tiny budget.
    const tokens = ai.provider === "anthropic" ? (maxTokens || 4096) : Math.max(maxTokens || 4096, 3000);
    let r;
    if (ai.provider === "ollama") {
        // think:false really switches Qwen3-style thinking off. Older Ollama or a proxy may refuse the option: retry without.
        try { r = await aiOnce(system, user, tokens, { think: false }); }
        catch (e) { if (!e.status) throw e; r = await aiOnce(system, user, tokens, null); }
    } else {
        r = await aiOnce(system, user, tokens, null);
    }
    if (r.thinkingOnly && ai.provider === "openai") {
        // Ask the server to switch thinking off (Ollama / Open WebUI / llama.cpp spellings) and allow more room.
        try { r = await aiOnce(system, user, Math.max(tokens, 6000), { think: false, reasoning_effort: "none" }); }
        catch (e) { if (e.status !== 400 && e.status !== 422) throw e; }
    }
    if (r.thinkingOnly) throw new Error(THINKING_ERROR);
    if (!r.text.trim()) throw new Error("The model returned an empty reply (check the model name).");
    return r.text;
}

let lastRaw = "";
let lastAiReply = "";

function parseJson(t) {
    t = String(t).replace(/<think>[\s\S]*?<\/think>/gi, "");
    const s = t.indexOf("{"), e = t.lastIndexOf("}");
    if (s < 0 || e < s) throw new Error("No JSON in the reply");
    return JSON.parse(t.slice(s, e + 1));
}

// Plain lines survive weak/local models far better than JSON:  key | Category | rare
function parseLines(t) {
    t = String(t).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "");
    const rows = [];
    for (let line of t.split(/\r?\n/)) {
        line = line.trim().replace(/^([-*•]|\d+[.)])\s+/, "");
        if (!line) continue;
        let parts = line.includes("|") ? line.split("|") : line.split(/\s*(?:=>|->|→|:)\s+/);
        parts = parts.map((p) => p.trim().replace(/^["'`*]+|["'`*]+$/g, ""));
        if (parts.length < 2 || !parts[0] || !parts[1]) continue;
        if (/^key$/i.test(parts[0]) || /^category$/i.test(parts[1])) continue;
        rows.push({ key: parts[0], cat: parts[1], kw: parts.slice(2).join(", ") });
    }
    return rows;
}

function toRows(text) {
    const rows = parseLines(text);
    if (rows.length) return rows;
    let r = [];
    try { r = normaliseAi(parseJson(text)); } catch (e) { /* not JSON either */ }
    if (!r.length) throw new Error("The model's reply wasn't in the expected format (lines like  package | Category | keywords).");
    return r;
}

const SYSTEM_PROMPT =
    "You organise the home screen of an Android phone. You receive installed apps and shortcuts, one per line as 'key | label'. " +
    "Put every item in exactly one category. Prefer the existing categories when they fit; otherwise create a new short category " +
    "(1-2 words, Title Case). Keep the total number of categories small (about 6 to 12). " +
    "Also give 4 to 8 short search keywords or synonyms describing what the item is for (in English and in the requested language), comma-separated. " +
    "Reply with plain text ONLY: exactly one line per input item, in the form  key | Category | keyword, keyword, keyword  " +
    "(copy the key exactly as given). Example line: com.example.mail | Communication | email, inbox, messages, mail. " +
    "No headings, no explanations, no numbering, no markdown, no JSON.";

function keyOf(i) { return i.type === "app" ? i.pkg : i.id; }

async function aiChunk(chunk) {
    const existing = state.categories.map((c) => c.name);
    const lines = chunk.map((i) => keyOf(i) + " | " + i.label + (i.type === "link" ? " (web shortcut: " + safeHost(i.url) + ")" : ""));
    const user = "Existing categories: " + (existing.length ? existing.join(", ") : "none") +
        "\nLanguage for new category names: " + (state.ai.lang || "English") + "\nITEMS:\n" + lines.join("\n");
    let text = await aiAsk(SYSTEM_PROMPT, user, 4096);
    lastAiReply = text;
    try { return toRows(text); }
    catch (e) {
        text = await aiAsk(SYSTEM_PROMPT, user + "\n\nYour previous reply could not be read. Reply ONLY with lines in the form  key | Category | keywords", 4096);
        lastAiReply = text;
        return toRows(text);
    }
}

function safeHost(u) { try { return new URL(u).hostname; } catch (e) { return u; } }

// Models don't always follow the requested shape, so accept the common variants:
//   {"apps":{"pkg":{"c":"Cat","rare":false}}}   (asked for)
//   {"apps":{"pkg":"Cat"}}  /  {"apps":[{"key":"pkg","c":"Cat"}]}
//   {"Cat":["pkg","Label",...]}  /  {"categories":{"Cat":[...]}}
function normaliseAi(res) {
    const rows = [];
    const add = (key, cat, kw) => { if (key && cat) rows.push({ key: String(key), cat: String(cat), kw: Array.isArray(kw) ? kw.join(", ") : String(kw || "") }); };
    const fromList = (cat, list) => {
        if (!Array.isArray(list)) return false;
        list.forEach((x) => add(typeof x === "string" ? x : x && (x.key || x.package || x.pkg || x.label || x.name), cat, x && (x.kw || x.keywords)));
        return true;
    };
    const a = res.apps;
    if (Array.isArray(a)) {
        a.forEach((e) => e && add(e.key || e.package || e.pkg || e.app || e.id || e.label || e.name,
            e.c || e.category || e.cat, e.kw || e.keywords));
    } else if (a && typeof a === "object") {
        for (const [k, v] of Object.entries(a)) {
            if (typeof v === "string") add(k, v, "");
            else if (Array.isArray(v)) fromList(k, v);
            else if (v) add(k, v.c || v.category || v.cat, v.kw || v.keywords);
        }
    }
    if (!rows.length) {
        const groups = res.categories && !Array.isArray(res.categories) && typeof res.categories === "object" ? res.categories : res;
        for (const [cat, list] of Object.entries(groups)) fromList(cat, list);
    }
    return rows;
}

function applyAi(res, chunk, opts, created) {
    const byKey = new Map(), byLabel = new Map();
    chunk.forEach((i) => {
        byKey.set(keyOf(i).toLowerCase(), i);
        const l = i.label.toLowerCase();
        if (!byLabel.has(l)) byLabel.set(l, i);
    });
    const rows = Array.isArray(res) ? res : normaliseAi(res);
    const matched = new Set();
    for (const r of rows) {
        const k = r.key.split("|")[0].trim().toLowerCase();
        const it = byKey.get(k) || byLabel.get(k) || byLabel.get(r.key.split("|").pop().trim().toLowerCase());
        if (!it) continue;
        const cat = ensureCat(r.cat, created);
        if (!cat) continue;
        it.catId = cat.id;
        if (r.kw && r.kw.trim()) setKw(it, r.kw);
        matched.add(it.id);
    }
    return { applied: matched.size, replied: rows.length };
}

function progressCard(title) {
    const w = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = title;
    const s = document.createElement("div");
    s.className = "note";
    const row = document.createElement("div");
    row.className = "row";
    const b = document.createElement("button");
    b.textContent = "Hide";
    b.onclick = closeOverlay;
    row.appendChild(b);
    w.append(h, s, row);
    showCard(w);
    return (t) => { s.textContent = t; };
}

function resultCard(title, summary, details) {
    form(title, [{ id: "d", label: summary, type: "textarea", rows: 9, value: details || "" }], "Close", () => {}, [
        { label: "Copy", run: (v, say) => { try { A.copyText(summary + "\n\n" + v.d); say("Copied"); } catch (e) { say("Copy failed"); } } }
    ]);
}

async function aiSort(opts) {
    if (aiBusy) return;
    aiBusy = true;
    const say = progressCard("AI is sorting");
    const t0 = Date.now();
    let stage = "Starting…";
    const tick = setInterval(() => say(stage + "\n" + Math.round((Date.now() - t0) / 1000) + " s elapsed" +
        "\n(Slow home servers can take a minute or more per batch.)"), 1000);
    say(stage);
    const BATCH = 40;
    try {
        const targets = state.items.filter((i) => !i.hidden && (opts.scope === "all" || !catOf(i)));
        if (!targets.length) { clearInterval(tick); resultCard("Nothing to sort", "Every item already has a category.", ""); return; }
        const chunks = [];
        for (let k = 0; k < targets.length; k += BATCH) chunks.push(targets.slice(k, k + BATCH));
        const created = new Set();
        let done = 0, replied = 0;
        for (let n = 0; n < chunks.length; n++) {
            stage = "Batch " + (n + 1) + " of " + chunks.length + " — waiting for the AI (" + chunks[n].length + " items)…";
            lastAiReply = "";
            lastRaw = "";
            const res = await aiChunk(chunks[n]);
            const r = applyAi(res, chunks[n], opts, created);
            done += r.applied;
            replied += r.replied;
            save();
            render();
        }
        clearInterval(tick);
        const summary = "Sorted " + done + " of " + targets.length + " items into " + (created.size ? created.size + " new categories (" + [...created].join(", ") + ")" : "existing categories") + ".";
        if (done === 0) {
            resultCard("AI answered, but nothing matched",
                "The reply was received (" + replied + " entries) but none could be matched to your apps. This is the AI's reply — send it to me if it looks wrong:",
                lastAiReply.slice(0, 3000));
        } else {
            closeOverlay();
            toast(summary, 6000);
        }
    } catch (e) {
        clearInterval(tick);
        resultCard("AI sorting failed", String(e.message || e),
            lastAiReply ? "Last reply from the AI:\n" + lastAiReply.slice(0, 3000)
                : lastRaw ? "Raw response from the server:\n" + lastRaw.slice(0, 1500) : "");
    } finally {
        clearInterval(tick);
        aiBusy = false;
    }
}

function aiDialog() {
    if (!aiConfigured()) { toast("Set up the AI server first"); aiSettings(); return; }
    const unsorted = state.items.filter((i) => !i.hidden && !catOf(i)).length;
    form("Sort with AI", [
        { id: "scope", label: "What to sort", type: "select", value: unsorted ? "unsorted" : "all", options: [
            { value: "unsorted", label: "Only unsorted items (" + unsorted + ")" },
            { value: "all", label: "Everything (re-sort)" }
        ] }
    ], "Start", (v) => { setTimeout(() => aiSort({ scope: v.scope }), 0); });
}

// ---- search keywords for items that don't have any yet ----

function parseKeywordLines(t) {
    t = String(t).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```[a-z]*/gi, "");
    const rows = [];
    for (let line of t.split(/\r?\n/)) {
        line = line.trim().replace(/^([-*•]|\d+[.)])\s+/, "");
        const p = line.split("|").map((x) => x.trim());
        if (p.length < 2 || !p[0] || !p[1]) continue;
        rows.push({ key: p[0], kw: p.slice(1).join(", ").slice(0, 200) });
    }
    return rows;
}

const INDEX_PROMPT =
    "You write search keywords for apps and shortcuts on an Android phone. Each input line is 'key | label'. " +
    "For every item write 5 to 8 short keywords or synonyms describing what it is for, in English and in the requested language, comma-separated. " +
    "Reply with plain text ONLY: exactly one line per input item, in the form  key | keyword, keyword, keyword  (copy the key exactly as given). " +
    "No headings, no explanations, no markdown.";

function aiIndexDialog() {
    if (!aiConfigured()) { toast("Set up the AI server first"); aiSettings(); return; }
    const todo = state.items.filter((i) => !i.hidden && !i.kw).length;
    if (!todo) { toast("Every item already has search keywords"); return; }
    confirmSheet("Ask the AI to write search keywords for " + todo + " items? Then you can search by meaning (e.g. “money”, “music”).", "Start", () => aiIndex());
}

async function aiIndex() {
    if (aiBusy) return;
    aiBusy = true;
    const say = progressCard("Writing search keywords");
    const t0 = Date.now();
    let stage = "Starting…";
    const tick = setInterval(() => say(stage + "\n" + Math.round((Date.now() - t0) / 1000) + " s elapsed"), 1000);
    try {
        const targets = state.items.filter((i) => !i.hidden && !i.kw);
        let done = 0;
        for (let k = 0; k < targets.length; k += 40) {
            const chunk = targets.slice(k, k + 40);
            stage = "Batch " + (k / 40 + 1) + " of " + Math.ceil(targets.length / 40) + "…";
            lastAiReply = ""; lastRaw = "";
            const user = "Language: " + (state.ai.lang || "English") + "\nITEMS:\n" +
                chunk.map((i) => keyOf(i) + " | " + i.label + (i.type === "link" ? " (" + safeHost(i.url) + ")" : "")).join("\n");
            const text = await aiAsk(INDEX_PROMPT, user, 4096);
            lastAiReply = text;
            const byKey = new Map(chunk.map((i) => [keyOf(i).toLowerCase(), i]));
            for (const r of parseKeywordLines(text)) {
                const it = byKey.get(r.key.toLowerCase());
                if (it) { setKw(it, r.kw); if (it.kw) done++; }
            }
            save();
        }
        clearInterval(tick);
        closeOverlay();
        toast(done ? "Search keywords added to " + done + " items" : "The AI answered, but nothing could be used", 5000);
    } catch (e) {
        clearInterval(tick);
        resultCard("Could not write keywords", String(e.message || e), lastAiReply ? "Last reply:\n" + lastAiReply.slice(0, 3000) : lastRaw ? lastRaw.slice(0, 1500) : "");
    } finally {
        clearInterval(tick);
        aiBusy = false;
    }
}

// ---- "Ask AI": for queries the keywords don't cover ----

async function aiFind(query) {
    if (aiBusy) return;
    aiBusy = true;
    toast("Asking the AI…", 60000);
    try {
        const items = state.items.filter((i) => !i.hidden);
        const lines = items.map((i) => keyOf(i) + " | " + i.label + (i.kw ? " | " + i.kw : ""));
        const system = "You find apps on a phone that match what the user wants. Each input line is 'key | label | keywords'. " +
            "Reply with plain text ONLY: up to 8 lines, each containing just a key copied exactly, best match first. No other text.";
        const text = await aiAsk(system, "The user wants: " + query + "\nITEMS:\n" + lines.join("\n"), 1500);
        const byKey = new Map(items.map((i) => [keyOf(i).toLowerCase(), i]));
        const ids = [];
        for (let l of text.replace(/<think>[\s\S]*?<\/think>/gi, "").split(/\r?\n/)) {
            l = l.trim().replace(/^([-*•]|\d+[.)])\s+/, "").split("|")[0].trim().toLowerCase();
            const it = byKey.get(l);
            if (it && !ids.includes(it.id)) ids.push(it.id);
        }
        aiHits = { q: query, ids };
        if (ids.length) $("toast").classList.remove("show"); else toast("The AI found nothing", 3000);
        renderResults();
    } catch (e) {
        toast("AI error: " + e.message, 6000);
    } finally {
        aiBusy = false;
    }
}

function aiSettings() {
    const a = state.ai;
    form("AI server", [
        { id: "provider", label: "Type", type: "select", value: a.provider, options: [
            { value: "ollama", label: "Ollama (also Open WebUI's /ollama) — same as Zeolite" },
            { value: "anthropic", label: "Claude API (Anthropic)" },
            { value: "openai", label: "OpenAI-compatible server (LM Studio, llama.cpp…)" }
        ] },
        { id: "url", label: "Server URL (blank = official Claude API). Ollama type: http://host:11434 or Open WebUI http://host:3000/ollama", type: "url", value: a.url, placeholder: "http://192.168.129.34:3000/ollama" },
        { id: "key", label: "API key (Open WebUI: Settings → Account → API keys; plain Ollama: none)", type: "password", value: a.key },
        { id: "model", label: "Model", value: a.model, placeholder: "claude-haiku-4-5-20251001 or llama3.1" },
        { id: "lang", label: "Language for category names", value: a.lang || "English" }
    ], "Save", (v) => {
        Object.assign(state.ai, { provider: v.provider, url: v.url.trim(), key: v.key.trim(), model: v.model.trim(), lang: v.lang.trim() || "English" });
        save();
        renderCloud($("pageCloud"));
        renderResults();
        toast("AI settings saved");
    }, [{
        label: "Test",
        run: async (v, say) => {
            const saved = Object.assign({}, state.ai);
            Object.assign(state.ai, { provider: v.provider, url: v.url.trim(), key: v.key.trim(), model: v.model.trim() });
            say("Testing…");
            try {
                const t = await aiAsk("Reply with the JSON object {\"ok\":true} and nothing else.", "ping", 50);
                say("Connected ✓  " + String(t).slice(0, 80));
            } catch (e) {
                say("Failed: " + e.message);
            } finally {
                state.ai = saved;
            }
        }
    }]);
}

// ------------------------------------------------------------- navigation ----

function pagerPage() {
    const p = $("pager");
    return Math.round(p.scrollLeft / Math.max(1, p.clientWidth));
}

function goPage(n, smooth) {
    const p = $("pager");
    p.scrollTo({ left: n * p.clientWidth, behavior: smooth ? "smooth" : "auto" });
}

// Screens, in swipe order: 0 keyword cloud | 1 main (home) | 2 most-used list.
const PAGE_CLOUD = 0, PAGE_MAIN = 1, PAGE_USAGE = 2;
let lastPage = PAGE_MAIN;
function updateDots() {
    const cur = pagerPage();
    document.querySelectorAll("#dots button").forEach((b) => b.classList.toggle("on", Number(b.dataset.p) === cur));
    if (cur === lastPage) return;
    if (cur === PAGE_USAGE) { refreshUsage(); renderUsage($("page1")); }       // fresh ranking each time it is opened
    if (cur === PAGE_CLOUD) renderCloud($("pageCloud"));
    if (lastPage === PAGE_CLOUD && cloudSel) { cloudSel = null; renderCloud($("pageCloud")); }   // leave it on the cloud itself
    lastPage = cur;
}

window.__launcherBack = function () {
    if ($("overlay").classList.contains("open")) { closeOverlay(); return true; }
    if (selectMode) { exitSelect(); return true; }
    if ($("q").value) { $("q").value = ""; renderResults(); return true; }
    if (cloudSel) { cloudSel = null; renderCloud($("pageCloud")); return true; }
    if (pagerPage() !== PAGE_MAIN) { goPage(PAGE_MAIN, true); return true; }
    return false;
};

window.__onHome = function () {
    closeOverlay();
    if (selectMode) exitSelect();
    $("q").value = "";
    $("q").blur();
    renderResults();
    goPage(PAGE_MAIN, true);
};

window.__onResume = function () {
    if (!state) return;
    const r = reconcile();
    refreshUsage();
    if (r.added || r.removed) {
        commit();
        toast(r.added + " new app" + (r.added === 1 ? "" : "s") + (r.removed ? ", " + r.removed + " removed" : ""));
    } else {
        renderUsage($("page1"));
    }
};

window.__onPause = flush;

// -------------------------------------------------------------------- init ----

function init() {
    state = load();
    let first = false;
    if (!state || !Array.isArray(state.items)) { state = newState(); first = true; }
    state.ai = Object.assign({}, DEFAULT_AI, state.ai || {});
    state.launches = state.launches || {};
    const r = reconcile();
    refreshUsage();
    flush();
    render();
    goPage(PAGE_MAIN, false);                       // open on the main screen, cloud to its left, usage list to its right
    requestAnimationFrame(() => goPage(PAGE_MAIN, false));
    if (first) toast("Found " + r.added + " apps. ⋮ → Sort with AI, or long-press to organise.", 6000);
    if (!state.legacyImported) importLegacy(true);

    $("q").addEventListener("input", renderResults);
    $("q").addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const hit = searchItems($("q").value.trim())[0];
        if (hit) { launch(hit); $("q").value = ""; $("q").blur(); renderResults(); }
    });
    $("btnAdd").onclick = addMenu;
    $("btnMenu").onclick = mainMenu;
    $("selMove").onclick = selectionMove;
    $("selMore").onclick = selectionHide;
    $("selDone").onclick = exitSelect;
    $("pager").addEventListener("scroll", updateDots, { passive: true });
    document.querySelectorAll("#dots button").forEach((b) => { b.onclick = () => goPage(Number(b.dataset.p), true); });
}

init();
})();
