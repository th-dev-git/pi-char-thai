# pi-char-thai

`pi-char-thai` fixes Thai text input in Pi's editor: vertical cursor drift on wrapped lines and Backspace that deletes combining marks ( Sara Am, tone marks, above/below vowels ) one at a time instead of swallowing the whole base character. It installs a custom editor subclass through Pi's official extension API — no core patch.

## Install

```bash
pi install npm:pi-char-thai
```

That is the only required step. Pi loads the TypeScript extension directly; there is no build step and no Pi core patch.

## Try this first

Open Pi and type Thai text with combining characters:

```text
ทดสอบภาษาไทย กํา น้ำ ที่
```

Then:

1. Wrap a long Thai line and move the cursor up/down — the cursor lands on the same visual column instead of drifting.
2. Press `Backspace` on `กํา` or `น้ำ` — the combining marks peel off one step at a time and `ำ` (dot plus า) vanishes in a single press (`กํา` → `ก`, `น้ำ` → `น้`), the base character stays until the next press.

## How it works

Pi's native editor measures lines and deletes by code unit assumptions that break on Thai grapheme clusters. This extension keeps Pi core untouched and changes behavior at the extension boundary:

- A `ThaiEditor` subclass of `CustomEditor` is registered via `setEditorComponent` on `session_start`.
- Vertical movement uses a grapheme-aware visual line map, so up/down across wrapped Thai lines keeps the visual column.
- Backspace peels Thai combining marks off the cluster before deleting the base character, using `Intl.Segmenter` grapheme segmentation. Sara Am (`ำ`) is one peel step: composed U+0E33 deletes whole, and a decomposed ํ+า pair (either order) deletes together, so the dot never lingers.
- Fail-closed: headless sessions, or any Pi whose editor no longer exposes the methods the overrides adapt, keep the stock editor with one warning and never a throw.

At every other input path, Pi's native editing behavior stays unchanged.

## Implementation map

| File        | Responsibility                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | Extension entry point. Registers the custom editor via `setEditorComponent`; guards headless sessions and incompatible editor shapes. |
| `editor.ts` | `ThaiEditor`; grapheme-aware visual line map, vertical move column computation, Thai combining-mark Backspace, required-method probe. |

## Test

Tests live in the parent `pi-extensions` repo:

```bash
bun test tests/pi-char-thai.test.ts   # unit
bun run test:integration              # headless Pi
```

Manual check: open Pi, type `กําน้ำ`, press `Backspace` — one press removes all of `ำ`, further presses peel the tone mark and then the base character.

## Compatibility and risks

The editor overrides TypeScript-private methods. A Pi upgrade can break them — the extension detects the mismatch at startup and falls back to the stock editor instead of throwing.

Confirmed against:

- Pi `0.85.1` Homebrew runtime
- Pi `0.84.3` pinned types

Fallback: patch Pi core TUI `editor.js` to segment graphemes for vertical movement and Backspace.

## Repository

<https://github.com/th-dev-git/pi-char-thai>
