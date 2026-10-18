// Development stand-in for the native bridge. Inside the APK window.Android already
// exists, so this file does nothing there. In a desktop browser it fakes the phone.
(function () {
    if (window.Android) return;
    window.__MOCK = true;

    const apps = [
        ["Gmail", "com.google.android.gm"], ["Chrome", "com.android.chrome"], ["Maps", "com.google.android.apps.maps"],
        ["WhatsApp", "com.whatsapp"], ["Messenger", "com.facebook.orca"], ["Telegram", "org.telegram.messenger"],
        ["Instagram", "com.instagram.android"], ["Facebook", "com.facebook.katana"], ["YouTube", "com.google.android.youtube"],
        ["Spotify", "com.spotify.music"], ["Deezer", "deezer.android.app"], ["Netflix", "com.netflix.mediaclient"],
        ["Camera", "com.sec.android.app.camera"], ["Gallery", "com.sec.android.gallery3d"], ["Photos", "com.google.android.apps.photos"],
        ["Calculator", "com.sec.android.app.popupcalculator"], ["Clock", "com.sec.android.app.clockpackage"],
        ["Calendar", "com.google.android.calendar"], ["Contacts", "com.samsung.android.contacts"], ["Phone", "com.samsung.android.dialer"],
        ["Messages", "com.samsung.android.messaging"], ["Settings", "com.android.settings"], ["Files", "com.sec.android.app.myfiles"],
        ["Easy Banking", "com.bnpp.easybanking"], ["PayPal", "com.paypal.android.p2pmobile"], ["Revolut", "com.revolut.revolut"],
        ["Ultimate Guitar", "com.ultimateguitar.tabs"], ["Tuner", "org.billthefarmer.tuner"], ["BandLab", "com.bandlab.bandlab"],
        ["Fender Tone", "com.fender.tone"], ["Voice Recorder", "com.sec.android.app.voicenote"], ["Play Store", "com.android.vending"],
        ["F-Droid", "org.fdroid.fdroid"], ["Claude", "com.anthropic.claude"], ["Samsung Members", "com.samsung.android.voc"],
        ["Bixby", "com.samsung.android.bixby.agent"], ["SmartThings", "com.samsung.android.oneconnect"],
        ["Galaxy Store", "com.sec.android.app.samsungapps"], ["Digital Wellbeing", "com.samsung.android.forest"],
        ["Strava", "com.strava"], ["SNCB", "be.sncb.mobile"], ["Zebra Quest", "org.example.zebraquest"]
    ].map((a) => ({ label: a[0], package: a[1] }));

    const rules = [
        ["Communication", /whatsapp|messenger|telegram|gmail|contacts|phone|messages|dialer/],
        ["Social", /instagram|facebook/],
        ["Media", /youtube|spotify|deezer|netflix|photos|gallery|camera/],
        ["Music Tools", /guitar|tuner|bandlab|fender|voicenote/],
        ["Finance", /bank|paypal|revolut/],
        ["Travel", /maps|sncb/],
        ["Utilities", /calculator|clock|calendar|files|settings|chrome|strava/],
        ["Stores", /vending|fdroid|samsungapps/],
        ["AI", /anthropic/]
    ];

    const KW = { Communication: "email, chat, messages, call, contacts", Social: "social network, friends, posts", Media: "video, music, streaming, photos, movies",
        "Music Tools": "guitar, tuner, practice, recording, instrument", Finance: "bank, money, payment, transfer", Travel: "map, navigation, train, journey",
        Utilities: "tool, calculator, clock, calendar, files, settings", Stores: "store, install, download apps", AI: "assistant, chat, ai", Other: "misc" };

    function fakeModel(user) {
        const lines = user.split(/(?:APPS|ITEMS):\n/)[1].split("\n");
        const out = { categories: [], apps: {} };
        for (const line of lines) {
            const m = line.match(/^(\S+) \| (.*)$/);
            if (!m) continue;
            const key = m[1], hay = (m[1] + " " + m[2]).toLowerCase();
            let cat = "Other";
            for (const [name, re] of rules) if (re.test(hay)) { cat = name; break; }
            if (!out.categories.includes(cat)) out.categories.push(cat);
            out.apps[key] = { c: cat, rare: /samsung|bixby|members|wellbeing|smartthings|galaxy/.test(hay) };
        }
        return "Here you go:\n```json\n" + JSON.stringify(out) + "\n```";
    }

    window.Android = {
        listApps: () => JSON.stringify(apps),
        listAppsAsync: (id) => setTimeout(() => window.__nativeResult(id, JSON.stringify(apps)), 1500),   // slow on purpose
        scanInfo: () => "query 12 ms, labels 3 ms (42 of 42 from cache)",
        launch: (p) => { console.log("launch", p); window.__lastLaunch = p; return true; },
        openUrl: (u) => { console.log("openUrl", u); window.__lastUrl = u; },
        appInfo: (p) => console.log("appInfo", p),
        browsers: () => JSON.stringify([{ label: "Brave", package: "com.brave.browser" }, { label: "Chrome", package: "com.android.chrome" }, { label: "Firefox", package: "org.mozilla.firefox" }]),
        openUrlIn: (u, p) => { console.log("openUrlIn", u, p); window.__lastUrl = u; window.__lastBrowser = p; },
        uninstall: (p) => console.log("uninstall", p),
        loadState: () => localStorage.getItem("mock-state") || "",
        saveState: (s) => localStorage.setItem("mock-state", s),
        copyText: (t) => { window.__clip = t; },
        usageAccess: () => localStorage.getItem("mock-usage") === "1",
        openUsageSettings: () => { window.__usageSettingsOpened = true; localStorage.setItem("mock-usage", "1"); },
        usageStats: () => JSON.stringify({ "com.spotify.music": 900000000, "com.whatsapp": 700000000, "com.google.android.youtube": 500000000, "com.android.chrome": 400000000, "deezer.android.app": 100 }),
        httpPost: (id, url, headers, body) => {
            setTimeout(() => {
                try {
                    const b = JSON.parse(body);
                    const anthropic = /anthropic|mock-claude/.test(url);
                    const ollama = /\/api\/chat$/.test(url);
                    window.__lastBody = b;
                    if (ollama && /mock-nothink-unsupported/.test(url) && "think" in b) { window.__httpResult(id, 400, '{"error":"think not supported"}'); return; }
                    if (ollama && /mock-thinks/.test(url) && b.think !== false) { window.__httpResult(id, 200, JSON.stringify({ message: { content: "", thinking: "hmm" } })); return; }
                    const user = anthropic ? b.messages[0].content : b.messages[1].content.replace(/ \/no_think$/, "");
                    if (/mock-empty/.test(url)) { window.__httpResult(id, 200, JSON.stringify({ choices: [{ message: { content: "" } }] })); return; }
                    if (/mock-reason/.test(url)) { window.__httpResult(id, 200, JSON.stringify({ choices: [{ message: { content: "", reasoning: "Let me think..." } }] })); return; }
                    if (/mock-fail/.test(url)) { window.__httpResult(id, 500, '{"error":"model overloaded"}'); return; }
                    const system = anthropic ? (b.system || "") : (b.messages[0].content || "");
                    let text = user === "ping" ? '{"ok":true}' : /(?:APPS|ITEMS):\n/.test(user) ? fakeModel(user) : "";
                    if (user !== "ping" && /write search keywords/.test(system)) {
                        const ents = user.split(/ITEMS:\n/)[1].split("\n").map((l) => l.match(/^(\S+) \| (.*)$/)).filter(Boolean);
                        const o = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
                        text = ents.map((m) => m[1] + " | " + KW[(o.apps[m[1]] || {}).c || "Other"]).join("\n");
                    } else if (user !== "ping" && /merge duplicate or near-synonym/.test(system)) {
                        const have = user.split("WORDS:\n")[1].split("\n").map((s) => s.trim().toLowerCase());
                        const groups = [["chat", "messages", "texting"], ["video", "movies", "streaming"], ["bank", "payment", "e-banking"], ["guitar", "instrument"]];
                        text = groups.map((g) => g.filter((w) => have.includes(w))).filter((g) => g.length > 1)
                            .map((g) => g[0][0].toUpperCase() + g[0].slice(1) + ": " + g.slice(1).join(", ")).join("\n") || "none";
                    } else if (user !== "ping" && /find apps on a phone/.test(system)) {
                        const q = user.match(/The user wants: (.*)\n/)[1].toLowerCase().split(/\s+/);
                        const ents = user.split(/ITEMS:\n/)[1].split("\n").map((l) => l.split(" | ")).filter((p) => p.length >= 2);
                        text = ents.map((p) => ({ k: p[0], s: q.filter((w) => p.join(" ").toLowerCase().includes(w)).length }))
                            .filter((x) => x.s).sort((a, c) => c.s - a.s).slice(0, 8).map((x) => x.k).join("\n") || "none";
                    } else if (user !== "ping") {
                        const obj = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
                        const lines = user.split(/(?:APPS|ITEMS):\n/)[1].split("\n").map((l) => l.match(/^(\S+) \| (.*)$/)).filter(Boolean);
                        text = lines.map((m) => m[1] + " | " + obj.apps[m[1]].c + " | " + KW[obj.apps[m[1]].c]).join("\n");
                        if (/mock-garbage/.test(url)) text = "I'm sorry, I can't help with that.";
                        else if (/mock-json/.test(url)) text = JSON.stringify(obj);
                        else if (/mock-think/.test(url)) text = "<think>maybe {\"x\":1} first</think>" + JSON.stringify(obj);
                        else if (/mock-lines/.test(url)) text = "Sure! Here is the sorting:\n```\n" + lines.map((m, n) => (n % 2 ? "- " : "") + m[1] + " | " + obj.apps[m[1]].c + " | " + (obj.apps[m[1]].rare ? "rare" : "common")).join("\n") + "\n```\nHope that helps!";
                        else if (/mock-array/.test(url)) text = JSON.stringify({ apps: lines.map((m) => ({ package: m[1], category: obj.apps[m[1]].c })) });
                        else if (/mock-bycat/.test(url)) {
                            const g = {};
                            lines.forEach((m) => { (g[obj.apps[m[1]].c] = g[obj.apps[m[1]].c] || []).push(m[2]); });
                            text = JSON.stringify(g);
                        } else if (/mock-nomatch/.test(url)) text = JSON.stringify({ apps: { "no.such.pkg": { c: "X" } } });
                    }
                    const payload = anthropic ? { content: [{ type: "text", text }] }
                        : ollama ? { message: { content: text } } : { choices: [{ message: { content: text } }] };
                    window.__httpResult(id, 200, JSON.stringify(payload));
                } catch (e) {
                    window.__httpResult(id, 500, String(e));
                }
            }, 250);
        },
        // ---- dashboard: weather (real Open-Meteo through fetch), calendar feeds, calendars, location ----
        httpGet: (id, url) => {
            if (/mock\.ics/.test(url)) {
                const d = new Date(); d.setDate(d.getDate() + 1);
                const z = (n) => String(n).padStart(2, "0");
                const day = d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate());
                const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:m1", "DTSTART;TZID=Romance Standard Time:" + day + "T090000", "DTEND;TZID=Romance Standard Time:" + day + "T100000",
                    "SUMMARY:Outlook planning", "LOCATION:Room 4", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
                setTimeout(() => window.__httpResult(id, 200, ics), 100);
                return;
            }
            fetch(url).then((r) => r.text().then((t) => window.__httpResult(id, r.status, t)), () => window.__httpResult(id, 0, "offline"));
        },
        hasCalendarAccess: () => localStorage.getItem("mock-cal") === "1",
        requestCalendarAccess: (id) => { localStorage.setItem("mock-cal", "1"); setTimeout(() => window.__nativeResult(id, '{"granted":true}'), 50); },
        calendars: () => JSON.stringify([
            { id: "1", name: "Personal", account: "me@gmail.com", type: "com.google", color: "#1a73e8", visible: true },
            { id: "2", name: "Work", account: "me@corp.com", type: "com.microsoft.exchange", color: "#d93025", visible: true },
            { id: "3", name: "Holidays", account: "Phone", type: "LOCAL", color: "#34a853", visible: false }]),
        events: (b, e, ids) => {
            const t0 = new Date(); t0.setHours(0, 0, 0, 0);
            const at = (dd, h, m) => new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + dd, h, m).getTime();
            const utc = (dd) => Date.UTC(t0.getFullYear(), t0.getMonth(), t0.getDate() + dd);
            return JSON.stringify([
                { id: 1, title: "Team stand-up", begin: at(0, 9, 0), end: at(0, 9, 15), allDay: false, location: "Teams", cal: "2" },
                { id: 2, title: "Lunch with Anna", begin: at(0, 12, 30), end: at(0, 14, 0), allDay: false, location: "Café Central", cal: "1" },
                { id: 3, title: "Dentist", begin: at(1, 15, 0), end: at(1, 16, 0), allDay: false, location: "", cal: "1" },
                { id: 4, title: "Conference", begin: utc(2), end: utc(4), allDay: true, location: "Brussels", cal: "2" }]);
        },
        openEvent: (id, b, e) => { window.__lastEvent = id; },
        hasLocationAccess: () => localStorage.getItem("mock-loc") === "1",
        requestLocation: (id) => { localStorage.setItem("mock-loc", "1"); setTimeout(() => window.__nativeResult(id, '{"granted":true,"lat":50.85,"lon":4.35,"place":"Brussels"}'), 80); }
    };
})();
