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
