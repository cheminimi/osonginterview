// 홈 화면 앱(PWA)·휴대폰 알림용 최소 서비스워커.
// 화면·파일 요청은 전혀 가로채지 않습니다 (fetch 처리 없음) → 브라우저가 시크릿 창과 똑같이 바로 네트워크로 엽니다.
// (2026-10-12) 예전에는 화면 이동을 대신 받아 실패하면 offline.html 을 보여 줬는데,
//  확장 프로그램·보안 프로그램·절전 직후 등으로 서비스워커 요청만 실패하면 인터넷이 되는데도 '연결 안 됨' 화면이 떠서 없앴습니다.
//  홈 화면 설치(크롬·안드로이드·아이폰)와 웹 푸시는 fetch 처리 없이도 됩니다.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  // 예전 판이 저장해 둔 안내 페이지 캐시까지 모두 지운다
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
