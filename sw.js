// 홈 화면 앱(PWA)용 최소 서비스워커.
// 앱 파일은 절대 캐시하지 않습니다 (옛 화면이 남아 화면이 멈추던 문제 방지).
// 인터넷이 끊겼을 때 보여 줄 안내 페이지 하나만 저장해 둡니다.
const OFFLINE = "osong-offline-v1";
const PAGE = "offline.html";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(OFFLINE).then((c) => c.add(PAGE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== OFFLINE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;                 // 나머지는 평소대로 네트워크에서
  e.respondWith(fetch(e.request).catch(() => caches.match(PAGE)));
});

// ===== 휴대폰 알림(웹 푸시) =====
// 보내는 쪽(Apps Script)은 '데이터만' 보내고, 화면에 띄우는 건 여기서 한다.
// 아이폰은 푸시를 받으면 반드시 알림을 띄워야 하므로, 내용이 없어도 기본 문구로 띄운다.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { try { d = { body: e.data.text() }; } catch (__) { d = {}; } }
  const data = d.data || d;                       // {title, body, url, tag}
  const title = data.title || "면접 스튜디오";
  const opts = {
    body: data.body || "앱에서 확인해 주세요.",
    icon: "icons/icon-192.png",
    badge: "icons/favicon-32.png",
    tag: data.tag || "osong",                     // 같은 tag 는 덮어쓴다 (알림이 쌓이지 않게)
    renotify: true,
    data: { url: data.url || "student.html" }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// 알림을 누르면 이미 열린 창이 있으면 그리로, 없으면 새로 연다
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "student.html";
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.includes("student.html") || c.url.includes("teacher.html")) {
        await c.focus();
        try { c.postMessage({ type: "push-open", url }); } catch (_) {}
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
