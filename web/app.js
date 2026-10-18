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

const perf = {};
const timed = (name, fn) => { const t = performance.now(); try { return fn(); } finally { perf[name] = Math.round(performance.now() - t); } };

function installedApps() {
    return timed("listApps", () => { try { return JSON.parse(A.listApps()); } catch (e) { return []; } });
}

// Adds newly installed apps, drops uninstalled ones, refreshes labels.
// An app of this profile is keyed by its package; one living in another profile (Secure Folder, work) also by that
// profile's number, because the same package can exist in both.
const appKey = (pkg, user) => (user ? pkg + "#u" + user : pkg);
const itemKey = (i) => appKey(i.pkg, i.user);

function reconcile(appsIn) {
    let apps = appsIn || installedApps();
    if (!apps.length) return { added: 0, removed: 0 };
    let added = 0, removed = 0;
    if (state.noProfiles) {                       // user switched the other profiles off
        apps = apps.filter((a) => !a.user);
        const before = state.items.length;
        state.items = state.items.filter((i) => !(i.type === "app" && i.user));
        removed += before - state.items.length;
    }
    const byKey = new Map(apps.map((a) => [appKey(a.package, a.user), a]));
    const usersSeen = new Set(apps.filter((a) => a.user).map((a) => a.user));
    state.items = state.items.filter((i) => {
        if (i.type !== "app" || byKey.has(itemKey(i))) return true;
        if (i.user && !usersSeen.has(i.user)) return true;   // that profile listed nothing (locked?): keep its apps
        removed++;
        return false;
    });
    const have = new Set(state.items.filter((i) => i.type === "app").map(itemKey));
    for (const a of apps) {
        const k = appKey(a.package, a.user);
        if (!have.has(k)) {
            const it = { id: "a:" + k, type: "app", pkg: a.package, label: a.label, catId: null, page: 0 };
            if (a.user) { it.user = a.user; it.kind = a.kind || "other"; }
            state.items.push(it);
            added++;
        }
    }
    for (const i of state.items) {
        if (i.type === "app") {
            const a = byKey.get(itemKey(i));
            if (a && !i.customLabel) i.label = a.label;
            if (a && i.user) i.kind = a.kind || "other";
        }
    }
    return { added, removed };
}

// What a tile or list row shows: apps of another profile carry a lock so they are told apart from this profile's copy.
// 💼 = work profile, 🔒 = any other profile (Secure Folder).
const shownLabel = (i) => (i.type === "app" && i.user ? i.label + (i.kind === "work" ? " 💼" : " 🔒") : i.label);

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
    if (i.type === "app") return "/icon/" + encodeURIComponent(itemKey(i)) + ".png";
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
    l.textContent = shownLabel(item);
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

// Categories as a word cloud instead of cards: tap a name to open it (state.mainView = "cloud").
let mainSel = null;   // "__un" or a category id while one category is open in the cloud view
const UNSORTED = "__un";

function renderCategoryCloud(el, items) {
    if (mainSel && mainSel !== UNSORTED && !catById(mainSel)) mainSel = null;
    if (mainSel) {
        const isUn = mainSel === UNSORTED;
        const c = isUn ? null : catById(mainSel);
        const list = items.filter((i) => (isUn ? !catOf(i) : i.catId === mainSel));
        const head = document.createElement("div");
        head.className = "cloudhead";
        const back = document.createElement("button");
        back.textContent = "← Categories";
        back.onclick = () => { mainSel = null; renderMain(el); };
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = isUn ? "Unsorted" : c.name;
        const more = document.createElement("button");
        more.textContent = "⋯";
        more.onclick = () => (isUn ? unsortedSheet(list) : categorySheet(c));
        head.append(back, t, more);
        el.appendChild(head);
        const card = document.createElement("div");
        card.className = "group";
        if (!list.length) {
            const e = document.createElement("div");
            e.className = "empty";
            e.textContent = "Empty — move apps here from their long-press menu.";
            card.appendChild(e);
        } else {
            const grid = document.createElement("div");
            grid.className = "grid";
            list.forEach((i) => grid.appendChild(tile(i)));
            card.appendChild(grid);
        }
        el.appendChild(card);
        return;
    }
    const entries = state.categories.map((c) => ({ id: c.id, label: c.name, items: items.filter((i) => i.catId === c.id), cat: c }));
    const un = items.filter((i) => !catOf(i));
    if (un.length) entries.push({ id: UNSORTED, label: "Unsorted", items: un, cat: null });
    if (!entries.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.style.cssText = "padding:40px 16px;text-align:center";
        e.textContent = "Nothing here yet. Tap ＋ to add a category or shortcut.";
        el.appendChild(e);
        return;
    }
    const note = document.createElement("div");
    note.className = "cloudnote";
    note.textContent = "Tap a category to open it · long-press for rename, move, merge";
    el.appendChild(note);
    const fracs = sizeFractions(entries.map((x) => ({ n: x.items.length, items: x.items })));
    const cloud = document.createElement("div");
    cloud.className = "cloud";
    entries.forEach((x, n) => {
        const b = document.createElement("button");
        b.className = "kw";
        b.textContent = x.label + (x.items.length ? "" : " (empty)");
        b.style.fontSize = Math.round(17 + 22 * fracs[n]) + "px";
        b.style.color = x.cat ? "hsl(" + hueOf(x.label) + ",62%,52%)" : "var(--muted)";
        attachPress(b, () => { mainSel = x.id; renderMain(el); el.scrollTop = 0; },
            () => (x.cat ? categorySheet(x.cat) : unsortedSheet(x.items)));
        cloud.appendChild(b);
    });
    el.appendChild(cloud);
}

function renderMain(el) {
    el.innerHTML = "";
    const items = state.items.filter((i) => !i.hidden);
    let any = false;
    const cloudView = state.mainView === "cloud";
    if (state.categories.length || cloudView) {
        const bar = document.createElement("div");
        bar.className = "cardbar";
        const mk = (label, fn) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.onclick = fn;
            return b;
        };
        if (!cloudView) bar.append(mk("▸ Collapse all", () => setAllCollapsed(true)), mk("▾ Expand all", () => setAllCollapsed(false)));
        bar.append(mk(cloudView ? "▦ Cards" : "☁ Word cloud", () => { state.mainView = cloudView ? "cards" : "cloud"; mainSel = null; commit(); }));
        if (!(cloudView && mainSel)) el.appendChild(bar);
    }
    if (cloudView) { renderCategoryCloud(el, items); return; }
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
    timed("usageStats", () => {
        try {
            usageGranted = hasUsageApi() && !!A.usageAccess();
            usageMs = usageGranted ? JSON.parse(A.usageStats()) : {};
        } catch (e) { usageGranted = false; usageMs = {}; }
    });
}

// Foreground time over the last 30 days (real usage, needs permission) plus launches made from here
// (each counted as one minute), so shortcuts and the no-permission case still rank sensibly.
function usageScore(i) {
    const ms = i.type === "app" && !i.user ? (usageMs[i.pkg] || 0) : 0;
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
        r.textContent = shownLabel(i);
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
            if (!e) { e = { k, items: [], forms: new Map() }; m.set(k, e); }
            e.items.push(i);
            e.forms.set(w, (e.forms.get(w) || 0) + 1);
        }
    }
    const out = [];
    for (const e of m.values()) {
        const forms = [...e.forms.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
        out.push({ k: e.k, label: (state.kwLabel || {})[e.k] || forms[0][0], n: e.items.length, items: e.items, variants: forms.map((f) => f[0]) });
    }
    return out;
}

// Font-size fractions (0..1) for a list of {n, items}. By use: a word is as big as the apps behind it are used
// (log scale, so one heavy app doesn't flatten everything); falls back to counts until there is any usage.
function sizeFractions(list) {
    let ws = list.map((x) => x.n);
    if (state.cloudSize !== "count") {
        const use = list.map((x) => x.items.reduce((a, i) => a + usageScore(i), 0));
        if (use.some(Boolean)) ws = use;
    }
    const lg = ws.map((w) => Math.log(1 + w));
    const lo = Math.min(...lg), hi = Math.max(...lg);
    return lg.map((v) => (hi === lo ? 0.4 : (v - lo) / (hi - lo)));
}

function maxCommon() {
    return state.cloudMaxN === undefined ? 10 : state.cloudMaxN;   // 0 = never hide
}

function pinnedKeys() { return state.kwPin || []; }

function togglePin(w) {
    state.kwPin = pinnedKeys().slice();
    const at = state.kwPin.indexOf(w.k);
    if (at >= 0) state.kwPin.splice(at, 1);
    else if (state.kwPin.length >= 12) { toast("Pin at most 12 words — unpin one first"); return; }
    else state.kwPin.push(w.k);
    commit();
}

function makeCategoryFromWord(w) {
    const related = relatedItems(w.k);
    const unsorted = related.filter((i) => !catOf(i));
    const name = w.label.charAt(0).toUpperCase() + w.label.slice(1);
    const go = (items) => {
        const c = ensureCat(name);
        const ids = new Set(items.map((i) => i.id));
        state.items.forEach((i) => { if (ids.has(i.id)) i.catId = c.id; });
        cloudSel = null;
        commit();
        goPage(PAGE_MAIN, true);
        toast("Category “" + c.name + "” now has " + items.length + " items");
    };
    const buttons = [{ label: "Move all " + related.length + " items there", run: () => go(related) }];
    if (unsorted.length && unsorted.length < related.length) buttons.push({ label: "Only the " + unsorted.length + " unsorted ones", run: () => go(unsorted) });
    sheet("Make “" + name + "” a category", buttons);
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
    const pinned = pinnedKeys().includes(w.k);
    const buttons = [
        { label: "Show apps (" + w.n + ")", run: () => { cloudSel = { k: w.k, label: w.label }; renderCloud($("pageCloud")); } },
        { label: pinned ? "★ Unpin from the top" : "☆ Pin to the top", run: () => togglePin(w) },
        { label: "Make this a category…", run: () => makeCategoryFromWord(w) },
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
        } },
        { label: "Hide very common words: " + (maxCommon() ? "more than " + maxCommon() + " items" : "OFF"), run: () => form("Hide very common words",
            [{ id: "n", label: "Hide a word when it matches more than this many items (0 = never hide)", type: "number", value: String(maxCommon()) }], "Save", (v) => {
                const n = parseInt(v.n, 10);
                if (isNaN(n) || n < 0) { toast("Enter 0 or a positive number"); return false; }
                state.cloudMaxN = n; commit();
            }) },
        { label: "Word size by: " + (state.cloudSize === "count" ? "number of apps" : "how much you use them"), run: () => {
            state.cloudSize = state.cloudSize === "count" ? "use" : "count"; commit();
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

function hueOf(s) {
    let h = 0;
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 360;
    return h;
}

function wordButton(w, frac, pinned) {
    const b = document.createElement("button");
    b.className = "kw" + (pinned ? " pin" : "");
    b.textContent = w.label;
    b.style.fontSize = Math.round(pinned ? 16 + 10 * frac : 15 + 21 * frac) + "px";
    b.style.color = "hsl(" + hueOf(w.k) + ",62%,52%)";
    attachPress(b, () => { cloudSel = { k: w.k, label: w.label }; renderCloud($("pageCloud")); $("pageCloud").scrollTop = 0; }, () => wordSheet(w));
    return b;
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
        const pin = document.createElement("button");
        const isPinned = pinnedKeys().includes(cloudSel.k);
        pin.textContent = isPinned ? "★" : "☆";
        pin.title = isPinned ? "Unpin" : "Pin to the top";
        pin.onclick = () => togglePin(cloudSel);
        const mk = document.createElement("button");
        mk.textContent = "＋ Category";
        mk.onclick = () => makeCategoryFromWord(cloudSel);
        head.append(back, t, pin, mk);
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
    const all = cloudWords();
    if (!all.length && !(state.items.some((i) => i.kw))) {
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
    const pinSet = new Set(pinnedKeys());
    const pinnedWords = pinnedKeys().map((k) => all.find((w) => w.k === k)).filter(Boolean);
    const minN = state.cloudMin || 1, maxN = maxCommon();
    let tooCommon = 0;
    const rest = all.filter((w) => {
        if (pinSet.has(w.k) || w.n < minN) return false;
        if (maxN && w.n > maxN) { tooCommon++; return false; }
        return true;
    });
    const bar = document.createElement("div");
    bar.className = "cloudbar";
    const note = document.createElement("span");
    note.textContent = rest.length + " words" + (tooCommon ? " · " + tooCommon + " very common hidden" : "") + " · tap to open, long-press for more";
    const cb = document.createElement("button");
    cb.textContent = "Condense…";
    cb.onclick = condenseMenu;
    bar.append(note, cb);
    el.appendChild(bar);

    if (pinnedWords.length) {
        const row = document.createElement("div");
        row.className = "pinrow";
        const lab = document.createElement("span");
        lab.className = "lab";
        lab.textContent = "★ Pinned";
        row.appendChild(lab);
        const fr = sizeFractions(pinnedWords);
        pinnedWords.forEach((w, n) => row.appendChild(wordButton(w, fr[n], true)));
        el.appendChild(row);
    }
    if (!rest.length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "No words left with the current filters.";
        el.appendChild(e);
        return;
    }
    const top = rest.slice().sort((a, b) => b.n - a.n || a.k.localeCompare(b.k)).slice(0, 90)
        .sort((a, b) => a.k.localeCompare(b.k));
    const fracs = sizeFractions(top);
    const cloud = document.createElement("div");
    cloud.className = "cloud";
    top.forEach((w, n) => cloud.appendChild(wordButton(w, fracs[n], false)));
    el.appendChild(cloud);
}

function render() {
    renderCloud($("pageCloud"));
    renderMain($("page0"));
    renderUsage($("page1"));
    renderDash($("pageDash"));
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
        try { ok = item.user && typeof A.launchUser === "function" ? A.launchUser(item.pkg, item.user) : A.launch(item.pkg); } catch (e) { /* ignore */ }
        if (!ok) toast("Could not open " + item.label);
    } else {
        try {
            if (item.browser && typeof A.openUrlIn === "function") A.openUrlIn(item.url, item.browser);
            else A.openUrl(item.url);
        } catch (e) { toast("Could not open link"); }
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
        if (!item.user) buttons.push({ label: "App info", run: () => { try { A.appInfo(item.pkg); } catch (e) { /* ignore */ } } });
        buttons.push({ label: "Hide from launcher", run: () => { setHidden(ids, true); toast("Hidden — bring it back via ＋ → Hidden app"); } });
        if (!item.user) buttons.push({ label: "Uninstall…", danger: true, run: () => { try { A.uninstall(item.pkg); } catch (e) { /* ignore */ } } });
    } else {
        buttons.push({ label: "Edit shortcut", run: () => shortcutForm(item) });
        buttons.push({ label: "Remove shortcut", danger: true, run: () => confirmSheet("Remove “" + item.label + "”?", "Remove", () => {
            state.items = state.items.filter((i) => i.id !== item.id);
            commit();
        }) });
    }
    sheet(item.label, buttons);
}

function installedBrowsers() {
    try { return typeof A.browsers === "function" ? JSON.parse(A.browsers()) : []; } catch (e) { return []; }
}

function shortcutForm(item) {
    const opts = [{ value: "", label: "Unsorted" }].concat(state.categories.map((c) => ({ value: c.id, label: c.name })));
    const browsers = installedBrowsers();
    const bopts = [{ value: "", label: "Default browser (Android decides)" }].concat(browsers.map((b) => ({ value: b.package, label: b.label })));
    if (item && item.browser && !browsers.some((b) => b.package === item.browser)) bopts.push({ value: item.browser, label: item.browser + " (not installed)" });
    const fields = [
        { id: "label", label: "Name", value: item ? item.label : "" },
        { id: "url", label: "Address (URL)", type: "url", value: item ? item.url : "", placeholder: "https://example.com" },
        { id: "cat", label: "Category", type: "select", options: opts, value: item ? (item.catId || "") : "" }
    ];
    if (typeof A.openUrlIn === "function") fields.push({ id: "browser", label: "Open with", type: "select", options: bopts, value: item ? (item.browser || "") : "" });
    fields.push({ id: "icon", label: "Icon (optional — otherwise the site's icon)", type: "file" });
    form(item ? "Edit shortcut" : "New shortcut", fields, "Save", (v) => {
        const label = v.label.trim(), url = normUrl(v.url);
        if (!label || !url) { toast("Name and address are required"); return false; }
        const setBrowser = (it) => { if (v.browser) it.browser = v.browser; else delete it.browser; };
        if (item) {
            item.label = label; item.url = url; item.catId = v.cat || null;
            if (v.icon) item.icon = v.icon;
            if ("browser" in v) setBrowser(item);
        } else {
            const n = { id: "s:" + uid(), type: "link", label, url, catId: v.cat || null, page: 0 };
            if (v.icon) n.icon = v.icon;
            if (v.browser) n.browser = v.browser;
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
        { label: state.mainView === "cloud" ? "Show categories as cards" : "Show categories as a word cloud", run: () => { state.mainView = state.mainView === "cloud" ? "cards" : "cloud"; mainSel = null; commit(); } },
        { label: state.startPage === "main" ? "Home button opens: categories → switch to dashboard" : "Home button opens: dashboard → switch to categories",
            run: () => { state.startPage = state.startPage === "main" ? "dash" : "main"; save(); toast("Home now opens the " + (state.startPage === "main" ? "categories" : "dashboard")); } },
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
        { label: state.noProfiles ? "Show apps from other profiles (work / Secure Folder)" : "Hide apps from other profiles (work / Secure Folder)",
            run: () => { state.noProfiles = !state.noProfiles; const r = reconcile(); commit(); toast(state.noProfiles ? "Other profiles hidden" : "Rescanning…"); if (!state.noProfiles) scanAndReconcile(() => commit()); } },
        { label: "Check Secure Folder / work profile access…", run: () => resultCard("Profiles this app can see",
            "If only one profile is listed, Android does not let this launcher list or open apps from the Secure Folder.",
            typeof A.profilesInfo === "function" ? A.profilesInfo() : "Not available in this version.") },
        { label: "Speed report…", run: () => resultCard("Speed report (milliseconds)", "How long each start-up step took on this phone:",
            "Page + scripts loaded after: " + perf.pageLoad + "\nSaved state read: " + perf.loadState + "\nFirst screens drawn: " + perf.firstRender +
            "\nApp scan (last, background): " + perf.listApps + (typeof A.scanInfo === "function" ? "\n   " + A.scanInfo() : "") +
            "\nUsage query (last): " + perf.usageStats + "\nAgenda ready after: " + perf.agenda + "\nWeather ready after: " + perf.weather +
            "\nApp list up to date at: " + perf.ready) },
        { label: "Copy categories to clipboard (for another device)", run: () => {
            try { A.copyText(JSON.stringify(categoriesExport())); toast("Categories copied — paste them on the other device"); } catch (e) { toast("Copy failed"); }
        } },
        { label: "Import categories from paste…", run: importCategoriesForm },
        { label: "Restore everything from pasted backup…", run: restoreForm },
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

// ------------------------------------------------- categories: copy to / import from another device ----
// Categories only. Same-named categories merge, categories only on this device stay untouched, categories only
// in the paste are created. Apps are matched by package (missing ones are skipped); shortcuts are matched by
// address and created here when missing.

const urlKey = (u) => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
const safeUrl = (u) => /^(https?|market|intent|[a-z][a-z0-9+.-]*):/i.test(u) && !/^(javascript|data|file|blob|content):/i.test(u);
const safeIcon = (i) => (typeof i === "string" && (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(i) || /^icons\/[\w\-./]+\.(png|jpe?g|webp|svg)$/i.test(i))) ? i : "";

function categoriesExport() {
    const names = new Map(state.categories.map((c) => [c.id, c.name]));
    return {
        v: 1, kind: "categories",
        categories: state.categories.map((c) => ({ name: c.name })),
        items: state.items.filter((i) => catOf(i)).map((i) => {
            const o = { type: i.type, label: i.label, cat: names.get(i.catId) };
            if (i.type === "app") { o.pkg = i.pkg; if (i.user) o.profile = true; }
            else { o.url = i.url; if (i.icon) o.icon = i.icon; if (i.kw) o.kw = i.kw; if (i.browser) o.browser = i.browser; }
            return o;
        })
    };
}

// Reads a category export or a full backup. Returns { cats: [names], entries: [{ cat, item }] }.
function parseCategoryPaste(text) {
    const s = JSON.parse(String(text).trim());
    if (!s || !Array.isArray(s.categories) || !Array.isArray(s.items)) throw new Error("not a category export or backup");
    const byId = new Map(s.categories.map((c) => [c && c.id, c && c.name]));
    const cats = [];
    s.categories.forEach((c) => { const n = normName(c && c.name); if (n && !cats.some((x) => x.toLowerCase() === n.toLowerCase())) cats.push(n); });
    const entries = [];
    s.items.forEach((i) => {
        if (!i || typeof i !== "object") return;
        const cat = normName(i.cat != null ? i.cat : byId.get(i.catId));
        if (!cat) return;
        if (!cats.some((x) => x.toLowerCase() === cat.toLowerCase())) cats.push(cat);
        entries.push({ cat, item: i });
    });
    return { cats, entries };
}

// Works out (and, with apply=true, performs) the import. moveSorted: also move apps that already sit in another category here.
function importCategories(text, moveSorted, apply) {
    const p = parseCategoryPaste(text);
    const sum = { newCats: 0, mergedCats: 0, assigned: 0, unchanged: 0, keptElsewhere: 0, appsMissing: 0, linksCreated: 0, linksBad: 0 };
    const has = (n) => state.categories.some((c) => c.name.toLowerCase() === n.toLowerCase());
    const catRef = new Map();          // lower-case name -> category (a stand-in object while only previewing)
    p.cats.forEach((n) => {
        const key = n.toLowerCase();
        if (has(n)) sum.mergedCats++; else sum.newCats++;
        catRef.set(key, apply ? ensureCat(n) : (state.categories.find((c) => c.name.toLowerCase() === key) || { id: "preview:" + key, name: n }));
    });
    const apps = new Map(state.items.filter((i) => i.type === "app").map((i) => [(i.user ? "p:" : "") + i.pkg, i]));
    const links = new Map(state.items.filter((i) => i.type === "link").map((i) => [urlKey(i.url), i]));
    const place = (dev, cat) => {
        if (dev.catId === cat.id) { sum.unchanged++; return; }
        if (dev.catId && catOf(dev) && !moveSorted) { sum.keptElsewhere++; return; }
        sum.assigned++;
        if (apply) dev.catId = cat.id;
    };
    for (const e of p.entries) {
        const cat = catRef.get(e.cat.toLowerCase());
        const i = e.item;
        if (i.type === "app") {
            const dev = apps.get((i.profile || i.user ? "p:" : "") + i.pkg);
            if (!dev) { sum.appsMissing++; continue; }          // not installed on this device: ignored
            place(dev, cat);
        } else if (i.type === "link") {
            const url = normUrl(i.url);
            if (!url || !safeUrl(url)) { sum.linksBad++; continue; }
            const dev = links.get(urlKey(url));
            if (dev) { place(dev, cat); continue; }
            sum.linksCreated++;
            if (apply) {
                const n = { id: "s:" + uid(), type: "link", label: String(i.label || url).slice(0, 60), url, catId: cat.id, page: 0 };
                const ic = safeIcon(i.icon);
                if (ic) n.icon = ic;
                if (typeof i.kw === "string" && i.kw) n.kw = i.kw.slice(0, 200);
                if (typeof i.browser === "string" && /^[\w.]{1,100}$/.test(i.browser)) n.browser = i.browser;
                state.items.push(n);
                links.set(urlKey(url), n);
            }
        }
    }
    return sum;
}

function importSummary(m) {
    const lines = [
        m.newCats + " new categor" + (m.newCats === 1 ? "y" : "ies") + " created, " + m.mergedCats + " merged with existing ones",
        m.assigned + " app/shortcut" + (m.assigned === 1 ? "" : "s") + " placed in a category",
        m.linksCreated + " shortcut" + (m.linksCreated === 1 ? "" : "s") + " created"
    ];
    if (m.unchanged) lines.push(m.unchanged + " already in the right category");
    if (m.keptElsewhere) lines.push(m.keptElsewhere + " left in their current category");
    if (m.appsMissing) lines.push(m.appsMissing + " app" + (m.appsMissing === 1 ? "" : "s") + " not installed here, ignored");
    if (m.linksBad) lines.push(m.linksBad + " shortcut" + (m.linksBad === 1 ? "" : "s") + " skipped (unusable address)");
    return lines.join("\n");
}

function importCategoriesForm() {
    form("Import categories", [
        { id: "text", label: "Paste the text copied with “Copy categories to clipboard” (a full backup works too)", type: "textarea", rows: 7 },
        { id: "moveSorted", label: "Also move apps that are already in another category on this device", type: "checkbox", value: true }
    ], "Import", (v) => {
        try {
            const m = importCategories(v.text, v.moveSorted, true);
            commit();
            toast(importSummary(m).split("\n").slice(0, 3).join(" · "), 6000);
        } catch (e) {
            toast("That doesn't look like a category export or backup");
            return false;
        }
    }, [{ label: "Preview", run: (v, say) => {
        try { say(importSummary(importCategories(v.text, v.moveSorted, false))); }
        catch (e) { say("That doesn't look like a category export or backup."); }
    } }]);
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

function keyOf(i) { return i.type === "app" && !i.user ? i.pkg : i.id; }

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

// Screens, in swipe order: 0 keyword cloud | 1 dashboard | 2 categories | 3 most-used list.
const PAGE_CLOUD = 0, PAGE_DASH = 1, PAGE_MAIN = 2, PAGE_USAGE = 3;
// "Home" (the Home button, first start) goes to the dashboard unless the user chose the categories.
const homePage = () => (state && state.startPage === "main" ? PAGE_MAIN : PAGE_DASH);
let lastPage = PAGE_DASH;
function updateDots() {
    const cur = pagerPage();
    document.querySelectorAll("#dots button").forEach((b) => b.classList.toggle("on", Number(b.dataset.p) === cur));
    if (cur === lastPage) return;
    if (cur === PAGE_USAGE) { refreshUsage(); renderUsage($("page1")); }       // fresh ranking each time it is opened
    if (cur === PAGE_CLOUD) { refreshUsage(); renderCloud($("pageCloud")); }   // word sizes follow current usage
    if (cur === PAGE_DASH) refreshDash(false);                                 // clocks, agenda, weather up to date
    if (lastPage === PAGE_CLOUD && cloudSel) { cloudSel = null; renderCloud($("pageCloud")); }   // leave it on the cloud itself
    lastPage = cur;
}

window.__launcherBack = function () {
    if ($("overlay").classList.contains("open")) { closeOverlay(); return true; }
    if (selectMode) { exitSelect(); return true; }
    if ($("q").value) { $("q").value = ""; renderResults(); return true; }
    if (cloudSel && pagerPage() === PAGE_CLOUD) { cloudSel = null; renderCloud($("pageCloud")); return true; }
    if (mainSel && pagerPage() === PAGE_MAIN) { mainSel = null; renderMain($("page0")); return true; }
    if (pagerPage() !== homePage()) { goPage(homePage(), true); return true; }
    return false;
};

window.__onHome = function () {
    closeOverlay();
    if (selectMode) exitSelect();
    $("q").value = "";
    $("q").blur();
    renderResults();
    if (mainSel) { mainSel = null; renderMain($("page0")); }
    goPage(homePage(), true);
};

window.__onResume = function () {
    if (!state) return;
    scanAndReconcile((r) => {
        if (r.added || r.removed) {
            commit();
            toast(r.added + " new app" + (r.added === 1 ? "" : "s") + (r.removed ? ", " + r.removed + " removed" : ""));
        } else {
            renderUsage($("page1"));
        }
    });
    if (pagerPage() === PAGE_DASH) refreshDash(false);
};

// The installed-app scan is slow on a big phone, so it runs on a native thread and the screen stays usable.
let scanning = false;
function scanAndReconcile(done) {
    if (scanning) return;
    if (typeof A.listAppsAsync !== "function") { const r = reconcile(); refreshUsage(); done(r); return; }
    scanning = true;
    const t = performance.now();
    nativeDirect("listAppsAsync").then((apps) => {
        scanning = false;
        perf.listApps = Math.round(performance.now() - t);
        const r = reconcile(Array.isArray(apps) ? apps : []);
        refreshUsage();
        done(r);
    });
}

window.__onPause = flush;

// ==================================================================== Dashboard screen ====
// Top: clocks for six time zones. Middle: agenda. Bottom: weather.

const nativePending = {};
let nativeSeq = 1000;
window.__nativeResult = function (id, json) {
    const p = nativePending[id];
    if (!p) return;
    delete nativePending[id];
    let v = {};
    try { v = JSON.parse(json); } catch (e) { /* keep {} */ }
    p(v);
};

// Android shows one permission dialog at a time (a second request is dropped), so calls run one after another.
let nativeChain = Promise.resolve();
function nativeDirect(fn, ...args) {
    return new Promise((resolve) => {
        const id = ++nativeSeq;
        nativePending[id] = resolve;
        try { A[fn](id, ...args); }
        catch (e) { delete nativePending[id]; resolve({ error: String(e) }); }
    });
}
function nativeCall(fn, ...args) {
    const p = nativeChain.then(() => nativeDirect(fn, ...args));
    nativeChain = p.catch(() => {});
    return p;
}

function httpGet(url) {
    return new Promise((resolve) => {
        const id = ++httpSeq;
        pending[id] = { resolve };
        try { A.httpGet(id, url); }
        catch (e) { delete pending[id]; resolve({ status: 0, text: String(e) }); }
    });
}

const DAY = 86400000;
const hhmm = (ms) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

function dashCard(title, buttons) {
    const c = document.createElement("div");
    c.className = "wcard";
    const h = document.createElement("div");
    h.className = "wh";
    const t = document.createElement("span");
    t.className = "wt";
    t.textContent = title;
    h.appendChild(t);
    (buttons || []).forEach((b) => {
        const x = document.createElement("button");
        x.textContent = b[0];
        x.title = b[2] || "";
        x.onclick = b[1];
        h.appendChild(x);
    });
    const body = document.createElement("div");
    c.append(h, body);
    return { card: c, body, title: t };
}

// ---------------------------------------------------------------- time ----

const DEFAULT_ZONES = [
    { label: "Seattle", tz: "America/Los_Angeles" }, { label: "St. Louis", tz: "America/Chicago" },
    { label: "Montréal", tz: "America/Toronto" }, { label: "São Paulo", tz: "America/Sao_Paulo" },
    { label: "Istanbul", tz: "Europe/Istanbul" }
];

const CITIES = [["Seattle", "America/Los_Angeles"], ["Vancouver", "America/Vancouver"], ["San Francisco", "America/Los_Angeles"],
    ["Denver", "America/Denver"], ["St. Louis", "America/Chicago"], ["Chicago", "America/Chicago"], ["Mexico City", "America/Mexico_City"],
    ["New York", "America/New_York"], ["Montréal", "America/Toronto"], ["Toronto", "America/Toronto"], ["Bogotá", "America/Bogota"],
    ["Lima", "America/Lima"], ["Santiago", "America/Santiago"], ["Buenos Aires", "America/Argentina/Buenos_Aires"], ["São Paulo", "America/Sao_Paulo"],
    ["Anchorage", "America/Anchorage"], ["Honolulu", "Pacific/Honolulu"], ["Reykjavik", "Atlantic/Reykjavik"], ["London", "Europe/London"],
    ["Dublin", "Europe/Dublin"], ["Lisbon", "Europe/Lisbon"], ["Paris", "Europe/Paris"], ["Brussels", "Europe/Brussels"], ["Amsterdam", "Europe/Amsterdam"],
    ["Berlin", "Europe/Berlin"], ["Rome", "Europe/Rome"], ["Madrid", "Europe/Madrid"], ["Zurich", "Europe/Zurich"], ["Stockholm", "Europe/Stockholm"],
    ["Warsaw", "Europe/Warsaw"], ["Athens", "Europe/Athens"], ["Helsinki", "Europe/Helsinki"], ["Kyiv", "Europe/Kiev"], ["Istanbul", "Europe/Istanbul"],
    ["Moscow", "Europe/Moscow"], ["Cairo", "Africa/Cairo"], ["Nairobi", "Africa/Nairobi"], ["Lagos", "Africa/Lagos"], ["Johannesburg", "Africa/Johannesburg"],
    ["Tel Aviv", "Asia/Jerusalem"], ["Dubai", "Asia/Dubai"], ["Tehran", "Asia/Tehran"], ["Karachi", "Asia/Karachi"], ["Delhi", "Asia/Kolkata"],
    ["Dhaka", "Asia/Dhaka"], ["Bangkok", "Asia/Bangkok"], ["Singapore", "Asia/Singapore"], ["Hong Kong", "Asia/Hong_Kong"], ["Shanghai", "Asia/Shanghai"],
    ["Tokyo", "Asia/Tokyo"], ["Seoul", "Asia/Seoul"], ["Sydney", "Australia/Sydney"], ["Perth", "Australia/Perth"], ["Auckland", "Pacific/Auckland"], ["UTC", "UTC"]];

const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const cityOfTz = (tz) => (String(tz).split("/").pop() || tz).replace(/_/g, " ");

function zoneList() {
    const mine = [{ label: cityOfTz(localTz()), tz: localTz(), here: true }];
    return mine.concat(state.zones && state.zones.length === 5 ? state.zones : DEFAULT_ZONES);
}

function zoneParts(tz, now) {
    const o = {};
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23" })
        .formatToParts(now).forEach((p) => { o[p.type] = +p.value; });
    return o;
}

function renderTime(body) {
    body.innerHTML = "";
    const now = new Date();
    const mine = zoneParts(localTz(), now);
    const grid = document.createElement("div");
    grid.className = "zones";
    zoneList().forEach((z) => {
        const p = zoneParts(z.tz, now);
        const diff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(mine.year, mine.month - 1, mine.day)) / DAY);
        const d = document.createElement("div");
        d.className = "zone" + (z.here ? " here" : "");
        const city = document.createElement("div");
        city.className = "zc";
        city.textContent = (p.hour >= 7 && p.hour < 19 ? "☀️ " : "🌙 ") + (z.here ? "📍" : "") + z.label;
        const tm = document.createElement("div");
        tm.className = "zt";
        tm.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", timeZone: z.tz }).format(now);
        const dt = document.createElement("div");
        dt.className = "zd";
        dt.textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", timeZone: z.tz }).format(now) +
            (diff ? " · " + (diff > 0 ? "+" : "") + diff + "d" : "");
        d.append(city, tm, dt);
        grid.appendChild(d);
    });
    body.appendChild(grid);
}

function editZones() {
    const cur = state.zones && state.zones.length === 5 ? state.zones : DEFAULT_ZONES;
    const options = CITIES.map((c) => ({ value: c[1] + "|" + c[0], label: c[0] + "  (" + c[1].split("/")[0] + ")" }));
    const fields = cur.map((z, n) => {
        const v = z.tz + "|" + z.label;
        if (!options.some((o) => o.value === v)) options.unshift({ value: v, label: z.label });
        return { id: "z" + n, label: "Zone " + (n + 1), type: "select", options, value: v };
    });
    form("Time zones (the first clock is always your own)", fields, "Save", (v) => {
        state.zones = [0, 1, 2, 3, 4].map((n) => { const [tz, label] = v["z" + n].split("|"); return { tz, label }; });
        commit();
    });
}

// -------------------------------------------------------------- agenda ----

const agenda = { items: [], perm: null, note: "", at: 0 };
const feedCache = {};

const hasCalApi = () => typeof A.hasCalendarAccess === "function";
const hasLocApi = () => typeof A.requestLocation === "function";

function acctKind(c) {
    const t = ((c.type || "") + " " + (c.account || "")).toLowerCase();
    if (/outlook|exchange|microsoft|office|hotmail|live\.com/.test(t)) return "Outlook";
    if (/google|gmail/.test(t)) return "Google";
    if (/samsung|local|device|android\.calendar/.test(t)) return "Phone";
    return c.account || "Other";
}

function devCalendars() {
    try { return JSON.parse(A.calendars()); } catch (e) { return []; }
}

const AGENDA_DAYS = 14;
function agendaWindow() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return [d.getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + AGENDA_DAYS).getTime()];
}

async function icsText(f, force) {
    const c = feedCache[f.id];
    if (c && !force && Date.now() - c.t < 30 * 60000) return c.text;
    const url = f.url.replace(/^webcal:/i, "https:");
    const r = await httpGet(url);
    if (r.status !== 200) throw new Error(r.status ? "HTTP " + r.status : "no connection");
    if (!/BEGIN:VCALENDAR/i.test(r.text)) throw new Error("not a calendar link");
    feedCache[f.id] = { t: Date.now(), text: r.text };
    return r.text;
}

async function loadAgenda(force) {
    if (!force && agenda.at && Date.now() - agenda.at < 60000) { renderAgenda(); return; }
    const [from, to] = agendaWindow();
    const items = [];
    const notes = [];
    if (hasCalApi()) {
        if (!A.hasCalendarAccess() && !state.askedCal) {
            state.askedCal = true;
            save();
            await nativeCall("requestCalendarAccess");
        }
        agenda.perm = !!A.hasCalendarAccess();
        if (agenda.perm) {
            const cals = devCalendars();
            const byId = new Map(cals.map((c) => [c.id, c]));
            const ids = state.calSel ? state.calSel : cals.filter((c) => c.visible).map((c) => c.id);
            let evs = [];
            try { evs = JSON.parse(A.events(from, to, JSON.stringify(ids))); } catch (e) { /* none */ }
            for (const e of evs) {
                let b = e.begin, en = e.end;
                if (e.allDay) {   // the calendar stores all-day events as UTC midnights
                    const d0 = new Date(b), d1 = new Date(en);
                    b = new Date(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()).getTime();
                    en = new Date(d1.getUTCFullYear(), d1.getUTCMonth(), d1.getUTCDate()).getTime();
                    if (en <= b) en = b + DAY;
                }
                const c = byId.get(e.cal) || {};
                items.push({ title: e.title || "(no title)", begin: b, end: en, allDay: !!e.allDay, location: e.location || "",
                    color: c.color || "#1a73e8", cal: c.name || "", dev: { id: e.id, begin: e.begin, end: e.end } });
            }
        }
    }
    for (const f of state.icsFeeds || []) {
        try {
            const text = await icsText(f, force);
            window.Ics.parse(text, from, to, 300).forEach((e) => items.push({ title: e.title, begin: e.begin, end: e.end, allDay: e.allDay,
                location: e.location, color: f.color || "#34a853", cal: f.name }));
        } catch (e) { notes.push("“" + f.name + "”: " + e.message); }
    }
    items.sort((a, b) => a.begin - b.begin || a.title.localeCompare(b.title));
    agenda.items = items;
    agenda.note = notes.join(" · ");
    agenda.at = Date.now();
    renderAgenda();
}

function openDeviceEvent(e) {
    try { A.openEvent(e.dev.id, e.dev.begin, e.dev.end); } catch (x) { toast("Could not open the event"); }
}

function eventSheet(e) {
    const when = e.allDay ? "All day" : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(e.begin)) + " – " + hhmm(e.end);
    const buttons = [];
    if (e.dev) buttons.push({ label: "Open in Calendar", run: () => openDeviceEvent(e) });
    else if (typeof A.openCalendarAt === "function") buttons.push({ label: "Open the Calendar app on that day", run: () => { try { A.openCalendarAt(e.begin); } catch (x) { toast("Could not open the calendar"); } } });
    sheet(e.title + "\n" + when + (e.location ? "\n" + e.location : "") + (e.cal ? "\n(" + e.cal + ")" : ""), buttons);
}

function renderAgenda() {
    const body = $("agendaBody");
    if (!body) return;
    body.innerHTML = "";
    const [from] = agendaWindow();
    const now = Date.now();
    if (agenda.perm === false && !(state.icsFeeds || []).length) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "Allow calendar access to see your events here (Google, Samsung, Outlook accounts on this phone).";
        const b = document.createElement("button");
        b.className = "ask";
        b.textContent = "Allow calendar access";
        b.onclick = async () => { await nativeCall("requestCalendarAccess"); loadAgenda(true); };
        body.append(e, b);
        return;
    }
    let shown = 0;
    for (let n = 0; n < AGENDA_DAYS; n++) {
        const ds = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate() + n).getTime();
        const de = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate() + n + 1).getTime();
        const list = agenda.items.filter((e) => e.begin < de && e.end > ds && (e.end > e.begin || e.begin >= ds));
        if (!list.length) continue;
        list.sort((a, b) => (b.allDay - a.allDay) || a.begin - b.begin);
        const h = document.createElement("div");
        h.className = "agd";
        h.textContent = n === 0 ? "Today" : n === 1 ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "short" }).format(new Date(ds));
        body.appendChild(h);
        for (const e of list) {
            if (shown++ > 80) break;
            const r = document.createElement("div");
            const live = e.begin <= now && e.end > now && !e.allDay;
            r.className = "age" + (live ? " now" : "") + (n === 0 && e.end <= now && !e.allDay ? " past" : "");
            r.style.borderLeftColor = e.color;
            const t = document.createElement("div");
            t.className = "aget";
            t.textContent = e.allDay ? "All day" : (e.begin < ds ? "…" : hhmm(e.begin)) + (e.end > e.begin ? "–" + (e.end > de ? "…" : hhmm(e.end)) : "");
            const x = document.createElement("div");
            x.className = "agx";
            const tt = document.createElement("div");
            tt.className = "agtt";
            tt.textContent = e.title;
            x.appendChild(tt);
            if (e.location) {
                const lc = document.createElement("div");
                lc.className = "agl";
                lc.textContent = e.location;
                x.appendChild(lc);
            }
            r.append(t, x);
            attachPress(r, () => (e.dev ? openDeviceEvent(e) : eventSheet(e)), () => eventSheet(e));   // tap: open in the calendar app; hold: details
            body.appendChild(r);
        }
    }
    if (!shown) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = agenda.at ? "No events in the next 14 days." : "Loading…";
        body.appendChild(e);
    }
    if (agenda.note) {
        const n = document.createElement("div");
        n.className = "wnote";
        n.textContent = agenda.note;
        body.appendChild(n);
    }
}

function chooseCalendars() {
    const cals = devCalendars();
    if (!cals.length) { toast("No calendars found on this phone yet"); return; }
    const chosen = new Set(state.calSel ? state.calSel : cals.filter((c) => c.visible).map((c) => c.id));
    const fields = cals.map((c) => ({ id: "c" + c.id, label: acctKind(c) + " · " + c.name + (c.account && c.account !== c.name ? "  (" + c.account + ")" : ""), type: "checkbox", value: chosen.has(c.id) }));
    form("Calendars shown in the agenda", fields, "Save", (v) => {
        state.calSel = cals.filter((c) => v["c" + c.id]).map((c) => c.id);
        save();
        loadAgenda(true);
    });
}

function addFeed() {
    form("Add a calendar link", [
        { id: "name", label: "Name", placeholder: "e.g. Work (Outlook)" },
        { id: "url", label: "Calendar link (https://… or webcal://…, ending in .ics)", type: "url", placeholder: "https://outlook.live.com/owa/calendar/…/calendar.ics" }
    ], "Add", (v) => {
        const url = v.url.trim();
        if (!/^(https?|webcal):\/\//i.test(url)) { toast("Paste a link starting with https:// or webcal://"); return false; }
        state.icsFeeds = state.icsFeeds || [];
        const colors = ["#0b84ff", "#34a853", "#f9ab00", "#d93025", "#a142f4", "#00acc1"];
        state.icsFeeds.push({ id: "f" + uid(), name: v.name.trim() || "Calendar link", url, color: colors[state.icsFeeds.length % colors.length] });
        save();
        loadAgenda(true);
        toast("Link added");
    });
}

function manageFeeds() {
    const feeds = state.icsFeeds || [];
    if (!feeds.length) { toast("No calendar links yet"); return; }
    sheet("Calendar links — tap to remove", feeds.map((f) => ({ label: f.name, sub: "remove", run: () => {
        state.icsFeeds = state.icsFeeds.filter((x) => x.id !== f.id);
        delete feedCache[f.id];
        save();
        loadAgenda(true);
    } })));
}

function outlookHelp() {
    resultCard("Getting Outlook into the agenda",
        "Three ways, easiest first:",
        "1) Add the account to Android (best): Settings → Accounts → Add account → Microsoft Exchange / Outlook.com (or Microsoft 365), and switch Calendar sync on. Its calendars then appear under “Choose device calendars” as Outlook.\n\n" +
        "2) Outlook app: in its Settings, pick your account and turn on the option that syncs calendars to the phone’s calendar (wording varies by version).\n\n" +
        "3) Calendar link (no sign-in, read-only, updates every few hours): in Outlook on the web → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link, then use “Add a calendar link”.\n\n" +
        "Google and Samsung calendars on the phone show up automatically.");
}

function agendaMenu() {
    const buttons = [];
    if (hasCalApi() && agenda.perm) buttons.push({ label: "Choose device calendars…", run: chooseCalendars });
    if (hasCalApi() && !agenda.perm) buttons.push({ label: "Allow calendar access", run: async () => { await nativeCall("requestCalendarAccess"); loadAgenda(true); } });
    buttons.push({ label: "Add a calendar link (ICS)…", run: addFeed });
    if ((state.icsFeeds || []).length) buttons.push({ label: "Calendar links (" + state.icsFeeds.length + ")…", run: manageFeeds });
    buttons.push({ label: "How to get Outlook here…", run: outlookHelp });
    buttons.push({ label: "Refresh", run: () => loadAgenda(true) });
    sheet("Agenda", buttons);
}

// ------------------------------------------------------------- weather ----

const wxState = { note: "", denied: false, busy: false };

function wmo(code, day) {
    const c = Number(code);
    if (c === 0) return day ? ["☀️", "Clear"] : ["🌙", "Clear"];
    if (c === 1) return day ? ["🌤️", "Mostly clear"] : ["🌙", "Mostly clear"];
    if (c === 2) return ["⛅", "Partly cloudy"];
    if (c === 3) return ["☁️", "Overcast"];
    if (c === 45 || c === 48) return ["🌫️", "Fog"];
    if (c >= 51 && c <= 57) return ["🌦️", "Drizzle"];
    if (c >= 61 && c <= 67) return ["🌧️", "Rain"];
    if (c >= 71 && c <= 77) return ["❄️", "Snow"];
    if (c >= 80 && c <= 82) return ["🌧️", "Showers"];
    if (c === 85 || c === 86) return ["🌨️", "Snow showers"];
    if (c >= 95) return ["⛈️", "Thunderstorm"];
    return ["·", ""];
}

async function fetchForecast(loc) {
    const imp = state.units === "imperial";
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + loc.lat.toFixed(3) + "&longitude=" + loc.lon.toFixed(3) +
        "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,precipitation" +
        "&hourly=temperature_2m,precipitation_probability,weather_code,is_day" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=6&timezone=auto" +
        (imp ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
    let r = await httpGet(url);
    if (r.status !== 200 && (r.status === 0 || r.status >= 500)) {   // one retry for a busy or just-woken network
        await new Promise((ok) => setTimeout(ok, 1500));
        r = await httpGet(url);
    }
    if (r.status !== 200) throw new Error(r.status ? "HTTP " + r.status : "no connection");
    return JSON.parse(r.text);
}

async function loadWeather(force) {
    if (wxState.busy) return;
    const wx = state.wx;
    const manual = state.weatherLoc || null;
    const units = state.units || "metric";
    const fresh = wx && !force && Date.now() - wx.t < 30 * 60000 && wx.units === units && !!wx.manual === !!manual &&
        (!manual || (Math.abs(wx.lat - manual.lat) < 0.001 && Math.abs(wx.lon - manual.lon) < 0.001));
    if (fresh) { renderWeather(); return; }
    wxState.busy = true;
    try {
        let loc = manual;
        if (!loc) {
            if (!hasLocApi()) { wxState.note = "Location is only available in the Android app."; renderWeather(); return; }
            if (!A.hasLocationAccess()) state.askedLoc = true;
            const r = await nativeCall("requestLocation");
            if (r.granted === false) { wxState.denied = true; wxState.note = "Location permission is off."; renderWeather(); return; }
            wxState.denied = false;
            if (r.error) { wxState.note = r.error; renderWeather(); return; }
            loc = { lat: r.lat, lon: r.lon, place: r.place };
        }
        try {
            const data = await fetchForecast(loc);
            state.wx = { t: Date.now(), lat: loc.lat, lon: loc.lon, place: loc.place || cityOfTz(data.timezone || ""), manual: !!manual, units, data };
            save();
            wxState.note = "";
        } catch (e) {
            wxState.note = wx ? "Offline — showing the last update" : "Could not load the weather (" + e.message + ")";
        }
    } finally {
        wxState.busy = false;
    }
    renderWeather();
}

function wxTitleText() {
    const wx = state.wx;
    let txt = (dashOpen.wx ? "▾ " : "▸ ") + "Weather" + (wx ? " · " + wx.place : "");
    if (!dashOpen.wx && wx && wx.data && wx.data.current) {      // collapsed: last known reading, no network
        const c = wx.data.current;
        txt += "   " + wmo(c.weather_code, c.is_day)[0] + " " + Math.round(c.temperature_2m) + "°";
    }
    return txt;
}

function renderWeather() {
    const body = $("wxBody");
    if (!body) return;
    body.innerHTML = "";
    const wx = state.wx;
    const t = $("wxTitle");
    if (t) t.textContent = wxTitleText();
    if (!wx) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = wxState.note || (wxState.busy ? "Finding your location…" : "Loading…");
        body.appendChild(e);
        if (wxState.denied || /location/i.test(wxState.note || "")) {
            const b = document.createElement("button");
            b.className = "ask";
            b.textContent = "Allow location";
            b.onclick = () => loadWeather(true);
            const c = document.createElement("button");
            c.className = "ask";
            c.textContent = "Or set a city…";
            c.onclick = setCity;
            body.append(b, c);
        }
        return;
    }
    const d = wx.data;
    const imp = wx.units === "imperial";
    const deg = (v) => Math.round(v) + "°";
    const cur = d.current;
    const [icon, text] = wmo(cur.weather_code, cur.is_day);
    const top = document.createElement("div");
    top.className = "wxcur";
    const big = document.createElement("div");
    big.className = "wxbig";
    big.textContent = icon + " " + deg(cur.temperature_2m) + (imp ? "F" : "C");
    const det = document.createElement("div");
    det.className = "wxdet";
    det.textContent = text + " · feels " + deg(cur.apparent_temperature) + "\n" + "💨 " + Math.round(cur.wind_speed_10m) + (imp ? " mph" : " km/h") +
        (d.daily ? "   ☔ " + (d.daily.precipitation_probability_max[0] || 0) + "%   ↑" + deg(d.daily.temperature_2m_max[0]) + " ↓" + deg(d.daily.temperature_2m_min[0]) : "");
    top.append(big, det);
    body.appendChild(top);

    const times = d.hourly.time;
    let i0 = times.findIndex((x) => x >= cur.time);
    if (i0 < 0) i0 = 0;
    const strip = document.createElement("div");
    strip.className = "wxhours";
    for (let i = i0; i < Math.min(times.length, i0 + 14); i++) {
        const h = document.createElement("div");
        h.className = "wxh";
        const [ic] = wmo(d.hourly.weather_code[i], d.hourly.is_day ? d.hourly.is_day[i] : 1);
        const pp = d.hourly.precipitation_probability ? d.hourly.precipitation_probability[i] : 0;
        h.innerHTML = "";
        [times[i].slice(11, 13) + "h", ic, deg(d.hourly.temperature_2m[i]), pp >= 20 ? pp + "%" : ""].forEach((s, n) => {
            const x = document.createElement("div");
            x.className = n === 3 ? "wxp" : "";
            x.textContent = s;
            h.appendChild(x);
        });
        strip.appendChild(h);
    }
    body.appendChild(strip);

    const days = document.createElement("div");
    days.className = "wxdays";
    for (let i = 0; i < Math.min(d.daily.time.length, 6); i++) {
        const r = document.createElement("div");
        r.className = "wxd";
        const [ic] = wmo(d.daily.weather_code[i], 1);
        const name = i === 0 ? "Today" : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(new Date(d.daily.time[i] + "T12:00"));
        const pp = d.daily.precipitation_probability_max[i];
        [name, ic, pp >= 20 ? "☔ " + pp + "%" : "", deg(d.daily.temperature_2m_max[i]) + " / " + deg(d.daily.temperature_2m_min[i])].forEach((s, n) => {
            const x = document.createElement("span");
            x.className = "wxc" + n;
            x.textContent = s;
            r.appendChild(x);
        });
        days.appendChild(r);
    }
    body.appendChild(days);
    const foot = document.createElement("div");
    foot.className = "wnote";
    foot.textContent = (wxState.note ? wxState.note + " · " : "") + "Updated " + hhmm(wx.t) + " · weather data by Open-Meteo.com";
    body.appendChild(foot);
}

function setCity() {
    form("Weather location", [{ id: "q", label: "City name", placeholder: "e.g. Brussels" }], "Search", (v) => {
        const q = v.q.trim();
        if (!q) return false;
        setTimeout(async () => {
            const r = await httpGet("https://geocoding-api.open-meteo.com/v1/search?name=" + encodeURIComponent(q) + "&count=6&language=en&format=json");
            let res = [];
            try { res = JSON.parse(r.text).results || []; } catch (e) { /* none */ }
            if (!res.length) { toast(r.status === 200 ? "No city found" : "Could not search (offline?)"); return; }
            sheet("Pick the city", res.map((c) => ({ label: c.name, sub: [c.admin1, c.country].filter(Boolean).join(", "), run: () => {
                state.weatherLoc = { lat: c.latitude, lon: c.longitude, place: c.name };
                commit();
                loadWeather(true);
            } })));
        }, 0);
    });
}

function weatherMenu() {
    const buttons = [{ label: "Refresh now", run: () => loadWeather(true) }];
    buttons.push({ label: "Units: " + (state.units === "imperial" ? "°F, mph → switch to °C, km/h" : "°C, km/h → switch to °F, mph"), run: () => {
        state.units = state.units === "imperial" ? "metric" : "imperial"; save(); loadWeather(true);
    } });
    if (state.weatherLoc) buttons.push({ label: "Use my location automatically", run: () => { state.weatherLoc = null; save(); loadWeather(true); } });
    buttons.push({ label: state.weatherLoc ? "Change city…" : "Set a city instead…", run: setCity });
    sheet("Weather", buttons);
}


// ---------------------------------------------------------------- dock ----
// Six favourite apps on one line under the weather; the user picks them.

const DOCK_N = 6;
const dockIds = () => {
    const d = Array.isArray(state.dock) ? state.dock.slice(0, DOCK_N) : [];
    while (d.length < DOCK_N) d.push(null);
    return d;
};

function setDock(slot, id) {
    const d = dockIds();
    if (id) { const k = d.indexOf(id); if (k >= 0) d[k] = null; }   // an app sits in one slot only
    d[slot] = id;
    state.dock = d;
    commit();
}

function dockPicker(slot) {
    const w = document.createElement("div");
    const t = document.createElement("h3");
    t.textContent = "Choose an app for slot " + (slot + 1);
    const q = document.createElement("input");
    q.type = "search";
    q.placeholder = "Filter…";
    q.autocomplete = "off";
    q.style.cssText = "width:100%;padding:10px;font-size:16px;border-radius:10px;border:1px solid var(--line);background:var(--tile);color:var(--text);margin-bottom:6px";
    const list = document.createElement("div");
    const all = state.items.filter((i) => !i.hidden).sort((a, b) => usageScore(b) - usageScore(a) || a.label.localeCompare(b.label));
    const fill = () => {
        list.innerHTML = "";
        const f = fold(q.value.trim());
        all.filter((i) => !f || fold(i.label).includes(f)).slice(0, 80).forEach((i) => {
            const b = document.createElement("button");
            b.className = "sbtn dockopt";
            const img = document.createElement("img");
            img.src = iconSrc(i);
            img.onerror = () => { img.onerror = null; img.src = letterIcon(i.label); };
            b.append(img, document.createTextNode(i.label));
            b.onclick = () => { closeOverlay(); setDock(slot, i.id); };
            list.appendChild(b);
        });
    };
    q.oninput = fill;
    fill();
    const row = document.createElement("div");
    row.className = "row";
    const c = document.createElement("button");
    c.textContent = "Cancel";
    c.onclick = closeOverlay;
    row.appendChild(c);
    w.append(t, q, list, row);
    showCard(w);
}

function renderDock(body) {
    body.innerHTML = "";
    const row = document.createElement("div");
    row.className = "dock";
    dockIds().forEach((id, slot) => {
        const item = id && itemById(id);
        const d = document.createElement("div");
        d.className = "dslot" + (item ? "" : " empty");
        if (item) {
            const img = document.createElement("img");
            img.src = iconSrc(item);
            img.onerror = () => { img.onerror = null; img.src = letterIcon(item.label); };
            const l = document.createElement("div");
            l.textContent = shownLabel(item);
            d.append(img, l);
            attachPress(d, () => launch(item), () => sheet(item.label, [
                { label: "Replace…", run: () => dockPicker(slot) },
                { label: "Remove from the bar", run: () => setDock(slot, null) }
            ]));
        } else {
            d.textContent = "+";
            d.onclick = () => dockPicker(slot);
        }
        row.appendChild(d);
    });
    body.appendChild(row);
}

// ---------------------------------------------------------------- page ----

// Agenda and weather are open at start but fill in after the first screens are drawn; a card can be folded
// with a tap on its title, and a folded card is not refreshed.
const dashOpen = { agenda: true, wx: true };

function foldable(card, key, onOpen) {
    const apply = () => {
        card.card.classList.toggle("shut", !dashOpen[key]);
        card.body.hidden = !dashOpen[key];
    };
    card.title.onclick = () => {
        dashOpen[key] = !dashOpen[key];
        apply();
        if (key === "agenda") card.title.textContent = (dashOpen.agenda ? "▾ " : "▸ ") + "Agenda";
        else renderWeather();
        if (dashOpen[key]) onOpen();
    };
    card.title.style.cursor = "pointer";
    apply();
}

function renderDash(el) {
    el.innerHTML = "";
    const time = dashCard("Time", [["⚙", editZones, "Choose the time zones"]]);
    time.body.id = "timeBody";
    const ag = dashCard((dashOpen.agenda ? "▾ " : "▸ ") + "Agenda", [["⋯", agendaMenu, "Calendars and links"]]);
    ag.body.id = "agendaBody";
    const wx = dashCard("Weather", [["⋯", weatherMenu, "Weather options"]]);
    wx.body.id = "wxBody";
    wx.title.id = "wxTitle";
    const dk = dashCard("Favourites", []);
    dk.body.id = "dockBody";
    ag.card.classList.add("grow");
    wx.card.classList.add("grow");
    foldable(ag, "agenda", () => loadAgenda(false));
    foldable(wx, "wx", () => loadWeather(false));
    el.append(time.card, ag.card, wx.card, dk.card);
    renderDock(dk.body);
    renderTime(time.body);
    renderAgenda();
    renderWeather();
}

function refreshDash(force) {
    const t = performance.now();
    if (dashOpen.agenda) loadAgenda(!!force).then(() => { perf.agenda = Math.round(performance.now() - t); });
    if (dashOpen.wx) loadWeather(!!force).then(() => { perf.weather = Math.round(performance.now() - t); });
    const tb = $("timeBody");
    if (tb) renderTime(tb);
}

setInterval(() => {
    if (document.visibilityState === "hidden") return;
    const tb = $("timeBody");
    if (tb && pagerPage() === PAGE_DASH) renderTime(tb);
}, 20000);


// -------------------------------------------------------------------- init ----

function init() {
    perf.pageLoad = Math.round(performance.now());           // time from navigation start until this script runs
    state = timed("loadState", load);
    let first = false;
    if (!state || !Array.isArray(state.items)) { state = newState(); first = true; }
    state.ai = Object.assign({}, DEFAULT_AI, state.ai || {});
    state.launches = state.launches || {};
    // Later starts paint straight from the saved state; the (slower) app scan and usage query run just after.
    const r = first ? reconcile() : { added: 0, removed: 0 };
    if (first) { refreshUsage(); flush(); }
    timed("firstRender", render);
    if (!first) setTimeout(() => scanAndReconcile((r2) => {
        if (r2.added || r2.removed) { commit(); toast(r2.added + " new app" + (r2.added === 1 ? "" : "s") + (r2.removed ? ", " + r2.removed + " removed" : "")); }
        else { renderUsage($("page1")); renderCloud($("pageCloud")); }
        perf.ready = Math.round(performance.now());
    }), 60);
    goPage(homePage(), false);                      // open on the dashboard: cloud | dashboard | categories | most used
    requestAnimationFrame(() => goPage(homePage(), false));
    lastPage = homePage();
    if (homePage() === PAGE_DASH) setTimeout(() => refreshDash(false), 400);   // after the first paint
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
