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
 * In-page DSQ toast notification with alert sound.
 *
 * Shown when a DSQ result arrives via WebSocket for the subscribed team.
 * This works even without push notification permission (in-page only).
 */
import { useState, useEffect, useCallback, useRef } from 'react'

// Generate a short alert beep using Web Audio API
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.connect(gain)
    gain.connect(ctx.destination)

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, ctx.currentTime) // A5
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5)

    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + 0.5)

    // Second beep
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.connect(gain2)
    gain2.connect(ctx.destination)
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.6)
    gain2.gain.setValueAtTime(0.3, ctx.currentTime + 0.6)
    gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.1)
    osc2.start(ctx.currentTime + 0.6)
    osc2.stop(ctx.currentTime + 1.1)
  } catch {
    // Audio not available — silent fallback
  }
}

export default function DsqToast({ dsqAlerts, onDismiss }) {
  if (!dsqAlerts || dsqAlerts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {dsqAlerts.map((alert, idx) => (
        <div
          key={alert.id || idx}
          className="bg-red-600 text-white rounded-lg shadow-lg p-3 animate-slide-in flex items-start gap-2"
        >
          <span className="text-lg">⚠️</span>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-sm">DSQ</p>
            <p className="text-sm truncate">{alert.athlete_name}</p>
            {alert.dsq_reason && (
              <p className="text-xs opacity-80 mt-0.5">{alert.dsq_reason}</p>
            )}
          </div>
          <button
            onClick={() => onDismiss(alert.id || idx)}
            className="text-white/70 hover:text-white text-lg leading-none"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * Hook to manage DSQ toast alerts.
 * Filters incoming results for DSQs matching the subscribed club.
 */
export function useDsqAlerts(subscribedClubName) {
  const [alerts, setAlerts] = useState([])
  const nextId = useRef(0)

  const addAlert = useCallback((dsqResult) => {
    const id = nextId.current++
    setAlerts((prev) => [...prev, { ...dsqResult, id }])
    playAlertSound()

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      setAlerts((prev) => prev.filter((a) => a.id !== id))
    }, 10000)
  }, [])

  const dismissAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // Process incoming results for DSQs matching the subscribed club
  const processResults = useCallback((results) => {
    if (!subscribedClubName) return
    for (const r of results) {
      if (r.status === 'DSQ' && r.club_name === subscribedClubName) {
        addAlert(r)
      }
    }
  }, [subscribedClubName, addAlert])

  return { alerts, dismissAlert, processResults }
}