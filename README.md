# Design Critic

### 👉 [**Open Design Critic**](https://yiftachneeman89.github.io/design-critic/) 👈

A strict design review of an Android app. Pick an Android Studio project folder: every screen is drawn exactly as its XML layout describes it, then checked against the rules real design and accessibility reviews use. It doesn't accept "it works" as good design.

## What it checks

- **Contrast**: every piece of text is measured against WCAG 2.2 AA (4.5:1, or 3:1 for large text), including hints. When no text colour can pass, it tells you to change the surface instead.
- **Touch targets**: anything tappable under 48×48dp (Android), 44pt (iOS), and 24px (WCAG 2.2) is flagged. The invisible inset around Material buttons is counted.
- **Typography**: text under 12sp, body text under 14sp, sizes in `dp`/`px` that ignore the user's font setting, cut-off text, long ALL CAPS, and the app-wide type scale.
- **Tokens**: hard-coded colours (and which `@color/` token they should be), colours that are *almost* a token, off-palette colours, spacing off the 4/8dp grid, and missing `dimens.xml` tokens.
- **States**: lists with no empty state, network work with no loading state, requests with no failure branch, errors and validation shown only as Toasts.
- **Accessibility and copy**: icon buttons without `contentDescription`, inputs without labels, hint-only labels, hard-coded strings, placeholder text, vague labels and mixed capitalisation.

## The review

- **Issue list**: each problem has a severity (blocker, major, minor), the screen it's on, a category and the platforms the guideline applies to.
- **On the screen**: the screen is drawn from its XML with the problem outlined. Tap targets show the 48dp area they should have.
- **Fixes**: each issue explains why it's a problem and proposes a fix (a token to use, a component to swap in, or a layout change). It shows a before/after preview and the XML now vs. fixed.
- **Status tracking**: open, in progress, fixed or won't fix, saved in your browser. Re-scan after changing the code: issues that are gone are marked fixed automatically, and "fixed" issues that are still there are re-opened. A history line shows progress over time.
- **Filters**: by screen, severity, category (accessibility, color, typography, layout, states, copy), platform (Android, iOS, web), status, or text search.
- **Score**: a grade out of 100. Won't-fix still counts against it, because bad design doesn't become good by agreeing to keep it. Any open blocker caps the grade at D.

Everything runs in your browser and nothing is uploaded. The screen drawing engine is shared with [Screen Map](https://github.com/yiftachneeman89/screen-map).
