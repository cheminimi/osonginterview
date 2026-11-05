import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  $, $$, esc, toast, showError, typeBadge, TYPES, FIELDS, TRACKS,
  deleteField, passageItems, passageReady, passageSchool, PASSAGE_MAX_ITEMS, univName
} from "./common.js";
import { S, register, openModal, closeModal, readForm, lines, opt, ensureBank } from "./t-core.js";
import { mathHtml, hasMath, MATH_INSERTS, MATH_HELP } from "./math.js";
import { SEED_QUESTIONS } from "./seed-questions.js";
import { savePersonal } from "./t-questions.js";

// 이 화면에서 부르는 유형 이름 (TYPES.document.label 은 '학생부 기반' 그대로)
const BT = { document: "학생부 공통", personality: "기본 인성", mmi: "MMI", passage: "제시문" };
const MK = ["상황", "인성", "시사"];   // MMI 종류 (mmiKind). 없으면 '상황'
const MK_PH = { 상황: "예) 조별 과제 발표 전날, 한 조원이 자료를 하나도 준비하지 않았다는 사실을 알게 되었다.",
  인성: "예) 시험 중 가장 친한 친구가 부정행위를 하는 것을 보았다. 감독 선생님은 보지 못했다.",
  시사: "예) [기사 요약] 지방 의료원의 응급실 전문의가 부족해 야간 진료를 멈추는 곳이 늘고 있다. 정부는 …" };
const MK_Q = { 상황: "예) 당신이라면 어떻게 하겠습니까?", 인성: "예) 친구와의 관계와 원칙 사이에서 어떻게 판단하겠습니까?", 시사: "예) 이 문제의 원인과 해결 방안을 말해 보세요." };
const mkOf = (q) => MK.includes(q.mmiKind) ? q.mmiKind : "상황";

let root;
const sel = new Set();
const fresh = new Set();   // '방금 추가' 표시 (저장 안 함 — 이 화면을 떠나면 사라짐)
let pill = "", mode = "line", mk = "", mkNew = "상황", dragQ = null;
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="bk-top"><div class="bk-row1">
      <div class="bk-pills" id="bPills"></div>
      <div class="bk-flt"><select id="bField" aria-label="계열">${opt(FIELDS, "", "계열 전체")}</select>
        <select id="bUniv" aria-label="제시문 학교" hidden></select>
        <label class="bk-srch"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="bSearch" placeholder="낱말로 찾기 (예: 윤리 · 충북대)" title="질문·제시문·문항·학교·전형·주제·대상 학과·꼬리질문·의도에서 찾아요" aria-label="낱말로 찾기"></label></div>
    </div><div class="bk-sub" id="bMk" hidden></div></div>
    <div id="bQuick"></div>
    <div class="toolbar" id="bSelBar" hidden>
      <span id="bSelCount"></span>
      <button class="btn-primary btn-sm" id="bAssign">선택한 질문을 학생에게 배정</button>
      <button class="btn-sm" id="bClear">선택 해제</button>
    </div>
    <div id="bList"></div>`;
  ["#bField", "#bUniv"].forEach((s) => $(s, root).onchange = render);
  $("#bSearch", root).oninput = render;   // 검색 칸은 다시 그리지 않음 (커서가 튀지 않게)
  $("#bClear", root).onclick = () => { sel.clear(); render(); };
  $("#bAssign", root).onclick = assignModal;
  bindPills();
  // 다른 화면으로 가면 '방금 추가' 표시를 지운다
  const sec = root.closest("[data-panel]") || root;
  new MutationObserver(() => { if (sec.hidden && fresh.size) { fresh.clear(); render(); } }).observe(sec, { attributes: true, attributeFilter: ["hidden"] });
  drawQuick();
  register("bank", render);
}

// 시간(초) → "10분" · "1분 30초"
const minTxt = (sec) => { const n = Math.round(Number(sec) || 0); const m = Math.floor(n / 60), r = n % 60; return m && r ? `${m}분 ${r}초` : m ? `${m}분` : `${r}초`; };
const schoolsOf = () => [...new Set(S.bank.filter((q) => q.type === "passage").map((q) => univName(q.univ)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
const isOldPassage = (q) => q.type === "passage" && !String(q.univ || "").trim();
const searchText = (q) => `${q.text}${q.passage}${(q.majors || []).join()}${q.univ || ""}${q.admission || ""}${q.topic || ""}${passageItems(q).map((x) => x.q).join()}${(q.followUps || []).join()}${q.intent || ""}`;
const seedMissing = () => { const have = new Set(S.bank.map((q) => q.seedId).filter(Boolean)); return SEED_QUESTIONS.filter((q) => !have.has(q.seedId)).length; };
const noSpace = (s) => String(s || "").replace(/\s/g, "");
const NEW_TAG = '<span class="bk-new">방금 추가</span>';

function drawPills() {
  const cnt = (t) => S.bank.filter((q) => q.type === t).length;
  $("#bPills", root).innerHTML = `<button type="button" class="bk-pill ${pill ? "" : "on"}" data-pill="">전체 <span>${S.bank.length}</span></button>`
    + Object.keys(BT).map((k) => `<button type="button" class="bk-pill ${TYPES[k].color} ${pill === k ? "on" : ""}" data-pill="${k}"><i></i>${BT[k]} <span>${cnt(k)}</span></button>`).join("");
  const box = $("#bMk", root);
  box.hidden = pill !== "mmi";
  box.innerHTML = pill !== "mmi" ? "" : `<span class="lab">MMI 종류</span><button type="button" data-mk="" class="${mk ? "" : "on"}">전체 <span>${cnt("mmi")}</span></button>`
    + MK.map((k) => `<button type="button" data-mk="${k}" class="${mk === k ? "on" : ""}">${k} <span>${S.bank.filter((q) => q.type === "mmi" && mkOf(q) === k).length}</span></button>`).join("");
  $$("[data-mk]", box).forEach((b) => b.onclick = () => { mk = b.dataset.mk; if (mk) { mkNew = mk; pickKind(mk); } render(); });
}

function render() {
  if (!S.bankLoaded) {
    $("#bList", root).innerHTML = '<div class="card empty">질문은행 불러오는 중…</div>';
    ensureBank().then(render).catch((e) => showError(e, "질문은행 불러오기"));
    return;
  }
  const uSel = $("#bUniv", root), schools = schoolsOf();
  if (uSel.dataset.list !== schools.join("|")) {
    uSel.innerHTML = opt(schools, schools.includes(uSel.value) ? uSel.value : "", "제시문 학교 전체");
    uSel.dataset.list = schools.join("|");
  }
  uSel.hidden = pill !== "passage" || !schools.length;
  drawPills();
  if (!pill) drawQuick();   // 기본 질문 불러오기 단추 개수
  const t = pill, f = $("#bField", root).value, u = pill === "passage" ? uSel.value : "", kw = $("#bSearch", root).value.trim();
  const list = S.bank.filter((q) => (!t || q.type === t) && (t !== "mmi" || !mk || mkOf(q) === mk) && (!f || q.track === f)
    && (!u || univName(q.univ) === u)
    && (!kw || searchText(q).includes(kw)));
  // 방금 넣은 질문을 맨 위로 (나중에 넣은 것이 먼저)
  const order = [...fresh];
  list.sort((a, b) => order.indexOf(b.id) - order.indexOf(a.id));
  $("#bSelBar", root).hidden = !sel.size;
  $("#bSelCount", root).textContent = `${sel.size}개 선택됨`;
  if (!list.length) {
    const n = seedMissing();
    $("#bList", root).innerHTML = `<div class="card empty">${S.bank.length ? "조건에 맞는 질문이 없습니다." : n ? `질문은행이 비어 있습니다. '전체'의 [기본 질문 ${n}개 불러오기]로 시작해 보세요.` : "질문은행이 비어 있습니다."}</div>`;
    return;
  }
  const hl = (s) => { const e = esc(s); if (!kw) return e; const k = esc(kw); return e.split(k).join(`<mark class="bk-m">${k}</mark>`); };
  $("#bList", root).innerHTML = `<div class="row bk-lh"><span class="muted">${kw ? `<span class="bk-hit">'<b>${esc(kw)}</b>' 들어간 질문 </span>` : ""}${list.length}개${t ? ` · ${BT[t]}${t === "mmi" && mk ? " · " + mk : ""}` : ""}</span><div class="spacer"></div>
      ${t !== "passage" ? '<span class="bk-sm bk-gh"><span class="bk-grip">⋮⋮</span> 를 잡고 위 유형 단추에 놓으면 유형이 바뀌어요</span>' : ""}</div>
    <div class="bk-list">` + list.map((q) => `
    <div class="q-item ${sel.has(q.id) ? "sel" : ""} ${fresh.has(q.id) ? "fresh" : ""}" data-qid="${esc(q.id)}">
      ${q.type === "passage" ? passageRow(q) : `
      <div class="row"><span class="bk-grip" draggable="true" data-grip="${esc(q.id)}" title="끌어서 유형 바꾸기">⋮⋮</span><input type="checkbox" data-sel="${q.id}" ${sel.has(q.id) ? "checked" : ""} style="width:auto">
        ${typeBadge(q.type)}${q.type === "mmi" ? `<span class="badge mk-b">${mkOf(q)}</span>` : ""} <span class="badge">${esc(q.track || "공통")}</span>
        ${(q.majors || []).map((m) => `<span class="badge badge-gray">${esc(m)}</span>`).join(" ")}${fresh.has(q.id) ? NEW_TAG : ""}</div>
      <div class="q-text pre" style="margin-top:6px">${hl(q.text)}</div>
      ${q.passage ? `<details><summary class="muted">제시문 보기</summary><div class="pre ans">${esc(q.passage)}</div></details>` : ""}
      <div class="q-meta">${q.intent ? `의도: ${esc(q.intent)} · ` : ""}${q.prepSec ? `준비 ${q.prepSec}초 · ` : ""}답변 ${q.answerSec ?? TYPES[q.type]?.answer}초</div>`}
      ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="q-actions"><button class="btn-sm" data-edit="${q.id}">수정</button><button class="btn-sm btn-danger" data-rm="${q.id}">삭제</button></div>
    </div>`).join("") + "</div>";
  $$("[data-sel]", root).forEach((c) => c.onchange = () => { c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); render(); });
  $$("[data-edit]", root).forEach((b) => b.onclick = () => edit(S.bank.find((q) => q.id === b.dataset.edit)));
  $$("[data-rm]", root).forEach((b) => b.onclick = async () => {
    if (!confirm("이 질문을 삭제할까요?")) return;
    try { await deleteDoc(doc(db, "questions", b.dataset.rm)); S.bank = S.bank.filter((q) => q.id !== b.dataset.rm); sel.delete(b.dataset.rm); fresh.delete(b.dataset.rm); render(); }
    catch (e) { showError(e, "질문 삭제"); }
  });
  $$("[data-grip]", root).forEach((g) => {
    g.addEventListener("dragstart", (e) => {
      dragQ = S.bank.find((q) => q.id === g.dataset.grip);
      const card = g.closest(".q-item");
      e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragQ.id); e.dataTransfer.setDragImage(card, 16, 16);
      card.classList.add("dragging");
      $$("[data-pill]", root).forEach((p) => { const can = canDrop(p); p.classList.toggle("can", can); p.classList.toggle("nodrop", !can); });
    });
    g.addEventListener("dragend", () => { dragQ = null; endDrag(); });
  });
}

// ---- 유형 단추: 누르면 거르기 · ⋮⋮ 를 놓으면 유형 바꾸기 (단추를 다시 그려도 그대로 되게 #bPills 에 건다)
const canDrop = (p) => !!dragQ && !["", "passage", dragQ.type].includes(p.dataset.pill);
function endDrag() {
  $$(".q-item.dragging", root).forEach((x) => x.classList.remove("dragging"));
  $$("[data-pill]", root).forEach((p) => p.classList.remove("can", "nodrop", "drop"));
}
function bindPills() {
  const box = $("#bPills", root), at = (e) => e.target.closest?.("[data-pill]");
  box.onclick = (e) => { const p = at(e); if (!p) return; pill = p.dataset.pill; drawQuick(); render(); };
  box.addEventListener("dragover", (e) => { const p = at(e); if (p && canDrop(p)) { e.preventDefault(); p.classList.add("drop"); } });
  box.addEventListener("dragleave", (e) => at(e)?.classList.remove("drop"));
  box.addEventListener("drop", (e) => {
    const p = at(e); if (!p || !canDrop(p)) return;
    e.preventDefault();
    const q = dragQ; dragQ = null; endDrag();
    moveType(q, p.dataset.pill);
  });
}
async function moveType(q, to) {
  const from = q.type, had = "mmiKind" in q;
  const back = { type: from, prepSec: q.prepSec, answerSec: q.answerSec, ...(had ? { mmiKind: q.mmiKind } : {}) };
  const next = { type: to, prepSec: TYPES[to].prep, answerSec: TYPES[to].answer, ...(to === "mmi" ? { mmiKind: "상황" } : {}) };
  const patch = async (vals, hasKind) => {
    await updateDoc(doc(db, "questions", q.id), { ...vals, ...(hasKind ? {} : { mmiKind: deleteField() }) });
    Object.assign(q, vals); if (!hasKind) delete q.mmiKind;
    render();
  };
  try { await patch(next, to === "mmi"); }
  catch (e) { return showError(e, "유형 바꾸기"); }
  const head = String(q.text || "").slice(0, 18);
  bkToast(`'${esc(head)}…' 을(를) ${esc(BT[from])} → <b>${esc(BT[to])}</b>${to === "mmi" ? "로" : "으로"} 옮겼어요${to === "mmi" ? " · 종류 상황 · 제시문은 [수정]에서 넣어 주세요" : ""}`,
    () => patch(back, had).catch((e) => showError(e, "되돌리기")));
}
// 되돌리기 단추가 있는 작은 알림 (common.js toast 는 단추를 못 담음)
let bkTimer = 0;
function bkToast(html, undo) {
  $(".bk-toast")?.remove();
  const el = document.createElement("div");
  el.className = "bk-toast";
  el.innerHTML = `<span>${html}</span><button type="button">되돌리기</button>`;
  $("button", el).onclick = () => { el.remove(); undo(); };
  document.body.append(el);
  clearTimeout(bkTimer); bkTimer = setTimeout(() => el.remove(), 4500);
}

// ---- 유형 단추 아래: 그 유형 질문 넣기 칸
const fieldOpts = () => opt(FIELDS);
const enterIsIME = (e) => e.isComposing || e.keyCode === 229;   // 한글 입력 중 Enter 는 무시 (글자 잘림·두 번 넣기 방지)
async function addOne(d, restore) {
  const q = normalizeBank(d);
  try {
    const ref = await addDoc(collection(db, "questions"), { ...q, createdAt: serverTimestamp() });
    S.bank.push({ id: ref.id, ...q }); fresh.add(ref.id);
    render();
    return true;
  } catch (e) { showError(e, "질문 저장"); restore?.(); return false; }
}
function drawQuick() {
  const box = $("#bQuick", root);
  if (!pill) {
    const n = S.bankLoaded ? seedMissing() : 0;
    box.innerHTML = `<div class="bk-tip">${n ? `<button type="button" class="btn-sm" id="bSeed">기본 질문 ${n}개 불러오기</button>` : ""}<span>💡 질문을 넣으려면 먼저 위에서 <b>유형을 골라요</b> — 그 유형을 넣는 칸이 여기 열려요.</span> <span class="bk-sm">학생부 공통·기본 인성은 한 줄 쓰고 <kbd>Enter</kbd> · MMI 는 종류 고르고 제시문·질문 · 제시문은 [+ 제시문 추가]</span></div>`;
    if (n) $("#bSeed", box).onclick = seed;
    return;
  }
  if (pill === "passage") {
    box.innerHTML = `<div class="bk-q violet"><div class="bk-qh"><span class="badge badge-violet">제시문</span><b>제시문 질문 넣기</b><span class="bk-sm">학교·전형·주제·제시문·문항·숙독/답변 시간이 필요해서 큰 창에서 넣어요</span><div class="spacer"></div><button type="button" class="btn-primary btn-sm" id="bPsg">+ 제시문 추가</button></div></div>`;
    $("#bPsg", box).onclick = () => edit();
    return;
  }
  if (pill === "mmi") return drawQuickMmi(box);
  const t = TYPES[pill];
  const ex = pill === "personality" ? ["지원자가 생각하는 책임감이란 무엇인가요?", "친구와 의견이 부딪혔을 때 어떻게 해결했나요?"] : ["고등학교 생활 중 가장 기억에 남는 활동은 무엇인가요?", "우리 학과에 지원한 이유를 말해 주세요."];
  const tabs = `<div class="bk-seg"><button type="button" data-mode="line" class="${mode === "line" ? "on" : ""}">한 줄씩</button><button type="button" data-mode="paste" class="${mode === "paste" ? "on" : ""}">여러 개 한 번에</button></div>`;
  const body = mode === "line" ? `<div class="bk-lw"><div>
      <div class="bk-line"><input id="bqL" placeholder="예) ${esc(ex[0])}" autocomplete="off" aria-label="질문"><select id="bqLF" aria-label="계열">${fieldOpts()}</select><button type="button" class="btn-primary btn-sm" id="bqLA">추가</button></div>
      <div class="bk-fu"><label for="bqLU">꼬리질문 <span class="muted" style="font-weight:500">(선택 · 한 줄에 하나)</span><span class="n" id="bqLN"></span></label>
        <textarea id="bqLU" placeholder="그 생각을 행동으로 보여 준 경험이 있나요?&#10;그때 다르게 했다면 어땠을까요?"></textarea></div></div>
      <div class="bk-how"><div class="t">쓰는 법</div>
        <div><b>질문 칸</b> <kbd>Enter</kbd> → 넣기 (꼬리질문도 함께)</div>
        <div><b>꼬리질문 칸</b> <kbd>Enter</kbd> → 줄 바꿈 = 하나 더</div>
        <div><b>꼬리질문 칸</b> <kbd>Ctrl</kbd>+<kbd>Enter</kbd> → 넣기</div>
        <div class="ex"><b>Q</b> 질문 &nbsp;<span class="muted">↳ 꼬리질문 1 · ↳ 꼬리질문 2</span></div></div></div>`
    : `<div class="bk-paste"><div><textarea id="bqPt" aria-label="질문 목록" placeholder="한 줄에 질문 하나.&#10;꼬리질문은 줄 앞에 - 를 붙여서 바로 아래에.&#10;&#10;${esc(ex[0])}&#10;- 그 생각을 행동으로 보여 준 경험은?&#10;${esc(ex[1])}"></textarea>
        <div class="row" style="margin-top:8px"><select id="bqPF" style="width:auto" aria-label="계열">${fieldOpts()}</select><span class="bk-sm">한글·워드·시트, <b>AI(Claude 등)에게 받은 질문 목록</b>도 그대로 붙여요. 번호(1. ①)는 알아서 빼요</span></div></div>
      <div><div class="bk-pv" id="bqPV"></div><div class="row" style="margin-top:8px"><div class="spacer"></div><button type="button" class="btn-primary" id="bqPA" disabled>넣기</button></div></div></div>`;
  box.innerHTML = `<div class="bk-q ${t.color}"><div class="bk-qh">${typeBadge(pill)}<b>${BT[pill]} 질문 넣기</b><span class="bk-sm">질문만 쓰면 돼요 — 계열 공통 · 답변 ${t.answer}초 · 의도·학과는 나중에 [수정]에서</span><div class="spacer"></div>${tabs}</div>${body}</div>`;
  $$("[data-mode]", box).forEach((b) => b.onclick = () => { mode = b.dataset.mode; drawQuick(); });
  if (mode === "line") bindLine(box); else bindPaste(box);
}
function bindLine(box) {
  const L = $("#bqL", box), U = $("#bqLU", box), F = $("#bqLF", box);
  const count = () => { const n = lines(U.value).length; $("#bqLN", box).textContent = n ? `${n}개` : ""; };
  const go = async () => {
    const text = L.value.trim();
    if (!text) return L.focus();
    const fu = U.value;
    // 먼저 칸을 비운다 — 이어서 눌러도 두 번 들어가지 않게. 저장에 실패하면 되돌려 놓음
    L.value = ""; U.value = ""; count(); L.focus();
    await addOne({ type: pill, track: F.value, text, followUps: lines(fu) }, () => { if (!L.value) L.value = text; if (!U.value) U.value = fu; count(); });
  };
  $("#bqLA", box).onclick = go;
  L.addEventListener("keydown", (e) => { if (e.key === "Enter" && !enterIsIME(e)) { e.preventDefault(); go(); } });
  U.addEventListener("input", count);
  U.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !enterIsIME(e)) { e.preventDefault(); go(); } });
}
/** 붙여 넣은 글 → 질문 목록. 줄 앞 - ㄴ ↳ └ > 는 바로 위 질문의 꼬리질문, 질문 줄 앞 번호·기호는 뺌, 이미 있는 질문은 dup */
export function parsePaste(txt, existing = []) {
  const out = [], FU = /^\s*(-|ㄴ|↳|└|>)\s*/;
  const clean = (l) => l.replace(FU, "").replace(/^\s*(\d{1,2}[.)](?!\d)|[①-⑳]|Q\d*[.:)]|Q\d+(?=\s)|[•·*])\s*/, "").trim();
  String(txt || "").split("\n").forEach((raw) => {
    if (!raw.trim()) return;
    if (FU.test(raw) && out.length) { const f = raw.replace(FU, "").trim(); if (f) out[out.length - 1].followUps.push(f); }
    else { const text = clean(raw); if (text) out.push({ text, followUps: [] }); }
  });
  const seen = new Set(existing.map(noSpace));
  return out.map((q) => { const k = noSpace(q.text), dup = seen.has(k); seen.add(k); return { ...q, dup }; });
}
function bindPaste(box) {
  const P = $("#bqPt", box), V = $("#bqPV", box), A = $("#bqPA", box);
  const parsed = () => parsePaste(P.value, S.bank.map((q) => q.text));
  const pv = () => {
    const qs = parsed(), ok = qs.filter((q) => !q.dup), fu = ok.reduce((a, q) => a + q.followUps.length, 0);
    V.innerHTML = qs.length ? `<b>질문 ${ok.length}개${fu ? ` · 꼬리질문 ${fu}개` : ""}</b>${qs.length - ok.length ? ` <span class="bk-sm">· 이미 있는 질문 ${qs.length - ok.length}개는 빼요</span>` : ""}
      <ol>${qs.map((q) => `<li class="${q.dup ? "dup" : ""}">${esc(q.text)}${q.followUps.map((f) => `<small>↳ ${esc(f)}</small>`).join("")}${q.dup ? "<small>이미 있어요</small>" : ""}</li>`).join("")}</ol>`
      : '<span class="bk-sm">붙여 넣으면 여기서 미리 봐요</span>';
    A.disabled = !ok.length; A.textContent = ok.length ? `${ok.length}개 넣기` : "넣기";
  };
  P.addEventListener("input", pv); pv();
  A.onclick = async () => {
    const ok = parsed().filter((q) => !q.dup);
    if (!ok.length) return;
    A.disabled = true;
    const track = $("#bqPF", box).value;
    if (await addMany(ok.map((q) => normalizeBank({ type: pill, track, text: q.text, followUps: q.followUps })), true)) P.value = "";
    pv();
  };
}
function pickKind(k) {
  const box = $("#bqKind", root); if (!box) return;
  $$("[data-mkn]", box).forEach((x) => x.classList.toggle("on", x.dataset.mkn === k));
  $("#bqS", root).placeholder = MK_PH[k]; $("#bqQ", root).placeholder = MK_Q[k];
}
function drawQuickMmi(box) {
  const k0 = mk || mkNew;
  box.innerHTML = `<div class="bk-q orange"><div class="bk-qh"><span class="badge badge-orange">MMI</span><b>MMI 질문 넣기</b><span class="bk-sm">종류 고르고 제시문·질문만 — 시간은 기본값(준비 2분 · 답변 3분)</span></div>
    <div class="row" style="margin-bottom:10px;gap:8px"><b style="font-size:.88rem">종류</b><span class="mk-pick" id="bqKind">${MK.map((k) => `<button type="button" data-mkn="${k}" class="${k0 === k ? "on" : ""}">${k}</button>`).join("")}</span><span class="bk-sm">상황 = 겪을 만한 장면 · 인성 = 가치·윤리 판단 · 시사 = 기사·사회 문제</span></div>
    <div class="bk-mmi"><div class="field" style="margin:0"><label for="bqS">제시문 * <span class="muted" style="font-weight:500">(상황·사례·기사 글)</span></label><textarea id="bqS" placeholder="${esc(MK_PH[k0])}"></textarea></div>
      <div><div class="field" style="margin:0 0 8px"><label for="bqQ">질문 *</label><input id="bqQ" placeholder="${esc(MK_Q[k0])}" autocomplete="off"></div>
        <div class="field" style="margin:0 0 8px"><label for="bqF">꼬리질문 <span class="muted">(선택 · 한 줄에 하나)</span></label><textarea id="bqF" rows="2" style="min-height:58px" placeholder="그 조원이 아파서 그랬다면?&#10;교수님께 알려야 할까요?"></textarea></div>
        <div class="bk-tm"><label class="bk-sm">준비 <input id="bqP" type="number" value="2" min="0" step="0.5">분</label><label class="bk-sm">답변 <input id="bqA" type="number" value="3" min="0.5" step="0.5">분</label>
          <select id="bqFd" style="width:auto" aria-label="계열">${fieldOpts()}</select><div class="spacer"></div><button type="button" class="btn-primary" id="bqAdd">추가</button></div></div></div></div>`;
  $$("[data-mkn]", box).forEach((b) => b.onclick = () => { mkNew = b.dataset.mkn; pickKind(mkNew); });
  const secOf = (v) => (v === "" ? "" : Math.round(Number(v) * 60));
  $("#bqAdd", box).onclick = async () => {
    const S1 = $("#bqS", box), Q = $("#bqQ", box), F = $("#bqF", box);
    const passage = S1.value.trim(), text = Q.value.trim(), fu = F.value;
    if (!passage || !text) return toast("제시문과 질문을 넣어 주세요", "error");
    const mmiKind = $("#bqKind .on", box)?.dataset.mkn || "상황";
    S1.value = ""; Q.value = ""; F.value = ""; S1.focus();
    await addOne({ type: "mmi", mmiKind, passage, text, followUps: lines(fu), track: $("#bqFd", box).value, prepSec: secOf($("#bqP", box).value), answerSec: secOf($("#bqA", box).value) },
      () => { if (!S1.value) S1.value = passage; if (!Q.value) Q.value = text; if (!F.value) F.value = fu; });
  };
}

// 제시문 한 줄: [제시문] 학교 · 전형 · 주제 / 문항 n개 · 숙독 · 답변 · 계열 · 학과 (예전 양식은 표시만 하고 부스·연습에서 쓰지 않음)
function passageRow(q) {
  const its = passageItems(q), ready = passageReady(q), old = isOldPassage(q);
  const head = old ? `<span class="badge badge-orange">예전 양식</span> <span class="q-text">${esc(String(q.text || "").split("\n")[0].slice(0, 60))}${String(q.text || "").length > 60 ? " …" : ""}</span>`
    : `<b class="pb-school">${esc(passageSchool(q))}</b> · <span class="q-text">${esc(q.topic || "(주제 없음)")}</span>`;
  const meta = [old ? "" : `문항 ${its.length}개`, !old && q.prepSec ? `숙독 ${minTxt(q.prepSec)}` : "", !old && q.answerSec ? `답변 ${minTxt(q.answerSec)}` : "",
    q.track || "공통", (q.majors || []).join(", ")].filter(Boolean).join(" · ");
  return `<div class="row"><input type="checkbox" data-sel="${q.id}" ${sel.has(q.id) ? "checked" : ""} style="width:auto">
      ${typeBadge(q.type)} ${head}${fresh.has(q.id) ? NEW_TAG : ""}</div>
    <div class="q-meta" style="margin-top:4px">${esc(meta)}</div>
    ${ready ? "" : `<div class="pb-warn">${old ? "예전 양식 — 부스·연습에서 쓰지 않아요. 학교·주제·문항·시간을 넣어 다시 저장하거나 지워 주세요."
      : "빈 칸이 있어 부스·연습에서 쓰지 않아요 — 학교·주제·제시문·문항·숙독·답변 시간을 모두 넣어 주세요."}</div>`}
    ${!old && its.length ? `<ol class="pb-items">${its.map((x) => `<li>${mathHtml(x.q)}</li>`).join("")}</ol>` : old ? `<div class="pre muted" style="margin-top:6px;font-size:.9rem">${esc(q.text || "")}</div>` : ""}
    ${q.passage ? `<details><summary class="muted">제시문 보기</summary><div class="pre ans">${mathHtml(q.passage)}</div></details>` : ""}
    ${q.intent ? `<div class="q-meta">의도: ${esc(q.intent)}</div>` : ""}`;
}

export function normalizeBank(d) {
  const type = TYPES[d.type] ? d.type : "document";
  const num = (x, def) => (x === "" || x == null || isNaN(Number(x))) ? def : Number(x);
  const base = {
    type, track: FIELDS.includes(d.track) ? d.track : "공통",
    majors: Array.isArray(d.majors) ? d.majors.map(String).filter(Boolean) : String(d.majors || "").split(/[,，]/).map((m) => m.trim()).filter(Boolean),
    text: String(d.text || "").trim(), passage: String(d.passage || "").trim(),
    prepSec: num(d.prepSec, TYPES[type].prep), answerSec: num(d.answerSec, TYPES[type].answer),
    intent: String(d.intent || "").trim(),
    followUps: Array.isArray(d.followUps) ? d.followUps.map(String).filter(Boolean) : lines(d.followUps)
  };
  if (type === "mmi") return { ...base, mmiKind: MK.includes(d.mmiKind) ? d.mmiKind : "상황" };
  if (type !== "passage") return base;
  // 제시문: 학교·전형·주제·문항 목록. 숙독·답변 시간은 기본값으로 채우지 않는다 (선생님이 반드시 넣음 — 비면 null)
  const items = passageItems(d).slice(0, PASSAGE_MAX_ITEMS);
  const sec = (x) => { const n = num(x, null); return n != null && n > 0 ? Math.round(n) : null; };
  return { ...base, univ: univName(d.univ), admission: String(d.admission || "").trim(), topic: String(d.topic || "").trim(),
    items, text: items[0]?.q || base.text, prepSec: sec(d.prepSec), answerSec: sec(d.answerSec) };
}
/** 예전 제시문의 text("(1) … (2) …")를 문항으로 나눔 — 줄 머리·띄어쓰기 뒤의 (1) 1. 1) ① 를 경계로 */
export function splitOldPassageText(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const parts = t.replace(/(^|\s)(\(\d{1,2}\)|[①-⑩]|\d{1,2}[.)](?=\s))\s*/g, "$1\u0000").split("\u0000").map((x) => x.trim()).filter(Boolean);
  return parts.length ? parts : [t];
}

const PASSAGE_ONLY = ["univ", "admission", "topic", "items"];
// 큰 창 = [수정]과 [+ 제시문 추가]만. 유형 고르기 칸 없음 (제시문은 유형을 못 바꿈)
function edit(q = null) {
  const v = q || { type: "passage", track: "공통" };
  const isP0 = v.type === "passage";
  // 예전 제시문을 열면 text 를 문항으로 나눠 넣어 주고, 시간 칸은 비워 둔다 (선생님이 새로 넣음)
  const old = isP0 && !!q && !String(v.univ || "").trim();
  const items0 = isP0 ? (passageItems(v).length ? passageItems(v).map((x) => x.q) : splitOldPassageText(v.text)) : [];
  const minVal = (sec) => (!old && Number(sec) > 0 ? String(Math.round(Number(sec) / 6) / 10) : "");
  const univs = [...new Set([...schoolsOf(), ...(S.interviews || []).map((x) => univName(x.univ)).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "ko"));
  const adms = [...new Set([...S.bank.filter((x) => x.type === "passage").map((x) => String(x.admission || "").trim()), ...(S.interviews || []).map((x) => String(x.admission || "").trim())].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const title = (t) => `${BT[t] || t} ${q ? "수정" : "추가"}`;
  const hint = q ? `유형을 바꾸려면 목록에서 ⋮⋮ 를 끌어 위 유형 단추에 놓아요${isP0 ? " (제시문은 못 바꿈)" : ""}` : "제시문 질문을 넣는 칸이에요";
  const head = `<div class="row bk-mh"><span id="bmBadge">${typeBadge(v.type)}</span><span class="bk-sm">${hint}</span><div class="spacer"></div>
    ${isP0 ? "" : `<select id="bmType" aria-label="유형 바꾸기"><option value="">유형 바꾸기</option>${["document", "personality", "mmi"].map((k) => `<option value="${k}">${BT[k]}</option>`).join("")}</select>`}</div>`;
  const passageFields = `
    <input type="hidden" name="type" value="passage">
    <div class="field"><label>계열</label><select name="track" style="width:auto;min-width:180px">${opt(FIELDS, v.track)}</select></div>
    ${old ? `<div class="pb-warn" style="margin:0 0 12px">예전 양식이에요. 문항을 1·2·3번으로 나눠 넣어 두었어요 — 학교·주제·숙독·답변 시간을 넣고 저장하면 부스·연습에서 써요.</div>` : ""}
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>학교 *</label><input name="univ" list="pbUnivs" value="${esc(v.univ || "")}" placeholder="이미 쓴 학교는 골라 넣기" autocomplete="off"></div>
      <div class="field"><label>전형</label><input name="admission" list="pbAdms" value="${esc(v.admission || "")}" placeholder="예) 학생부종합 (면접형)" autocomplete="off"></div>
    </div>
    <datalist id="pbUnivs">${univs.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <datalist id="pbAdms">${adms.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <div class="field"><label>주제 * <span class="muted">— 목록·부스에서 제목처럼 보여요</span></label><input name="topic" value="${esc(v.topic || "")}" placeholder="예) 과산화 수소수의 분해 반응"></div>
    <div class="field"><label>대상 학과 키워드 (쉼표 구분, 비우면 계열 전체)</label><input name="majors" value="${esc((v.majors || []).join(", "))}" placeholder="화학, 약학"></div>
    <div class="field"><label>제시문 *</label>
      <div class="mt-bar">${MATH_INSERTS.map(([t, c]) => `<button type="button" class="btn-sm" data-mins="${esc(c)}">${esc(t)}</button>`).join("")}
        <span class="muted">수식은 <code>$ … $</code> 안에 — 아래 '수식 넣는 법'</span></div>
      <textarea name="passage" style="min-height:120px">${esc(v.passage)}</textarea>
      <div class="mt-prev"><span class="lab">미리 보기 — 학생에게 이렇게 보여요</span><div class="mt-out" id="pbPsgPrev"></div></div></div>
    <div class="field"><label>문항 * <span class="muted">— 부스·연습에서 1번부터 차례로 물어요 (최대 ${PASSAGE_MAX_ITEMS}개)</span></label>
      <div class="pb-ed" id="pbItems"></div>
      <button type="button" class="btn-sm" id="pbAdd">+ 문항 추가</button>
      <div class="rv-hint muted" style="font-size:.8rem;margin-top:4px">문항에도 수식을 쓸 수 있어요. 면접관이 소리로 읽을 때 수식 부분은 '수식'이라고 읽어요 (학생은 화면에서 봐요).</div></div>
    <details class="mt-help"><summary>수식 넣는 법 <span class="muted">— 자주 쓰는 것만. [넣기]를 누르면 커서 자리에 들어가요</span></summary>
      <table><thead><tr><th>이렇게 쓰면</th><th>이렇게 보여요</th><th></th></tr></thead><tbody>
      ${MATH_HELP.map(([n, c]) => `<tr><td><b>${esc(n)}</b><br><code>${esc(c)}</code></td><td class="mt-out">${mathHtml(c)}</td><td><button type="button" class="btn-sm" data-mins="${esc(c)}">넣기</button></td></tr>`).join("")}
      </tbody></table>
      <p class="muted" style="margin:8px 0 0;font-size:.82rem">· <code>$</code> 두 개 사이가 수식이에요. 글자 사이에 섞어 써도 돼요 · 크게 한 줄로 쓰려면 <code>$$ … $$</code> · 돈 표시 '$' 는 <code>\\$</code><br>
        · 틀리면 그 부분만 빨갛게 보여요 (저장은 돼요) · 꼬리질문은 소리로 읽으니 수식 없이 말로 써 주세요</p></details>
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>숙독 시간 * (분)</label><input name="prepMin" type="number" min="0.5" step="0.5" inputmode="decimal" value="${minVal(v.prepSec)}" placeholder="예) 10"><div class="muted" style="font-size:.8rem;margin-top:3px">제시문과 문항을 읽고 생각하는 시간</div></div>
      <div class="field"><label>답변 시간 * (분)</label><input name="answerMin" type="number" min="0.5" step="0.5" inputmode="decimal" value="${minVal(v.answerSec)}" placeholder="예) 7"><div class="muted" style="font-size:.8rem;margin-top:3px">1번부터 마지막 문항까지 모두 합쳐서</div></div>
    </div>
    <div class="field"><label>질문 의도</label><input name="intent" value="${esc(v.intent)}"></div>
    <div class="field"><label data-flabel="1">꼬리질문 (한 줄에 하나) <span class="muted">— 마지막 문항까지 답하고 시간이 남으면 하나 · 소리로 읽으니 수식 없이 말로</span></label><textarea name="followUps">${esc((v.followUps || []).join("\n"))}</textarea></div>`;
  const track0 = FIELDS.includes(v.track) ? v.track : "공통", kind0 = mkOf(v);
  // 학생부 공통·기본 인성·MMI — 칸은 모두 form 안에 두고 유형에 따라 보이기만 바꾼다 (접히거나 숨어도 값이 저장 때 지워지지 않게)
  const askFields = `
    <input type="hidden" name="type" value="${esc(v.type)}">
    <input type="hidden" name="mmiKind" value="${kind0}">
    <input type="hidden" name="track" value="${esc(track0)}">
    <div class="field" data-mmi="1"><label>종류</label><span class="mk-pick" id="bmKind">${MK.map((k) => `<button type="button" data-mkm="${k}" class="${kind0 === k ? "on" : ""}">${k}</button>`).join("")}</span></div>
    <div class="field" data-mmi="1"><label>제시문 * <span class="muted">(상황·사례·기사 글)</span></label><textarea name="passage" rows="4" placeholder="${esc(MK_PH[kind0])}">${esc(v.passage)}</textarea></div>
    <div class="field"><label>질문 *</label><textarea name="text" rows="2" style="min-height:64px">${esc(v.text)}</textarea></div>
    <div class="grid grid-2" style="gap:0 14px" data-mmi="1">
      <div class="field"><label>준비 시간 (분)</label><input name="prepMin" type="number" min="0" step="0.5" inputmode="decimal"></div>
      <div class="field"><label>답변 시간 (분)</label><input name="answerMin" type="number" min="0.5" step="0.5" inputmode="decimal"></div>
    </div>
    <div class="field"><label>계열</label><div class="bm-chips" id="bmTrack">${FIELDS.map((f) => `<button type="button" data-tr="${esc(f)}" class="${track0 === f ? "on" : ""}">${esc(f)}</button>`).join("")}</div></div>
    <div class="field"><label>꼬리질문 <span class="muted">(한 줄에 하나 · 선택)</span></label><textarea name="followUps" rows="3">${esc((v.followUps || []).join("\n"))}</textarea></div>
    <details class="bk-more"><summary class="muted">더 넣기 — 질문 의도 · 대상 학과<span data-nm="1"> · 시간</span> <span class="bk-sm">(비우면 기본값)</span></summary>
      <div class="field" style="margin-top:8px"><label>질문 의도</label><input name="intent" value="${esc(v.intent)}"></div>
      <div class="field"><label>대상 학과 키워드 (쉼표, 비우면 계열 전체)</label><input name="majors" value="${esc((v.majors || []).join(", "))}" placeholder="화학, 약학"></div>
      <div class="grid grid-2" style="gap:0 14px" data-nm="1">
        <div class="field"><label>준비 시간(초)</label><input name="prepSec" type="number" min="0"></div>
        <div class="field"><label>답변 시간(초)</label><input name="answerSec" type="number" min="10"></div>
      </div></details>`;
  const body = openModal(title(v.type), `${head}<form id="f" novalidate>
    ${isP0 ? passageFields : askFields}
    <div class="row" style="margin-top:12px"><div class="spacer"></div><button class="btn-primary">${q ? "저장" : "추가"}</button></div></form>`);
  const box = $("#pbItems", body);
  const psgTa = $("textarea[name=passage]", body);
  let minutesToSec = () => {};   // MMI 분 칸 → 초
  if (isP0) bindPassageEd();
  else bindAskEd();

  function bindPassageEd() {
    // 문항 칸: 1번·2번… [↑][↓][×]
    const drawItems = (list) => {
      box.innerHTML = list.map((t, i) => `<div class="pb-row"><b>${i + 1}번</b><div class="pb-q"><textarea data-it="${i}" rows="2" placeholder="${i + 1}번 문항">${esc(t)}</textarea><div class="mt-out mt-mini" data-prev="${i}"></div></div>
        <span class="pb-btns"><button type="button" class="btn-sm" data-up="${i}" ${i ? "" : "disabled"} aria-label="${i + 1}번 위로">↑</button><button type="button" class="btn-sm" data-dn="${i}" ${i < list.length - 1 ? "" : "disabled"} aria-label="${i + 1}번 아래로">↓</button><button type="button" class="btn-sm" data-x="${i}" aria-label="${i + 1}번 지우기">×</button></span></div>`).join("");
      $("#pbAdd", body).disabled = list.length >= PASSAGE_MAX_ITEMS;
      const cur = () => $$("[data-it]", box).map((t) => t.value);
      $$("[data-up]", box).forEach((b) => b.onclick = () => { const l = cur(), i = Number(b.dataset.up); [l[i - 1], l[i]] = [l[i], l[i - 1]]; drawItems(l); });
      $$("[data-dn]", box).forEach((b) => b.onclick = () => { const l = cur(), i = Number(b.dataset.dn); [l[i + 1], l[i]] = [l[i], l[i + 1]]; drawItems(l); });
      $$("[data-x]", box).forEach((b) => b.onclick = () => { const l = cur(); l.splice(Number(b.dataset.x), 1); drawItems(l.length ? l : [""]); });
      $$("[data-it]", box).forEach((t) => { t.addEventListener("input", preview); t.addEventListener("focus", () => { lastTa = t; }); });
      preview();
    };
    // 수식: 미리 보기 (제시문은 늘, 문항은 수식이 있을 때만) · 넣기 단추는 마지막으로 누른 칸(처음엔 제시문)에
    let lastTa = psgTa;
    function preview() {
      const pv = $("#pbPsgPrev", body);
      if (pv) pv.innerHTML = psgTa.value.trim() ? mathHtml(psgTa.value) : '<span class="muted">제시문을 쓰면 여기에 보여요</span>';
      $$("[data-it]", box).forEach((t) => { const d = $(`[data-prev="${t.dataset.it}"]`, box); if (d) { d.hidden = !hasMath(t.value); d.innerHTML = d.hidden ? "" : mathHtml(t.value); } });
    }
    psgTa.addEventListener("input", preview);
    psgTa.addEventListener("focus", () => { lastTa = psgTa; });
    $$("[data-mins]", body).forEach((b) => b.onclick = () => {
      const t = lastTa && document.body.contains(lastTa) ? lastTa : psgTa, v = b.dataset.mins;
      const a = t.selectionStart ?? t.value.length, z = t.selectionEnd ?? a;
      t.value = t.value.slice(0, a) + v + t.value.slice(z);
      t.focus(); t.selectionStart = t.selectionEnd = a + v.length;
      preview();
    });
    drawItems(items0.length ? items0 : [""]);
    $("#pbAdd", body).onclick = () => { const l = $$("[data-it]", box).map((t) => t.value); if (l.length < PASSAGE_MAX_ITEMS) { drawItems([...l, ""]); $$("[data-it]", box).pop()?.focus(); } };
  }

  function bindAskEd() {
    const typeIn = $("input[name=type]", body), pS = $("input[name=prepSec]", body), aS = $("input[name=answerSec]", body), pM = $("input[name=prepMin]", body), aM = $("input[name=answerMin]", body);
    // 분 칸은 0.1분까지만 보여 주므로, 안 고쳤으면 저장할 때 원래 초를 그대로 쓴다
    const minOf = (sec) => String(Math.round(Number(sec) / 6) / 10);
    const applyType = (tp) => {
      const t = TYPES[tp], same = tp === v.type;
      typeIn.value = tp;
      $("#mTitle").textContent = title(tp);
      $("#bmBadge", body).innerHTML = typeBadge(tp);
      $$("[data-mmi]", body).forEach((x) => x.hidden = tp !== "mmi");
      $$("[data-nm]", body).forEach((x) => x.hidden = tp === "mmi");
      // 유형을 바꾸면 시간은 그 유형 기본값, 원래 유형으로 돌아오면 원래 값
      pS.value = same ? v.prepSec ?? "" : ""; aS.value = same ? v.answerSec ?? "" : "";
      pS.placeholder = `기본 ${t.prep}초`; aS.placeholder = `기본 ${t.answer}초`;
      pM.value = minOf(same ? v.prepSec ?? t.prep : TYPES.mmi.prep); aM.value = minOf(same ? v.answerSec ?? t.answer : TYPES.mmi.answer);
      $$("#bmType option", body).forEach((o) => { o.disabled = o.value === tp; });
    };
    const pM0 = () => (v.type === "mmi" ? minOf(v.prepSec ?? TYPES.mmi.prep) : null), aM0 = () => (v.type === "mmi" ? minOf(v.answerSec ?? TYPES.mmi.answer) : null);
    applyType(v.type);
    const tSel = $("#bmType", body);
    tSel.onchange = () => { if (tSel.value) applyType(tSel.value); tSel.value = ""; };
    $$("[data-mkm]", body).forEach((b) => b.onclick = () => {
      $$("[data-mkm]", body).forEach((x) => x.classList.toggle("on", x === b));
      $("input[name=mmiKind]", body).value = b.dataset.mkm;
      psgTa.placeholder = MK_PH[b.dataset.mkm];
    });
    $$("[data-tr]", body).forEach((b) => b.onclick = () => {
      $$("[data-tr]", body).forEach((x) => x.classList.toggle("on", x === b));
      $("input[name=track]", body).value = b.dataset.tr;
    });
    minutesToSec = (f) => {
      const conv = (val, was, sec) => (val === "" ? "" : val === was ? sec : Math.round(Number(val) * 60));
      f.prepSec = conv(f.prepMin, pM0(), v.prepSec); f.answerSec = conv(f.answerMin, aM0(), v.answerSec);
    };
  }

  $("#f", body).onsubmit = async (e) => {
    e.preventDefault();
    const f = readForm(body), isP = f.type === "passage";
    if (isP) {
      const its = $$("[data-it]", box).map((t) => t.value.trim()).filter(Boolean);
      const miss = [!f.univ && "학교", !f.topic && "주제", !f.passage && "제시문", !its.length && "문항"].filter(Boolean);
      if (miss.length) return toast(`${miss.join("·")}을(를) 넣어 주세요.`, "error");
      const pm = Number(f.prepMin), am = Number(f.answerMin);
      if (!(pm > 0) || !(am > 0)) return toast("숙독 시간과 답변 시간을 넣어 주세요.", "error");
      Object.assign(f, { items: its, prepSec: Math.round(pm * 60), answerSec: Math.round(am * 60) });
    } else if (f.type === "mmi") {
      if (!f.passage || !f.text) return toast("제시문과 질문을 넣어 주세요", "error");
      minutesToSec(f);
    } else if (!f.text) return toast("질문을 넣어 주세요.", "error");
    delete f.prepMin; delete f.answerMin;
    const d = normalizeBank(f);
    // 제시문이 아닌 유형이면 제시문 칸을, MMI 가 아니면 종류 칸을 지운다
    const clear = q && !isP ? Object.fromEntries(PASSAGE_ONLY.filter((k) => k in q).map((k) => [k, deleteField()])) : {};
    if (q && d.type !== "mmi" && "mmiKind" in q) clear.mmiKind = deleteField();
    try {
      if (q) { await updateDoc(doc(db, "questions", q.id), { ...d, ...clear }); Object.keys(clear).forEach((k) => delete q[k]); Object.assign(q, d); }
      else { const ref = await addDoc(collection(db, "questions"), { ...d, createdAt: serverTimestamp() }); S.bank.push({ id: ref.id, ...d }); fresh.add(ref.id); }
      toast("저장했습니다."); closeModal(); render();
    } catch (err) { showError(err, "질문 저장"); }
  };
}

async function addMany(qs, mark = false) {
  try {
    for (let i = 0; i < qs.length; i += 400) {
      const batch = writeBatch(db); const added = [];
      qs.slice(i, i + 400).forEach((q) => {
        const ref = doc(collection(db, "questions"));
        batch.set(ref, { ...q, createdAt: serverTimestamp() });
        added.push({ id: ref.id, ...q });
      });
      await batch.commit();
      S.bank.push(...added);
      if (mark) added.forEach((x) => fresh.add(x.id));
    }
    toast(`${qs.length}개 추가했습니다.`); render();
    return true;
  } catch (e) { showError(e, "질문 추가"); render(); return false; }
}

async function seed() {
  await ensureBank();
  const have = new Set(S.bank.map((q) => q.seedId).filter(Boolean));
  const add = SEED_QUESTIONS.filter((q) => !have.has(q.seedId));
  if (!add.length) return toast("기본 질문은 이미 모두 들어 있습니다.");
  if (!confirm(`기본 질문 ${add.length}개를 추가할까요?`)) return;
  await addMany(add.map((q) => ({ ...normalizeBank(q), seedId: q.seedId })));
}

function assignModal() {
  if (!S.students.length) return toast("등록된 학생이 없습니다.", "error");
  const body = openModal(`질문 ${sel.size}개 배정`, `
    <p class="muted">선택한 학생의 '내 생기부 면접' 질문 목록에 추가됩니다.</p>
    <div class="row" style="margin-bottom:6px"><select id="aTrack" style="width:auto">${opt(TRACKS, "", "전체 트랙")}</select>
      <input id="aKw" placeholder="이름·학번·학과" style="width:auto">
      <button class="btn-sm" id="aAll">보이는 학생 전체 선택</button></div>
    <div class="check-list" id="aList"></div>
    <div style="margin-top:12px"><button class="btn-primary" id="aGo">배정</button></div>`);
  const draw = () => {
    const tr = $("#aTrack", body).value, kw = $("#aKw", body).value.trim();
    $("#aList", body).innerHTML = S.students.filter((s) => (!tr || s.track === tr)
      && (!kw || `${s.name}${s.studentNo}${(s.universities || []).map((u) => u.dept).join()}`.includes(kw))).map((s) =>
      `<label><input type="checkbox" value="${s.studentNo}"> ${esc(s.studentNo)} ${esc(s.name)} <span class="muted">${esc((s.universities || [])[0]?.dept || s.track || "")}</span></label>`).join("");
  };
  draw();
  $("#aTrack", body).onchange = draw; $("#aKw", body).oninput = draw;
  $("#aAll", body).onclick = () => $$("#aList input", body).forEach((c) => c.checked = true);
  $("#aGo", body).onclick = async () => {
    const nos = $$("#aList input:checked", body).map((c) => c.value);
    if (!nos.length) return toast("학생을 선택하세요.", "error");
    const qs = S.bank.filter((q) => sel.has(q.id)).map((q) => ({
      text: q.text, type: q.type, passage: q.passage || "", prepSec: q.prepSec, answerSec: q.answerSec,
      category: `질문은행-${TYPES[q.type]?.label || ""}`, basis: "", intent: q.intent || "", followUps: q.followUps || [], source: "bank", bankId: q.id,
      // 제시문: 학교·전형·주제·문항 목록도 같이 (2026-10-26)
      ...(q.type === "passage" ? { univ: q.univ || "", admission: q.admission || "", topic: q.topic || "", items: passageItems(q) } : {}),
      // MMI 종류 (보관용)
      ...(q.type === "mmi" ? { mmiKind: mkOf(q) } : {})
    }));
    $("#aGo", body).disabled = true;
    let fail = 0;
    for (const no of nos) { try { await savePersonal(no, qs, true); } catch (_) { fail++; } }
    if (!fail) { toast(`${nos.length}명에게 배정했습니다.`); closeModal(); sel.clear(); render(); }
    else $("#aGo", body).disabled = false;
  };
}
