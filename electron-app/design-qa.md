# Quick-note card design QA

Source visual truth: [selected third image](docs/quick-note-card/selected-reference.png).
Implementation: local app preview at http://127.0.0.1:5173/ using the same renderer as Electron; native window behavior verified separately in an isolated Electron run.
Viewport: 925 × 1071 CSS px; popup window 520 × 292 CSS px; visible card 508 × 280 CSS px.
State: light theme, 随手记 active, three recent notes, saved content matching the source.

## Comparison history

Initial evidence: [normalized full view](docs/quick-note-card/comparison-light.png), [enlarged typography/toolbar/footer](docs/quick-note-card/comparison-detail.png).
Source image: 1659 × 948 pixels, cropped to the card at (165, 115)–(1495, 832), then proportionally normalized to 508 pixels wide. Implementation: browser screenshot 925 × 1071 at density 1; cropped to the actual 508 × 280 card without stretching.

- [P2] Paragraph rhythm is too loose. The implementation uses 1.8 line height, making a blank line noticeably taller than in the source. Reduce the quick-note body line height to 1.4 and recapture.
- Fixed during implementation: toolbar icons initially inherited the workspace's unrelated `.quick-icon` rule and resolved relative asset URLs from the stylesheet. Scoped the class and resolved each official icon asset against the document URL. All eight toolbar icons now render.

Second comparison: [final full view](docs/quick-note-card/comparison-final.png), [final focused details](docs/quick-note-card/comparison-final-detail.png), [actual light card](docs/quick-note-card/implementation-light-final.png). The body now uses 1.4 line height and the accent caret. The two paragraphs match the source's compact rhythm. No actionable P0/P1/P2 differences remain. Only initial opening has a 100ms translation; note switching and state updates are immediate, without fading/replaying the entry animation.

## Required fidelity surfaces

- Typography: native system sans, 14px toolbar, 16px editable title, 14px body at 1.4 line height, 12px footer. Paragraph rhythm corrected and verified in the second comparison.
- Spacing/layout: one flat 2px-radius card, 34px toolbar, borderless editor, saved/complete row and 36px bottom strip. No sidebar, nested editor card or second navigation row.
- Colors: neutral white editor, cool gray toolbar/strip, warm amber active/action states; dark theme retained.
- Assets: official Phosphor regular SVGs with bundled MIT license; no generated raster assets are needed inside this UI.
- Copy: matches the selected mock; platform shortcut label adapts between Command and Control.

The source has no photo, illustration or decorative image. All required fidelity surfaces are visible in the normalized full comparison, and the enlarged comparison checks the typography, toolbar icons and bottom strip directly. The standard library's note-pencil icon replaces the mock's note-plus icon, and a faint active background communicates the selected function; these are accepted product affordances. The actual card is 508 × 280 CSS px versus the source's proportional 508 × 274 rendering, preserving system-size text and a practical minimum footer height.

## Behavior evidence

45 relevant unit tests passed; the 29 tests covering the final save/focus and IPC changes were rerun successfully. Isolated Electron end-to-end checks passed after the final native behavior changes: compact/expanded sizes, toolbar/menu, bottom tabs, sequential and rapid input, complete/reopen, keyboard shortcut, reload, same-title notes, flush before switching and quitting, no runtime exceptions or extra files.

Browser checks: creation, typing, switching among three notes, theme menu, complete and reopen all worked. Console inspection returned no warnings or errors. [Dark theme](docs/quick-note-card/implementation-dark.png) retains readable contrast. At 360 × 640 CSS px, the card is 348 × 280; every toolbar control, Complete and New remains within the viewport, with the history strip scrolling horizontally. The [narrow capture](docs/quick-note-card/preview-narrow.png) is letterboxed by the in-app browser; actual CSS geometry was checked separately. The temporary viewport override was reset before handoff.

Full repository suite: 590/591 passed. The existing `pkb-ui.test.js` metadata-preview fixture still fails because it does not provide `window.DMNoteDetails.model`; this predated the popup changes and does not affect the popup flow.

## Implementation checklist

- Completed paragraph/caret fix and post-fix comparison.
- Completed light/dark and narrow-window checks.
- Completed persistence and native popup interaction checks.

## Scope and follow-up

No open design questions or blocking visual findings. The browser preview uses local preview data. Source files are updated; the installed application has not been repackaged in this task.

Follow-up requested by the user: new notes now use a local-date title such as `随手记 2026-10-30` and an empty body. The instructional text is a native textarea placeholder, which disappears on input and never becomes saved content. Fresh browser preview data follows the same rule. The [updated empty-note screenshot](docs/quick-note-card/implementation-empty-dated.png) confirms the intended content change without changing the selected layout. New-note focus goes directly to the body.

Follow-up tab cleanup: title-and-body-empty drafts are omitted from the bottom switcher, which removes the preview's blank “未命名便签” option without deleting note data. The history strip retains horizontal navigation for larger collections but no longer displays a scrollbar. Clicking “临时想法” was rechecked: the three remaining tabs have 464px content width within a 464px strip, with `scrollbar-width: none`. See [updated tabs](docs/quick-note-card/implementation-clean-tabs.png).

Current category behavior supersedes the earlier recent-note strip: the footer now has exactly three fixed type buttons, “随手记 / 会议要点 / 临时想法”. Titles remain editable above and never replace footer labels. All three buttons share the available width with no scrolling. New notes are saved under the configured quick-note root in a same-named type folder; type is derived from the folder when reloaded. Existing root files stay readable and move into their type folder on edit, retaining identity and decorations. Exact legacy category-label filenames retain their intended type; folder membership takes precedence after classification. PKB initialization detects category subfolders so it cannot orphan an existing categorized vault.

Updated evidence: [fixed category footer](docs/quick-note-card/implementation-note-types.png). Browser checks confirmed all three types reopen their own content, fixed labels, equal content/client widths (464px) and no console warnings/errors. Native end-to-end checks passed for three separate on-disk folders, type-specific date titles, placeholders, title changes without category changes, repeat switching without duplicate drafts, multiple notes in one type, search of older notes, reload, compact layout and quit flush. 58 focused tests passed. The most recent full-suite run passed 593/594; its only failure remains the existing metadata-preview fixture described above. One additional legacy-category regression passed in the focused run after that full run.

Release follow-up (v3.16.1, 2026-10-30): the metadata-preview fixture now supplies its real model dependency; all 595 unit tests pass. Source quick-note and notes-home end-to-end checks pass. Packaged Mac arm64 quick-note, notes-home/details/appearance and independent Markdown editor checks all pass. The first sidebar drag test needed the initial pointer move and explicit button state to make its synthetic drag deterministic; the product resize implementation was unchanged. See `../docs/releases/v3.16.1-verification.md` for release verification and platform limits.

final result: passed
