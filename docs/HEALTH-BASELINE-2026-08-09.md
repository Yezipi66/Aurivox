# Aurivox UI Health Baseline — 2026-08-09

> Internal stabilization record. This is a health baseline, not a release declaration.

## Scope

Reading Proofing / Han character language hand-off in the Text preparation modal.

## Manually observed scenario

- Han language target: Chinese.
- Text contains `今日は Thank you`.
- Only `今` is explicitly assigned to Chinese in the Han character language picker.
- The upper Selected Han readings panel shows one Chinese position (`@0`) and allows editing its reading (`jin1`).
- The Auto Reading Proofing preview returns `今日` as a Japanese word token, but that token overlaps the explicitly selected Han position.

## Expected UI contract

1. The selected position remains visible and editable in the upper Han-reading panel.
2. The overlapping lower `今日` token is dimmed and its lower reading editor is inactive.
3. The lower token tells the user to adjust the reading above.
4. Unrelated automatic units remain available for review:
   - `は` remains a normal Japanese token.
   - `Thank` and `you` remain normal English tokens.
5. Final Preview shows the explicit/automatic split:
   - `今` → ZH
   - `日 は` → JA
   - `Thank you` → EN

## Why the whole lower token is dimmed

The preview endpoint exposes `今日` as one word-level Japanese token rather than two independent Han-character controls. When a word-level token partially overlaps a position-level Han override, the UI conservatively disables the whole lower token instead of allowing an edit that could affect the explicitly routed character. Finer per-character editing for partially overlapping word tokens is a separate future contract and is intentionally not part of this baseline.

## Evidence

- Manual UI evidence: user-provided Windows/NVIDIA workbench screenshot on 2026-08-09.
- Node regression suite: `92 pass / 0 fail / 21 skipped` in the current source snapshot. The skipped tests require backend Node dependencies that are not present in this workspace.
- Frontend production build: `vite build` succeeded.
- Python syntax compilation: passed; an existing `invalid escape sequence '\\W'` warning remains non-fatal.

## Baseline files

- `web/src/components/pron/PronProofing.jsx`
- `web/src/lib/pronTokenPositions.js`
- `web/src/lib/pronTokenPositions.node.test.js`
- `web/src/styles.css`
- `CHANGELOG.md`

## Release gate status

- No merge to `main`.
- No push.
- No release.
- No new formal `v1.0.8` tag.
- A Git commit must be made in the user's local repository after verifying the current `dev` / `main` / `origin/main` positions.
