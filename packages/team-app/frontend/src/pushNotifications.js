/**
 * Web Push notification utilities for DSQ alerts.
 *
 * Flow:
 * 1. Coach enters team PIN on live results page
 * 2. We validate PIN via /api/live/subscribe
 * 3. Browser prompts for notification permission
 * 4. We register the Service Worker and create a push subscription
 * 5. Subscription is sent to the server linked to the coach's club
 *
 * The PIN is stored in localStorage so returning coaches are auto-subscribed.
 */

const SW_PATH = '/sw.js'
const STORAGE_KEY = 'dsq_notify_pin'

/**
 * Check if push notifications are supported in this browser.
 */
export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * Get the stored notification PIN (if any).
 */
export function getStoredPin() {
  return localStorage.getItem(STORAGE_KEY) || ''
}

/**
 * Clear the stored notification PIN.
 */
export function clearStoredPin() {
  localStorage.removeItem(STORAGE_KEY)
}

/**
 * Convert a URL-safe base64 string to a Uint8Array (for applicationServerKey).
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

/**
 * Subscribe to DSQ push notifications.
 *
 * @param {string} pin - The team PIN
 * @returns {Promise<{ok: boolean, club_name?: string, error?: string}>}
 */
export async function subscribeToPush(pin) {
  if (!isPushSupported()) {
    return { ok: false, error: 'Push notifications not supported in this browser' }
  }

  // Request notification permission
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { ok: false, error: 'Notification permission denied' }
  }

  try {
    // Get VAPID public key from server
    const keyRes = await fetch('/api/live/vapid-public-key')
    if (!keyRes.ok) {
      return { ok: false, error: 'Failed to get server key' }
    }
    const { public_key } = await keyRes.json()

    // Register service worker
    const registration = await navigator.serviceWorker.register(SW_PATH)
    await navigator.serviceWorker.ready

    // Create push subscription
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(public_key),
    })

    // Send subscription + PIN to server for validation
    const subRes = await fetch('/api/live/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pin: pin,
        subscription: subscription.toJSON(),
      }),
    })

    if (!subRes.ok) {
      const err = await subRes.json().catch(() => ({}))
      return { ok: false, error: err.detail || `Error ${subRes.status}` }
    }

    const data = await subRes.json()

    // Store PIN in localStorage for auto-reconnect
    localStorage.setItem(STORAGE_KEY, pin)

    return { ok: true, club_name: data.club_name }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush() {
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH)
    if (registration) {
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        // Tell server to remove
        await fetch('/api/live/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        }).catch(() => {})
        // Unsubscribe locally
        await subscription.unsubscribe()
      }
    }
  } catch {
    // Best effort
  }
  clearStoredPin()
}

/**
 * Check if currently subscribed (has active push subscription).
 */
export async function isSubscribed() {
  if (!isPushSupported()) return false
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH)
    if (!registration) return false
    const subscription = await registration.pushManager.getSubscription()
    return !!subscription
  } catch {
    return false
  }
}

/**
 * Auto-resubscribe if PIN is stored (call on page load).
 * Returns the club name if successful, null otherwise.
 */
export async function autoResubscribe() {
  const pin = getStoredPin()
  if (!pin) return null
  if (!isPushSupported()) return null

  // Check if already subscribed
  const alreadySubscribed = await isSubscribed()
  if (alreadySubscribed) {
    // Verify PIN is still valid by re-subscribing (updates server-side if needed)
    const result = await subscribeToPush(pin)
    return result.ok ? result.club_name : null
  }

  // Not subscribed — try to subscribe with stored PIN
  const result = await subscribeToPush(pin)
  if (!result.ok) {
    // PIN might be invalid (new meet cycle) — clear it
    clearStoredPin()
    return null
  }
  return result.club_name
}
