// Design Critic: turns issues into a prompt you can paste into an AI coding assistant
// (Claude, ChatGPT, Copilot, Gemini…) so it fixes them in the project.

const SEV_ORDER = { blocker: 0, major: 1, minor: 2 };

function layoutPath(name) {
  const f = name && app.res.files.layout[name];
  return f ? f.path : name ? `res/layout/${name}.xml` : null;
}

function classPath(screenId) {
  const s = app.model.screens[screenId];
  const c = s && app.model.classes[s.cls];
  return c ? c.file.path : null;
}

function xmlText(x) {
  if (!x) return "";
  return [`<${x.tag}`, ...x.attrs.map((a) => `    ${a.name}="${a.value}"`), "/>"].join("\n");
}

function changeLines(fix) {
  if (!fix) return [];
  if (fix.changes) return fix.changes.map((c) => `${c.attr}: "${c.from}" → "${c.to}"`);
  if (fix.attr && fix.value && !/…/.test(fix.value)) return [`${fix.attr} → "${fix.value}"`];
  return [];
}

function tokenSummary() {
  const colors = Object.keys(app.res.values.color || {});
  const theme = app.renderer.theme(app.model.appTheme);
  const colorList = colors.slice(0, 30).map((n) => {
    const rgb = cssToRgb(app.res.color("@color/" + n, theme));
    return `@color/${n} = ${rgb ? hex(rgb) + (rgb[3] < 1 ? ` at ${Math.round(rgb[3] * 100)}% opacity` : "") : "?"}`;
  });
  const dimens = Object.entries(app.res.values.dimen || {}).slice(0, 30).map(([n, v]) => `@dimen/${n} = ${v.value}`);
  return { colorList, dimens, moreColors: Math.max(0, colors.length - 30) };
}

// where the issue lives in the code, as concrete as possible
function whereText(i) {
  const parts = [];
  const sn = screenName(i.screen);
  parts.push(`Screen: ${sn}${i.alsoOn?.length ? ` (also on ${i.alsoOn.map(screenName).join(", ")})` : ""}`);
  if (i.category === "states" && i.screen !== "__app") {
    const cp = classPath(i.screen);
    if (cp) parts.push(`Code: ${cp}`);
    if (i.target?.layout) parts.push(`Layout: ${layoutPath(i.target.layout)}`);
  } else if (i.target?.layout) {
    parts.push(`File: ${layoutPath(i.target.layout)}`);
  }
  const ids = [i.target, ...(i.more || [])].map((t) => t?.vid).filter(Boolean);
  if (ids.length) parts.push(`View${ids.length > 1 ? "s" : ""}: ${ids.slice(0, 12).map((v) => "@+id/" + v).join(", ")}${ids.length > 12 ? ` and ${ids.length - 12} more` : ""}`);
  else if (i.target?.label && i.target.path) parts.push(`View: ${i.target.label}`);
  return parts;
}

function buildPrompt(issues, opts = {}) {
  const { includeXml = true } = opts;
  const list = [...issues].filter((i) => !i.gone).sort((a, b) => {
    const fa = a.target?.layout || "~", fb = b.target?.layout || "~";
    return SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || fa.localeCompare(fb);
  });
  const counts = SEVERITIES.map((s) => [s, list.filter((i) => i.severity === s).length]).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(", ");
  const tk = tokenSummary();
  const out = [];
  out.push(`You are fixing design and accessibility problems in the Android app "${app.name}". A strict design review (Design Critic) found ${list.length} issue${list.length === 1 ? "" : "s"} (${counts}). Fix them in the project's files.`);
  out.push("");
  out.push("## Rules");
  out.push("- Fix every issue below. Make the smallest change that fixes it properly - don't redesign screens or change what the app does.");
  out.push("- Don't rename or remove view ids; Java/Kotlin code depends on them.");
  out.push("- Use tokens, not hard-coded values: colours go in res/values/colors.xml (or theme attributes), spacing in res/values/dimens.xml, text sizes through a TextAppearance style. Reuse an existing token when one fits; otherwise add one with a role-based name (e.g. color_on_accent, space_m).");
  out.push("- Text sizes in sp, never dp or px. Touch targets at least 48×48dp (use minWidth/minHeight and padding - not a bigger icon). Text contrast at least 4.5:1 (3:1 for text ≥ 24sp or bold ≥ 18.66sp), measured against the surface behind it.");
  out.push("- Move hard-coded strings into res/values/strings.xml when you touch a view.");
  out.push("- If an issue can't be fixed as described (e.g. it would break the layout), fix it the closest correct way and say why.");
  out.push("");
  if (tk.colorList.length || tk.dimens.length) {
    out.push("## Existing tokens in the project");
    if (tk.colorList.length) out.push(`Colors: ${tk.colorList.join(", ")}${tk.moreColors ? ` (+${tk.moreColors} more)` : ""}`);
    out.push(tk.dimens.length ? `Dimens: ${tk.dimens.join(", ")}` : "Dimens: none yet - create res/values/dimens.xml with a 4/8dp spacing scale (space_xs 4dp, space_s 8dp, space_m 16dp, space_l 24dp, space_xl 32dp).");
    out.push("");
  }
  out.push("## Issues (most severe first)");
  list.forEach((i, n) => {
    out.push("");
    out.push(`### ${n + 1}. [${i.severity.toUpperCase()} · ${CATEGORIES[i.category]}] ${i.title}`);
    for (const w of whereText(i)) out.push(w);
    out.push(`Problem: ${i.why}`);
    if (i.measured?.ratio) out.push(`Measured: ${i.measured.fg} on ${i.measured.bg} = ${fmtRatio(i.measured.ratio)} (needs ${i.measured.need}:1)`);
    if (i.measured?.sizes) out.push(`Sizes in use: ${i.measured.sizes.map((x) => x + "sp").join(", ")}`);
    out.push(`Fix: ${i.fix?.text || ""}`);
    const ch = changeLines(i.fix);
    if (ch.length) out.push(`Suggested change: ${ch.join("; ")}`);
    if (includeXml && i.xml) {
      out.push("Current XML:");
      out.push("```xml");
      out.push(xmlText(i.xml));
      out.push("```");
    }
  });
  out.push("");
  out.push("## When you're done");
  out.push("List the files you changed and, for each issue number, one line on what you did. Flag anything you couldn't fix. Don't touch anything unrelated.");
  return out.join("\n");
}

// ---------------------------------------------------------------- the dialog

function openPromptDialog(scope) {
  const dlg = $("promptDialog");
  const selectedIssue = allItems().find((i) => i.key === selected);
  const screenId = selectedIssue ? selectedIssue.screen : filters.screen !== "all" ? filters.screen : null;
  const scopes = [
    ["list", `Issues in the list (${visible().filter((i) => !i.gone).length})`, () => visible()],
    screenId && screenId !== "__app" ? ["screen", `This screen: ${screenName(screenId)} (${app.issues.filter((i) => (i.screen === screenId || (i.alsoOn || []).includes(screenId)) && ["open", "progress"].includes(statusOf(i.key))).length})`,
      () => app.issues.filter((i) => (i.screen === screenId || (i.alsoOn || []).includes(screenId)) && ["open", "progress"].includes(statusOf(i.key)))] : null,
    selectedIssue && !selectedIssue.gone ? ["issue", "Only the selected issue", () => [selectedIssue]] : null,
    ["blockers", `All open blockers (${app.issues.filter((i) => i.severity === "blocker" && ["open", "progress"].includes(statusOf(i.key))).length})`, () => app.issues.filter((i) => i.severity === "blocker" && ["open", "progress"].includes(statusOf(i.key)))],
  ].filter(Boolean);
  let current = scopes.find((s) => s[0] === scope) || scopes[0];
  const body = dlg.querySelector(".pd-body");
  body.innerHTML = `
    <div class="pd-scopes">${scopes.map(([k, label]) => `<label><input type="radio" name="pscope" value="${k}" ${k === current[0] ? "checked" : ""}> ${esc(label)}</label>`).join("")}</div>
    <label class="pd-opt"><input type="checkbox" id="pdXml" checked> Include each view's current XML</label>
    <textarea id="pdText" readonly spellcheck="false"></textarea>
    <div class="pd-foot"><span id="pdStats"></span>
      <button class="pill-btn" id="pdDownload">Download .md</button>
      <button class="primary-btn" id="pdCopy">Copy prompt</button></div>`;
  const update = () => {
    const issues = current[2]().filter((i) => !i.gone);
    const text = issues.length ? buildPrompt(issues, { includeXml: $("pdXml").checked }) : "No open issues in this selection.";
    $("pdText").value = text;
    $("pdStats").textContent = `${issues.length} issue${issues.length === 1 ? "" : "s"} · ${text.split(/\s+/).length.toLocaleString()} words`;
  };
  for (const r of body.querySelectorAll("[name=pscope]")) r.onchange = () => { current = scopes.find((s) => s[0] === r.value); update(); };
  $("pdXml").onchange = update;
  $("pdCopy").onclick = async () => {
    const t = $("pdText");
    try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
    $("pdCopy").textContent = "Copied ✓";
    setTimeout(() => { if ($("pdCopy")) $("pdCopy").textContent = "Copy prompt"; }, 1600);
  };
  $("pdDownload").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([$("pdText").value], { type: "text/markdown" }));
    a.download = `${app.name.replace(/[^\w.-]+/g, "_")}-design-fixes.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  update();
  dlg.showModal();
}
