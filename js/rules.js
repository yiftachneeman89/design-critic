// Design Critic: the checks. Each screen is drawn from its XML (same engine as Screen Map),
// then measured: contrast, touch targets, text sizes, tokens, spacing, states, labels and copy.
// The bar is set on purpose high - "it works" is not the same as "it's well designed".

const SEV_WEIGHT = { blocker: 12, major: 4, minor: 1 };
const ALL_PLATFORMS = ["android", "ios", "web"];
const COLOR_ATTRS = ["textColor", "textColorHint", "background", "backgroundTint", "tint", "strokeColor", "iconTint", "drawableTint", "boxStrokeColor", "hintTextColor", "cardBackgroundColor", "itemIconTint", "itemTextColor", "trackTint", "thumbTint", "buttonTint", "progressTint", "indeterminateTint", "textColorLink"];
const SPACING_ATTRS = ["layout_margin", "layout_marginTop", "layout_marginBottom", "layout_marginStart", "layout_marginEnd", "layout_marginLeft", "layout_marginRight", "layout_marginHorizontal", "layout_marginVertical",
  "padding", "paddingTop", "paddingBottom", "paddingStart", "paddingEnd", "paddingLeft", "paddingRight", "paddingHorizontal", "paddingVertical"];
const INTERACTIVE_KINDS = ["v-button", "v-imagebutton", "v-fab", "v-efab", "v-check", "v-radio", "v-switch", "v-chip", "v-spinner", "v-edit", "v-seek", "v-toggle", "bn-item"];
const VAGUE_LABELS = /^(ok|okay|click here|here|press|submit|go|yes|no|button|tap|tap here|continue|next|done|send)$/i;
const PLACEHOLDER_TEXT = /^(textview|button|new text|text|title|label|lorem ipsum.*|sample text|placeholder|todo|test|xxx+|asdf.*|name)$/i;

// ---------------------------------------------------------------- colour maths

function parseRgb(css) {
  const m = String(css || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!m) return null;
  let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [+m[1], +m[2], +m[3], a];
}

const _probe = document.createElement("i");
function cssToRgb(css) {
  if (!css) return null;
  _probe.style.color = "";
  _probe.style.color = css;
  if (!_probe.style.color) return null;
  document.body.append(_probe);
  const v = parseRgb(getComputedStyle(_probe).color);
  _probe.remove();
  return v;
}

function relLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function blend(top, under) {
  const a = top[3] ?? 1;
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
}

function hex(rgb) { return "#" + rgb.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase(); }

// rough perceptual distance (redmean)
function colorDistance(a, b) {
  const rm = (a[0] + b[0]) / 2;
  const [dr, dg, db] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

// move a colour towards black or white until it reaches the target contrast on bg
function fixContrast(fg, bg, target) {
  const towards = relLum(bg) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = [0, 1, 2].map((i) => fg[i] + (towards[i] - fg[i]) * t);
    if (contrast(c, bg) >= target) return c;
  }
  return towards;
}

// ---------------------------------------------------------------- measuring the drawn screen

function visibleRect(el, phoneRect) {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  if (r.right <= phoneRect.left || r.bottom <= phoneRect.top || r.left >= phoneRect.right || r.top >= phoneRect.bottom) return null;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return null;
  return r;
}

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

// what is painted under `el`: nearest layers first. Returns { rgb, image } (image = text sits on a picture)
function backdrop(el, phone) {
  const layers = [];
  const own = (n) => {
    const out = [];
    const cs = getComputedStyle(n);
    if (n.tagName === "IMG" || n.tagName === "svg" || (cs.backgroundImage && cs.backgroundImage !== "none" && !/gradient/.test(cs.backgroundImage))) out.push({ image: true });
    for (const bl of n.querySelectorAll(":scope > .bg-layer")) {
      const c = parseRgb(getComputedStyle(bl).backgroundColor);
      if (c && c[3] > 0) out.push({ rgb: c });
    }
    const c = parseRgb(cs.backgroundColor);
    if (c && c[3] > 0) out.push({ rgb: c });
    if (/gradient/.test(cs.backgroundImage)) out.push({ image: true, gradient: true });
    return out;
  };
  const r0 = el.getBoundingClientRect();
  let node = el;
  let first = true;
  while (node && node !== phone.parentElement) {
    if (!first) layers.push(...own(node));
    first = false;
    // earlier siblings that sit under this one (ConstraintLayout / FrameLayout stacking)
    const parent = node.parentElement;
    if (parent && node !== phone) {
      const pcs = getComputedStyle(parent);
      if (pcs.display !== "flex" || /absolute/.test(getComputedStyle(node).position)) {
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.classList.contains("v") && sib.style.display !== "none") {
            const sr = sib.getBoundingClientRect();
            if (overlapArea(sr, r0) > 0.5 * r0.width * r0.height) {
              const inner = sib.querySelector("img, svg");
              if (inner && overlapArea(inner.getBoundingClientRect(), r0) > 0.5 * r0.width * r0.height) layers.push({ image: true });
              layers.push(...own(sib));
            }
          }
          sib = sib.previousElementSibling;
        }
      }
    }
    if (node === phone) break;
    node = parent;
  }
  // composite from the bottom up, stopping at the first opaque layer
  let image = false;
  const stack = [];
  for (const l of layers) {
    if (l.image) { image = true; break; }
    stack.push(l.rgb);
    if (l.rgb[3] >= 0.99) break;
  }
  let rgb = [255, 255, 255, 1];
  for (let i = stack.length - 1; i >= 0; i--) rgb = blend(stack[i], rgb);
  return { rgb, image };
}

// ---------------------------------------------------------------- reading the XML behind a view

function xmlAttrs(el) {
  const out = {};
  const x = el._x;
  if (!x) return out;
  for (const at of x.attributes) out[at.name.split(":").pop()] = { name: at.name, value: at.value };
  return out;
}

function xmlSnippet(el, highlight = []) {
  const x = el._x;
  if (!x) return "";
  const attrs = [...x.attributes].filter((a) => !a.name.startsWith("xmlns"));
  return { tag: x.tagName, attrs: attrs.map((a) => ({ name: a.name, value: a.value, hl: highlight.includes(a.name.split(":").pop()) })) };
}

function layoutOf(el) {
  const host = el.closest("[data-layout], [data-include]");
  return host ? host.dataset.layout || host.dataset.include : null;
}

// position of el inside its layout's root, as child indexes - finds the same view in a fresh drawing
function pathIn(el) {
  const root = el.closest("[data-layout], [data-include]");
  const path = [];
  let n = el;
  while (n && n !== root) { path.unshift([...n.parentElement.children].indexOf(n)); n = n.parentElement; }
  return { layout: layoutOf(el), path };
}

function labelOf(el) {
  const a = el._a || {};
  const t = el.querySelector(".txt")?.textContent?.trim();
  const id = el.dataset.vid;
  return t ? `“${t.length > 40 ? t.slice(0, 38) + "…" : t}”` : id ? `#${id}` : `a ${el.dataset.tag || "view"}`;
}

function isInteractive(el, wired) {
  if (INTERACTIVE_KINDS.some((k) => el.classList.contains(k))) return true;
  const a = el._a || {};
  if (a.clickable === "true" || a.onClick) return true;
  return !!(el.dataset.vid && wired.has(el.dataset.vid));
}

function fmtRatio(r) { return (Math.floor(r * 100) / 100).toFixed(2) + ":1"; }

// ---------------------------------------------------------------- the per-screen checks

class Critic {
  constructor(model, res, renderer) {
    this.model = model;
    this.res = res;
    this.r = renderer;
    this.wired = new Set(Object.values(model.screens).flatMap((s) => s.handlers.map((h) => h.id)).filter(Boolean));
    this.palette = this.readPalette();
    this.dimens = this.readDimens();
    this.seen = new Map();  // issue key -> issue (a view shared by several screens is reported once)
    this.stats = { fontSizes: new Map(), colors: new Map(), buttons: [], caps: [], spacingRaw: 0, spacingToken: 0 };
  }

  readPalette() {
    const out = [];
    const theme = this.r.theme(this.model.appTheme);
    for (const name of Object.keys(this.res.values.color || {})) {
      const css = this.res.color("@color/" + name, theme);
      const rgb = cssToRgb(css);
      if (rgb && rgb[3] > 0.99) out.push({ name, rgb, hex: hex(rgb) });
    }
    return out;
  }

  readDimens() {
    const out = [];
    for (const [name, v] of Object.entries(this.res.values.dimen || {})) {
      const m = String(v.value).match(/^(-?[\d.]+)\s*(dp|dip|sp)$/);
      if (m) out.push({ name, value: parseFloat(m[1]), unit: m[2] });
    }
    return out;
  }

  nearestToken(rgb, test) {
    let best = null;
    for (const p of this.palette) {
      if (test && !test(p)) continue;
      const d = colorDistance(rgb, p.rgb);
      if (!best || d < best.d) best = { ...p, d };
    }
    return best;
  }

  add(issue) {
    const key = issue.key;
    if (this.seen.has(key)) {
      const prev = this.seen.get(key);
      if (!prev.alsoOn.includes(issue.screen) && prev.screen !== issue.screen) prev.alsoOn.push(issue.screen);
      return;
    }
    issue.alsoOn = [];
    this.seen.set(key, issue);
  }

  // turns a live element into what an issue stores
  where(el, phone) {
    const pr = phone.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { ...pathIn(el), rect: { x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height }, label: labelOf(el), vid: el.dataset.vid || null };
  }

  issue(s, el, phone, o) {
    const w = el ? this.where(el, phone) : { layout: s.layout, path: null, rect: null, label: null };
    const key = `${o.rule}|${w.layout || s.id}|${w.path ? w.path.join(".") : o.keyExtra || ""}`;
    this.add({
      key, rule: o.rule, screen: s.id, severity: o.severity, category: o.category, platforms: o.platforms || ALL_PLATFORMS,
      title: o.title, why: o.why, fix: o.fix, measured: o.measured || null,
      target: w, xml: el ? xmlSnippet(el, o.attrs || []) : null, more: (o.more || []).map((m) => this.where(m, phone)),
    });
  }

  scanScreen(s, phone) {
    const pr = phone.getBoundingClientRect();
    const scope = phone.querySelector(".dialog-card") || phone.querySelector(".screen-content") || phone;
    const views = [...scope.querySelectorAll(".v")].filter((v) => !v.closest("[data-copy]") && !v.closest(".under-dialog") && visibleRect(v, pr));
    const texts = views.filter((v) => v.classList.contains("textual") || v.querySelector(":scope > .txt"));
    for (const v of views) {
      this.checkTokens(s, v, phone);
      this.checkSpacing(s, v, phone);
      this.checkLabels(s, v, phone);
    }
    for (const v of texts) {
      this.checkText(s, v, phone, pr);
    }
    for (const v of [...views, ...scope.querySelectorAll(".bn-item")]) {
      if (isInteractive(v, this.wired)) this.checkTarget(s, v, phone, pr);
    }
    this.flushSpacing(s, phone);
    this.checkEdges(s, texts, phone, pr);
    this.checkOverlaps(s, texts, phone);
    this.checkStates(s, phone, views);
    this.checkCopy(s, texts, phone);
  }

  // ---- contrast, size, units, truncation
  checkText(s, v, phone, pr) {
    const span = v.querySelector(":scope > .txt") || v.querySelector(".txt");
    if (!span || !span.textContent.trim()) return;
    const cs = getComputedStyle(span);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const fg = parseRgb(cs.color);
    const a = v._a || {};
    const x = xmlAttrs(v);
    const isHint = !(this.r.textContent(a, { theme: this.r.theme(this.model.appTheme) })) && !!a.hint;
    const text = span.textContent.trim();
    this.stats.fontSizes.set(Math.round(size * 2) / 2, (this.stats.fontSizes.get(Math.round(size * 2) / 2) || 0) + 1);

    // contrast
    if (fg) {
      const bd = backdrop(span, phone);
      const fgOn = blend(fg, bd.rgb);
      const ratio = contrast(fgOn, bd.rgb);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (bd.image) {
        this.issue(s, v, phone, {
          rule: "text-on-image", severity: "major", category: "color", attrs: ["textColor"],
          title: `Text over an image: ${labelOf(v)}`,
          why: "This text sits directly on a picture. Its contrast changes with every pixel behind it, so on part of the image it will be unreadable - and nobody can promise a ratio. Designers who care put a scrim or a solid surface behind text on photos.",
          fix: { text: "Put the text on a solid surface, or add a dark scrim (#99000000) between the image and the text, then check 4.5:1 against the scrim.", kind: "scrim" },
        });
      } else if (ratio < need) {
        const target = fixContrast(fg, bd.rgb, need + 0.1);
        const token = this.nearestToken(target, (p) => contrast(p.rgb, bd.rgb) >= need);
        const sev = ratio < (large ? 2 : 3) ? "blocker" : "major";
        // the text is already as light (or dark) as it gets: the surface has to change
        if (contrast(target, bd.rgb) < need) {
          const bg = fixContrast(bd.rgb, fgOn, need + 0.1);
          const bgToken = this.nearestToken(bg, (p) => contrast(fgOn, p.rgb) >= need);
          const useToken = bgToken && colorDistance(bgToken.rgb, bg) < 60;  // a different hue would change the brand, not fix it
          const onButton = v.classList.contains("v-button") || !!v.closest(".v-button");
          const attr = onButton ? "app:backgroundTint" : "android:background";
          this.issue(s, v, phone, {
            rule: "contrast", severity: sev, category: "accessibility", attrs: ["textColor", "backgroundTint", "background"],
            title: `Text contrast ${fmtRatio(ratio)} - needs ${need}:1: ${labelOf(v)}`,
            why: `${hex(fgOn)} on ${hex(bd.rgb)} measures ${fmtRatio(ratio)}. WCAG 2.2 AA asks for ${need}:1 for ${large ? "large" : "normal"} text. The text is already ${relLum(fgOn) > 0.5 ? "near-white" : "near-black"}, so no text colour can fix this - the ${onButton ? "button colour" : "background"} itself is the problem.${sev === "blocker" ? " At this level many people can't read it at all. Not shippable." : ""}`,
            measured: { ratio, need, fg: hex(fgOn), bg: hex(bd.rgb) },
            fix: {
              text: useToken ? `Use a darker surface from your palette: ${attr}="@color/${bgToken.name}" (${bgToken.hex}, ${fmtRatio(contrast(fgOn, bgToken.rgb))}).`
                : `Change the ${onButton ? "button colour" : "background"} to ${hex(bg)} (${fmtRatio(contrast(fgOn, bg))}) and make it a token - e.g. a darker shade of your accent for filled buttons.`,
              attr, value: useToken ? `@color/${bgToken.name}` : hex(bg), kind: "bg", color: useToken ? bgToken.hex : hex(bg),
            },
          });
          return this.checkTextRest(s, v, phone, span, size, x, a, text);
        }
        this.issue(s, v, phone, {
          rule: "contrast", severity: sev, category: "accessibility", attrs: [isHint ? "textColorHint" : "textColor"],
          title: `${isHint ? "Hint" : "Text"} contrast ${fmtRatio(ratio)} - needs ${need}:1: ${labelOf(v)}`,
          why: `${hex(fgOn)} on ${hex(bd.rgb)} measures ${fmtRatio(ratio)}. WCAG 2.2 AA asks for ${need}:1 for ${large ? "large" : "normal"} text${isHint ? " - and hints are text people must read, not decoration" : ""}. ${sev === "blocker" ? "At this level a large share of users simply can't read it, especially outdoors or with low vision. Not shippable." : "It will be hard to read in sunlight, on cheap screens and for anyone with weaker eyesight."}`,
          measured: { ratio, need, fg: hex(fgOn), bg: hex(bd.rgb) },
          fix: {
            text: token && colorDistance(token.rgb, target) < 120
              ? `Use @color/${token.name} (${token.hex}) - it's already in your palette and reaches ${fmtRatio(contrast(token.rgb, bd.rgb))}.`
              : `Darken it to ${hex(target)} (${fmtRatio(contrast(target, bd.rgb))}) and add it to colors.xml as a token - nothing in your palette passes on this background.`,
            attr: isHint ? "android:textColorHint" : "android:textColor",
            value: token && colorDistance(token.rgb, target) < 120 ? `@color/${token.name}` : hex(target),
            kind: "color", color: token && colorDistance(token.rgb, target) < 120 ? token.hex : hex(target),
          },
        });
      }
    }

    this.checkTextRest(s, v, phone, span, size, x, a, text);
  }

  checkTextRest(s, v, phone, span, size, x, a, text) {
    // size
    if (size < 12 || (size < 14 && text.length > 40)) {
      const sev = size < 10 ? "blocker" : size < 12 ? "major" : "minor";
      this.issue(s, v, phone, {
        rule: "font-size", severity: sev, category: "typography", attrs: ["textSize"],
        title: `${size}sp text is too small: ${labelOf(v)}`,
        why: size < 12
          ? `${size}sp is below the 12sp floor of every mainstream type scale (Material's smallest label is 11sp, and only for single words). On a phone at arm's length this is a squint.`
          : `${size}sp for a ${text.length}-character sentence is caption size used as body text. Body copy should be 14-16sp so people can read it without zooming.`,
        measured: { size },
        fix: { text: `Use a type-scale style instead of a raw size: android:textAppearance="?attr/textAppearanceBodyMedium" (14sp)${text.length > 40 ? " or BodyLarge (16sp) for longer text" : ""}.`, attr: "android:textSize", value: text.length > 40 ? "16sp" : "14sp", kind: "font", size: text.length > 40 ? 16 : 14 },
      });
    }
    const ts = x.textSize?.value || "";
    if (/\d\s*(dp|dip|px)$/.test(ts)) {
      this.issue(s, v, phone, {
        rule: "font-unit", severity: "major", category: "accessibility", platforms: ["android"], attrs: ["textSize"],
        title: `Text size in ${ts.match(/(dp|dip|px)$/)[1]} ignores the user's font setting: ${labelOf(v)}`,
        why: `android:textSize="${ts}" is fixed. People who raise the system font size (a quarter of Android users do) get no bigger text here, while the rest of their phone grows. That's an accessibility failure, not a style choice.`,
        fix: { text: `Use sp: android:textSize="${ts.replace(/(dp|dip|px)$/, "sp")}" - better, a textAppearance from your type scale.`, attr: "android:textSize", value: ts.replace(/(dp|dip|px)$/, "sp"), kind: "code" },
      });
    }

    // cut-off text
    const lost = size * 0.45;  // tall fonts poke a little past their line box - that isn't clipping
    const clipped = span.scrollWidth > span.clientWidth + 3 || span.scrollHeight > span.clientHeight + lost || (v.scrollHeight > v.clientHeight + lost && getComputedStyle(v).overflow !== "visible");
    if (clipped && !(a.ellipsize && (a.maxLines === "1" || a.singleLine === "true"))) {
      this.issue(s, v, phone, {
        rule: "clipped", severity: "major", category: "layout", attrs: ["layout_height", "layout_width", "maxLines"],
        title: `Text is cut off: ${labelOf(v)}`,
        why: "The text doesn't fit its box at the default font size, so letters or whole lines disappear. With a bigger system font or a longer translation it gets worse. A layout that only works for one string length is broken.",
        fix: { text: "Let the view grow: layout_height=\"wrap_content\" (and a minHeight if you need one), or allow a second line. If truncation is intended, say so with maxLines + ellipsize=\"end\".", attr: "android:layout_height", value: "wrap_content", kind: "code" },
      });
    }

    if (a.textAllCaps === "true" && text.length > 20) {
      this.issue(s, v, phone, {
        rule: "all-caps", severity: "minor", category: "typography", attrs: ["textAllCaps"],
        title: `Long text in ALL CAPS: ${labelOf(v)}`,
        why: "Capitals remove word shapes, so a sentence in caps is measurably slower to read and reads as shouting.",
        fix: { text: "Remove android:textAllCaps, or keep caps to one- or two-word labels.", attr: "android:textAllCaps", value: "false", kind: "code" },
      });
    }
  }

  // ---- touch targets
  checkTarget(s, v, phone, pr) {
    const r = v.getBoundingClientRect();
    const extra = v._touchExtra || 0;
    const w = r.width, h = r.height + extra;
    const small = Math.min(w, h);
    if (small >= 48) return;
    const sev = small < 24 ? "blocker" : small < 40 ? "major" : "minor";
    const isLink = v.classList.contains("v-text");
    this.issue(s, v, phone, {
      rule: "tap-target", severity: sev, category: "accessibility", attrs: ["layout_width", "layout_height", "minHeight", "padding"],
      title: `Touch target ${Math.round(w)}×${Math.round(h)}dp - needs 48×48: ${labelOf(v)}`,
      why: `${isLink ? "This is tappable text, and its" : "Its"} touch area is ${Math.round(w)}×${Math.round(h)}dp. Android asks for 48×48dp, Apple 44×44pt, WCAG 2.2 at least 24×24px. ${sev === "blocker" ? "At this size people miss it constantly - not acceptable for anything tappable." : "Fingers are ~10mm wide; this will cause missed taps and taps on the neighbour."}`,
      measured: { w: Math.round(w), h: Math.round(h) },
      fix: {
        text: isLink
          ? "Give the link real touch area: android:minHeight=\"48dp\", android:gravity=\"center_vertical\" and horizontal padding - or make it a TextButton (Widget.Material3.Button.TextButton), which is 48dp tall by default."
          : "Set android:minWidth=\"48dp\" and android:minHeight=\"48dp\" (padding grows the target without growing the icon).",
        attr: "android:minHeight", value: "48dp", kind: "target",
      },
    });
  }

  // ---- hard-coded colours vs the palette
  checkTokens(s, v, phone) {
    const x = xmlAttrs(v);
    for (const name of COLOR_ATTRS) {
      const at = x[name];
      if (!at || !/^#[0-9a-f]{3,8}$/i.test(at.value)) continue;
      const rgb = cssToRgb(hexToCss(at.value));
      if (!rgb) continue;
      this.stats.colors.set(hex(rgb), (this.stats.colors.get(hex(rgb)) || 0) + 1);
      const near = this.nearestToken(rgb);
      const same = near && near.d < 3;
      const close = near && near.d < 40;
      this.issue(s, v, phone, {
        rule: "color-token", keyExtra: name, severity: same || close ? "minor" : "major", category: "color", platforms: ["android", "ios", "web"], attrs: [name],
        title: same ? `Hard-coded ${at.value} instead of @color/${near.name}: ${labelOf(v)}`
          : close ? `${at.value} is almost @color/${near.name} - an accidental off-palette colour: ${labelOf(v)}`
          : `Off-palette colour ${at.value}: ${labelOf(v)}`,
        why: same ? "The value matches a token, but it's typed out by hand. Change the token and this view silently stays behind - that's how apps drift into fifty greys."
          : close ? `It differs from ${near.hex} by a hair. Nobody chose this on purpose; it's two near-identical colours that will look like a mistake side by side.`
          : `This colour isn't in colors.xml at all${this.palette.length ? "" : " - there is no colour palette in this project"}. One-off colours make the UI inconsistent and impossible to re-theme (dark mode, brand changes).`,
        fix: near && (same || close)
          ? { text: `Use the token: ${at.name}="@color/${near.name}".`, attr: at.name, value: `@color/${near.name}`, kind: "swatch", from: at.value, to: near.hex }
          : { text: `Add it to colors.xml with a role-based name (e.g. color_text_secondary), or replace it with the closest existing token${near ? ` (@color/${near.name}, ${near.hex})` : ""}.`, attr: at.name, value: near ? `@color/${near.name}` : "@color/…", kind: "swatch", from: at.value, to: near ? near.hex : null },
      });
    }
  }

  // ---- spacing on the 4/8dp grid and through tokens
  checkSpacing(s, v, phone) {
    const x = xmlAttrs(v);
    const off = [];
    for (const name of SPACING_ATTRS) {
      const at = x[name];
      if (!at) continue;
      if (/^@dimen\//.test(at.value)) { this.stats.spacingToken++; continue; }
      const m = at.value.match(/^(-?[\d.]+)\s*(dp|dip|px|sp)$/);
      if (!m) continue;
      this.stats.spacingRaw++;
      const n = parseFloat(m[1]);
      if (m[2] === "px" || m[2] === "sp" || (Math.abs(n) % 4 !== 0 && Math.abs(n) > 2)) off.push({ name, value: at.value, n, unit: m[2], full: at.name });
    }
    if (!off.length) return;
    const layout = layoutOf(v) || s.layout;
    if (!this.offGrid) this.offGrid = new Map();
    if (!this.offGrid.has(layout)) this.offGrid.set(layout, { s, items: [] });
    if (this.offGrid.get(layout).s === s) this.offGrid.get(layout).items.push({ v, off });
  }

  // one issue per layout file, listing every off-grid value in it
  flushSpacing(s, phone) {
    for (const [layout, g] of this.offGrid || []) if (g.s === s && !g.done) { g.done = true; this.spacingIssue(s, phone, layout, g.items); }
  }

  spacingIssue(s, phone, layout, items) {
    const v = items[0].v;
    const off = items.flatMap((i) => i.off);
    const snap = (n) => Math.sign(n || 1) * Math.max(4, Math.round(Math.abs(n) / 4) * 4);
    const tokenFor = (n) => this.dimens.find((d) => d.value === n);
    const values = [...new Set(off.map((o) => o.value))].sort((a, b) => parseFloat(a) - parseFloat(b));
    const mapping = values.map((val) => { const n = parseFloat(val); const t = tokenFor(snap(n)); return `${val} → ${t ? "@dimen/" + t.name : snap(n) + "dp"}`; });
    this.issue(s, v, phone, {
      rule: "spacing-grid", severity: items.length > 5 ? "major" : "minor", category: "layout", platforms: ALL_PLATFORMS, keyExtra: "layout", attrs: items[0].off.map((o) => o.name),
      more: items.slice(1).map((i) => i.v), measured: { mapping },
      title: `Off-grid spacing in ${items.length} place${items.length > 1 ? "s" : ""}: ${values.join(", ")}`,
      why: `Spacing should come from a 4dp/8dp scale (4, 8, 12, 16, 24, 32…). ${layout}.xml uses ${values.join(", ")} in ${items.length} view${items.length > 1 ? "s" : ""} - all outlined on the screen${off.some((o) => o.unit === "px") ? ", and px values even change size between devices" : ""}. Values like these are why a screen feels slightly “off” without anyone being able to say why.`,
      fix: {
        text: `Snap every value to the scale: ${mapping.join(", ")}.` + (this.dimens.length ? "" : " Then define the scale once in dimens.xml (space_xs 4dp, space_s 8dp, space_m 16dp, space_l 24dp) and use @dimen/… instead of numbers."),
        changes: items[0].off.map((o) => { const t = tokenFor(snap(o.n)); return { attr: o.full, from: o.value, to: t ? "@dimen/" + t.name : snap(o.n) + "dp" }; }),
        kind: "code",
      },
    });
  }

  // ---- labels for screen readers and inputs
  checkLabels(s, v, phone) {
    const a = v._a || {};
    const tag = v.dataset.tag || "";
    const hasText = !!v.querySelector(".txt")?.textContent.trim();
    const desc = a.contentDescription;
    const iconOnly = v.classList.contains("v-imagebutton") || v.classList.contains("v-fab") || (/ImageView|ImageButton/.test(tag) && isInteractive(v, this.wired)) || (v.classList.contains("v-button") && !hasText);
    if (iconOnly && !desc && a.importantForAccessibility !== "no") {
      this.issue(s, v, phone, {
        rule: "no-label", severity: "blocker", category: "accessibility", attrs: ["contentDescription"],
        title: `Icon button with no label: ${labelOf(v)}`,
        why: "TalkBack and VoiceOver will announce this as “Unlabelled button”. For a blind user that's a button that could do anything - including delete their account. Every icon-only control needs a spoken name.",
        fix: { text: `Add android:contentDescription="@string/${(v.dataset.vid || "action").replace(/_(btn|button|ib|iv|img)$/, "")}_description" describing the action (“Go back”, not “arrow”).`, attr: "android:contentDescription", value: "@string/…", kind: "code" },
      });
    }
    if (v.classList.contains("v-edit")) {
      const til = v.closest(".v-til, [data-tag$=TextInputLayout]");
      const hint = a.hint || til?._a?.hint;
      const labelled = [...phone.querySelectorAll(".v")].some((o) => o._a?.labelFor && o._a.labelFor.replace(/^@\+?id\//, "") === v.dataset.vid);
      if (!hint && !labelled) {
        this.issue(s, v, phone, {
          rule: "input-label", severity: "major", category: "accessibility", attrs: ["hint"],
          title: `Input field with no label or hint: ${labelOf(v)}`,
          why: "Nothing tells the user - or a screen reader - what goes in this field.",
          fix: { text: "Wrap it in a TextInputLayout with android:hint, or point a TextView at it with android:labelFor.", kind: "code", attr: "android:hint", value: "@string/…" },
        });
      } else if (!til && !labelled) {
        this.issue(s, v, phone, {
          rule: "hint-as-label", severity: "minor", category: "accessibility", platforms: ALL_PLATFORMS, attrs: ["hint"],
          title: `The hint is the only label: ${labelOf(v)}`,
          why: "The hint vanishes the moment someone starts typing, so they lose track of what the field was - especially in forms with several fields, or when coming back after an error.",
          fix: { text: "Use a TextInputLayout (Material) so the hint floats up and stays visible as a label, with room for an error message underneath.", kind: "swap", component: "TextInputLayout" },
        });
      }
    }
  }

  // ---- text touching the screen edges / leaving the screen
  checkEdges(s, texts, phone, pr) {
    const cr = (phone.querySelector(".dialog-card") || phone).getBoundingClientRect();
    for (const v of texts) {
      const span = v.querySelector(".txt");
      if (!span || !span.textContent.trim()) continue;
      const r = span.getBoundingClientRect();
      if (r.right > cr.right + 1 || r.left < cr.left - 1) {
        this.issue(s, v, phone, {
          rule: "off-screen", severity: "major", category: "layout",
          title: `Text runs off the screen: ${labelOf(v)}`,
          why: `On a 360dp-wide phone this text extends ${Math.round(Math.max(r.right - cr.right, cr.left - r.left))}dp past the edge. Smaller phones and larger fonts make it worse.`,
          fix: { text: "Constrain the width (0dp/match_constraint between parent edges, or match_parent with margins) instead of a fixed or wrap_content width.", kind: "code", attr: "android:layout_width", value: "0dp" },
        });
      } else if ((r.left - cr.left < 12 || cr.right - r.right < 12) && r.width > 40 && !v.closest(".v-button, .bn-item, .v-chip")) {
        this.issue(s, v, phone, {
          rule: "edge-margin", severity: "minor", category: "layout",
          title: `Text ${Math.round(Math.min(r.left - cr.left, cr.right - r.right))}dp from the screen edge: ${labelOf(v)}`,
          why: "Text needs breathing room from the edge - 16dp is the standard phone margin. Text that hugs the bezel looks cramped and is hard to read on curved-edge screens.",
          fix: { text: "Use one screen margin for the whole app (e.g. @dimen/screen_margin = 16dp) on the container, not on each view.", kind: "code", attr: "android:layout_marginStart", value: "16dp" },
        });
      }
    }
  }

  // ---- texts drawn over each other
  checkOverlaps(s, texts, phone) {
    const spans = texts.map((v) => ({ v, r: v.querySelector(".txt")?.getBoundingClientRect() })).filter((x) => x.r && x.r.width > 2);
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        const A = spans[i], B = spans[j];
        if (A.v.contains(B.v) || B.v.contains(A.v)) continue;
        const area = overlapArea(A.r, B.r);
        if (area > 0.2 * Math.min(A.r.width * A.r.height, B.r.width * B.r.height)) {
          this.issue(s, A.v, phone, {
            rule: "overlap", severity: "major", category: "layout", keyExtra: B.v.dataset.vid || j, more: [B.v],
            title: `Text overlaps other text: ${labelOf(A.v)} and ${labelOf(B.v)}`,
            why: "Two pieces of text are drawn on top of each other in the XML as written. Usually a missing constraint or a fixed size that doesn't fit the content.",
            fix: { text: "Chain the views (e.g. app:layout_constraintTop_toBottomOf) so they push each other instead of stacking, and avoid fixed heights on text.", kind: "code" },
          });
        }
      }
    }
  }

  // ---- empty / loading / error states (from the layout + what the code does)
  checkStates(s, phone, views) {
    const effects = [...s.handlers, ...s.auto].flatMap((h) => h.effects);
    const layoutText = views.map((v) => `${v.dataset.vid || ""} ${v.dataset.tag || ""}`).join(" ");
    const hasList = views.some((v) => /RecyclerView|ListView|GridView/.test(v.dataset.tag || ""));
    const listEl = views.find((v) => /RecyclerView|ListView|GridView/.test(v.dataset.tag || ""));
    if (hasList && !/empty|no_?items|no_?results|placeholder/i.test(layoutText)) {
      this.issue(s, listEl, phone, {
        rule: "no-empty-state", severity: "major", category: "states",
        title: "List with no empty state",
        why: "When this list has nothing in it, the user gets a blank area - no explanation, no next step. A blank screen reads as “broken”. Every list needs a designed empty state.",
        fix: { text: "Add an empty-state view next to the list (icon + one line of explanation + a primary action), shown when the adapter is empty.", kind: "state", state: "empty" },
      });
    }
    const async = effects.filter((e) => e.type === "api" && !/signs the user out|on the device|saved settings/i.test(e.text) && /Firebase|Firestore|network|Gemini|Signs in|Creates an account|Sends|Reads from|Saves to|Deletes/i.test(e.text));
    if (!async.length) return;
    const loading = effects.some((e) => e.type === "visibility" && /progress|loading|spinner|shimmer/i.test(e.text)) || /ProgressBar|progress|loading|shimmer/i.test(layoutText);
    const what = [...new Set(async.map((e) => e.text.replace(/\s*\(.*\)$/, "").toLowerCase()))].slice(0, 2).join(" and ");
    if (!loading) {
      this.issue(s, null, phone, {
        rule: "no-loading-state", severity: "major", category: "states", keyExtra: s.id,
        title: "Waits on the network with no loading state",
        why: `This screen ${what}, which can take seconds on mobile data. Nothing on screen changes meanwhile, so people tap again (sending duplicates) or assume the app froze.`,
        fix: { text: "Show progress where the action happened: disable the button and put a CircularProgressIndicator in it (or a LinearProgressIndicator at the top) until the result comes back.", kind: "state", state: "loading" },
      });
    }
    const failure = effects.some((e) => (e.cond || []).some((c) => /fail|not .*isSuccessful|cancel/i.test(c)));
    if (!failure) {
      this.issue(s, null, phone, {
        rule: "no-error-state", severity: "major", category: "states", keyExtra: s.id,
        title: "No error state when the request fails",
        why: `If ${what} fails (no signal, server down), the code has no failure branch - the user is left with nothing happening and no way to retry.`,
        fix: { text: "Handle the failure: show what went wrong in plain words, keep what the user typed, and offer Retry.", kind: "state", state: "error" },
      });
    } else {
      const toastOnly = effects.filter((e) => (e.cond || []).some((c) => /fail|not .*isSuccessful/i.test(c))).every((e) => e.type === "toast");
      if (toastOnly) {
        this.issue(s, null, phone, {
          rule: "toast-errors", severity: "minor", category: "states", keyExtra: s.id,
          title: "Errors only shown as a Toast",
          why: "A Toast disappears after ~2 seconds, can't be re-read, can't hold a Retry button, and is easy to miss entirely. Errors deserve a place on the screen.",
          fix: { text: "Show the error inline (a message near the form, or a Snackbar with a Retry action for transient failures).", kind: "state", state: "error" },
        });
      }
    }
    const validation = effects.some((e) => e.type === "toast" && (e.cond || []).some((c) => /isEmpty|isBlank|length/i.test(c)));
    if (validation) {
      this.issue(s, null, phone, {
        rule: "toast-validation", severity: "minor", category: "states", keyExtra: s.id,
        title: "Form validation by Toast",
        why: "“Please enter both email and password” in a Toast doesn't say which field is wrong and vanishes before people find it. Validation belongs on the field.",
        fix: { text: "Use TextInputLayout.setError(…) on the specific field, and move focus to it.", kind: "state", state: "field-error" },
      });
    }
  }

  // ---- copy: hard-coded strings, placeholders, vague labels, shouting
  checkCopy(s, texts, phone) {
    const hard = [];
    for (const v of texts) {
      const x = xmlAttrs(v);
      const t = x.text?.value;
      const shown = v.querySelector(".txt")?.textContent.trim() || "";
      if (t && !t.startsWith("@") && t.trim()) hard.push(v);
      if (shown && PLACEHOLDER_TEXT.test(shown) && !x.text?.value?.startsWith("@string")) {
        this.issue(s, v, phone, {
          rule: "placeholder-copy", severity: "major", category: "copy",
          title: `Placeholder text left in: “${shown}”`,
          why: "This reads like a default or dummy string. If it's replaced at runtime, use tools:text so it never ships; if not, it's unfinished UI.",
          fix: { text: "Write the real copy into strings.xml, or use tools:text for design-time-only text.", kind: "code", attr: "tools:text", value: "…" },
        });
      }
      if (v.classList.contains("v-button") || (isInteractive(v, this.wired) && v.classList.contains("v-text"))) {
        const label = shown.replace(/[!.]+$/, "");
        this.stats.caps.push({ text: shown, screen: s.id });
        if (VAGUE_LABELS.test(label)) {
          this.issue(s, v, phone, {
            rule: "vague-label", severity: "minor", category: "copy",
            title: `Vague button label “${shown}”`,
            why: "A label should say what happens - “Save changes”, “Send reset link”. Generic words force people to read everything around the button to guess.",
            fix: { text: "Use a verb + object that names the result.", kind: "code", attr: "android:text", value: "@string/…" },
          });
        }
        if (/!/.test(shown)) {
          this.issue(s, v, phone, {
            rule: "exclaim", severity: "minor", category: "copy",
            title: `Exclamation mark in a control: “${shown}”`,
            why: "Buttons and links are instructions, not celebrations. Exclamation marks in controls look amateurish and get tiring fast.",
            fix: { text: `Drop it: “${shown.replace(/!+/g, "")}”.`, kind: "code", attr: "android:text", value: shown.replace(/!+/g, "") },
          });
        }
      }
    }
    if (hard.length) {
      this.issue(s, hard[0], phone, {
        rule: "hardcoded-strings", severity: "minor", category: "copy", platforms: ["android"], keyExtra: "all", more: hard.slice(1),
        title: `${hard.length} hard-coded string${hard.length > 1 ? "s" : ""} in the layout`,
        why: "Text typed straight into the XML can't be translated, reused or reviewed in one place, and Lint flags every one. Copy belongs in strings.xml.",
        fix: { text: "Move each to strings.xml and reference it: android:text=\"@string/…\".", kind: "code", attr: "android:text", value: "@string/…" },
      });
    }
  }

  // ---------------------------------------------------------------- app-wide judgements
  appWide() {
    const app = { id: "__app", layout: null };
    const sizes = [...this.stats.fontSizes.keys()].sort((a, b) => a - b);
    if (sizes.length > 6) {
      this.issue(app, null, null, {
        rule: "type-scale", severity: "major", category: "typography", keyExtra: "app",
        title: `${sizes.length} different text sizes - there is no type scale`,
        why: `Text across the app uses ${sizes.map((x) => x + "sp").join(", ")}. A designed app uses 5-6 sizes from a scale, each with a job (title, body, label). This many means sizes were picked per view by eye.`,
        measured: { sizes },
        fix: { text: "Adopt a type scale and use textAppearance everywhere: e.g. Display 32 · Headline 24 · Title 20 · Body 16/14 · Label 12. Map every view to one of them.", kind: "scale", scale: [32, 24, 20, 16, 14, 12] },
      });
    }
    const colors = [...this.stats.colors.keys()];
    if (colors.length > 8) {
      this.issue(app, null, null, {
        rule: "palette-sprawl", severity: "major", category: "color", keyExtra: "app",
        title: `${colors.length} hard-coded colours outside the palette`,
        why: "Colours are typed into layouts instead of coming from tokens. This is how a brand slowly turns into a rainbow, and why dark mode becomes a rewrite.",
        measured: { colors },
        fix: { text: "Define roles in colors.xml / the theme (primary, onPrimary, surface, onSurface, outline, error…) and reference only those.", kind: "palette", colors },
      });
    }
    if (!this.dimens.length && this.stats.spacingRaw > 10) {
      this.issue(app, null, null, {
        rule: "no-spacing-tokens", severity: "major", category: "layout", platforms: ["android"], keyExtra: "app",
        title: `No spacing tokens - ${this.stats.spacingRaw} margins and paddings typed by hand`,
        why: "There is no dimens.xml, so every margin is a magic number. Consistent spacing is impossible to keep, and changing the rhythm means editing every file.",
        fix: { text: "Create res/values/dimens.xml with a scale (space_xs 4dp, space_s 8dp, space_m 16dp, space_l 24dp, space_xl 32dp) and use @dimen/… everywhere.", kind: "code" },
      });
    }
    const caseOf = (t) => (t === t.toUpperCase() && /[A-Z]/.test(t) ? "UPPER" : /^([A-Z][a-z']*\W*)+$/.test(t.replace(/[!?.]/g, "").trim()) && t.trim().split(/\s+/).length > 1 ? "Title Case" : "Sentence case");
    const styles = new Map();
    for (const c of this.stats.caps) if (c.text.trim().split(/\s+/).length > 1) {
      const k = caseOf(c.text);
      if (!styles.has(k)) styles.set(k, []);
      styles.get(k).push(c.text);
    }
    if (styles.size > 1) {
      this.issue(app, null, null, {
        rule: "caps-mix", severity: "minor", category: "copy", keyExtra: "app",
        title: `Buttons mix ${[...styles.keys()].join(", ")}`,
        why: `Pick one capitalisation for actions and stick to it. Right now: ${[...styles].map(([k, v]) => `${k} (“${v.slice(0, 2).join("”, “")}”)`).join("; ")}.`,
        fix: { text: "Use Sentence case for buttons (“Sign in”, “Forgot password?”) - it's the Material and Apple default and reads most naturally.", kind: "code" },
      });
    }
    return [...this.seen.values()];
  }
}
