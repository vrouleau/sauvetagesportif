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

import { useState } from 'react'
import { useLang } from '../i18n'
import { headers } from '../api'

const STORE = 'qbExportOptions'
const DEFAULTS = { item_name: "Frais d'inscription", tax_code: 'Exempt', due_days: 30 }

// Per-viewer convenience only: the page works the same when storage is blocked.
function loadOptions() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') } } catch { return { ...DEFAULTS } }
}
function saveOptions(o) {
  try { localStorage.setItem(STORE, JSON.stringify(o)) } catch { /* ignore */ }
}

// "Export for QuickBooks": a ZIP of CSV files (customers + invoices) that
// QuickBooks Online imports under Settings > Import data. The three fields are
// what the importing company must match: the product/service every line is
// booked against, its exempt tax code (exact name) and the payment delay.
export default function QuickBooksExport({ clubIds, onMessage }) {
  const { t, lang } = useLang()
  const [open, setOpen] = useState(false)
  const [opts, setOpts] = useState(loadOptions)
  const [busy, setBusy] = useState(false)

  const set = (k, v) => setOpts(o => ({ ...o, [k]: v }))

  async function run() {
    saveOptions(opts)
    setBusy(true)
    onMessage(t.qbx_generating, false)
    try {
      const res = await fetch('/api/invoices/quickbooks-export', {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ club_ids: clubIds.map(Number), lang, ...opts, due_days: Number(opts.due_days) || 0 }),
      })
      if (!res.ok) {
        let detail = `${res.status}`
        try { detail = (await res.json()).detail || detail } catch { /* not JSON */ }
        throw new Error(detail)
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url; a.download = 'quickbooks-import.zip'; a.click()
      URL.revokeObjectURL(url)
      onMessage(t.qbx_done, false)
      setOpen(false)
    } catch (e) { onMessage(e.message || 'Error', true) } finally { setBusy(false) }
  }

  const field = (k, label, props = {}) => (
    <label className="flex flex-col gap-0.5 text-xs text-gray-600">
      {label}
      <input value={opts[k]} onChange={e => set(k, e.target.value)}
        className="border border-gray-300 rounded px-2 py-1 text-xs" {...props} />
    </label>
  )

  return (
    <span className="relative inline-flex flex-col">
      <button onClick={() => setOpen(o => !o)} disabled={!clubIds.length}
        className="text-white px-3 py-1 rounded text-xs disabled:opacity-50 bg-purple-600 hover:bg-purple-700">
        {t.qbx_btn} {clubIds.length > 0 && `(${clubIds.length})`}
      </button>
      {open && (
        <div className="absolute z-20 mt-8 bg-white border border-gray-300 rounded shadow-lg p-3 flex flex-col gap-2 w-80">
          <div className="text-xs text-gray-500">{t.qbx_help}</div>
          {field('item_name', t.qbx_item)}
          {field('tax_code', t.qbx_tax_code)}
          {field('due_days', t.qbx_due_days, { type: 'number', min: 0, max: 365 })}
          <div className="flex gap-2">
            <button onClick={run} disabled={busy}
              className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50">{t.qbx_export}</button>
            <button onClick={() => setOpen(false)} className="px-3 py-1 bg-gray-200 text-xs rounded hover:bg-gray-300">{t.qbx_close}</button>
          </div>
        </div>
      )}
    </span>
  )
}
