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
 * Dialog for configuring Gemini API keys.
 * Two keys: free tier and paid tier.
 * Keys are masked once entered.
 */

import { useState, useEffect } from 'react'

function timingApi() {
  return (window as any).api?.timing
}

export function GeminiKeyDialog({ onClose }: { onClose: () => void }) {
  const [freeKey, setFreeKey] = useState('')
  const [paidKey, setPaidKey] = useState('')
  const [, setHasFreeKey] = useState(false)
  const [, setHasPaidKey] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    timingApi()?.getGeminiKey().then((res: any) => {
      if (res) {
        setHasFreeKey(res.hasFreeKey)
        setHasPaidKey(res.hasPaidKey)
        if (res.hasFreeKey) setFreeKey(res.freeKey) // masked: ***xxxx
        if (res.hasPaidKey) setPaidKey(res.paidKey)
      }
    })
  }, [])

  async function handleSave() {
    const api = timingApi()
    if (!api) return

    // Only send keys that were actually changed (not the masked ones)
    const newFree = freeKey.startsWith('***') ? null : freeKey
    const newPaid = paidKey.startsWith('***') ? null : paidKey

    await api.setGeminiKey(newFree, newPaid)
    setSaved(true)
    setTimeout(onClose, 1000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white border border-gray-400 shadow-xl w-[480px] text-xs">
        <div className="flex items-center justify-between bg-gray-700 text-white px-3 py-2">
          <span className="font-semibold">Clés API Gemini</span>
          <button onClick={onClose} className="hover:text-gray-300 text-lg leading-none">×</button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-gray-600 text-xs">
            Les clés API Gemini permettent la reconnaissance automatique des temps manuscrits.
            Obtenez vos clés sur <a href="https://aistudio.google.com/apikey" className="text-blue-600 underline">aistudio.google.com/apikey</a>
          </p>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Clé gratuite (free tier)
            </label>
            <input
              type="text"
              value={freeKey}
              onChange={(e) => { setFreeKey(e.target.value); setSaved(false) }}
              onFocus={() => { if (freeKey.startsWith('***')) setFreeKey('') }}
              placeholder="AIza..."
              className="w-full border border-gray-300 rounded px-2 py-1.5 font-mono text-xs"
            />
            <p className="text-gray-400 text-2xs mt-0.5">Utilisée en priorité. Limite: 15 req/min, 1500/jour</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">
              Clé payante (paid tier) — optionnelle
            </label>
            <input
              type="text"
              value={paidKey}
              onChange={(e) => { setPaidKey(e.target.value); setSaved(false) }}
              onFocus={() => { if (paidKey.startsWith('***')) setPaidKey('') }}
              placeholder="AIza..."
              className="w-full border border-gray-300 rounded px-2 py-1.5 font-mono text-xs"
            />
            <p className="text-gray-400 text-2xs mt-0.5">Utilisée automatiquement si la clé gratuite est limitée. ~$0.0001/scan</p>
          </div>

          {saved && (
            <div className="text-green-600 text-xs font-semibold">✓ Clés sauvegardées</div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <button
            onClick={onClose}
            className="px-4 py-1 border border-gray-400 bg-white hover:bg-gray-100 text-gray-700"
          >
            Annuler
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1 bg-blue-600 text-white hover:bg-blue-700 border border-blue-700"
          >
            Sauvegarder
          </button>
        </div>
      </div>
    </div>
  )
}
