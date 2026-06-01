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
