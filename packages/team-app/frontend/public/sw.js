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
 * Service Worker for DSQ push notifications.
 *
 * Receives push events from the server and displays notifications
 * even when the browser tab is closed or in the background.
 */

/* eslint-disable no-restricted-globals */

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    payload = { title: 'DSQ', body: event.data.text() }
  }

  const options = {
    body: payload.body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    tag: payload.tag || 'notification',
    renotify: true,
    vibrate: [200, 100, 200],
    data: payload.data || {},
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Notification', options)
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url || '/results'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Navigate existing results tab to the deep link, then focus
      for (const client of clients) {
        if (client.url.includes('/results') && 'focus' in client) {
          if ('navigate' in client) {
            return client.navigate(url).then(c => c && c.focus())
          }
          return client.focus()
        }
      }
      // Otherwise open a new tab
      return self.clients.openWindow(url)
    })
  )
})