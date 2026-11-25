// Web Push subscription: lets the server deliver alarms while the app is closed.
import { api } from './api.js';

const KEY = 'ykmaps:pushSub';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
}

export function pushSubId() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/**
 * Ensure we have a push subscription registered with the server.
 * Returns the server-side subscription id, or null if push isn't available.
 */
export async function ensurePush({ ask = true } = {}) {
  if (!pushSupported()) return null;
  if (Notification.permission === 'denied') return null;
  if (Notification.permission !== 'granted') {
    if (!ask) return null;
    if ((await Notification.requestPermission()) !== 'granted') return null;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api.push.key();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    const { id } = await api.push.subscribe(sub.toJSON());
    localStorage.setItem(KEY, id);
    return id;
  } catch (e) {
    console.warn('push subscribe failed', e);
    return null;
  }
}
