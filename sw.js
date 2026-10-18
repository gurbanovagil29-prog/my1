// Офлайн-режим: файлы приложения хранятся в кэше на случай, если сети нет.
const CACHE = 'everyday-calendar-v9';
const ASSETS = [
  './', 'index.html', 'style.css', 'config.js', 'core.js', 'alarms.js', 'sync.js', 'tasks.js', 'reminders-ui.js', 'app.js',
  'vendor/supabase-2.117.2.js', 'manifest.webmanifest', 'icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть: при интернете сразу открывается свежая версия. Кэш — запасной вариант без сети
// или когда сеть отвечает дольше 4 секунд.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    network.catch(() => {}); // если ответ взят из кэша, ошибка сети уже не важна
    const timeout = new Promise((resolve) => { setTimeout(resolve, 4000); });
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch {
      // Нет сети — ниже возьмём из кэша
    }
    const cached = await cache.match(e.request, { ignoreSearch: true });
    return cached || network;
  })());
});

// Push от сервера (функция «remind» в Supabase): показать уведомление и плашку в открытом календаре
self.addEventListener('push', (e) => {
  let d;
  try {
    d = e.data.json();
  } catch {
    d = { title: 'Календарь', body: e.data ? e.data.text() : '' };
  }
  const actions = d.kind === 'task'
    ? [{ action: 'done', title: '✓ Сделал' }, { action: 'snooze15', title: 'Через 15 мин' }]
    : [{ action: 'snooze15', title: 'Через 15 мин' }];
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title, {
      body: d.body, tag: d.tag, renotify: true, icon: 'icon.svg', badge: 'icon.svg', data: d, actions,
    }),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => list.forEach((c) => c.postMessage({ type: 'alarm', alarm: d }))),
  ]));
});

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  e.notification.close();
  const action = e.action;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if ((action === 'done' || action === 'snooze15') && d.kind) {
      if (d.token && d.actionUrl) {
        // Кнопка в уведомлении работает и при закрытом календаре: сразу сообщаем серверу
        try {
          const res = await fetch(d.actionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action === 'done' ? 'done' : 'snooze', minutes: 15, user: d.user, type: d.kind, id: d.id, token: d.token }),
          });
          if (res.ok) return;
        } catch {
          // Нет сети — передадим действие календарю
        }
      }
      if (list[0]) {
        list[0].postMessage({ type: 'alarm-action', action, kind: d.kind, id: d.id });
        return;
      }
      await self.clients.openWindow(`./?alarm=${d.kind}:${d.id}`);
      return;
    }
    if (list[0]) {
      await list[0].focus();
      if (d.kind) list[0].postMessage({ type: 'alarm', alarm: d });
      return;
    }
    await self.clients.openWindow(d.kind ? `./?alarm=${d.kind}:${d.id}` : './');
  })());
});
