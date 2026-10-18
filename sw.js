// Офлайн-режим: файлы приложения хранятся в кэше на случай, если сети нет.
const CACHE = 'everyday-calendar-v7';
const ASSETS = [
  './', 'index.html', 'style.css', 'config.js', 'core.js', 'sync.js', 'tasks.js', 'app.js',
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

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))),
  );
});
