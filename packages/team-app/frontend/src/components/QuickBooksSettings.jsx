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

import { useState, useEffect } from 'react'
import { useLang } from '../i18n'
import api from '../api'

// Which tax code, income account and item this club's QuickBooks invoices use.
// The choices are read from the club's own QuickBooks company (never typed),
// so a name that doesn't exist there can't be saved. Shown to the organizer
// club once its QuickBooks is connected; the choice is remembered for every
// later meet.
export default function QuickBooksSettings({ settings, onSaved }) {
  const { t } = useLang()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState(null)
  const [values, setValues] = useState({ tax_code: '', income_account: '', item_name: '' })
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => { setValues({ tax_code: '', income_account: '', item_name: '', ...settings }) }, [settings])

  async function toggle() {
    if (open) { setOpen(false); return }
    setError(''); setSaved(false)
    try {
      const r = await api.get('/invoice-provider/settings/options')
      setOptions(r.data)
      setOpen(true)
    } catch (e) { setError(e.detail || e.message || 'Error') }
  }

  async function save() {
    setError(''); setSaved(false)
    try {
      const r = await api.put('/invoice-provider/settings', values)
      setSaved(true)
      onSaved?.(r.data)
    } catch (e) { setError(e.detail || e.message || 'Error') }
  }

  const complete = !!(settings?.tax_code && (settings?.item_name || settings?.income_account))

  const select = (field, label, list, { blank, extra } = {}) => (
    <label className="flex flex-col gap-0.5 text-xs text-gray-600">
      {label}
      <select value={values[field]} onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))}
        className="border border-gray-300 rounded px-2 py-1 text-xs min-w-48">
        <option value="">{blank}</option>
        {[...(extra || []), ...list].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  )

  return (
    <span className="relative inline-flex flex-col">
      <button onClick={toggle}
        className={`px-3 py-1 text-white text-xs rounded ${complete ? 'bg-gray-600 hover:bg-gray-700' : 'bg-amber-600 hover:bg-amber-700'}`}>
        {t.qbo_settings_btn}{complete ? '' : ' ⚠'}
      </button>
      {error && !open && <span className="text-xs text-red-600 mt-1">{error}</span>}
      {open && options && (
        <div className="absolute z-20 mt-8 bg-white border border-gray-300 rounded shadow-lg p-3 flex flex-col gap-2 w-80">
          <div className="text-xs text-gray-500">{t.qbo_settings_help}</div>
          {select('tax_code', t.qbo_tax_code, options.tax_codes,
            { blank: t.qbo_choose, extra: ['none'] })}
          {select('income_account', t.qbo_income_account, options.income_accounts, { blank: t.qbo_choose })}
          {select('item_name', t.qbo_item, options.items, { blank: t.qbo_item_default })}
          {error && <div className="text-xs text-red-600">{error}</div>}
          {saved && <div className="text-xs text-green-700">{t.qbo_saved}</div>}
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700">{t.qbo_save}</button>
            <button onClick={() => setOpen(false)} className="px-3 py-1 bg-gray-200 text-xs rounded hover:bg-gray-300">{t.qbo_close}</button>
          </div>
        </div>
      )}
    </span>
  )
}
