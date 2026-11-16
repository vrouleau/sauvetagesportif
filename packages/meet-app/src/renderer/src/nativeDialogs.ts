// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
//
// This file is part of Sauvetage Sportif.
//
// Sauvetage Sportif is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Sauvetage Sportif is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

/**
 * Replaces window.alert/confirm with main-process message boxes that hand
 * keyboard focus back to the page when they close.
 *
 * Electron on Windows: after a renderer-side alert()/confirm() the page loses
 * keyboard focus while the window still looks active — fields ignore input
 * until the user switches to another window and back. Overriding the globals
 * here fixes every existing call site (shared-ui included) without touching
 * them. See 'dialog:*-sync' in main/index.ts.
 */

type Lang = 'fr' | 'en'
let dialogLang: Lang = 'fr'

/** Keep confirm()'s button labels in the current UI language. */
export function setDialogLang(lang: Lang): void {
  dialogLang = lang
}

const LABELS: Record<Lang, { ok: string; cancel: string }> = {
  fr: { ok: 'OK', cancel: 'Annuler' },
  en: { ok: 'OK', cancel: 'Cancel' },
}

export function installNativeDialogs(): void {
  const dialogs = (window as any).api?.dialogs
  if (!dialogs) return // not running under Electron (e.g. tests) — keep the browser's own
  window.alert = (message?: unknown): void => {
    dialogs.alert(message === undefined ? '' : String(message))
  }
  window.confirm = (message?: string): boolean => {
    const l = LABELS[dialogLang]
    return !!dialogs.confirm(message ?? '', l.ok, l.cancel)
  }
}
