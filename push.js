// 휴대폰 알림(웹 푸시) — 켜기·끄기와 토큰 보관
//
// 보내는 쪽은 시트 Apps Script 입니다. 이 파일은 '이 기기로 보내도 된다'는 표(토큰)를
// 받아서 pushTokens 에 적어 두는 일만 합니다.
//
// 아이폰은 사파리 탭에서는 알림을 받을 수 없고, 홈 화면에 앱으로 추가해야만 됩니다.
// (iOS 16.4 이상) 그래서 '왜 안 되는지' 를 항상 말로 돌려줍니다.
import { db, doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, where, toast } from "./common.js";

const KEY_OFF = "pushOff";            // 사용자가 스스로 끈 경우
const KEY_ASKED = "pushAsked";        // 한 번 물어봤는지 (같은 걸 자꾸 묻지 않도록)
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export function pushSupported() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }

/** 지금 이 기기에서 알림을 켤 수 있는 상태인지 + 왜 안 되는지 */
export function pushState() {
  if (!pushSupported()) return { can: false, why: "이 브라우저는 알림을 지원하지 않아요." };
  if (isIOS() && !isStandalone()) {
    return { can: false, needInstall: true,
      why: "아이폰은 홈 화면에 앱으로 추가한 뒤에야 알림을 받을 수 있어요.\n공유 버튼 → '홈 화면에 추가' 를 한 뒤, 그 아이콘으로 열어 주세요." };
  }
  const p = Notification.permission;
  if (p === "denied") return { can: false, blocked: true, why: "브라우저에서 알림을 막아 두었어요. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요." };
  return { can: true, granted: p === "granted" };
}

const offLocally = () => { try { return localStorage.getItem(KEY_OFF) === "1"; } catch (_) { return false; } };
const setOff = (v) => { try { v ? localStorage.setItem(KEY_OFF, "1") : localStorage.removeItem(KEY_OFF); } catch (_) {} };
export const wasAsked = () => { try { return localStorage.getItem(KEY_ASKED) === "1"; } catch (_) { return false; } };
export const markAsked = () => { try { localStorage.setItem(KEY_ASKED, "1"); } catch (_) {} };

// 웹 푸시 인증서(공개 키). 관리 화면에서 넣어 두면 config/push 에 있습니다.
let vapidCache = null;
async function vapidKey() {
  if (vapidCache !== null) return vapidCache;
  try {
    const s = await getDoc(doc(db, "config", "push"));
    vapidCache = (s.exists() && s.data().vapidKey) || "";
  } catch (e) { vapidCache = ""; }
  return vapidCache;
}

let msgMod = null;
async function messaging() {
  if (!msgMod) msgMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js");
  return msgMod;
}

const tokenRef = (t) => doc(db, "pushTokens", t);

/**
 * 알림 켜기. 성공하면 true.
 * ctx: requireRole() 이 준 것 (uid·역할·학번/교사ID)
 */
export async function enablePush(ctx, { quiet = false } = {}) {
  const st = pushState();
  if (!st.can) { if (!quiet) toast(st.why, "error", 9000); return false; }
  const key = await vapidKey();
  if (!key) { if (!quiet) toast("알림 설정이 아직 준비되지 않았어요. 선생님께 알려 주세요.", "error", 7000); return false; }

  markAsked();
  let perm = Notification.permission;
  if (perm !== "granted") {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = "denied"; }
  }
  if (perm !== "granted") { if (!quiet) toast("알림이 허용되지 않았어요.", "error", 6000); return false; }

  try {
    const reg = await navigator.serviceWorker.ready;
    const { getMessaging, getToken } = await messaging();
    const token = await getToken(getMessaging(), { vapidKey: key, serviceWorkerRegistration: reg });
    if (!token) throw new Error("토큰을 받지 못했습니다.");
    await setDoc(tokenRef(token), {
      uid: ctx.user.uid,
      role: ctx.account.role === "student" ? "student" : "staff",
      key: String(ctx.account.key || ""),
      name: ctx.profile?.name || "",
      createdAtMs: Date.now(), lastSeenMs: Date.now()
    });
    setOff(false);
    try { localStorage.setItem("pushToken", token); } catch (_) {}
    if (!quiet) toast("알림을 켰어요. 일정이 확정되면 휴대폰으로 알려드릴게요.");
    return true;
  } catch (e) {
    console.warn("push enable", e);
    if (!quiet) toast("알림을 켜지 못했어요. 잠시 뒤 다시 시도해 주세요.", "error", 7000);
    return false;
  }
}

/** 알림 끄기 — 이 기기 토큰만 지운다 (다른 기기는 그대로) */
export async function disablePush() {
  setOff(true);
  let token = "";
  try { token = localStorage.getItem("pushToken") || ""; } catch (_) {}
  try {
    if (!token && pushSupported()) {
      const reg = await navigator.serviceWorker.ready;
      const key = await vapidKey();
      if (key) {
        const { getMessaging, getToken, deleteToken } = await messaging();
        const m = getMessaging();
        token = await getToken(m, { vapidKey: key, serviceWorkerRegistration: reg }).catch(() => "");
        if (token) await deleteToken(m).catch(() => {});
      }
    }
    if (token) await deleteDoc(tokenRef(token)).catch(() => {});
    try { localStorage.removeItem("pushToken"); } catch (_) {}
    toast("알림을 껐어요.");
    return true;
  } catch (e) { console.warn("push disable", e); toast("알림을 끄지 못했어요.", "error"); return false; }
}

/** 이 기기에서 알림이 켜져 있나 (화면 표시용) */
export function pushOn() {
  if (offLocally() || !pushSupported()) return false;
  if (Notification.permission !== "granted") return false;
  try { return !!localStorage.getItem("pushToken"); } catch (_) { return false; }
}

/**
 * 앱을 열 때 조용히 토큰을 갱신한다.
 * 이미 켜 둔 사람만 대상이며, 권한을 새로 묻지 않는다 (토큰은 주기적으로 바뀐다).
 */
export async function refreshPush(ctx) {
  if (offLocally() || !pushSupported()) return;
  if (Notification.permission !== "granted") return;
  if (!pushState().can) return;
  await enablePush(ctx, { quiet: true });
}

/** 알림을 누르고 들어왔을 때 해당 화면으로 (서비스워커가 알려 준다) */
export function onPushOpen(fn) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "push-open") fn(e.data.url || "");
  });
}

/** 관리 화면용: 지금 몇 대가 알림을 받을 수 있나 */
export async function countTokens(role) {
  const q = role ? query(collection(db, "pushTokens"), where("role", "==", role)) : collection(db, "pushTokens");
  const snap = await getDocs(q);
  return snap.size;
}
