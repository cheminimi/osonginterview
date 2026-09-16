import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  $, $$, esc, toast, showError, copyText, parseLooseJSON, typeBadge, TYPES, FIELDS, TRACKS
} from "./common.js";
import { S, register, openModal, closeModal, readForm, lines, opt } from "./t-core.js";
import { bankPrompt } from "./prompts.js";
import { SEED_QUESTIONS } from "./seed-questions.js";
import { savePersonal } from "./t-questions.js";

let root;
const sel = new Set();
export function init(el) {
  root = el;
  root.innerHTML = `
    <div class="toolbar">
      <select id="bType">${opt(Object.entries(TYPES).map(([k, v]) => [k, v.label]), "", "전체 유형")}</select>
      <select id="bField">${opt(FIELDS, "", "전체 계열")}</select>
      <input id="bSearch" placeholder="검색">
      <div class="spacer"></div>
      <button id="bSeed">기본 질문 불러오기</button>
      <button id="bImport">AI로 질문 만들기</button>
      <button class="btn-primary" id="bAdd">+ 질문 추가</button>
    </div>
    <div class="toolbar" id="bSelBar" hidden>
      <span id="bSelCount"></span>
      <button class="btn-primary btn-sm" id="bAssign">선택한 질문을 학생에게 배정</button>
      <button class="btn-sm" id="bClear">선택 해제</button>
    </div>
    <p class="muted">질문은행은 학생의 '공통·제시문·인성' 말하기 연습에 쓰입니다. 학생에게 배정하면 '내 생기부 면접'에도 들어갑니다.</p>
    <div id="bList"></div>`;
  ["#bType", "#bField"].forEach((s) => $(s, root).onchange = render);
  $("#bSearch", root).oninput = render;
  $("#bAdd", root).onclick = () => edit();
  $("#bImport", root).onclick = importModal;
  $("#bSeed", root).onclick = seed;
  $("#bClear", root).onclick = () => { sel.clear(); render(); };
  $("#bAssign", root).onclick = assignModal;
  register("bank", render);
}

function render() {
  const t = $("#bType", root).value, f = $("#bField", root).value, kw = $("#bSearch", root).value.trim();
  const list = S.bank.filter((q) => (!t || q.type === t) && (!f || q.track === f)
    && (!kw || `${q.text}${q.passage}${(q.majors || []).join()}`.includes(kw)));
  $("#bSelBar", root).hidden = !sel.size;
  $("#bSelCount", root).textContent = `${sel.size}개 선택됨`;
  if (!list.length) {
    $("#bList", root).innerHTML = `<div class="card empty">${S.bank.length ? "조건에 맞는 질문이 없습니다." : "질문은행이 비어 있습니다. '기본 질문 불러오기'로 시작해 보세요."}</div>`;
    return;
  }
  $("#bList", root).innerHTML = `<div class="muted" style="margin-bottom:8px">${list.length}개</div>` + list.map((q) => `
    <div class="q-item ${sel.has(q.id) ? "sel" : ""}">
      <div class="row"><input type="checkbox" data-sel="${q.id}" ${sel.has(q.id) ? "checked" : ""} style="width:auto">
        ${typeBadge(q.type)} <span class="badge">${esc(q.track || "공통")}</span>
        ${(q.majors || []).map((m) => `<span class="badge badge-gray">${esc(m)}</span>`).join(" ")}</div>
      <div class="q-text pre" style="margin-top:6px">${esc(q.text)}</div>
      ${q.passage ? `<details><summary class="muted">${q.type === "mmi" ? "상황" : "제시문"} 보기</summary><div class="pre ans">${esc(q.passage)}</div></details>` : ""}
      <div class="q-meta">${q.intent ? `의도: ${esc(q.intent)} · ` : ""}${q.prepSec ? `준비 ${q.prepSec}초 · ` : ""}답변 ${q.answerSec ?? TYPES[q.type]?.answer}초</div>
      ${q.followUps?.length ? `<ul class="follow">${q.followUps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <div class="q-actions"><button class="btn-sm" data-edit="${q.id}">수정</button><button class="btn-sm btn-danger" data-rm="${q.id}">삭제</button></div>
    </div>`).join("");
  $$("[data-sel]", root).forEach((c) => c.onchange = () => { c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); render(); });
  $$("[data-edit]", root).forEach((b) => b.onclick = () => edit(S.bank.find((q) => q.id === b.dataset.edit)));
  $$("[data-rm]", root).forEach((b) => b.onclick = async () => {
    if (!confirm("이 질문을 삭제할까요?")) return;
    try { await deleteDoc(doc(db, "questions", b.dataset.rm)); S.bank = S.bank.filter((q) => q.id !== b.dataset.rm); sel.delete(b.dataset.rm); render(); }
    catch (e) { showError(e, "질문 삭제"); }
  });
}

export function normalizeBank(d) {
  const type = TYPES[d.type] ? d.type : "document";
  const num = (x, def) => (x === "" || x == null || isNaN(Number(x))) ? def : Number(x);
  return {
    type, track: FIELDS.includes(d.track) ? d.track : "공통",
    majors: Array.isArray(d.majors) ? d.majors.map(String).filter(Boolean) : String(d.majors || "").split(/[,，]/).map((m) => m.trim()).filter(Boolean),
    text: String(d.text || "").trim(), passage: String(d.passage || "").trim(),
    prepSec: num(d.prepSec, TYPES[type].prep), answerSec: num(d.answerSec, TYPES[type].answer),
    intent: String(d.intent || "").trim(),
    followUps: Array.isArray(d.followUps) ? d.followUps.map(String).filter(Boolean) : lines(d.followUps)
  };
}

function edit(q = null) {
  const v = q || { type: "document", track: "공통" };
  const body = openModal(q ? "질문 수정" : "질문 추가", `<form id="f">
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>유형</label><select name="type">${opt(Object.entries(TYPES).map(([k, t]) => [k, t.label]), v.type)}</select></div>
      <div class="field"><label>계열</label><select name="track">${opt(FIELDS, v.track)}</select></div>
    </div>
    <div class="field"><label>대상 학과 키워드 (쉼표 구분, 비우면 계열 전체)</label><input name="majors" value="${esc((v.majors || []).join(", "))}" placeholder="화학, 약학"></div>
    <div class="field"><label>질문 *</label><textarea name="text" required style="min-height:70px">${esc(v.text)}</textarea></div>
    <div class="field"><label>제시문 / MMI 상황 <span class="muted">(학생부·인성은 비워두기)</span></label><textarea name="passage" style="min-height:120px">${esc(v.passage)}</textarea></div>
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>준비 시간(초)</label><input name="prepSec" type="number" min="0" value="${v.prepSec ?? ""}"></div>
      <div class="field"><label>답변 시간(초)</label><input name="answerSec" type="number" min="10" value="${v.answerSec ?? ""}"></div>
    </div>
    <div class="field"><label>질문 의도</label><input name="intent" value="${esc(v.intent)}"></div>
    <div class="field"><label>꼬리질문 (한 줄에 하나)</label><textarea name="followUps">${esc((v.followUps || []).join("\n"))}</textarea></div>
    <button class="btn-primary">${q ? "저장" : "추가"}</button></form>`);
  const typeSel = $("select[name=type]", body);
  typeSel.onchange = () => {
    const t = TYPES[typeSel.value];
    $("input[name=prepSec]", body).placeholder = `기본 ${t.prep}초`;
    $("input[name=answerSec]", body).placeholder = `기본 ${t.answer}초`;
  };
  typeSel.onchange();
  $("#f", body).onsubmit = async (e) => {
    e.preventDefault();
    const d = normalizeBank(readForm(body));
    try {
      if (q) { await updateDoc(doc(db, "questions", q.id), d); Object.assign(q, d); }
      else { const ref = await addDoc(collection(db, "questions"), { ...d, createdAt: serverTimestamp() }); S.bank.push({ id: ref.id, ...d }); }
      toast("저장했습니다."); closeModal(); render();
    } catch (err) { showError(err, "질문 저장"); }
  };
}

function importModal() {
  const body = openModal("AI(Claude)로 질문은행 만들기", `
    <div class="ai-intro">원하는 유형을 고르고 요청문을 Claude에게 보내면, Claude가 질문을 만들어 줘요. 그 답변을 붙여넣으면 질문은행에 들어갑니다.</div>
    <div class="card" style="box-shadow:none;background:#fafbfc">
      <b>1. 조건 고르고 요청문 복사 → Claude에 보내기</b>
      <div class="grid grid-2" style="gap:0 14px;margin-top:8px">
        <div class="field"><label>유형</label><select id="pType">${opt(Object.entries(TYPES).map(([k, t]) => [k, t.label]))}</select></div>
        <div class="field"><label>계열</label><select id="pField">${opt(FIELDS)}</select></div>
        <div class="field"><label>대상 학과 (선택)</label><input id="pMajors" placeholder="화학과, 신소재공학과"></div>
        <div class="field"><label>문항 수</label><input id="pN" type="number" value="10" min="1" max="30"></div>
      </div>
      <div class="row"><button class="btn-primary" id="pCopy">요청문 복사</button><a class="btn" href="https://claude.ai/new" target="_blank" rel="noopener">Claude 열기 ↗</a></div>
    </div>
    <div class="field" style="margin-top:14px"><label>2. Claude 답변 붙여넣기 <span class="muted">(요청문이 아니라 Claude가 답한 내용)</span></label><textarea id="imp" style="min-height:160px" placeholder="Claude 답변 아래 복사 버튼을 눌러 그대로 붙여넣으세요."></textarea></div>
    <button class="btn-primary" id="doImp">질문은행에 넣기</button>`);
  $("#pCopy", body).onclick = () => copyText(bankPrompt({ type: $("#pType", body).value, track: $("#pField", body).value, majors: $("#pMajors", body).value.trim(), n: Number($("#pN", body).value) || 10 }), "요청문을 복사했어요. Claude 새 채팅에 붙여넣고 보내세요.");
  $("#doImp", body).onclick = async () => {
    let arr;
    try { arr = parseLooseJSON($("#imp", body).value); if (!Array.isArray(arr)) arr = [arr]; }
    catch (e) { return toast(e.message, "error", 9000); }
    const qs = arr.map(normalizeBank).filter((q) => q.text);
    if (!qs.length) return toast("질문을 찾지 못했습니다.", "error");
    if (await addMany(qs)) closeModal();
  };
}

async function addMany(qs) {
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
    }
    toast(`${qs.length}개 추가했습니다.`); render();
    return true;
  } catch (e) { showError(e, "질문 추가"); render(); return false; }
}

async function seed() {
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
      category: `질문은행-${TYPES[q.type]?.label || ""}`, basis: "", intent: q.intent || "", followUps: q.followUps || [], source: "bank", bankId: q.id
    }));
    $("#aGo", body).disabled = true;
    let fail = 0;
    for (const no of nos) { try { await savePersonal(no, qs, true); } catch (_) { fail++; } }
    if (!fail) { toast(`${nos.length}명에게 배정했습니다.`); closeModal(); sel.clear(); render(); }
    else $("#aGo", body).disabled = false;
  };
}
