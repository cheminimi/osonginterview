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
