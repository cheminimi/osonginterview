// 교사 '오늘' 탭: 1차 발표일 · 대학 면접일 (2026-10-26)
// 파란 '오늘 면접' 칸 안에 '내 담당 학생 일정' 줄 + 맨 아래 학교 전체 한 줄 → 누르면 팝업(오늘|내일 · 대학별|내 담당만).
// 읽기: interviews 캐시는 학생이 결과를 눌러도 '바뀜' 표시를 못 올려서(규칙) 늦게 보일 수 있다 →
//   오늘·내일 해당 줄만 따로 실시간으로 읽는다 (firstAnnounce == 오늘/내일, date == 오늘/내일) + 오늘 면접 후기(reviews date == 오늘).
import { db, collection, query, where, onSnapshot, $, $$, esc, isoDay, fmtDay, univName, sameUniv } from "./common.js";
import { S, myName, myRoles } from "./t-core.js";
import { openStudent } from "./t-students.js";

const WIDE = window.matchMedia("(min-width: 721px)");
const RV_OPEN_HOUR = 18;          // 학생 후기는 면접 당일 18시부터
const st = { key: "", stops: [], iv: {}, rv: [], onChange: null, timer: null };
const dayOf = (k) => { const d = new Date(); d.setDate(d.getDate() + k); return isoDay(d); };

/** 오늘·내일 실시간 읽기를 켠다 (날짜가 바뀌면 다시 건다). onChange 는 값이 바뀔 때 화면을 다시 그리는 함수 */
export function watchAnnounce(onChange) {
  st.onChange = onChange;
  const today = dayOf(0), tm = dayOf(1), key = today + "|" + tm;
  if (st.key === key) return;
  st.stops.forEach((f) => f()); st.stops = []; st.iv = {}; st.rv = []; st.key = key;
  const fire = () => { clearTimeout(st.timer); st.timer = setTimeout(() => st.onChange?.(), 120); };
  const listen = (field, day) => {
    const k = `${field}:${day}`;
    st.stops.push(onSnapshot(query(collection(db, "interviews"), where(field, "==", day)), (snap) => {
      st.iv[k] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); fire();
    }, (e) => console.warn("오늘 발표·면접", e)));
  };
  listen("firstAnnounce", today); listen("firstAnnounce", tm); listen("date", today); listen("date", tm);
  st.stops.push(onSnapshot(query(collection(db, "reviews"), where("date", "==", today)), (snap) => {
    st.rv = snap.docs.map((d) => ({ id: d.id, ...d.data() })); fire();
  }, (e) => console.warn("오늘 면접 후기", e)));
}

// ---- 줄 만들기: { k: "ann"|"iv", day: "today"|"tomorrow", id, no, nm, univ, dept, admission, r, at, rv }
function rowsOf(day) {
  const d = day === "today" ? dayOf(0) : dayOf(1);
  const active = new Map(S.students.map((s) => [String(s.studentNo), s]));
  const out = [];
  const add = (k, x) => {
    const no = String(x.studentNo || "");
    if (!active.has(no)) return;          // 삭제한 학생은 빼기
    const rv = k === "iv" ? st.rv.find((r) => r.id === x.id || (String(r.studentNo) === no && sameUniv(r.univ, x.univ) && (r.dept || "") === (x.dept || "") && r.date === x.date)) : null;
    out.push({ k, day, id: x.id, no, nm: active.get(no)?.name || x.name || "", univ: univName(x.univ), dept: x.dept || "", admission: x.admission || "",
      r: x.announceResult || "", at: Number(x.announceAt) || 0, rv: rv?.id || "" });
  };
  (st.iv[`firstAnnounce:${d}`] || []).forEach((x) => add("ann", x));
  (st.iv[`date:${d}`] || []).forEach((x) => { if (x.announceResult !== "fail") add("iv", x); });   // 1차 불합격한 대학 면접은 빼기
  return out;
}
const isMine = (no) => { const me = myName(); if (!me) return true; const s = S.students.find((x) => String(x.studentNo) === no); return !!s && myRoles(s, me).length > 0; };
const hhmm = (ms) => { const t = new Date(ms); return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`; };
const univs = (list, k) => [...new Set(list.filter((x) => x.k === k).map((x) => x.univ))];
const names = (u) => u.length > 3 ? u.slice(0, 2).join("·") + ` 외 ${u.length - 2}곳` : u.join("·");
/** 결과 알약 — hero: 파란 칸 안(흰 글씨) / 팝업: 흰 창 */
function pillOf(x, hero) {
  const c = (cls, t, attr = "") => `<span class="${hero ? "ta-p" : "ta-b"} ${cls}"${attr}>${t}</span>`;
  if (x.day === "tomorrow") return hero ? "" : c("ln", "-");
  if (x.k === "ann") return x.r === "pass" ? c("ok", `합격${x.at ? " " + hhmm(x.at) : ""}`) : x.r === "fail" ? c("gr", "불합격") : c("gr", "아직");
  if (x.rv) return `<button type="button" class="${hero ? "ta-p" : "ta-b"} ok" data-tarv="${esc(x.rv)}">후기 씀</button>`;
  return new Date().getHours() >= RV_OPEN_HOUR ? c("ln", "후기 아직") : c("ln", "18시부터 후기");
}
const lineText = (list) => [univs(list, "ann").length ? `<span class="ta-dot ann"></span>1차 발표 ${esc(names(univs(list, "ann")))}` : "",
  univs(list, "iv").length ? `<span class="ta-dot iv"></span>면접 ${esc(names(univs(list, "iv")))}` : ""].filter(Boolean).join(" · ");

/** 파란 '오늘 면접' 칸 안에 넣을 것. has = 오늘·내일 학생 일정이 하나라도 있는지 */
export function announceHero() {
  const td = rowsOf("today"), tm = rowsOf("tomorrow");
  const mine = td.filter((x) => isMine(x.no)).sort((a, b) => (a.k === "iv" ? 0 : 1) - (b.k === "iv" ? 0 : 1) || a.no.localeCompare(b.no));
  let html = "";
  if (mine.length) html += `<div class="ta-div">내 담당 학생 일정</div>` + mine.map((x) => `
    <div class="ta-srow"><div class="k"><span class="ta-dot ${x.k}"></span>${x.k === "ann" ? "1차 발표" : "대학 면접"}</div>
      <button type="button" class="sb" data-tano="${esc(x.no)}"><b>${esc(x.nm)}</b> ${esc(x.no)} · ${esc(x.univ)} <span>${esc(x.dept)}</span></button>${pillOf(x, true)}</div>`).join("");
  if (td.length) html += `<button type="button" class="ta-line" data-taopen="today"><span class="t">${lineText(td)}</span><span class="go">${td.length}명 ›</span></button>`;
  else if (tm.length) html += `<button type="button" class="ta-line" data-taopen="tomorrow"><span class="t">내일 · ${lineText(tm)}</span><span class="go">${tm.length}명 ›</span></button>`;
  return { html, has: !!(td.length || tm.length) };
}
/** 그린 뒤 연결 (root 안의 줄·한 줄) */
export function bindAnnounce(root) {
  $$("[data-tano]", root).forEach((b) => b.onclick = () => openStudent(b.dataset.tano));
  $$("[data-taopen]", root).forEach((b) => b.onclick = () => openPopup(b.dataset.taopen));
  $$("[data-tarv]", root).forEach((b) => b.onclick = (e) => { e.stopPropagation(); openRv(b.dataset.tarv); });
}
async function openRv(id) {
  const m = await import("./t-reviews.js");
  await m.load();
  m.openReviewDetail(id);
}

// ---------------- 팝업 (컴퓨터: 가운데 창 · 휴대폰: 아래에서 올라오는 시트)
const pop = { day: "today", scope: "all" };
export function openPopup(day) {
  pop.day = day; pop.scope = "all";
  closePopup();
  document.body.insertAdjacentHTML("beforeend", `<div class="ta-bg${WIDE.matches ? "" : " ta-sheet"}" id="taPop"><div class="ta-pop" role="dialog" aria-modal="true" aria-labelledby="taT">
    <div class="ta-ph"><div class="ta-grip"></div>
      <div class="top"><div><h3 id="taT"></h3><div class="muted" id="taSub"></div></div><button type="button" class="ta-x" id="taX" aria-label="닫기">✕</button></div>
      <div class="ta-tabs"><span class="ta-seg" id="taDay"><button type="button" data-d="today">오늘</button><button type="button" data-d="tomorrow">내일</button></span>
        <span class="ta-seg" id="taScope"><button type="button" data-s="all">대학별</button><button type="button" data-s="mine">내 담당만</button></span></div></div>
    <div class="ta-pb" id="taBody"></div>
    <div class="ta-pf"><span id="taFoot"></span><button type="button" id="taClose">닫기</button></div></div></div>`);
  const bg = $("#taPop");
  bg.onclick = (e) => { if (e.target === bg) closePopup(); };
  $("#taX", bg).onclick = closePopup; $("#taClose", bg).onclick = closePopup;
  $$("#taDay [data-d]", bg).forEach((b) => b.onclick = () => { pop.day = b.dataset.d; drawPopup(); });
  $$("#taScope [data-s]", bg).forEach((b) => b.onclick = () => { pop.scope = b.dataset.s; drawPopup(); });
  document.addEventListener("keydown", onKey, true);
  drawPopup();
  $("#taX", bg).focus();
}
function onKey(e) { if (e.key === "Escape" && $("#taPop")) { e.stopPropagation(); closePopup(); } }
export function closePopup() { $("#taPop")?.remove(); document.removeEventListener("keydown", onKey, true); }
function drawPopup() {
  const bg = $("#taPop"); if (!bg) return;
  $$("#taDay [data-d]", bg).forEach((b) => b.classList.toggle("on", b.dataset.d === pop.day));
  $$("#taScope [data-s]", bg).forEach((b) => b.classList.toggle("on", b.dataset.s === pop.scope));
  const all = rowsOf(pop.day), list = pop.scope === "mine" ? all.filter((x) => isMine(x.no)) : all;
  $("#taT", bg).textContent = pop.day === "today" ? "오늘 발표·면접" : "내일 발표·면접";
  $("#taSub", bg).textContent = `${fmtDay(pop.day === "today" ? dayOf(0) : dayOf(1))} · ${all.length}명 · ${new Set(all.map((x) => x.univ)).size}개 대학`;
  const other = rowsOf(pop.day === "today" ? "tomorrow" : "today");
  $("#taFoot", bg).innerHTML = other.length ? `<button type="button" class="ta-swap" id="taSwap">${pop.day === "today" ? "내일" : "오늘"} ${other.length}명 보기 ›</button>` : "";
  $("#taSwap", bg)?.addEventListener("click", () => { pop.day = pop.day === "today" ? "tomorrow" : "today"; drawPopup(); });
  if (!list.length) { $("#taBody", bg).innerHTML = `<div class="ta-empty">${pop.scope === "mine" ? "내 담당 학생 일정은 없어요." : "일정이 없어요."}</div>`; return; }
  const grp = (k, title) => {
    const us = univs(list, k); if (!us.length) return "";
    return `<div class="ta-grp"><h4 class="${k}"><span class="ta-dot ${k}"></span>${title}</h4>` + us.map((u) => {
      const ss = list.filter((x) => x.k === k && x.univ === u), hasMine = ss.some((x) => isMine(x.no));
      const ok = ss.filter((x) => x.r === "pass").length, no = ss.filter((x) => x.r === "fail").length, wait = ss.length - ok - no;
      const sum = k === "ann" && pop.day === "today" ? [ok && `합격 ${ok}`, no && `불합격 ${no}`, wait && `아직 ${wait}`].filter(Boolean).join(" · ")
        : [...new Set(ss.map((x) => x.dept).filter(Boolean))].join(" · ");
      return `<details class="ta-u" ${hasMine || pop.scope === "mine" ? "open" : ""}><summary><span><b>${esc(u)}</b> <span class="m">${ss.length}명${sum ? " · " + esc(sum) : ""}</span></span><span class="ar">›</span></summary>
        <div class="ls">${ss.sort((a, b) => a.dept.localeCompare(b.dept, "ko") || a.no.localeCompare(b.no)).map((x) => `<div class="ta-sr">
          <span><button type="button" class="nm" data-tastu="${esc(x.no)}">${esc(x.nm)}</button> <span class="d">${esc(x.no)} · ${esc(x.dept)}</span>${isMine(x.no) && myName() ? '<span class="mine">내 담당</span>' : ""}</span>${pillOf(x, false)}</div>`).join("")}</div></details>`;
    }).join("") + `</div>`;
  };
  $("#taBody", bg).innerHTML = grp("ann", "1차 발표") + grp("iv", "대학 면접");
  $$("[data-tastu]", bg).forEach((b) => b.onclick = () => { closePopup(); openStudent(b.dataset.tastu); });
  $$("[data-tarv]", bg).forEach((b) => b.onclick = () => { closePopup(); openRv(b.dataset.tarv); });
}
/** 화면이 바뀔 때 팝업 내용도 새로 (열려 있으면) */
export function refreshPopup() { drawPopup(); }
