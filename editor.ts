/**
 * ThaiEditor: pi's CustomEditor, Thai-aware.
 *
 * Vertical movement. pi-tui stores `state.cursorCol` as a UTF-16
 * code-unit offset but its vertical-move math treats that offset as a terminal
 * cell column (editor.js:1167-1246, :1460-1483). Every Thai combining mark,
 * CJK char and emoji therefore drifts the cursor sideways on ArrowUp/Down.
 * The three methods below re-do that arithmetic in cells, converting back to a
 * UTF-16 grapheme boundary before touching `state.cursorCol`.
 *
 * Ticket 09 — Backspace. Stock `handleBackspace` deletes a whole grapheme, so
 * one press wipes an entire Thai syllable (`น้ำ` is one grapheme). The override
 * peels Thai combining-mark clusters code point by code point and leaves every
 * other cluster — emoji ZWJ, CJK, Latin — atomic. One exception: ำ is a single
 * peel step — one press removes the whole vowel, both the dot and า, whether
 * the text holds composed U+0E33 or the decomposed ํ+า pair.
 */

import type { EditorConstructor } from './editor-chain'
import { CustomEditor } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'

/** Stock pi-tui visual line, plus the cell width this extension needs. */
interface VisualLine {
  logicalLine: number
  /** UTF-16 offset of this segment in its logical line. */
  startCol: number
  /** UTF-16 length of this segment — kept for stock slicing/lookup. */
  length: number
  /** Terminal cells the segment occupies. Added here; stock code ignores it. */
  cells: number
}

/** The slice of pi-tui's private editor state the overrides read and write. */
interface EditorState {
  lines: string[]
  cursorLine: number
  cursorCol: number
}

/**
 * Thai combining marks: สระบน/ล่าง, วรรณยุกต์, ไม้หันอากาศ, ์, ํ, ฺ. A grapheme
 * holding one of these is a Thai syllable cluster the user expects to peel
 * mark-by-mark. U+0E33 (ำ) is the composed form of ํ + า and is not itself a
 * combining mark, but a cluster ending in it must peel too — otherwise a bare
 * composed cluster like `อำ` would fall to stock and lose its base consonant
 * together with the vowel (spec.md "Backspace: Thai cluster peel", step 4).
 */
const THAI_COMBINING = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/

function isThaiPeelable(cluster: string): boolean {
  return THAI_COMBINING.test(cluster) || cluster.endsWith('\u0E33')
}

/**
 * pi-tui `Editor` internals the Backspace override reuses. They are TS-private
 * but ordinary runtime members (verified on pinned 0.84.3 and host pi 0.85.1);
 * this named shape keeps the access checked instead of spraying `any`.
 */
interface EditorInternals {
  state: EditorState
  lastAction: unknown
  onChange?: (text: string) => void
  autocompleteState: unknown
  autocompleteTriggerPattern: RegExp
  segment: (text: string, granularity: 'grapheme') => Intl.Segments
  exitHistoryBrowsing: () => void
  pushUndoSnapshot: () => void
  setCursorCol: (col: number) => void
  updateAutocomplete: () => void
  tryTriggerAutocomplete: () => void
  isInSlashCommandContext: (textBeforeCursor: string) => boolean
  getText: () => string
}

/**
 * Class factory: builds ThaiEditor on top of `Base` — CustomEditor standalone,
 * or another extension's editor class when composed through
 * chainEditorComponent (editor-chain.ts). pi keeps only ONE editor factory
 * (setEditorComponent replaces wholesale), so editor-installing extensions
 * must stack their classes instead of replacing each other.
 */
export function makeThaiEditorClass(Base: EditorConstructor = CustomEditor): EditorConstructor {
  // @ts-expect-error TS2415 — the three vertical-move methods are TS-private on
  // pi-tui's `Editor`, so TS rejects any redeclaration; at runtime they are plain
  // prototype methods and this subclass overrides them normally (verified on
  // pinned 0.84.3 and host pi 0.85.1, ticket 02 Q4). The factory shape-checks the
  // names before installing this editor.
  return class ThaiEditor extends Base {
  /**
   * Stock map plus each segment's cell width, so the movement math never has
   * to re-derive it. `length` stays UTF-16 — inherited `findVisualLineAt`,
   * `render` and friends still index with code units.
   */
    private buildVisualLineMap(width: number): VisualLine[] {
    // @ts-expect-error — see above: private-in-TS, overridable at runtime.
      const visualLines = super.buildVisualLineMap(width) as Omit<VisualLine, 'cells'>[]
      // @ts-expect-error — `state` is private (and untyped) on pi-tui's Editor.
      const lines = (this.state as EditorState).lines
      return visualLines.map(vl => ({
        ...vl,
        cells: visibleWidth((lines[vl.logicalLine] || '').slice(vl.startCol, vl.startCol + vl.length)),
      }))
    }

    /**
     * Sticky-column decision table, unchanged. The arithmetic is unit-agnostic,
     * so the single change is the unit its caller feeds it: terminal cells, not
     * code units — which also makes the sticky `preferredVisualCol` a cell count.
     * Overridden (rather than called through `super` at the one call site) to pin
     * that unit contract in one documented place.
     */
    private computeVerticalMoveColumn(currentVisualCell: number, sourceMaxCell: number, targetMaxCell: number): number {
    // @ts-expect-error — private-in-TS, real prototype method at runtime.
      return super.computeVerticalMoveColumn(currentVisualCell, sourceMaxCell, targetMaxCell) as number
    }

    /**
     * Stock `moveToVisualLine` with every visual column expressed in terminal
     * cells. Positions (`startCol`, `cursorCol`, paste-marker snapping) stay
     * UTF-16 throughout; only the columns handed to the sticky-column logic —
     * and the value converted back at the end — are cells.
     */
    /** Recursion below re-enters this override, as upstream's does. */
    private moveToVisualLine(visualLines: VisualLine[], currentVisualLine: number, targetVisualLine: number): void {
      const currentVL = visualLines[currentVisualLine]
      const targetVL = visualLines[targetVisualLine]
      if (!(currentVL && targetVL))
        return
      // @ts-expect-error — `state` is private (and untyped) on pi-tui's Editor.
      const state = this.state as EditorState
      // @ts-expect-error — private field, set by stock code on snap.
      const snappedFrom = this.snappedFromCursorCol as number | null

      // When the cursor was snapped to a segment start, resolve the pre-snap
      // position against the VL it belongs to (stock behavior), then measure
      // that offset in cells.
      let currentVisualCell: number
      if (snappedFrom !== null) {
      // @ts-expect-error — private method on pi-tui's Editor, verified at runtime.
        const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, snappedFrom) as number
        const vl = visualLines[vlIndex]!
        currentVisualCell = visibleWidth((state.lines[vl.logicalLine] || '').slice(vl.startCol, snappedFrom))
      }
      else {
        currentVisualCell = visibleWidth(
          (state.lines[currentVL.logicalLine] || '').slice(currentVL.startCol, state.cursorCol),
        )
      }

      // For non-last segments, clamp inside the segment (stock: length - 1;
      // a cell short of the segment end, which the grapheme walk below floors
      // to the boundary before a wide trailing cluster).
      const isLastSourceSegment
        = currentVisualLine === visualLines.length - 1
          || visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine
      const sourceMaxCell = isLastSourceSegment ? currentVL.cells : Math.max(0, currentVL.cells - 1)
      const isLastTargetSegment
        = targetVisualLine === visualLines.length - 1
          || visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine
      const targetMaxCell = isLastTargetSegment ? targetVL.cells : Math.max(0, targetVL.cells - 1)

      const moveToCell = this.computeVerticalMoveColumn(currentVisualCell, sourceMaxCell, targetMaxCell)

      state.cursorLine = targetVL.logicalLine
      const logicalLine = state.lines[targetVL.logicalLine] || ''
      // Paste-marker-aware segmentation: markers are one atomic "grapheme".
      // @ts-expect-error — private method on pi-tui's Editor, verified at runtime.
      const segments = [...this.segment(logicalLine, 'grapheme')] as Intl.SegmentData[]

      // Cells -> UTF-16: walk graphemes from the segment start, stopping at the
      // last boundary that still fits in `moveToCell` cells. The cursor therefore
      // never lands inside a grapheme or a paste marker.
      let targetCol = Math.min(targetVL.startCol, logicalLine.length)
      let usedCells = 0
      for (const seg of segments) {
        if (seg.index < targetVL.startCol)
          continue
        const cells = visibleWidth(seg.segment)
        if (usedCells + cells > moveToCell)
          break
        usedCells += cells
        targetCol = seg.index + seg.segment.length
      }
      state.cursorCol = Math.min(targetCol, logicalLine.length)

      // Stock snapping: land on the start of an atomic multi-grapheme segment
      // (paste markers) rather than inside it. Pure UTF-16 arithmetic, copied.
      for (const seg of segments) {
        if (seg.index > state.cursorCol)
          break
        if (seg.segment.length <= 1)
          continue
        if (state.cursorCol < seg.index + seg.segment.length) {
          const isContinuation = seg.index < targetVL.startCol
          const isMovingDown = targetVisualLine > currentVisualLine
          if (isContinuation && isMovingDown) {
          // The segment started on a previous visual line and we already
          // visited it on the way down: skip its continuation VLs.
            const segEnd = seg.index + seg.segment.length
            let next = targetVisualLine + 1
            while (
              next < visualLines.length
              && visualLines[next]!.logicalLine === targetVL.logicalLine
              && visualLines[next]!.startCol < segEnd
            ) {
              next++
            }
            if (next < visualLines.length) {
              this.moveToVisualLine(visualLines, currentVisualLine, next)
              return
            }
          }
          // Snap to the segment start, remembering the pre-snap position so the
          // next vertical move can resolve it to the right visual column.
          // @ts-expect-error — private field on pi-tui's Editor.
          this.snappedFromCursorCol = state.cursorCol
          state.cursorCol = seg.index
          return
        }
      }
      // @ts-expect-error — private field on pi-tui's Editor.
      this.snappedFromCursorCol = null
    }

    /**
     * Thai cluster peel. Non-Thai clusters (and column 0, i.e. the line merge)
     * fall straight through to stock `handleBackspace`; only the Thai branch is
     * re-implemented, and it mirrors stock control flow exactly: history exit,
     * undo snapshot, edit, `setCursorCol`, `onChange`, autocomplete retrigger.
     * Paste markers never match `isThaiPeelable`, so their stock renumbering
     * bookkeeping stays in stock hands.
     */
    private handleBackspace(): void {
      const self = this as unknown as EditorInternals
      const state = self.state
      const line = state.lines[state.cursorLine] || ''
      const beforeCursor = line.slice(0, state.cursorCol)

      // ำ is one peel step: one press removes the dot and า together. Typed
      // input arrives decomposed as ํ+า (macOS keyboard order, ticket 01) or
      // า+ํ (canonical order); both display as ำ, so a tail pair in either
      // order goes together. Detect it on raw code points, before grapheme
      // inspection: in the macOS order า is its own grapheme and would
      // otherwise fall through to stock single-cell deletion. Spread iterates
      // code points, so `tail`/`prev` stay whole even across a surrogate pair.
      const codePoints = [...beforeCursor]
      const tail = codePoints[codePoints.length - 1]
      const prev = codePoints[codePoints.length - 2]
      const isAmPair
        = (tail === '\u0E32' && prev === '\u0E4D')
          || (tail === '\u0E4D' && prev === '\u0E32')

      const graphemes = [...self.segment(beforeCursor, 'grapheme')]
      const cluster = graphemes[graphemes.length - 1]?.segment
      if (state.cursorCol === 0 || (!isAmPair && (!cluster || !isThaiPeelable(cluster)))) {
      // @ts-expect-error — private-in-TS, real prototype method at runtime.
        super.handleBackspace()
        return
      }

      self.exitHistoryBrowsing()
      self.lastAction = null
      self.pushUndoSnapshot()

      // Composed U+0E33 is one code point, so removing `tail` removes the whole
      // vowel; the decomposed pair removes both code points at once.
      const removed = isAmPair ? prev!.length + tail!.length : tail!.length
      const head = beforeCursor.slice(0, beforeCursor.length - removed)
      state.lines[state.cursorLine] = head + line.slice(state.cursorCol)
      self.setCursorCol(head.length)

      // Stock tail, copied verbatim (editor.js:1132-1150).
      if (self.onChange)
        self.onChange(self.getText())
      if (self.autocompleteState) {
        self.updateAutocomplete()
      }
      else {
        const currentLine = state.lines[state.cursorLine] || ''
        const textBeforeCursor = currentLine.slice(0, state.cursorCol)
        if (self.isInSlashCommandContext(textBeforeCursor) || self.autocompleteTriggerPattern.test(textBeforeCursor)) {
          self.tryTriggerAutocomplete()
        }
      }
    }
  }
}

/** Standalone class (CustomEditor base) — kept for direct construction. */
export const ThaiEditor = makeThaiEditorClass()

/**
 * Methods the overrides adapt. They are TS-private but real prototype methods
 * at runtime (verified on pinned 0.84.3 and host pi 0.85.1), living on the
 * pi-tui `Editor` ancestor of `CustomEditor`. If a pi upgrade renames or drops
 * one, the copied arithmetic would silently diverge — so the factory
 * shape-checks them and keeps the stock editor instead.
 */
export const REQUIRED_EDITOR_METHODS = [
  'moveToVisualLine',
  'computeVerticalMoveColumn',
  'buildVisualLineMap',
  'handleBackspace',
] as const

/** Read-only prototype-chain check: every required method is callable. */
export function missingEditorMethods(proto: object = CustomEditor.prototype): string[] {
  return REQUIRED_EDITOR_METHODS.filter(
    // Walks the whole chain: the methods sit on the pi-tui Editor ancestor,
    // not on CustomEditor.prototype itself.
    name => typeof (proto as Record<string, unknown>)[name] !== 'function',
  )
}
