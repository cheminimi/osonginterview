// 홈 화면에 앱처럼 추가하기 (PWA)
// - 서비스워커는 앱 파일을 캐시하지 않는다 (sw.js 참고). 설치 조건과 오프라인 안내만 담당.
// - 안드로이드: 설치 버튼, 아이폰: 공유 → 홈 화면에 추가 안내
const HIDE_KEY = "pwaTipHidden";
let deferred = null;

export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isMobile = () => isIOS() || /android/i.test(navigator.userAgent);

export function registerSW() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));
  });
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; document.dispatchEvent(new Event("pwa-installable")); });
window.addEventListener("appinstalled", () => { deferred = null; try { localStorage.setItem(HIDE_KEY, "1"); } catch (e) {} });

/** 홈 화면 추가 안내 띄우기. el 안에 넣고, 닫으면 다시 보여 주지 않는다. */
export function mountInstallTip(el, { force = false } = {}) {
  if (!el) return;
  const hidden = (() => { try { return localStorage.getItem(HIDE_KEY) === "1"; } catch (e) { return false; } })();
  if (isStandalone() || (!force && (hidden || !isMobile()))) { el.innerHTML = ""; return; }
  const ios = isIOS();
  el.innerHTML = `<div class="pwa-tip">
    <img src="icons/icon-192.png" alt="" width="40" height="40">
    <div class="pwa-tip-body">
      <b>홈 화면에 추가하면 앱처럼 쓸 수 있어요</b>
      <span class="muted">${ios
        ? "사파리 아래 <b>공유</b> 버튼 → <b>홈 화면에 추가</b>"
        : "브라우저 메뉴(⋮) → <b>앱 설치</b> 또는 <b>홈 화면에 추가</b>"}</span>
    </div>
    ${ios ? "" : `<button class="btn-sm btn-primary" id="pwaGo" hidden>설치</button>`}
    <button class="btn-sm" id="pwaNo" aria-label="닫기">✕</button>
  </div>`;
  const go = el.querySelector("#pwaGo");
  const showGo = () => { if (go && deferred) go.hidden = false; };
  showGo(); document.addEventListener("pwa-installable", showGo, { once: true });
  go?.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch (e) {}
    deferred = null; el.innerHTML = "";
  });
  el.querySelector("#pwaNo").onclick = () => { try { localStorage.setItem(HIDE_KEY, "1"); } catch (e) {} el.innerHTML = ""; };
}

/** 설정/도움말에서 다시 부를 때: 저장된 '닫음'을 무시하고 보여 준다. */
export function showInstallTipAgain(el) {
  try { localStorage.removeItem(HIDE_KEY); } catch (e) {}
  mountInstallTip(el, { force: true });
}
