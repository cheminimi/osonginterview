// 면접 부스 기록 보기 — 스튜디오(학생 기록 모달·교사 연습 리뷰)에서 부스 결과 화면과 같은 내용을 보여 준다 (영상만 없음)
// sessions/{id} 중 mode:"booth" 기록만. 부스가 저장한 값을 그대로 쓰고 다시 계산하지 않는다 (낱말·질문 핵심어 포함).
// 칸이 없는 옛 기록은 그 줄·상자만 숨긴다. 기준 숫자는 booth.html 의 SPEED·GAZE·KW·QUICK 과 같게 맞춘다.
// aiReport(부스가 자동으로 만든 AI 피드백)와 aiFeedback(선생님이 붙여 넣는 칸)은 서로 다른 칸 — 여기서는 aiReport 만 다룬다.
import { db, doc, getDoc, esc, fmtSec } from "./common.js";

const SPEED = { low: 250, high: 330 };                         // 분당 글자 수 참고 범위
const GAZE = { ok: 70, mid: 50, headMoveBig: 8, awayHint: 3 };  // 70% 이상 초록 · 50~70 주황 · 50 미만 빨강
const KW = { strong: 3, mid: 2 };                              // 낱말 칩 진하기: 3번 이상 진하게 · 2번 중간 · 1번 옅게
const FOLLOW_SEC = 60;                                         // 꼬리질문 답변 기준 시간 (부스와 같음)
const AI_PENDING_MAX = 30 * 60 * 1000;                         // 이보다 오래 '준비 중'이면 멈춘 것으로 보고 숨김
const IV_LABEL = { A: "A 교수", B: "B 교수", C: "C 교수", D: "D 교수" };
const TYPE_LABEL = { personal: "내 생기부 면접", document: "학생부 공통 질문", passage: "제시문 면접", personality: "기본 인성·MMI" };
const RULE_LABEL = { role: "역할", evidence: "근거", limit: "아쉬운 점", link: "학과 연결" };

export const isBoothSession = (s) => s?.mode === "booth";

const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
const arr = (x) => (Array.isArray(x) ? x : []);
const ms = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : t.seconds ? t.seconds * 1000 : typeof t === "string" ? Date.parse(t) || 0 : 0);
const sec = (x) => fmtSec(num(x) || 0);
const ivLabel = (id) => IV_LABEL[id] || (id ? String(id) : "");
const gzCls = (p) => (p >= GAZE.ok ? "good" : p >= GAZE.mid ? "note" : "bad");
const gzSumCls = (p) => (p >= GAZE.ok ? "ok" : p >= GAZE.mid ? "mid" : "bad");
const fillerList = (f) => Object.entries(f && typeof f === "object" ? f : {}).filter(([, n]) => num(n) != null);
const topFillers = (f, min = 3) => fillerList(f).filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, 3);
const typeLabelOf = (it) => it.slot === "opening" ? "첫 질문" : it.slot === "closing" ? "마지막 질문" : it.source === "personal" ? "내 생기부"
  : it.type === "passage" ? "제시문" : it.type === "mmi" ? "MMI" : it.type === "personality" ? "인성" : "학생부 공통";

// ---------------- AI 피드백 (aiReport) ----------------
/** "done" | "pending" | "" — error·없음·오래 멈춘 pending 은 "" (숨김) */
export function aiReportState(s) {
  const r = s?.aiReport;
  if (!r || typeof r !== "object") return "";
  if (r.status === "done" && r.summary) return "done";
  if (r.status === "pending") { const t = ms(r.createdAt); return !t || Date.now() - t < AI_PENDING_MAX ? "pending" : ""; }
  return "";
}
/** AI 피드백 상자 (자리 #bvAi 는 늘 둔다 — 나중에 내용이 오면 이 자리만 바꾼다) */
export function aiReportHtml(s) {
  const st = aiReportState(s), r = s?.aiReport || {};
  if (st === "pending") return `<div id="bvAi" data-st="pending" class="bv-ai pending"><b>AI 피드백</b><p>AI 피드백 준비 중이에요. 잠시 뒤 다시 열어 보세요.</p></div>`;
  if (st !== "done") return `<div id="bvAi" data-st="" hidden></div>`;
  const li = (a) => arr(a).filter((x) => x != null && x !== "").map((x) => `<li>${esc(x)}</li>`).join("");
  const st1 = li(r.strengths), im1 = li(r.improve);
  const pq = arr(r.perQuestion).filter((q) => q && q.comment);
  return `<div id="bvAi" data-st="done" class="bv-ai"><b>AI 피드백 <span class="by">· 부스에서 자동으로 만든 피드백</span></b>
    <p class="sum">${esc(r.summary)}</p>
    ${st1 || im1 ? `<div class="cols">${st1 ? `<div><i>잘한 점</i><ul>${st1}</ul></div>` : ""}${im1 ? `<div><i>다음에 해 볼 것</i><ul>${im1}</ul></div>` : ""}</div>` : ""}
    ${pq.length ? `<div class="pq">${pq.map((q) => `<p><span>Q${esc(q.idx)}</span>${esc(q.comment)}</p>`).join("")}</div>` : ""}</div>`;
}
/** 서버에서 그 기록 하나만 다시 읽어 aiReport 를 바꿔 넣는다 (교사 화면 — 열 때마다). 바뀌었으면 true */
export async function refreshAiReport(s) {
  const snap = await getDoc(doc(db, "sessions", s.id));
  if (!snap.exists()) return false;
  const next = snap.data().aiReport;
  const changed = JSON.stringify(next ?? null) !== JSON.stringify(s.aiReport ?? null);
  if (next === undefined) delete s.aiReport; else s.aiReport = next;
  return changed;
}
/** 다시 읽어야 하는 기록인지: 준비 중이거나, 막 끝난(2시간 안) 기록인데 아직 칸이 없을 때 */
export function aiReportMaybeComing(s) {
  if (!isBoothSession(s)) return false;
  if (s.aiReport?.status === "pending") return true;
  if (s.aiReport) return false;
  const t = ms(s.submittedAt) || ms(s.updatedAt) || ms(s.startedAt);
  return !!t && Date.now() - t < 2 * 3600 * 1000;
}

// ---------------- 맨 위: 정보 줄 · 오늘 면접 한눈에 · 요약 칸 ----------------
function infoLine(s) {
  const p = [];
  if (num(s.planSec)) p.push(`${Math.round(s.planSec / 60)}분 면접`);
  const ty = arr(s.types).map((k) => TYPE_LABEL[k] || k).filter(Boolean);
  if (ty.length) p.push(ty.join(" → "));
  const iv = arr(s.interviewers).map(ivLabel).filter(Boolean);
  if (iv.length) p.push(iv.join(" · "));
  return p.length ? `<div class="bv-info">${esc(p.join(" · "))}</div>` : "";
}
function quickHtml(s) {
  const q = s.quickSummary;
  if (!q || (!q.praise && !q.improve)) return "";
  return `<div class="bv-quick"><b>오늘 면접 한눈에</b>${q.praise ? `<p class="pr">👍 ${esc(q.praise)}</p>` : ""}${q.improve ? `<p class="im">✏️ ${esc(q.improve)}</p>` : ""}</div>`;
}
function sumHtml(s, items) {
  if (!items.length) return "";
  const mm = items.flatMap((it) => [it.m, it.followM]).filter((m) => m && typeof m === "object");
  const nFollow = items.filter((it) => it.followUp).length;
  const speeds = mm.map((m) => num(m.cpm)).filter((x) => x != null);
  const avg = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;
  const pauses = mm.reduce((t, m) => t + (num(m.pauses) || 0), 0);
  const allF = {};
  mm.forEach((m) => fillerList(m.fillers).forEach(([w, n]) => { allF[w] = (allF[w] || 0) + n; }));
  const tf = topFillers(allF, 3)[0];
  const g = !s.gazeOff && s.gaze && num(s.gaze.onPct) != null ? s.gaze : null;
  const used = num(s.usedTotalSec), plan = num(s.planSec);
  return `<div class="bv-sum${g ? " five" : ""}">
    <div><b>${items.length}문항</b><span>받은 질문${nFollow ? ` (꼬리질문 ${nFollow}개 포함 ${items.length + nFollow}번 답변)` : ""}</span></div>
    <div><b>${used != null ? fmtSec(used) : "–"}${plan ? ` <small>/ ${fmtSec(plan)}</small>` : ""}</b><span>쓴 시간 / 정한 시간</span></div>
    <div><b>${avg != null ? avg + "자" : "–"}</b><span>평균 말 속도 (분당, 참고 ${SPEED.low}~${SPEED.high}자)</span></div>
    <div><b>${pauses}번</b><span>3초 넘게 멈춘 곳${tf ? ` · “${esc(tf[0])}” ${tf[1]}번` : ""}</span></div>
    ${g ? `<div><b class="gz-${gzSumCls(g.onPct)}">${g.onPct}%</b><span>화면 응시 (답변 중 평균)</span></div>` : ""}
  </div>`;
}

// ---------------- 질문별로 쓴 시간 ----------------
function timeChart(s, items) {
  const rows = items.map((it) => {
    const th = (num(it.thinkUsedSec) || 0) + (num(it.prepUsedSec) || 0), a = num(it.usedSec) || 0, f = num(it.followUsedSec) || 0;
    const span = num(it.spanSec);                                   // 없으면 '질문 읽기 등' 0
    return { it, th, a, f, gap: span != null ? Math.max(0, span - th - a - f) : 0, sum: th + a + f };
  });
  const plan = num(s.planSec) || 0;
  const total = Math.max(plan, rows.reduce((t, r) => t + r.sum + r.gap, 0));
  if (!total) return "";
  const w = (v) => `${(v / total * 100).toFixed(2)}%`;
  const bar = rows.map((r, i) => [
    r.th ? `<i class="s-think" style="width:${w(r.th)}"></i>` : "",
    r.a ? `<i class="s-ans" style="width:${w(r.a)}">${r.a / total > 0.06 ? `Q${i + 1}` : ""}</i>` : "",
    r.f ? `<i class="s-fol" style="width:${w(r.f)}"></i>` : "",
    r.gap ? `<i class="s-gap" style="width:${w(r.gap)}"></i>` : ""].join("")).join("") + `<i class="s-rest"></i>`;
  const maxSum = Math.max(1, ...rows.map((r) => r.sum));
  const longest = rows.length > 1 ? rows.findIndex((r) => r.sum === maxSum) : -1;
  const axis = [0, 1, 2, 3].map((k) => `<span>${fmtSec(total * k / 3)}</span>`).join("");
  const used = num(s.usedTotalSec);
  const why = s.endReason === "time" ? (plan && used != null ? `남은 시간 ${fmtSec(Math.max(0, plan - used))} — 다음 질문을 받기엔 부족해서 여기서 마쳤어요.` : "시간이 다 되어 마쳤어요.")
    : s.endReason === "questions" ? "준비된 질문을 모두 해서 마쳤어요."
    : s.endReason === "asked" ? "‘면접 종료’로 여기서 마쳤어요."
    : s.endReason === "noreply" ? "대답이 없어서 여기서 마쳤어요."
    : s.endReason === "error" ? "장비 문제로 여기까지 제출했어요." : "";
  const more = rows.map((r, i) => (r.it.thinkMore ? `Q${i + 1}` : "")).filter(Boolean);
  const note = [why, more.length ? `${more.join("·")} 의 생각 시간에는 “잠시만요” 20초가 들어 있어요.` : ""].filter(Boolean).join(" ");
  return `<section class="bv-card bv-time"><div class="bv-time-h"><h3>질문별로 쓴 시간</h3>
      <div class="bv-legend"><span><i class="s-think"></i>생각·준비</span><span><i class="s-ans"></i>답변</span><span><i class="s-fol"></i>꼬리질문 답변</span><span><i class="s-gap"></i>질문 읽기 등</span><span><i class="s-rest"></i>남은 시간</span></div></div>
    <div class="bv-bar">${bar}</div><div class="bv-axis">${axis}</div>
    <table class="bv-t"><thead><tr><th>문항</th><th>질문</th><th class="c-th">생각·준비</th><th>답변</th><th class="c-f">꼬리 답변</th><th>합계</th><th class="c-mini"></th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td class="n">Q${i + 1}</td>
        <td class="q">${r.it.type !== "document" || r.it.source !== "personal" ? `<span class="ytag">${esc(typeLabelOf(r.it))}</span>` : ""}${esc(r.it.text || "")}${i === longest ? `<span class="tag-long">가장 길게 씀</span>` : ""}</td>
        <td class="c-th">${fmtSec(r.th)}</td><td>${fmtSec(r.a)}</td><td class="c-f">${r.it.followUp ? fmtSec(r.f) : "–"}</td><td class="n">${fmtSec(r.sum)}</td>
        <td class="c-mini"><div class="mini"><i style="width:${(r.sum / maxSum * 100).toFixed(1)}%"></i></div></td></tr>`).join("")}
    </tbody></table>
    ${note ? `<p class="bv-tnote">${esc(note)}</p>` : ""}</section>`;
}

// ---------------- 문항 카드 ----------------
function chips(m, used, limit, g) {
  const c = [];
  const u = num(used), lim = num(limit);
  if (u != null) c.push(`<span class="${lim != null && u > lim + 30 ? "note" : ""}">답변 ${fmtSec(u)}</span>`);
  if (m && typeof m === "object") {
    const cpm = num(m.cpm);
    if (cpm != null) {
      const cls = cpm < SPEED.low || cpm > SPEED.high ? "note" : "good";
      const word = cpm < SPEED.low ? "조금 느려요" : cpm > SPEED.high ? "조금 빨라요" : "알맞아요";
      c.push(`<span class="${cls}">말 속도 ${cpm}자/분 · ${word}</span>`);
    }
    const first = num(m.firstSec);
    if (first != null && first >= 4) c.push(`<span class="note">첫 마디까지 ${Math.round(first)}초</span>`);
    if (first == null) c.push(`<span class="note">목소리가 잡히지 않았어요</span>`);
    else c.push(`<span class="${(num(m.pauses) || 0) >= 2 ? "note" : "good"}">3초 넘게 멈춤 ${num(m.pauses) || 0}번</span>`);
    topFillers(m.fillers).forEach(([w, n]) => c.push(`<span class="note">“${esc(w)}” ${n}번</span>`));
  }
  if (g && num(g.onPct) != null) {
    c.push(`<span class="${gzCls(g.onPct)}">👁 화면 응시 ${g.onPct}% · 다른 곳 ${num(g.awayCount) || 0}번</span>`);
    if (num(g.headMove) > GAZE.headMoveBig) c.push(`<span class="gz-head">고개를 자주 움직였어요</span>`);
  }
  return c.length ? `<div class="bv-chips">${c.join("")}</div>` : "";
}
const gzTip = (g) => g && num(g.onPct) != null && ((num(g.awayCount) || 0) >= GAZE.awayHint || g.onPct < GAZE.mid)
  ? `<p class="bv-gztip">시선이 자주 벗어났어요. 생각할 때도 면접관 쪽을 보며 말해 보세요.</p>` : "";
function kwBlock(ks, qk) {
  const list = arr(ks).filter((k) => k && k.w);
  const qs = arr(qk).filter((k) => k && k.w);
  if (!list.length && !qs.length) return "";
  const lv = (n) => (n >= KW.strong ? "k3" : n >= KW.mid ? "k2" : "k1");
  return `<div class="bv-kw">${list.length ? `<div class="bv-kw-h">많이 쓴 낱말</div>
      <div class="bv-kw-c">${list.map((k) => `<span class="${lv(num(k.n) || 1)}">${esc(k.w)} <i>${num(k.n) || 1}</i></span>`).join("")}</div>` : ""}
    ${qs.length ? `<p class="bv-kw-q">질문 핵심어: ${qs.map((k) => `<span class="${k.hit ? "hit" : "miss"}">${esc(k.w)}${k.hit ? " ✓" : ""}</span>`).join(" · ")}</p>` : ""}</div>`;
}
function followTag(it, teacher) {
  const src = it.followSource;
  if (src === "teacher") return `<span class="bv-src teacher"${teacher ? ` title="선생님이 등록한 꼬리질문"` : ""}>등록</span>`;
  if (src === "ai") return `<span class="bv-src ai"${teacher ? ` title="${esc(`AI 꼬리질문${it.followModel ? " · " + it.followModel : ""}`)}"` : ""}>AI</span>`;
  if (src === "rule") {
    const r = RULE_LABEL[it.followRule] || "";
    return `<span class="bv-src rule"${teacher ? ` title="${esc(`자동 질문${r ? " · " + r : ""} (답변에서 빠진 것을 묻는 규칙 질문)`)}"` : ""}>자동${teacher && r ? ` · ${esc(r)}` : ""}</span>`;
  }
  return "";
}
const ansBox = (t) => `<div class="bv-ans">${t ? esc(t) : `<span class="muted">받아쓴 답변이 없어요</span>`}</div>`;
function itemCard(s, it, i, { teacher, itemExtra }) {
  const head = [`질문 ${i + 1}`, typeLabelOf(it), ivLabel(it.askedBy)].filter(Boolean).join(" · ");
  const fol = it.followUp ? `<div class="bv-fol">
      <div class="bv-qn">꼬리질문 ${followTag(it, teacher)}</div>
      <div class="bv-qt">${esc(it.followUp)}</div>
      ${chips(it.followM, it.followUsedSec, FOLLOW_SEC, it.followGaze)}
      ${ansBox(it.followAnswer)}
      ${s.sttOff ? "" : kwBlock(it.followKeywords, it.followQuestionKeys)}${gzTip(it.followGaze)}</div>` : "";
  return `<article class="bv-card bv-q">
    <div class="bv-qn">${esc(head)}</div>
    <div class="bv-qt">${esc(it.text || "")}</div>
    ${it.passage ? `<details class="bv-psg"><summary>제시문 보기</summary><div class="bv-ans">${esc(it.passage)}</div></details>` : ""}
    ${chips(it.m, it.usedSec, it.answerSec, it.gaze)}
    ${ansBox(it.answer)}
    ${s.sttOff ? "" : kwBlock(it.keywords, it.questionKeys)}${gzTip(it.gaze)}
    ${fol}
    ${itemExtra ? itemExtra(i) || "" : ""}
  </article>`;
}

/**
 * 부스 기록 전체 (부스 결과 화면 순서: 오늘 면접 한눈에 → AI 피드백 → 요약 칸 → 질문별 시간 → 문항 카드)
 * opts.teacher: 꼬리질문 출처를 자세히(툴팁) · opts.top: 정보 줄 아래에 끼울 HTML(선생님 피드백 등) · opts.itemExtra(i): 문항 카드 맨 아래
 */
export function boothViewHtml(s, { teacher = false, top = "", itemExtra = null } = {}) {
  const items = arr(s.items).filter((it) => it && typeof it === "object");
  return `<div class="bv" data-sid="${esc(s.id || "")}">
    ${infoLine(s)}
    ${top}
    ${quickHtml(s)}
    ${aiReportHtml(s)}
    ${sumHtml(s, items)}
    ${timeChart(s, items)}
    ${items.length ? items.map((it, i) => itemCard(s, it, i, { teacher, itemExtra })).join("") : `<div class="bv-card muted">답한 질문이 없어요.</div>`}
  </div>`;
}
/** 열려 있는 화면의 AI 피드백 자리만 바꿈 — 지금 그 기록이 열려 있을 때만 (다른 기록으로 바뀌었으면 그대로 둠) */
export function replaceAiReport(root, s) {
  const view = [...(root?.querySelectorAll(".bv[data-sid]") || [])].find((v) => v.dataset.sid === String(s.id || ""));
  const box = view?.querySelector("#bvAi");
  if (box) box.outerHTML = aiReportHtml(s);
}
