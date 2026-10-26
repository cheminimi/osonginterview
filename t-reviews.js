// 선생님 화면: 학생이 쓴 '대학 면접 후기' 보기
// 후기 1건 = 지원 대학 1곳 (문서 id = 면접일 문서 id).
// 읽기 사용량: 이 화면을 처음 열 때 한 번만 받아 둔다 (다시 받기 버튼으로 갱신).
// (2026-10-25) 새 양식: procedure(면접 절차 및 진행 방식) · qa [{q, a}](받은 질문과 실제 답변) · notes(기타 유의사항).
//   예전 후기의 questions(받은 질문 글)는 그대로 두고 함께 보여 준다.
import { db, collection, getDocs, $, $$, esc, toast, showError, fmtDay, icon, isoDay } from "./common.js";
import { S, register, myName, openModal, closeModal, opt, switchTab } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { queueNotify } from "./notify.js";

let root = null;
let loaded = false, loading = null;

export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="toolbar">
      <select id="rvYear" style="width:auto"></select>
      <select id="rvUniv" style="width:auto"></select>
      <select id="rvWho" style="width:auto">
        <option value="mine">내 담당 학생</option><option value="">전체 학생</option>
      </select>
      <input id="rvSearch" placeholder="학생 이름·학번·질문 내용">
      <div class="spacer"></div>
      <button class="btn-sm" id="rvReload">다시 받기</button>
    </div>
    <div id="rvNotice"></div>
    <div class="card table-wrap"><table class="rows-sm">
      <thead><tr><th>면접일</th><th>학생</th><th>대학·학과</th><th>전형</th><th>받은 질문</th><th>분위기</th><th>난이도</th></tr></thead>
      <tbody id="rvBody"></tbody></table></div>
    <p class="muted">학생이 직접 쓴 후기입니다. 선생님과 그 학생 본인만 볼 수 있어요.</p>`;
  ["#rvYear", "#rvUniv", "#rvWho"].forEach((s) => $(s, root).onchange = render);
  $("#rvSearch", root).oninput = render;
  $("#rvReload", root).onclick = () => load(true);
  register("reviews", render);
}

// ---- 불러오기 (이 화면을 열 때 한 번)
export async function load(force = false) {
  if (loading) return loading;
  if (loaded && !force) return;
  loading = (async () => {
    try {
      const snap = await getDocs(collection(db, "reviews"));
      S.reviews = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      loaded = true;
      if (force) toast(`후기 ${S.reviews.length}건을 다시 받았습니다.`);
    } catch (e) { showError(e, "면접 후기 불러오기"); }
    finally { loading = null; }
  })();
  await loading;
  render();
}

export const yearOf = (r) => Number(r.year) || (r.date ? Number(String(r.date).slice(0, 4)) + (Number(String(r.date).slice(5, 7)) >= 3 ? 1 : 0) : 0);
const stageStars = (n) => {
  const v = Number(n) || 0;
  if (!v) return '<span class="muted">-</span>';
  return `<span class="stars sm" title="${v}점">${[1, 2, 3, 4, 5].map((i) => `<span class="st${i <= v ? " on" : ""}">${icon("star", 15)}</span>`).join("")}</span>`;
};
const oneLine = (s, n = 70) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean).join(" · ").slice(0, n);
export const qaOf = (r) => (Array.isArray(r.qa) ? r.qa : []).filter((x) => x && (x.q || x.a));
const hasText = (r) => !!(r.questions || r.helped || r.regret || r.procedure || r.notes || qaOf(r).length);
// 받은 질문과 실제 답변을 글로 (복사·내보내기용). 예전 양식 글은 뒤에 그대로 붙인다
export function qaText(r) {
  const lines = qaOf(r).map((x, i) => `Q${i + 1}. ${x.q || ""}\nA. ${x.a || "(적지 않음)"}`);
  if (r.questions) lines.push(String(r.questions).trim());
  return lines.join("\n");
}
const qList = (r) => [...qaOf(r).map((x) => "Q " + (x.q || "")), ...String(r.questions || "").split("\n")].map((x) => x.trim()).filter(Boolean).join(" · ");

// 학생 화면과 같은 기준: 면접 당일 저녁 6시부터 후기를 쓸 수 있다
const RV_OPEN_HOUR = 18;
const reviewOpen = (iv) => {
  const d = iv.date ? isoDay(iv.date) : "", today = isoDay();
  return !!d && (d < today || (d === today && new Date().getHours() >= RV_OPEN_HOUR));
};
const sameInterview = (r, iv) => r.id === iv.id || (String(r.studentNo) === String(iv.studentNo)
  && String(r.univ || "") === String(iv.univ || "") && String(r.dept || "") === String(iv.dept || "")
  && String(r.date || "") === String(iv.date || ""));

// 내 담당 학생인지 (배정표 기준)
function isMine(r) {
  const me = myName();
  if (!me) return true;
  const st = S.students.find((s) => String(s.studentNo) === String(r.studentNo));
  const a = st?.assign || {};
  return [a.s1, a.s2, a.s3a, a.s3b].filter(Boolean).includes(me);
}

function render() {
  if (!root) return;
  if (!loaded) { $("#rvBody", root).innerHTML = `<tr><td colspan="7" class="empty">불러오는 중…</td></tr>`; return; }
  const list0 = S.reviews || [];

  // 고르는 칸 채우기 (고른 값은 유지)
  const yearSel = $("#rvYear", root), univSel = $("#rvUniv", root);
  const years = [...new Set(list0.map(yearOf).filter(Boolean))].sort((a, b) => b - a);
  const univs = [...new Set(list0.map((r) => r.univ).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  if (yearSel.dataset.n !== String(years.length)) {
    yearSel.innerHTML = opt(years.map((y) => [String(y), `${y}학년도`]), yearSel.value || String(years[0] || ""), "전체 학년도");
    yearSel.dataset.n = String(years.length);
  }
  if (univSel.dataset.n !== String(univs.length)) {
    univSel.innerHTML = opt(univs, univSel.value || "", "전체 대학");
    univSel.dataset.n = String(univs.length);
  }

  const y = yearSel.value, u = univSel.value, who = $("#rvWho", root).value;
  const kw = $("#rvSearch", root).value.trim();
  const list = list0.filter((r) =>
    (!y || String(yearOf(r)) === y)
    && (!u || r.univ === u)
    && (who !== "mine" || isMine(r))
    && (!kw || `${r.name || ""}${r.studentNo || ""}${r.univ || ""}${r.dept || ""}${r.questions || ""}${r.helped || ""}${r.regret || ""}${r.procedure || ""}${r.notes || ""}${qaOf(r).map((x) => `${x.q || ""}${x.a || ""}`).join("")}`.includes(kw)));

  renderMissing({ y, u, who, kw });

  if (!list.length) {
    $("#rvBody", root).innerHTML = `<tr><td colspan="7" class="empty">${list0.length ? "조건에 맞는 후기가 없습니다." : "아직 들어온 후기가 없습니다. 학생이 면접 당일 저녁 6시부터 쓸 수 있어요."}</td></tr>`;
    return;
  }
  $("#rvBody", root).innerHTML = list.map((r) => `
    <tr class="clickable" data-id="${esc(r.id)}">
      <td class="nowrap" data-l="면접일"><b>${r.date ? fmtDay(r.date) : "-"}</b></td>
      <td class="nowrap head" data-l="-"><b>${esc(r.name || "")}</b> <span class="muted">${esc(r.studentNo || "")}</span></td>
      <td data-l="대학"><b>${esc(r.univ || "")}</b> <span class="muted">${esc(r.dept || "")}</span></td>
      <td class="pack" data-l="전형">${esc(r.admission || "")}</td>
      <td class="pack" data-l="받은 질문">${esc(qList(r).slice(0, 70)) || '<span class="muted">-</span>'}</td>
      <td class="nowrap" data-l="분위기">${stageStars(r.mood)}</td>
      <td class="nowrap" data-l="난이도">${stageStars(r.difficulty)}</td>
    </tr>`).join("");
  $$("#rvBody tr[data-id]", root).forEach((tr) => tr.onclick = () => openReviewDetail(tr.dataset.id));
}

// ---- 아직 후기를 쓰지 않은 면접 (접힘) — 위의 학년도·대학·내 담당 고르기를 그대로 따른다
const NUDGE_KEY = "rvNudged";
const nudged = () => { try { return JSON.parse(localStorage.getItem(NUDGE_KEY) || "{}"); } catch (e) { return {}; } };
function markNudged(id) {
  try { const m = nudged(), cut = isoDay(new Date(Date.now() - 7 * 86400000));
    Object.keys(m).forEach((k) => { if (m[k] < cut) delete m[k]; });
    m[id] = isoDay(); localStorage.setItem(NUDGE_KEY, JSON.stringify(m)); } catch (e) {}
}
const missOpen = { v: false };    // 다시 그려도 펼친 상태 유지

function renderMissing({ y, u, who, kw }) {
  const box = $("#rvNotice", root);
  const me = myName();
  const active = new Map(S.students.map((s) => [String(s.studentNo), s]));
  const mine = (no) => { const a = active.get(no)?.assign || {}; return [a.s1, a.s2, a.s3a, a.s3b].filter(Boolean).includes(me); };
  const reviews = S.reviews || [];
  const today = isoDay();
  const miss = (S.interviews || []).filter((iv) => {
    const no = String(iv.studentNo || "");
    if (!active.has(no) || !reviewOpen(iv) || iv.announceResult === "fail") return false;   // 1차 불합격한 대학은 후기 대상 아님
    if (y && String(yearOf(iv)) !== y) return false;
    if (u && iv.univ !== u) return false;
    if (who === "mine" && me && !mine(no)) return false;
    if (kw && !`${iv.name || ""}${no}${iv.univ || ""}${iv.dept || ""}`.includes(kw)) return false;
    return !reviews.some((r) => sameInterview(r, iv) && hasText(r));
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!miss.length) { box.innerHTML = ""; return; }
  const sent = nudged();
  const ago = (d) => Math.round((new Date(today.replace(/-/g, "/")) - new Date(isoDay(d).replace(/-/g, "/"))) / 86400000);
  box.innerHTML = `<details class="rv-miss"${missOpen.v ? " open" : ""}><summary><b>아직 후기를 쓰지 않은 면접</b><span class="n">${miss.length}건</span>
      <span class="muted sm">${who === "mine" && me ? "내 담당 학생" : "전체 학생"}${y ? ` · ${y}학년도` : ""}</span><span class="sp"></span><span class="ar">${icon("chevron", 16)}</span></summary>
    <div class="table-wrap"><table class="rows-sm"><thead><tr><th>면접일</th><th>학생</th><th>대학·학과</th><th>지남</th><th></th></tr></thead><tbody>
    ${miss.map((iv) => { const g = ago(iv.date); const name = active.get(String(iv.studentNo))?.name || iv.name || "";
      return `<tr>
      <td class="nowrap" data-l="면접일"><b>${fmtDay(iv.date)}</b></td>
      <td class="nowrap head" data-l="-"><b>${esc(name)}</b> <span class="muted">${esc(iv.studentNo || "")}</span></td>
      <td data-l="대학"><b>${esc(iv.univ || "")}</b> <span class="muted">${esc(iv.dept || "")}</span></td>
      <td class="nowrap ${g <= 0 ? "today" : g >= 7 ? "late" : ""}" data-l="지남">${g <= 0 ? "오늘" : g + "일"}</td>
      <td class="nowrap" data-l="-" style="text-align:right">${sent[iv.id] === today
        ? '<span class="muted sm">오늘 보냄</span>'
        : `<button class="btn-sm" data-nudge="${esc(iv.id)}">안내 보내기</button>`}</td></tr>`; }).join("")}
    </tbody></table></div>
    <p class="muted sm" style="margin:8px 14px 12px">[안내 보내기] = 그 학생 휴대폰에 후기를 남겨 달라는 알림 1번 (알림을 켠 학생만 받아요)</p></details>`;
  const det = $("details", box);
  det.ontoggle = () => { missOpen.v = det.open; };
  $$("[data-nudge]", box).forEach((b) => b.onclick = async () => {
    const iv = miss.find((x) => x.id === b.dataset.nudge);
    if (!iv) return;
    b.disabled = true;
    const ok = await queueNotify({ role: "student", key: String(iv.studentNo), title: `${iv.univ || "대학"} 면접 후기를 남겨 주세요`,
      body: "받은 질문과 답을 기억나는 만큼 적어 두세요 · 5분", url: "student.html", tag: `rv_${iv.id}` });
    if (!ok) { b.disabled = false; return toast("알림을 적어 두지 못했어요. 잠시 뒤 다시 해 주세요.", "error"); }
    markNudged(iv.id);
    toast("안내 알림을 보냈어요. 30분 안에 학생 휴대폰에 도착해요.");
    render();
  });
}

// ---- 후기 하나 자세히 보기
export function openReviewDetail(id) {
  const r = (S.reviews || []).find((x) => x.id === id);
  if (!r) return toast("후기를 찾지 못했어요.", "error");
  const blk = (label, text) => text ? `<h3 style="margin:16px 0 6px;font-size:.98rem">${label}</h3>
    <div class="ans" style="white-space:pre-wrap">${esc(text)}</div>` : "";
  const qa = qaOf(r);
  const qaHtml = qa.length || r.questions ? `<h3 style="margin:16px 0 6px;font-size:.98rem">받은 질문과 실제 답변</h3>
    ${qa.length ? `<div class="rv-qa-view">${qa.map((x, i) => `<p class="q"><b>Q${i + 1}</b>${esc(x.q || "")}</p>
      <p class="a"><b>A</b>${x.a ? esc(x.a) : '<span class="muted">(답 적지 않음)</span>'}</p>`).join("")}</div>` : ""}
    ${r.questions ? `${qa.length ? '<p class="muted sm" style="margin:10px 0 4px">예전에 적은 받은 질문</p>' : ""}<div class="ans" style="white-space:pre-wrap">${esc(r.questions)}</div>` : ""}` : "";
  const body = openModal(`${r.univ || ""} ${r.dept || ""} 면접 후기`, `
    <dl class="kv">
      <dt>학생</dt><dd>${esc(r.studentNo || "")} ${esc(r.name || "")}</dd>
      <dt>면접</dt><dd><b>${r.date ? fmtDay(r.date) : "-"}</b> · ${esc([r.admission, r.format].filter(Boolean).join(" · "))}</dd>
      <dt>분위기</dt><dd>${stageStars(r.mood)} <span class="muted">편안했다 ↔ 긴장됐다</span></dd>
      <dt>체감 난이도</dt><dd>${stageStars(r.difficulty)} <span class="muted">쉬웠다 ↔ 어려웠다</span></dd>
    </dl>
    ${blk("면접 절차 및 진행 방식", r.procedure)}
    ${qaHtml}
    ${blk("기타 유의사항", r.notes)}
    ${blk("준비하면서 도움된 것", r.helped)}
    ${blk("아쉬웠던 것 · 다시 한다면", r.regret)}
    ${hasText(r) ? "" : '<p class="muted" style="margin-top:14px">별점만 남기고 글은 쓰지 않았어요.</p>'}
    <div class="row" style="margin-top:18px">
      <button class="btn-sm" id="rvGoStudent">학생 화면 열기</button>
      <button class="btn-sm" id="rvCopy">질문·답 복사</button>
    </div>`);
  $("#rvGoStudent", body).onclick = () => { closeModal(); openStudent(r.studentNo); };
  $("#rvCopy", body).onclick = async () => {
    const t = qaText(r).trim();
    if (!t) return toast("복사할 질문이 없어요.", "error");
    try { await navigator.clipboard.writeText(t); toast("받은 질문과 답을 복사했어요."); }
    catch (e) { showError(e, "복사"); }
  };
}
