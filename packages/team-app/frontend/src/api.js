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

const API = '/api'

function headers(extra = {}) {
  const pin = localStorage.getItem('pin') || ''
  return { 'X-Club-Pin': pin, ...extra }
}

const api = {
  async get(path) {
    const res = await fetch(`${API}${path}`, { headers: headers() })
    if (!res.ok) {
      const err = new Error(`${res.status}`)
      try { err.detail = (await res.json()).detail } catch {}
      throw err
    }
    return { data: await res.json() }
  },
  async post(path, body) {
    const isFormData = body instanceof FormData
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: isFormData ? headers() : headers({ 'Content-Type': 'application/json' }),
      body: isFormData ? body : JSON.stringify(body),
    })
    if (!res.ok) {
      const err = new Error(`${res.status}`)
      try { err.detail = (await res.json()).detail } catch {}
      throw err
    }
    return { data: await res.json() }
  },
  async delete(path) {
    const res = await fetch(`${API}${path}`, { method: 'DELETE', headers: headers() })
    if (!res.ok) throw new Error(`${res.status}`)
    return { data: await res.json() }
  },
  async put(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return { data: await res.json() }
  },
}

export default api