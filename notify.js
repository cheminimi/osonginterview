// 알림 대기열 — 앱이 '이건 알려 주세요' 하고 한 줄 적어 두면, 시트 Apps Script 가 보냅니다.
//
// 일정 관련 알림(신청·확정·거절·취소)은 Apps Script 가 bookingLogs 만 보고 스스로 판단하므로
// 여기 적지 않습니다. 로그가 없는 것 — 피드백 공개 — 만 적습니다.
import { db, collection, addDoc } from "./common.js";

/**
 * 학생에게 보낼 알림을 적어 둔다. 실패해도 하던 일을 막지 않는다.
 * tag 가 같으면 학생 휴대폰에서 이전 알림을 덮어쓴다.
 */
export async function queueNotify({ role = "student", key, title, body = "", url = "student.html", tag = "" }) {
  if (!key || !title) return false;
  try {
    await addDoc(collection(db, "notify"), {
      role, key: String(key), title: String(title).slice(0, 80), body: String(body).slice(0, 140),
      url, tag: String(tag || "").slice(0, 60),
      createdAtMs: Date.now(), sentAtMs: 0
    });
    return true;
  } catch (e) { console.warn("notify", e); return false; }
}

/** 같은 학생에게 여러 건을 한꺼번에 (중복은 tag 로 걸러진다) */
export async function queueMany(list) {
  const seen = new Set();
  for (const n of list) {
    const k = `${n.key}|${n.tag}`;
    if (seen.has(k)) continue;
    seen.add(k);
    await queueNotify(n);
  }
}
