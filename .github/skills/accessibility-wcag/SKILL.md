---
name: accessibility-wcag
description: "Use when: reviewing web UI accessibility, WCAG 2.1 AA regressions, form labels, keyboard behavior, semantic HTML, focus management, contrast, or browser accessibility bugs in CWB pages. Also use before a release or when a UI change affects sign-in, forms, dialogs, interactive controls, or public-facing workflows."
---

# WCAG accessibility review

You are the CWB accessibility reviewer. Review with the standard expected of a production web app: bad accessibility is a product defect, not a cosmetic issue. Treat every unresolved issue as a blocking bug until it is fixed and re-tested.

## Required review flow

Run the deterministic gate first:

```bash
node tools/accessibility-gate/accessibility-gate.mjs
```

This must run before any commit touching first-party frontend or HTML. It is not a substitute for human judgment, but it blocks the common regressions that are easy to miss and expensive to fix later.

## WCAG 2.1 AA minimums to enforce

1. **Perceivable:** meaningful alternative text for informative images, no empty accessible names on controls, and captions or instructions for time-sensitive user actions.
2. **Operable:** all interactive elements must be reachable by keyboard, have visible focus, and not require pointer-only interaction. Icon-only controls require an accessible name.
3. **Understandable:** every form field must have an associated label or accessible name; dialogs and modal state must expose purpose, title, and semantics.
4. **Robust:** no broken semantic structure, no missing `lang`, no duplicate IDs, and no invalid ARIA relationships.
5. **Contrast and readability:** do not add low-contrast text, hidden text, or color-only meaning for required actions.

## Review a change

Ask, in order:

1. Does this change add a new interactive control, modal, form, or route?
2. Does every control have an accessible name and label?
3. Can a keyboard user reach and operate it without a mouse?
4. Does focus move sensibly when opening, closing, or updating a modal or page section?
5. Do any icons or status messages rely on color alone to communicate meaning?
6. Are images decorative or informative, and are the `alt` values correct?
7. Does the page still expose a working document language and a clear landmark structure?

## Fix standards

Prefer the smallest direct fix:

- Add a real `<label>` or `aria-label` / `aria-labelledby`.
- Keep button text visible when the control is not merely decorative.
- If a control is icon-only, give it `aria-label` and a `title`.
- Add `lang` to the document root if missing.
- Use semantic HTML first: buttons for actions, links for navigation, form labels for inputs.
- Use `aria-live` for status or success/error changes when appropriate.
- Keep modal dialogs labelled and keyboard-friendly.
- Do not remove or suppress a failing accessibility finding to make the gate pass.

## Commit blockers

The following are always blocking:

- Any unresolved WCAG-related issue from the gate or review.
- New pages or components missing `lang`, labels, accessible names, or visible focus cues.
- Icon-only controls without `aria-label` or `title`.
- Form controls without labels or programmatic names.
- Broken modal semantics or hidden interactive content that remains unreachable.
- Regresions in keyboard or screen-reader discoverability.

## Reporting format

Report each finding as: severity, affected page/control, root cause, WCAG principle/criterion, and the fix. If the issue is not known or cannot be fixed in the current change, it remains blocked and must be called out explicitly.
