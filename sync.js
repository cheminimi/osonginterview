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
    toast(`시트 반영 지연: ${e.message} — 30분 안에(07~22시) 자동으로 다시 맞춰집니다.`, "error", 8000);
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
