import {
  db, collection, doc, addDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
  $, $$, esc, toast, showError, copyText, parseLooseJSON, typeBadge, TYPES, FIELDS, TRACKS,
  deleteField, passageItems, passageReady, passageSchool, PASSAGE_MAX_ITEMS
} from "./common.js";
import { S, register, openModal, closeModal, readForm, lines, opt, ensureBank } from "./t-core.js";
import { bankPrompt } from "./prompts.js";
import { mathHtml, hasMath, MATH_INSERTS, MATH_HELP } from "./math.js";
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
      <select id="bUniv" aria-label="제시문 학교"></select>
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
  ["#bType", "#bField", "#bUniv"].forEach((s) => $(s, root).onchange = render);
  $("#bSearch", root).oninput = render;
  $("#bAdd", root).onclick = () => edit();
  $("#bImport", root).onclick = importModal;
  $("#bSeed", root).onclick = seed;
  $("#bClear", root).onclick = () => { sel.clear(); render(); };
  $("#bAssign", root).onclick = assignModal;
  register("bank", render);
}

// 시간(초) → "10분" · "1분 30초"
const minTxt = (sec) => { const n = Math.round(Number(sec) || 0); const m = Math.floor(n / 60), r = n % 60; return m && r ? `${m}분 ${r}초` : m ? `${m}분` : `${r}초`; };
const schoolsOf = () => [...new Set(S.bank.filter((q) => q.type === "passage").map((q) => String(q.univ || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
const isOldPassage = (q) => q.type === "passage" && !String(q.univ || "").trim();
const searchText = (q) => `${q.text}${q.passage}${(q.majors || []).join()}${q.univ || ""}${q.admission || ""}${q.topic || ""}${passageItems(q).map((x) => x.q).join()}`;

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
  uSel.hidden = !schools.length;
  const t = $("#bType", root).value, f = $("#bField", root).value, u = uSel.value, kw = $("#bSearch", root).value.trim();
  const list = S.bank.filter((q) => (!t || q.type === t) && (!f || q.track === f)
    && (!u || (q.type === "passage" && String(q.univ || "").trim() === u))
    && (!kw || searchText(q).includes(kw)));
  $("#bSelBar", root).hidden = !sel.size;
  $("#bSelCount", root).textContent = `${sel.size}개 선택됨`;
  if (!list.length) {
    $("#bList", root).innerHTML = `<div class="card empty">${S.bank.length ? "조건에 맞는 질문이 없습니다." : "질문은행이 비어 있습니다. '기본 질문 불러오기'로 시작해 보세요."}</div>`;
    return;
  }
  $("#bList", root).innerHTML = `<div class="muted" style="margin-bottom:8px">${list.length}개</div>` + list.map((q) => `
    <div class="q-item ${sel.has(q.id) ? "sel" : ""}" data-qid="${esc(q.id)}">
      ${q.type === "passage" ? passageRow(q) : `
      <div class="row"><input type="checkbox" data-sel="${q.id}" ${sel.has(q.id) ? "checked" : ""} style="width:auto">
        ${typeBadge(q.type)} <span class="badge">${esc(q.track || "공통")}</span>
        ${(q.majors || []).map((m) => `<span class="badge badge-gray">${esc(m)}</span>`).join(" ")}</div>
      <div class="q-text pre" style="margin-top:6px">${esc(q.text)}</div>
      ${q.passage ? `<details><summary class="muted">${q.type === "mmi" ? "상황" : "제시문"} 보기</summary><div class="pre ans">${esc(q.passage)}</div></details>` : ""}
      <div class="q-meta">${q.intent ? `의도: ${esc(q.intent)} · ` : ""}${q.prepSec ? `준비 ${q.prepSec}초 · ` : ""}답변 ${q.answerSec ?? TYPES[q.type]?.answer}초</div>`}
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
// 제시문 한 줄: [제시문] 학교 · 전형 · 주제 / 문항 n개 · 숙독 · 답변 · 계열 · 학과 (예전 양식은 표시만 하고 부스·연습에서 쓰지 않음)
function passageRow(q) {
  const its = passageItems(q), ready = passageReady(q), old = isOldPassage(q);
  const head = old ? `<span class="badge badge-orange">예전 양식</span> <span class="q-text">${esc(String(q.text || "").split("\n")[0].slice(0, 60))}${String(q.text || "").length > 60 ? " …" : ""}</span>`
    : `<b class="pb-school">${esc(passageSchool(q))}</b> · <span class="q-text">${esc(q.topic || "(주제 없음)")}</span>`;
  const meta = [old ? "" : `문항 ${its.length}개`, !old && q.prepSec ? `숙독 ${minTxt(q.prepSec)}` : "", !old && q.answerSec ? `답변 ${minTxt(q.answerSec)}` : "",
    q.track || "공통", (q.majors || []).join(", ")].filter(Boolean).join(" · ");
  return `<div class="row"><input type="checkbox" data-sel="${q.id}" ${sel.has(q.id) ? "checked" : ""} style="width:auto">
      ${typeBadge(q.type)} ${head}</div>
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
  if (type !== "passage") return base;
  // 제시문: 학교·전형·주제·문항 목록. 숙독·답변 시간은 기본값으로 채우지 않는다 (선생님이 반드시 넣음 — 비면 null)
  const items = passageItems(d).slice(0, PASSAGE_MAX_ITEMS);
  const sec = (x) => { const n = num(x, null); return n != null && n > 0 ? Math.round(n) : null; };
  return { ...base, univ: String(d.univ || "").trim(), admission: String(d.admission || "").trim(), topic: String(d.topic || "").trim(),
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
function edit(q = null) {
  const v = q || { type: "document", track: "공통" };
  const isP0 = v.type === "passage";
  // 예전 제시문을 열면 text 를 문항으로 나눠 넣어 주고, 시간 칸은 비워 둔다 (선생님이 새로 넣음)
  const old = isP0 && !String(v.univ || "").trim();
  const items0 = isP0 ? (passageItems(v).length ? passageItems(v).map((x) => x.q) : splitOldPassageText(v.text)) : [];
  const minVal = (sec) => (!old && Number(sec) > 0 ? String(Math.round(Number(sec) / 6) / 10) : "");
  const univs = [...new Set([...schoolsOf(), ...(S.interviews || []).map((x) => String(x.univ || "").trim()).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "ko"));
  const adms = [...new Set([...S.bank.filter((x) => x.type === "passage").map((x) => String(x.admission || "").trim()), ...(S.interviews || []).map((x) => String(x.admission || "").trim())].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const body = openModal(q ? "질문 수정" : "질문 추가", `<form id="f" novalidate>
    <div class="grid grid-2" style="gap:0 14px">
      <div class="field"><label>유형</label><select name="type">${opt(Object.entries(TYPES).map(([k, t]) => [k, t.label]), v.type)}</select></div>
      <div class="field"><label>계열</label><select name="track">${opt(FIELDS, v.track)}</select></div>
    </div>
    ${old ? `<div class="pb-warn" style="margin:0 0 12px">예전 양식이에요. 문항을 1·2·3번으로 나눠 넣어 두었어요 — 학교·주제·숙독·답변 시간을 넣고 저장하면 부스·연습에서 써요.</div>` : ""}
    <div data-p="1">
      <div class="grid grid-2" style="gap:0 14px">
        <div class="field"><label>학교 *</label><input name="univ" list="pbUnivs" value="${esc(v.univ || "")}" placeholder="이미 쓴 학교는 골라 넣기" autocomplete="off"></div>
        <div class="field"><label>전형</label><input name="admission" list="pbAdms" value="${esc(v.admission || "")}" placeholder="예) 학생부종합 (면접형)" autocomplete="off"></div>
      </div>
      <datalist id="pbUnivs">${univs.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      <datalist id="pbAdms">${adms.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      <div class="field"><label>주제 * <span class="muted">— 목록·부스에서 제목처럼 보여요</span></label><input name="topic" value="${esc(v.topic || "")}" placeholder="예) 과산화 수소수의 분해 반응"></div>
    </div>
    <div class="field"><label>대상 학과 키워드 (쉼표 구분, 비우면 계열 전체)</label><input name="majors" value="${esc((v.majors || []).join(", "))}" placeholder="화학, 약학"></div>
    <div class="field" data-np="1"><label>질문 *</label><textarea name="text" style="min-height:70px">${esc(v.text)}</textarea></div>
    <div class="field"><label data-plabel="1">제시문 / MMI 상황 <span class="muted">(학생부·인성은 비워두기)</span></label>
      <div class="mt-bar" data-p="1">${MATH_INSERTS.map(([t, c]) => `<button type="button" class="btn-sm" data-mins="${esc(c)}">${esc(t)}</button>`).join("")}
        <span class="muted">수식은 <code>$ … $</code> 안에 — 아래 '수식 넣는 법'</span></div>
      <textarea name="passage" style="min-height:120px">${esc(v.passage)}</textarea>
      <div class="mt-prev" data-p="1"><span class="lab">미리 보기 — 학생에게 이렇게 보여요</span><div class="mt-out" id="pbPsgPrev"></div></div></div>
    <div data-p="1">
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
    </div>
    <div class="grid grid-2" style="gap:0 14px" data-np="1">
      <div class="field"><label>준비 시간(초)</label><input name="prepSec" type="number" min="0" value="${isP0 ? "" : v.prepSec ?? ""}"></div>
      <div class="field"><label>답변 시간(초)</label><input name="answerSec" type="number" min="10" value="${isP0 ? "" : v.answerSec ?? ""}"></div>
    </div>
    <div class="field"><label>질문 의도</label><input name="intent" value="${esc(v.intent)}"></div>
    <div class="field"><label data-flabel="1">꼬리질문 (한 줄에 하나)</label><textarea name="followUps">${esc((v.followUps || []).join("\n"))}</textarea></div>
    <button class="btn-primary">${q ? "저장" : "추가"}</button></form>`);
  const typeSel = $("select[name=type]", body);
  const box = $("#pbItems", body);
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
  const psgTa = $("textarea[name=passage]", body);
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
  typeSel.onchange = () => {
    const tp = typeSel.value, t = TYPES[tp], isP = tp === "passage";
    $$("[data-p]", body).forEach((x) => x.hidden = !isP);
    $$("[data-np]", body).forEach((x) => x.hidden = isP);
    $("[data-plabel]", body).innerHTML = isP ? "제시문 *" : '제시문 / MMI 상황 <span class="muted">(학생부·인성은 비워두기)</span>';
    $("[data-flabel]", body).innerHTML = isP ? '꼬리질문 (한 줄에 하나) <span class="muted">— 마지막 문항까지 답하고 시간이 남으면 하나 · 소리로 읽으니 수식 없이 말로</span>' : "꼬리질문 (한 줄에 하나)";
    $("input[name=prepSec]", body).placeholder = `기본 ${t.prep}초`;
    $("input[name=answerSec]", body).placeholder = `기본 ${t.answer}초`;
  };
  typeSel.onchange();
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
    } else if (!f.text) return toast("질문을 넣어 주세요.", "error");
    delete f.prepMin; delete f.answerMin;
    const d = normalizeBank(f);
    // 제시문이 아닌 유형으로 바꾸면 제시문 칸을 지운다
    const clear = q && !isP ? Object.fromEntries(PASSAGE_ONLY.filter((k) => k in q).map((k) => [k, deleteField()])) : {};
    try {
      if (q) { await updateDoc(doc(db, "questions", q.id), { ...d, ...clear }); PASSAGE_ONLY.forEach((k) => { if (k in clear) delete q[k]; }); Object.assign(q, d); }
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
      ...(q.type === "passage" ? { univ: q.univ || "", admission: q.admission || "", topic: q.topic || "", items: passageItems(q) } : {})
    }));
    $("#aGo", body).disabled = true;
    let fail = 0;
    for (const no of nos) { try { await savePersonal(no, qs, true); } catch (_) { fail++; } }
    if (!fail) { toast(`${nos.length}명에게 배정했습니다.`); closeModal(); sel.clear(); render(); }
    else $("#aGo", body).disabled = false;
  };
}
