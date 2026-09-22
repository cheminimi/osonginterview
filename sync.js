// 앱 ⇄ 구글 시트 동기화 요청 (Apps Script 웹 앱)
// 앱은 Firestore 에 먼저 저장한 뒤 '동기화 요청'만 보낸다. 시트 쪽 스크립트가 양쪽을 비교해 반영한다.
// 요청이 실패해도 시트 스크립트의 정기 대조(30분) 때 반영된다.
import { db, doc, getDoc, toast } from "./common.js";

let cfgCache = null;
export async function getSyncConfig(force = false) {
  if (cfgCache && !force) return cfgCache;
  const snap = await getDoc(doc(db, "config", "sync"));
  cfgCache = snap.exists() ? snap.data() : {};
  return cfgCache;
}
export function clearSyncCache() { cfgCache = null; }

let pending = null, pendingKinds = new Set();
/**
 * kinds: ['students' | 'interviews' | 'meetings']
 * 짧은 시간에 여러 번 부르면 한 번으로 묶어서 보낸다.
 */
export function requestSync(kinds, { quiet = false } = {}) {
  kinds.forEach((k) => pendingKinds.add(k));
  if (pending) return pending;
  pending = new Promise((resolve) => setTimeout(async () => {
    const list = [...pendingKinds]; pendingKinds = new Set(); pending = null;
    resolve(await send(list, quiet));
  }, 400));
  return pending;
}

async function send(kinds, quiet) {
  let cfg;
  try { cfg = await getSyncConfig(); } catch (e) { cfg = {}; }
  if (!cfg.url || !cfg.token) {
    if (!quiet) toast("시트 연동이 설정되지 않아 앱에만 저장했습니다.", "error", 5000);
    return { ok: false, skipped: true };
  }
  try {
    // Content-Type 을 지정하지 않아야(text/plain) 브라우저 사전요청 없이 Apps Script로 보낼 수 있다.
    const res = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ token: cfg.token, kinds }), redirect: "follow" });
    let data;
    try { data = await res.json(); } catch (_) { throw new Error("시트 응답을 읽을 수 없습니다 (웹 앱 URL·배포 권한 확인)"); }
    if (!data.ok) throw new Error(data.error || "시트 동기화 실패");
    if (!quiet) toast("구글 시트에 반영했습니다.");
    return { ok: true, result: data.result };
  } catch (e) {
    console.error("sheet sync", e);
    // 정기 대조(timedSync)가 도는 항목만 '자동 반영'을 약속한다
    const AUTO = ["students", "interviews", "meetings", "bookings", "reviews"];
    const autoOk = kinds.every((k) => AUTO.includes(k));
    toast(`앱에는 저장했지만 시트 반영이 늦어집니다: ${e.message}`
      + (autoOk ? " — 시트 스크립트의 정기 대조(07~22시, 30분마다)가 돌고 있으면 그때 맞춰집니다."
                : " — 자동으로 다시 맞추지 않으니 관리자 화면에서 [시트 동기화]를 눌러 주세요."), "error", 9000);
    return { ok: false, error: e.message };
  }
}

export async function testConnection(url, token) {
  const u = new URL(url);
  u.searchParams.set("token", token);
  const res = await fetch(u.toString(), { redirect: "follow" });
  let data;
  try { data = await res.json(); } catch (_) { throw new Error("응답이 JSON이 아닙니다. URL이 …/exec 로 끝나는지, 액세스 권한이 '모든 사용자'인지 확인하세요."); }
  if (!data.ok) throw new Error(data.error || "연결 실패");
  return data;
}

// 모의면접 일정 변경 알림 (학생도 보냄 · 토큰 없이 '일정 로그 옮기기'만 요청). 실패해도 30분 대조 때 반영
export function pingScheduleSync(url) {
  if (!url) return;
  try {
    fetch(url, { method: "POST", mode: "no-cors", body: JSON.stringify({ kinds: ["bookings"] }) }).catch((e) => console.warn("schedule sync", e));
  } catch (e) { console.warn("schedule sync", e); }
}
