/**
 * pi-char-thai — Thai input fixes for pi's editor.
 *
 * Installs a CustomEditor subclass through the official setEditorComponent
 * API. Fails closed: headless sessions and any pi whose editor no longer
 * exposes the methods the overrides adapt keep the stock editor, with one
 * notification and never a throw.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { missingEditorMethods, ThaiEditor } from './editor'

export default function charThai(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (!ctx.hasUI)
      return // RPC/print modes never construct an editor
    try {
      const missing = missingEditorMethods()
      if (missing.length > 0) {
        ctx.ui.notify(
          `pi-char-thai: incompatible pi editor shape (missing ${missing.join(', ')}) — keeping the stock editor`,
          'warning',
        )
        return
      }
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new ThaiEditor(tui, theme, keybindings))
    }
    catch (err) {
      // Never take down pi startup over an editor swap.
      try {
        ctx.ui.notify(`pi-char-thai: editor install failed (${String(err)}) — keeping the stock editor`, 'error')
      }
      catch {}
    }
  })
}
