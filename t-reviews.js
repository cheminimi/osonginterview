// 선생님 화면: 학생이 쓴 '대학 면접 후기' 보기
// 후기 1건 = 지원 대학 1곳 (문서 id = 면접일 문서 id).
// 읽기 사용량: 이 화면을 처음 열 때 한 번만 받아 둔다 (다시 받기 버튼으로 갱신).
import { db, collection, getDocs, $, $$, esc, toast, showError, fmtDay, icon } from "./common.js";
import { S, register, myName, openModal, closeModal, opt, switchTab } from "./t-core.js";
import { openStudent } from "./t-students.js";

let root = null;
let loaded = false, loading = null;

export function init(el) {
  root = el;
  root.innerHTML = `
    <div id="rvNotice"></div>
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

const yearOf = (r) => Number(r.year) || (r.date ? Number(String(r.date).slice(0, 4)) + (Number(String(r.date).slice(5, 7)) >= 3 ? 1 : 0) : 0);
const stageStars = (n) => {
  const v = Number(n) || 0;
  if (!v) return '<span class="muted">-</span>';
  return `<span class="stars sm" title="${v}점">${[1, 2, 3, 4, 5].map((i) => `<span class="st${i <= v ? " on" : ""}">${icon("star", 15)}</span>`).join("")}</span>`;
};
const oneLine = (s, n = 70) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean).join(" · ").slice(0, n);
const hasText = (r) => !!(r.questions || r.helped || r.regret);

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
    && (!kw || `${r.name || ""}${r.studentNo || ""}${r.univ || ""}${r.dept || ""}${r.questions || ""}${r.helped || ""}${r.regret || ""}`.includes(kw)));

  renderNotice(list0, who);

  if (!list.length) {
    $("#rvBody", root).innerHTML = `<tr><td colspan="7" class="empty">${list0.length ? "조건에 맞는 후기가 없습니다." : "아직 들어온 후기가 없습니다. 학생이 면접 다음날부터 쓸 수 있어요."}</td></tr>`;
    return;
  }
  $("#rvBody", root).innerHTML = list.map((r) => `
    <tr class="clickable" data-id="${esc(r.id)}">
      <td class="nowrap" data-l="면접일"><b>${r.date ? fmtDay(r.date) : "-"}</b></td>
      <td class="nowrap head" data-l="-"><b>${esc(r.name || "")}</b> <span class="muted">${esc(r.studentNo || "")}</span></td>
      <td data-l="대학"><b>${esc(r.univ || "")}</b> <span class="muted">${esc(r.dept || "")}</span></td>
      <td class="pack" data-l="전형">${esc(r.admission || "")}</td>
      <td class="pack" data-l="받은 질문">${esc(oneLine(r.questions)) || '<span class="muted">-</span>'}</td>
      <td class="nowrap" data-l="분위기">${stageStars(r.mood)}</td>
      <td class="nowrap" data-l="난이도">${stageStars(r.difficulty)}</td>
    </tr>`).join("");
  $$("#rvBody tr[data-id]", root).forEach((tr) => tr.onclick = () => openReviewDetail(tr.dataset.id));
}

// 몇 건이 들어왔고 몇 건이 아직인지
function renderNotice(list, who) {
  const box = $("#rvNotice", root);
  const me = myName();
  const today = new Date().toISOString().slice(0, 10);
  // 내(또는 전체) 담당 학생의 '이미 치른 대학 면접' 수
  const scope = who === "mine" && me
    ? S.students.filter((s) => { const a = s.assign || {}; return [a.s1, a.s2, a.s3a, a.s3b].filter(Boolean).includes(me); })
    : S.students;
  const nos = new Set(scope.map((s) => String(s.studentNo)));
  const past = (S.interviews || []).filter((iv) => nos.has(String(iv.studentNo)) && iv.date && String(iv.date) < today);
  const written = list.filter((r) => nos.has(String(r.studentNo)) && hasText(r)).length;
  if (!past.length) { box.innerHTML = ""; return; }
  const left = Math.max(0, past.length - written);
  box.innerHTML = `<div class="notice">면접을 마친 <b>${past.length}건</b> 가운데 <b>${written}건</b>의 후기가 들어왔습니다.
    ${left ? `나머지 ${left}건은 아직 학생이 쓰지 않았어요.` : "모두 들어왔어요."}</div>`;
}

// ---- 후기 하나 자세히 보기
export function openReviewDetail(id) {
  const r = (S.reviews || []).find((x) => x.id === id);
  if (!r) return toast("후기를 찾지 못했어요.", "error");
  const blk = (label, text) => text ? `<h3 style="margin:16px 0 6px;font-size:.98rem">${label}</h3>
    <div class="ans" style="white-space:pre-wrap">${esc(text)}</div>` : "";
  const body = openModal(`${r.univ || ""} ${r.dept || ""} 면접 후기`, `
    <dl class="kv">
      <dt>학생</dt><dd>${esc(r.studentNo || "")} ${esc(r.name || "")}</dd>
      <dt>면접</dt><dd><b>${r.date ? fmtDay(r.date) : "-"}</b> · ${esc([r.admission, r.format].filter(Boolean).join(" · "))}</dd>
      <dt>분위기</dt><dd>${stageStars(r.mood)} <span class="muted">편안했다 ↔ 긴장됐다</span></dd>
      <dt>체감 난이도</dt><dd>${stageStars(r.difficulty)} <span class="muted">쉬웠다 ↔ 어려웠다</span></dd>
    </dl>
    ${blk("실제로 받은 질문", r.questions)}
    ${blk("준비하면서 도움된 것", r.helped)}
    ${blk("아쉬웠던 것 · 다시 한다면", r.regret)}
    ${hasText(r) ? "" : '<p class="muted" style="margin-top:14px">별점만 남기고 글은 쓰지 않았어요.</p>'}
    <div class="row" style="margin-top:18px">
      <button class="btn-sm" id="rvGoStudent">학생 화면 열기</button>
      <button class="btn-sm" id="rvCopy">질문 복사</button>
    </div>`);
  $("#rvGoStudent", body).onclick = () => { closeModal(); openStudent(r.studentNo); };
  $("#rvCopy", body).onclick = async () => {
    const t = String(r.questions || "").trim();
    if (!t) return toast("복사할 질문이 없어요.", "error");
    try { await navigator.clipboard.writeText(t); toast("받은 질문을 복사했어요."); }
    catch (e) { showError(e, "복사"); }
  };
}
