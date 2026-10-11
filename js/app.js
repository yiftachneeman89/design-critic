// Design Critic: loading a project, scanning every screen, and the review UI
// (summary, filters, issue list, the screen with highlights, fixes and status tracking).

const $ = (id) => document.getElementById(id);
let app = null;  // { name, res, model, renderer, issues, screens }

const SEVERITIES = ["blocker", "major", "minor"];
const CATEGORIES = { accessibility: "Accessibility", color: "Color", typography: "Typography", layout: "Layout", states: "States", copy: "Copy" };
const PLATFORMS = { android: "Android", ios: "iOS", web: "Web" };
const STATUSES = { open: "Open", progress: "In progress", fixed: "Fixed", wont: "Won't fix" };
const KIND_LABEL = { activity: "Activity", fragment: "Fragment", dialog: "Dialog" };

const filters = { screen: "all", severity: new Set(), category: new Set(), platform: new Set(), status: new Set(["open", "progress"]), q: "" };
let selected = null;   // issue key
let showMarkers = true;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function show(section) {
  for (const id of ["landing", "loading", "review"]) $(id).hidden = id !== section;
}

function friendlyName(s) {
  if (!s) return "";
  if (s.id === "__app") return "Whole app";
  if (s.dialogOf) {
    const t = s.layout.replace(/^(dialog|dlg|layout|alert)_/, "").replace(/_(dialog|dlg|file|layout)$/g, "").replace(/_/g, " ");
    return t[0].toUpperCase() + t.slice(1) + " (pop-up)";
  }
  const base = s.cls.replace(/(DialogFragment|Activity|Fragment|Dialog)$/, "") || s.cls;
  return base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function screenName(id) { return id === "__app" ? "Whole app" : friendlyName(app.model.screens[id]) || id; }

// ---------------------------------------------------------------- loading and scanning

async function load(items) {
  show("loading");
  $("loadError").hidden = true;
  try {
    $("loadingText").textContent = "Reading files…";
    const raw = await readProject(items);
    if (!raw.texts.some((f) => /\/res\/layout/.test("/" + f.path))) throw new Error("No Android layouts found. Pick the project folder (the one that contains app/).");
    $("loadingText").textContent = "Loading images and fonts…";
    const res = await loadResources(raw);
    $("loadingText").textContent = "Reading the code…";
    await tick();
    const model = new Analyzer(raw, res).run();
    if (!Object.keys(model.screens).length) throw new Error("Couldn't find any activities or fragments in this project.");
    await Promise.all(["400", "500", "700"].map((w) => document.fonts.load(`${w} 16px Roboto`).catch(() => {})));
    await document.fonts.ready;
    const renderer = new Renderer(res, model);
    app = { name: raw.name, res, model, renderer };
    app.issues = await scanAll();
    syncTracking();
    $("projectName").textContent = raw.name;
    $("topActions").hidden = false;
    document.title = `${raw.name} · Design Critic`;
    show("review");
    selected = null;
    renderAll();
  } catch (err) {
    console.error(err);
    show("landing");
    $("loadError").textContent = err.message || String(err);
    $("loadError").hidden = false;
  }
}

function tick() { return new Promise((r) => setTimeout(r, 15)); }

function screensInOrder() {
  const list = Object.values(app.model.screens);
  const rank = (s) => (s.launcher ? 0 : s.kind === "activity" ? 1 : s.kind === "fragment" ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b) || friendlyName(a).localeCompare(friendlyName(b)));
}

async function settle(phone) {
  const imgs = [...phone.querySelectorAll("img")];
  await Promise.race([
    Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  relayout(phone);
}

// draws each screen off to the side at full size, measures it, throws it away
async function scanAll() {
  const critic = new Critic(app.model, app.res, app.renderer);
  const stage = $("stage");
  const screens = screensInOrder();
  for (const [i, s] of screens.entries()) {
    $("loadingText").textContent = `Reviewing ${friendlyName(s)} (${i + 1} of ${screens.length})…`;
    await tick();
    if (!s.layout) continue;
    const phone = app.renderer.screen(s);
    stage.append(phone);
    await settle(phone);
    try { critic.scanScreen(s, phone); } catch (e) { console.error("scan failed for", s.id, e); }
    phone.remove();
  }
  const issues = critic.appWide();
  const order = { blocker: 0, major: 1, minor: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity] || screenName(a.screen).localeCompare(screenName(b.screen)));
}

// ---------------------------------------------------------------- status tracking (kept in this browser)

function storeKey(k) { return `dc.${app.name}.${k}`; }
function readStore(k, d) { try { return JSON.parse(localStorage.getItem(storeKey(k))) ?? d; } catch { return d; } }
function writeStore(k, v) { try { localStorage.setItem(storeKey(k), JSON.stringify(v)); } catch {} }

function statusOf(key) { return app.status[key]?.status || "open"; }

// compares this scan with the last one: issues that disappeared are marked fixed
function syncTracking() {
  app.status = readStore("status", {});
  const known = readStore("known", {});
  const now = new Set(app.issues.map((i) => i.key));
  app.resolved = [];
  for (const [key, info] of Object.entries(known)) {
    if (now.has(key)) continue;
    const st = app.status[key];
    if (!st || st.status === "open" || st.status === "progress") app.status[key] = { status: "fixed", at: Date.now(), auto: true };
    app.resolved.push({ ...info, key, gone: true });
  }
  for (const i of app.issues) {
    known[i.key] = { key: i.key, title: i.title, screen: i.screen, severity: i.severity, category: i.category, platforms: i.platforms, rule: i.rule };
    // an issue that was marked fixed but is detected again isn't fixed
    if (app.status[i.key]?.status === "fixed") app.status[i.key] = { status: "open", at: Date.now(), reopened: true };
  }
  writeStore("known", known);
  writeStore("status", app.status);
  recordHistory();
}

function counts(list) {
  const c = { open: 0, progress: 0, fixed: 0, wont: 0 };
  for (const i of list) c[statusOf(i.key)]++;
  return c;
}

function recordHistory() {
  const hist = readStore("history", []);
  const day = new Date().toISOString().slice(0, 10);
  const c = counts([...app.issues, ...app.resolved]);
  const entry = { d: day, ...c, score: score().value };
  if (hist.length && hist[hist.length - 1].d === day) hist[hist.length - 1] = entry; else hist.push(entry);
  writeStore("history", hist.slice(-60));
  app.history = hist;
}

function setStatus(key, status) {
  app.status[key] = { status, at: Date.now() };
  writeStore("status", app.status);
  recordHistory();
  renderAll();
}

// ---------------------------------------------------------------- score: won't-fix still counts. Bad design doesn't stop being bad.

function score() {
  let pen = 0, blockers = 0;
  for (const i of app.issues) {
    const st = statusOf(i.key);
    if (st === "fixed") continue;
    pen += SEV_WEIGHT[i.severity];
    if (i.severity === "blocker") blockers++;
  }
  const value = Math.round(100 / (1 + pen / 60));
  let grade = value >= 90 ? "A" : value >= 75 ? "B" : value >= 60 ? "C" : value >= 40 ? "D" : "F";
  if (blockers && grade < "D") grade = "D";
  const verdict = {
    A: "Solid. A reviewer would nitpick, not reject.",
    B: "Decent, with real problems still to fix before this is good.",
    C: "Mediocre. It works, but it isn't designed - it's assembled.",
    D: blockers ? `Not shippable: ${blockers} blocker${blockers > 1 ? "s" : ""} would fail an accessibility review on ${blockers > 1 ? "their" : "its"} own.` : "Poor. Too many basic rules broken.",
    F: "Failing. This would be sent back in any serious design review.",
  }[grade];
  return { value, grade, verdict, blockers };
}

// ---------------------------------------------------------------- filtering

function allItems() { return [...app.issues, ...app.resolved]; }

function matches(i, skip) {
  if (skip !== "screen" && filters.screen !== "all" && i.screen !== filters.screen && !(i.alsoOn || []).includes(filters.screen)) return false;
  if (skip !== "severity" && filters.severity.size && !filters.severity.has(i.severity)) return false;
  if (skip !== "category" && filters.category.size && !filters.category.has(i.category)) return false;
  if (skip !== "platform" && filters.platform.size && !i.platforms.some((p) => filters.platform.has(p))) return false;
  if (skip !== "status" && filters.status.size && !filters.status.has(statusOf(i.key))) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (!`${i.title} ${i.why || ""} ${screenName(i.screen)}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function visible() { return allItems().filter((i) => matches(i)); }

// ---------------------------------------------------------------- rendering the page

function renderAll() {
  renderSummary();
  renderFilters();
  renderList();
  renderDetail();
}

function renderSummary() {
  const sc = score();
  const c = counts(allItems());
  const total = allItems().length || 1;
  const sev = Object.fromEntries(SEVERITIES.map((s) => [s, app.issues.filter((i) => i.severity === s && !["fixed"].includes(statusOf(i.key))).length]));
  const hist = app.history || [];
  const spark = sparkline(hist.map((x) => x.open + x.progress + x.wont));
  $("summary").innerHTML = `
    <div class="grade grade-${sc.grade}"><b>${sc.grade}</b><span>${sc.value}<small>/100</small></span></div>
    <div class="verdict">
      <p class="v-title">${esc(sc.verdict)}</p>
      <p class="v-sub">${app.issues.length} problems found across ${Object.keys(app.model.screens).length} screens. Won't-fix still counts against the score - bad design doesn't become good by agreeing to keep it.</p>
    </div>
    <div class="sev-counts">
      ${SEVERITIES.map((s) => `<button class="sev-count sev-${s} ${filters.severity.has(s) ? "on" : ""}" data-sev="${s}"><b>${sev[s]}</b><span>${s}</span></button>`).join("")}
    </div>
    <div class="progress">
      <div class="p-head"><span>Progress</span><span>${c.fixed} fixed · ${c.progress} in progress · ${c.wont} won't fix · ${c.open} open</span></div>
      <div class="p-bar">
        <i class="st-fixed" style="width:${(c.fixed / total) * 100}%"></i><i class="st-progress" style="width:${(c.progress / total) * 100}%"></i><i class="st-wont" style="width:${(c.wont / total) * 100}%"></i>
      </div>
      <div class="p-hist">${spark}<span>${hist.length > 1 ? `unresolved over ${hist.length} days` : "history builds up as you re-scan on later days"}</span></div>
    </div>`;
  for (const b of $("summary").querySelectorAll("[data-sev]")) b.onclick = () => { toggle(filters.severity, b.dataset.sev); renderAll(); };
}

function sparkline(vals) {
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 120 28"><line x1="0" y1="14" x2="120" y2="14" /></svg>`;
  const max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 118 + 1},${26 - (v / max) * 24}`).join(" ");
  return `<svg class="spark" viewBox="0 0 120 28"><polyline points="${pts}" /></svg>`;
}

function toggle(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

function renderFilters() {
  const f = $("filters");
  const countBy = (skip, test) => allItems().filter((i) => matches(i, skip) && test(i)).length;
  const chipGroup = (title, key, entries) => `
    <div class="f-group"><h4>${title}</h4><div class="chips">
      ${entries.map(([v, label, cls = ""]) => `<button class="chip ${cls} ${filters[key].has(v) ? "on" : ""}" data-f="${key}" data-v="${v}">${label}<small>${countBy(key, (i) => key === "status" ? statusOf(i.key) === v : key === "platform" ? i.platforms.includes(v) : i[key] === v)}</small></button>`).join("")}
    </div></div>`;
  const screens = [{ id: "__app" }, ...screensInOrder()].filter((s) => allItems().some((i) => i.screen === s.id || (i.alsoOn || []).includes(s.id)));
  f.innerHTML = `
    <div class="f-group"><h4>Screen</h4>
      <div class="screen-list">
        <button class="scr ${filters.screen === "all" ? "on" : ""}" data-screen="all">All screens<small>${countBy("screen", () => true)}</small></button>
        ${screens.map((s) => `<button class="scr ${filters.screen === s.id ? "on" : ""}" data-screen="${esc(s.id)}">${esc(screenName(s.id))}${s.kind ? `<em>${KIND_LABEL[s.kind] || ""}</em>` : ""}<small>${countBy("screen", (i) => i.screen === s.id || (i.alsoOn || []).includes(s.id))}</small></button>`).join("")}
      </div>
    </div>
    ${chipGroup("Severity", "severity", SEVERITIES.map((s) => [s, s[0].toUpperCase() + s.slice(1), "sev-" + s]))}
    ${chipGroup("Category", "category", Object.entries(CATEGORIES))}
    ${chipGroup("Platform", "platform", Object.entries(PLATFORMS))}
    ${chipGroup("Status", "status", Object.entries(STATUSES).map(([k, v]) => [k, v, "st-" + k]))}
    <button class="link-btn" id="clearFilters">Clear filters</button>`;
  for (const b of f.querySelectorAll("[data-screen]")) b.onclick = () => { filters.screen = b.dataset.screen; selected = null; renderAll(); };
  for (const b of f.querySelectorAll("[data-f]")) b.onclick = () => { toggle(filters[b.dataset.f], b.dataset.v); renderAll(); };
  $("clearFilters").onclick = () => { filters.screen = "all"; for (const k of ["severity", "category", "platform", "status"]) filters[k].clear(); filters.q = ""; $("search").value = ""; renderAll(); };
}

function renderList() {
  const list = visible();
  $("listCount").textContent = `${list.length} issue${list.length === 1 ? "" : "s"}`;
  const el = $("issueList");
  el.innerHTML = "";
  if (!list.length) {
    el.innerHTML = `<p class="empty">${allItems().length ? "Nothing matches these filters." : "No issues found. Suspicious - but well done."}</p>`;
    return;
  }
  if (selected && !list.some((i) => i.key === selected)) selected = null;
  for (const i of list) {
    const st = statusOf(i.key);
    const card = document.createElement("button");
    card.className = `issue sev-${i.severity} ${i.key === selected ? "sel" : ""} ${i.gone ? "gone" : ""}`;
    card.innerHTML = `
      <span class="sev-dot"></span>
      <span class="i-main">
        <span class="i-title"></span>
        <span class="i-meta"><span>${esc(screenName(i.screen))}${i.alsoOn?.length ? ` +${i.alsoOn.length}` : ""}</span><span>${CATEGORIES[i.category]}</span>${i.gone ? "<span>no longer detected</span>" : ""}</span>
      </span>
      <span class="st-pill st-${st}">${STATUSES[st]}</span>`;
    card.querySelector(".i-title").textContent = i.title;
    card.onclick = () => { selected = i.key; renderList(); renderDetail(); };
    el.append(card);
  }
}

// ---------------------------------------------------------------- detail: the screen + the explanation

function findTarget(phone, t) {
  if (!t || !t.path || !t.layout) return null;
  const roots = [...phone.querySelectorAll(`[data-layout="${CSS.escape(t.layout)}"], [data-include="${CSS.escape(t.layout)}"]`)].filter((r) => !r.closest("[data-copy]") && !r.closest(".under-dialog"));
  for (const root of roots) {
    let n = root;
    for (const idx of t.path) { n = n?.children[idx]; if (!n) break; }
    if (n) return n;
  }
  return null;
}

function renderDetail() {
  const d = $("detail");
  const issue = allItems().find((i) => i.key === selected);
  const screenId = issue ? issue.screen : filters.screen !== "all" ? filters.screen : null;
  d.innerHTML = "";
  if (!issue && !screenId) {
    d.innerHTML = `<div class="detail-empty"><p>Pick an issue to see it on the screen, why it's a problem and how to fix it.</p><p class="muted">Or pick a screen on the left to see all of its problems at once.</p></div>`;
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "detail-inner";
  d.append(wrap);

  if (screenId && screenId !== "__app" && app.model.screens[screenId]?.layout) {
    const s = app.model.screens[screenId];
    const box = document.createElement("div");
    box.className = "phone-col";
    box.innerHTML = `<div class="phone-head"><b>${esc(friendlyName(s))}</b><span>${esc(s.layout)}.xml</span><label><input type="checkbox" id="markerToggle" ${showMarkers ? "checked" : ""}> Highlights</label></div>`;
    wrap.append(box);
    drawPhone(box, s, issue);
    box.querySelector("#markerToggle").onchange = (e) => { showMarkers = e.target.checked; renderDetail(); };
  }
  const text = document.createElement("div");
  text.className = "explain";
  wrap.append(text);
  if (issue) explain(text, issue);
  else {
    const mine = visible().filter((i) => i.screen === screenId || (i.alsoOn || []).includes(screenId));
    text.innerHTML = `<h2>${esc(screenName(screenId))}</h2><p class="muted">${mine.length} issue${mine.length === 1 ? "" : "s"} with the current filters. Numbers on the screen match the list below; click one to open it.</p>`;
    const ol = document.createElement("ol");
    ol.className = "mini-list";
    mine.forEach((i) => {
      const li = document.createElement("li");
      li.className = "sev-" + i.severity;
      li.innerHTML = `<button></button>`;
      li.firstChild.textContent = i.title;
      li.firstChild.onclick = () => { selected = i.key; renderList(); renderDetail(); };
      ol.append(li);
    });
    text.append(ol);
  }
}

// the screen as its XML draws it, with numbered boxes on every problem
function drawPhone(box, s, issue) {
  const holder = document.createElement("div");
  holder.className = "phone-holder";
  box.append(holder);
  const phone = app.renderer.screen(s);
  const avail = Math.min(640, Math.max(300, window.innerHeight - 250));
  const scale = Math.min(1, avail / SCREEN_H);
  holder.style.width = SCREEN_W * scale + "px";
  holder.style.height = SCREEN_H * scale + "px";
  const scaler = document.createElement("div");
  scaler.className = "phone-scale";
  scaler.style.transform = `scale(${scale})`;
  scaler.append(phone);
  holder.append(scaler);
  const overlay = document.createElement("div");
  overlay.className = "markers";
  overlay.style.width = SCREEN_W + "px";
  overlay.style.height = SCREEN_H + "px";
  overlay.style.transform = `scale(${scale})`;
  holder.append(overlay);
  const place = () => {
    relayout(phone);
    overlay.innerHTML = "";
    if (!showMarkers) return;
    const pr = phone.getBoundingClientRect();
    const k = SCREEN_W / (pr.width || 1);
    const mine = visible().filter((i) => (i.screen === s.id || (i.alsoOn || []).includes(s.id)) && !i.gone);
    const list = issue ? [issue, ...mine.filter((i) => i.key !== issue.key)] : mine;
    let n = 0;
    for (const i of list) {
      n++;
      const targets = [i.target, ...(i.more || [])];
      const isSel = issue && i.key === issue.key;
      if (issue && !isSel) continue;  // focus on the selected issue only
      if (!i.target?.path) {
        if (isSel || !issue) {
          const m = document.createElement("div");
          m.className = `marker whole sev-${i.severity}`;
          m.innerHTML = `<span>${issue ? "" : n}</span><em>${esc(i.title)}</em>`;
          overlay.append(m);
        }
        continue;
      }
      targets.forEach((t, ti) => {
        const el = findTarget(phone, t);
        let r = t.rect;
        if (el) { const er = el.getBoundingClientRect(); r = { x: (er.left - pr.left) * k, y: (er.top - pr.top) * k, w: er.width * k, h: er.height * k }; }
        if (!r) return;
        const m = document.createElement("button");
        m.className = `marker sev-${i.severity} ${isSel ? "sel" : ""} ${isSel && targets.length === 1 ? "focus" : ""}`;
        Object.assign(m.style, { left: r.x - 3 + "px", top: r.y - 3 + "px", width: r.w + 6 + "px", height: r.h + 6 + "px" });
        if (ti === 0) m.innerHTML = `<span>${issue ? "!" : n}</span>`;
        m.title = i.title;
        m.onclick = () => { selected = i.key; renderList(); renderDetail(); };
        if (i.rule === "tap-target" && isSel) {
          const ring = document.createElement("i");
          ring.className = "target-ring";
          const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
          Object.assign(ring.style, { left: cx - 24 + "px", top: cy - 24 + "px" });
          overlay.append(ring);
        }
        overlay.append(m);
      });
    }
  };
  requestAnimationFrame(async () => { await settle(phone); place(); });
}

function explain(el, i) {
  const st = statusOf(i.key);
  const stInfo = app.status[i.key];
  el.innerHTML = `
    <div class="ex-tags">
      <span class="sev-tag sev-${i.severity}">${i.severity}</span>
      <span class="tag">${CATEGORIES[i.category]}</span>
      ${i.platforms.map((p) => `<span class="tag plat">${PLATFORMS[p]}</span>`).join("")}
    </div>
    <h2></h2>
    <p class="where"><b>${esc(screenName(i.screen))}</b>${i.alsoOn?.length ? ` · also on ${i.alsoOn.map((x) => esc(screenName(x))).join(", ")}` : ""}${i.target?.layout ? ` · <code>${esc(i.target.layout)}.xml</code>` : ""}</p>
    ${i.gone ? `<p class="gone-note">This issue isn't detected any more - it was marked fixed automatically on the last scan.</p>` : ""}
    <div class="status-row">${Object.entries(STATUSES).map(([k, v]) => `<button class="st-btn st-${k} ${st === k ? "on" : ""}" data-st="${k}">${v}</button>`).join("")}
      ${stInfo?.reopened ? `<span class="muted">Re-opened: it was marked fixed but is still there.</span>` : stInfo?.at ? `<span class="muted">since ${new Date(stInfo.at).toLocaleDateString()}</span>` : ""}</div>
    <h3>Why this is a problem</h3>
    <p class="why"></p>
    <div class="measured"></div>
    <h3>Fix</h3>
    <p class="fix-text"></p>
    <div class="ba"></div>
    <div class="xml"></div>`;
  el.querySelector("h2").textContent = i.title;
  el.querySelector(".why").textContent = i.why || "";
  el.querySelector(".fix-text").textContent = i.fix?.text || "";
  for (const b of el.querySelectorAll("[data-st]")) b.onclick = () => setStatus(i.key, b.dataset.st);
  if (i.measured?.mapping) {
    el.querySelector(".measured").innerHTML = `<div class="mapping">${i.measured.mapping.map((m) => `<code>${esc(m)}</code>`).join("")}</div>`;
  }
  if (i.measured?.ratio) {
    el.querySelector(".measured").innerHTML = `<div class="meter"><span class="sw" style="background:${i.measured.bg};color:${i.measured.fg}">Aa</span><span>Measured <b>${fmtRatio(i.measured.ratio)}</b> · needs <b>${i.measured.need}:1</b><br><code>${i.measured.fg}</code> on <code>${i.measured.bg}</code></span></div>`;
  }
  if (!i.gone) beforeAfter(el.querySelector(".ba"), i);
  if (i.xml) xmlDiff(el.querySelector(".xml"), i);
}

// ---------------------------------------------------------------- before / after previews

function liveElement(i) {
  const s = app.model.screens[i.screen];
  if (!s || !i.target?.path) return null;
  const phone = document.querySelector(".phone-holder .phone");
  return phone ? findTarget(phone, i.target) : null;
}

function cloneForPreview(src) {
  const c = src.cloneNode(true);
  const r = src.getBoundingClientRect();
  const k = SCREEN_W / (src.closest(".phone").getBoundingClientRect().width || SCREEN_W);
  Object.assign(c.style, { position: "relative", left: "auto", top: "auto", right: "auto", bottom: "auto", margin: "0", transform: "none", width: r.width * k + "px", height: r.height * k + "px", flex: "none" });
  return c;
}

function previewPane(label, node, bg) {
  const pane = document.createElement("div");
  pane.className = "ba-pane";
  pane.innerHTML = `<span class="ba-label">${label}</span>`;
  const stage = document.createElement("div");
  stage.className = "ba-stage phone";
  stage.style.background = bg || "#fff";
  stage.append(node);
  pane.append(stage);
  return pane;
}

function beforeAfter(host, i) {
  const fix = i.fix || {};
  const kind = fix.kind;
  const make = (before, after, bg) => {
    host.innerHTML = "";
    host.append(previewPane("Before", before, bg), previewPane("After", after, bg));
  };
  if (["color", "bg", "font", "target"].includes(kind) || i.rule === "clipped") {
    // wait for the phone to be drawn, then copy the real view
    requestAnimationFrame(() => setTimeout(() => {
      const src = liveElement(i);
      if (!src) return;
      const btn = src.classList.contains("v-button") ? src : src.closest(".v-button");
      const bg = kind === "bg" && btn ? hex(backdrop(btn, src.closest(".phone")).rgb) : i.measured?.bg || hex(backdrop(src, src.closest(".phone")).rgb);
      const before = cloneForPreview(src), after = cloneForPreview(src);
      if (kind === "bg") {
        const btn = after.classList.contains("v-button") ? after : after.querySelector(".v-button") || after;
        btn.style.backgroundColor = fix.color;
        for (const bl of btn.querySelectorAll(".bg-layer")) bl.style.backgroundColor = fix.color;
      }
      if (kind === "color") for (const t of [after, ...after.querySelectorAll(".txt")]) if (t.classList.contains("txt")) t.style.color = fix.color;
      if (kind === "font") for (const t of after.querySelectorAll(".txt")) { t.style.fontSize = fix.size + "px"; t.style.lineHeight = fix.size * 1.3 + "px"; after.style.height = "auto"; after.style.width = Math.max(parseFloat(after.style.width), 200) + "px"; }
      if (i.rule === "clipped") { after.style.height = "auto"; for (const t of after.querySelectorAll(".txt")) { t.style.webkitLineClamp = "unset"; t.style.whiteSpace = "pre-wrap"; t.style.overflow = "visible"; t.classList.remove("clamp"); } }
      if (kind === "target") {
        before.classList.add("show-target");
        const w = Math.max(48, parseFloat(after.style.width)), hgt = Math.max(48, parseFloat(after.style.height));
        Object.assign(after.style, { width: w + "px", height: hgt + "px", minHeight: "48px", display: "flex", alignItems: "center", justifyContent: "center" });
        after.classList.add("show-target");
      }
      make(before, after, bg);
      host.insertAdjacentHTML("beforeend", kind === "target" ? `<p class="ba-note">Dashed outline = the area a finger can hit.</p>` : "");
    }, 60));
    return;
  }
  if (kind === "swatch") {
    const sw = (c, label) => { const d = document.createElement("div"); d.className = "swatch"; d.innerHTML = `<i style="background:${esc(hexToCss(c) || c)}"></i><code>${esc(label)}</code>`; return d; };
    make(sw(fix.from, fix.from), fix.to ? sw(fix.to, fix.value) : sw("#ffffff", "a new token in colors.xml"), "#fff");
    return;
  }
  if (kind === "state") { statePreview(host, i); return; }
  if (kind === "swap") {
    const before = document.createElement("div");
    before.innerHTML = `<div class="mock-field plain"><span>Email address</span></div><div class="mock-field plain typed"><span>ana@exam</span></div><p class="mock-cap">Typing hides the only label</p>`;
    const after = document.createElement("div");
    after.innerHTML = `<div class="mock-field outlined"><label>Email address</label><span>ana@exam</span></div><p class="mock-cap">The label floats up and stays</p>`;
    make(before, after, "#fff");
    return;
  }
  if (kind === "scale") {
    const col = (sizes) => { const d = document.createElement("div"); d.className = "scale-col"; d.innerHTML = sizes.map((s) => `<div style="font-size:${s}px">Aa <small>${s}sp</small></div>`).join(""); return d; };
    make(col(i.measured.sizes), col(fix.scale), "#fff");
    return;
  }
  if (kind === "palette") {
    const pal = (cols) => { const d = document.createElement("div"); d.className = "palette"; d.innerHTML = cols.map((c) => `<i title="${c}" style="background:${c}"></i>`).join(""); return d; };
    const roles = document.createElement("div");
    roles.className = "roles";
    roles.innerHTML = ["primary", "onPrimary", "surface", "onSurface", "onSurfaceVariant", "outline", "error"].map((r) => `<code>?attr/color${r[0].toUpperCase() + r.slice(1)}</code>`).join("");
    make(pal(fix.colors), roles, "#fff");
  }
}

// states: the real screen, small, with the missing state drawn into it
function statePreview(host, i) {
  const s = app.model.screens[i.screen];
  if (!s?.layout) return;
  const mini = (withState) => {
    const outer = document.createElement("div");
    outer.className = "mini-phone";
    const phone = app.renderer.screen(s);
    const sc = document.createElement("div");
    sc.className = "phone-scale";
    sc.style.transform = "scale(0.5)";
    sc.append(phone);
    outer.append(sc);
    if (withState) {
      const layer = document.createElement("div");
      layer.className = "state-layer state-" + i.fix.state;
      layer.innerHTML = {
        loading: `<div class="st-loading"><i></i><span>Signing in…</span></div>`,
        error: `<div class="st-error"><b>Couldn't connect</b><span>Check your connection and try again.</span><em>Retry</em></div>`,
        empty: `<div class="st-empty"><i></i><b>Nothing here yet</b><span>Items you add will show up here.</span><em>Add the first one</em></div>`,
        "field-error": `<div class="st-field"><span class="lbl">Email address</span><span class="box"></span><span class="err">Enter your email address</span></div>`,
      }[i.fix.state] || "";
      outer.append(layer);
    }
    return outer;
  };
  host.innerHTML = "";
  const b = mini(false), a = mini(true);
  host.append(previewPane("Before", b, "transparent"), previewPane("After (suggested)", a, "transparent"));
  for (const p of host.querySelectorAll(".phone")) settle(p);
}

// the view's XML, with the lines to change marked and the fixed version next to it
function xmlDiff(host, i) {
  const x = i.xml;
  const changes = new Map();
  if (i.fix?.changes) for (const c of i.fix.changes) changes.set(c.attr, c.to);
  else if (i.fix?.attr && i.fix.value && !/…/.test(i.fix.value)) changes.set(i.fix.attr, i.fix.value);
  const line = (name, value, cls) => `<div class="xl ${cls}">    ${esc(name)}=<q>"${esc(value)}"</q></div>`;
  const before = [`<div class="xl">&lt;${esc(x.tag)}</div>`, ...x.attrs.map((a) => line(a.name, a.value, a.hl || changes.has(a.name) ? "hl" : "")), `<div class="xl">/&gt;</div>`];
  const afterAttrs = x.attrs.map((a) => (changes.has(a.name) ? line(a.name, changes.get(a.name), "add") : line(a.name, a.value, "")));
  for (const [name, v] of changes) if (!x.attrs.some((a) => a.name === name)) afterAttrs.push(line(name, v, "add"));
  const after = [`<div class="xl">&lt;${esc(x.tag)}</div>`, ...afterAttrs, `<div class="xl">/&gt;</div>`];
  host.innerHTML = `<h3>In the XML</h3><div class="xml-cols"><div><span class="ba-label">Now</span><pre>${before.join("")}</pre></div>${changes.size ? `<div><span class="ba-label">Fixed</span><pre>${after.join("")}</pre></div>` : ""}</div>`;
}

// ---------------------------------------------------------------- events

$("folderInput").addEventListener("change", (e) => { if (e.target.files.length) load(filesFromInput(e.target.files)); e.target.value = ""; });
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => { e.preventDefault(); drop.classList.remove("over"); load(await filesFromDrop(e.dataTransfer)); });
$("openOther").onclick = () => { app = null; $("topActions").hidden = true; $("projectName").textContent = "A design review that doesn't go easy on you"; document.title = "Design Critic"; show("landing"); };
$("rescan").onclick = () => $("folderInput").click();
$("search").addEventListener("input", (e) => { filters.q = e.target.value.trim(); renderList(); renderDetail(); });
document.addEventListener("keydown", (e) => {
  if (!app || $("review").hidden || e.target.tagName === "INPUT") return;
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = visible();
  const idx = list.findIndex((i) => i.key === selected);
  const next = list[Math.max(0, Math.min(list.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next) { e.preventDefault(); selected = next.key; renderList(); renderDetail(); document.querySelector(".issue.sel")?.scrollIntoView({ block: "nearest" }); }
});
