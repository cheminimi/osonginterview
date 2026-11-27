// 자습실(3층 공용학습실) 예약 — 일정 탭 '자습실 예약' (2026-11-24). 학생 화면과 교사 화면이 같이 쓴다.
// 교시 단위 · 인원 제한 없음 · 승인 없이 바로 예약 · 한 교시 / 이어서 여러 교시 / 일과 통째로(1~7교시)
// 출석: 학생이 예약마다 한 번 [출석하기] (예약 시간 — 시작 10분 전부터 끝날 때까지). 학생·선생님 모두 봄
//
// 저장 (firestore.rules '자습실 예약' 참고)
//   studyBookings/{id}  { uid, date, blocks:[교시 코드…], start, end, createdAt, checkinAt? }
//       학번·이름 없이 계정 uid 만 → 학생도 그날 예약을 읽어 교시별 인원수만 셈. 이름은 선생님 화면에서 uid → 학생 명단으로 찾음
//   studyClosed/{date}  { blocks:[막은 교시 코드], by } — 선생님이 막은 교시
// 며칠 앞까지·취소 마감은 부스 예약 설정(config/schedule.booth: aheadDays·cancelMin)과 같다
import {
  db, auth, collection, doc, getDoc, query, where, onSnapshot, serverTimestamp, setDoc, addDoc, updateDoc, deleteDoc,
  $, $$, esc, toast, showError, isoDay, toDate, confirmBox
} from "./common.js";
import { scheduleConfigOf, ACTIVE, stageShort } from "./schedule.js";
import { boothConfigOf } from "./booth-booking.js";
import { queueNotify } from "./notify.js";

export const STUDY_ROOM = { name: "공용학습실", place: "3층 공용학습실" };
const CHECKIN_EARLY = 10;   // 출석은 시작 이만큼(분) 전부터

const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const WEEK = "일월화수목금토";
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dayText = (iso) => { const d = toDate(iso); return d ? `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})` : iso; };
const atMs = (iso, hm) => { const d = toDate(iso); if (!d) return 0; const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() + toMin(hm) * 60000; };
const tsMs = (t) => (!t ? 0 : typeof t.toMillis === "function" ? t.toMillis() : t.seconds ? t.seconds * 1000 : Number(t) || 0);
const hm = (ms) => { const x = new Date(ms); return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
/** 수업 교시 (일과) — '1교시'~'7교시' 이름 또는 p1~p7 코드 */
const isClass = (b) => /^\d+교시$/.test(String(b.label || "").trim()) || /^p\d$/.test(b.key);

/**
 * opts: role("student"|"teacher"|"admin"), student(학생 프로필 — uid·studentNo), getInterviewBookings(학생: 모의면접 일정 — 겹침 안내),
 *       getStudents·isMine·myName(교사)
 */
export function mountStudyBooking(root, opts) {
  const isStudent = opts.role === "student";
  const myUid = isStudent ? (auth.currentUser?.uid || opts.student?.uid || "") : "";
  const myNo = isStudent ? String(opts.student?.studentNo || "") : "";
  const first = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); const w = d.getDay(); return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d; })();
  const st = {
    cfg: scheduleConfigOf({}), bcfg: boothConfigOf({}), date: isoDay(first), week: mondayOf(first),
    day: [], closed: [], mine: [], booth: [], showPast: false, blockMode: false, picked: new Set(), filterMine: false, ready: false,
    uidNo: {}   // 선생님: 명단에 없는 uid → 학번 (계정 문서에서 찾은 것)
  };
  let stopDay = null, stopClosed = null, stopMine = null, stopCfg = null, stopBooth = null;

  root.innerHTML = `<div class="bb sr">
    <div class="bb-mine" id="srMine"></div>
    <div class="bb-top" id="srTop"></div>
    <div class="bb-days" id="srDays"></div>
    <div class="bb-tools" id="srTools"></div>
    <div class="bb-mode" id="srMode" hidden></div>
    <div id="srGrid"><div class="empty">불러오는 중…</div></div>
    <div class="bb-legend" id="srLegend"></div>
  </div>`;

  // ---- 읽기 (실시간)
  stopCfg = onSnapshot(doc(db, "config", "schedule"), (snap) => {
    const c = snap.exists() ? snap.data() : {};
    st.cfg = scheduleConfigOf(c); st.bcfg = boothConfigOf(c); st.ready = true; render();
  }, (e) => { console.warn("자습실 예약 설정", e); st.ready = true; render(); });
  if (isStudent && myUid) {
    stopMine = onSnapshot(query(collection(db, "studyBookings"), where("uid", "==", myUid)), (snap) => {
      st.mine = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (e) => console.warn("내 자습실 예약", e));
    // 같은 시간 부스 예약 안내용 (막지 않음)
    if (myNo) stopBooth = onSnapshot(query(collection(db, "boothBookings"), where("studentNo", "==", myNo)), (snap) => {
      st.booth = snap.docs.map((d) => d.data());
    }, (e) => console.warn("내 부스 예약 (겹침 안내)", e));
  }
  function watchDate() {
    stopDay?.(); stopClosed?.();
    const d = st.date;
    stopDay = onSnapshot(query(collection(db, "studyBookings"), where("date", "==", d)), (snap) => {
      if (d !== st.date) return;
      st.day = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
      render();
      if (!isStudent) findMissingNames();
    }, (e) => showError(e, "자습실 예약 불러오기"));
    stopClosed = onSnapshot(doc(db, "studyClosed", d), (snap) => {
      if (d !== st.date) return;
      st.closed = snap.exists() ? (snap.data().blocks || []) : [];
      render();
    }, (e) => console.warn("자습실 막은 교시", e));
  }
  watchDate();

  // ---- 계산
  const blocks = () => [...st.cfg.blocks].sort((a, b) => a.start.localeCompare(b.start));
  const blockOf = (k) => st.cfg.blocks.find((b) => b.key === k);
  const lastDay = () => isoDay(addDays(new Date(), st.bcfg.aheadDays));
  const now = () => Date.now();
  const countAt = (k) => st.day.filter((b) => (b.blocks || []).includes(k)).length;
  const pastBlock = (d, b) => d < isoDay() || (d === isoDay() && atMs(d, b.end) <= now());
  const closedAt = (k) => st.closed.includes(k);
  const mineAt = (d, k) => st.mine.find((b) => b.date === d && (b.blocks || []).includes(k));
  /** 예약의 교시들을 표 순서대로 */
  const orderOf = (b) => { const list = blocks().map((x) => x.key); return [...(b.blocks || [])].sort((x, y) => list.indexOf(x) - list.indexOf(y)); };
  const spanOf = (keys) => { const bs = keys.map(blockOf).filter(Boolean); return bs.length ? { start: bs[0].start, end: bs[bs.length - 1].end } : { start: "", end: "" }; };
  /** '5교시 ~ 7교시' (표에서 붙어 있으면) · 떨어져 있으면 '1교시·3교시' */
  function rangeText(keys) {
    const list = blocks().map((x) => x.key), idx = keys.map((k) => list.indexOf(k)).filter((i) => i >= 0).sort((a, b) => a - b);
    const lab = (i) => blocks()[i]?.label || "";
    if (!idx.length) return "";
    if (idx.length === 1) return lab(idx[0]);
    const runs = []; let s = idx[0], p = idx[0];
    idx.slice(1).forEach((i) => { if (i === p + 1) p = i; else { runs.push([s, p]); s = p = i; } }); runs.push([s, p]);
    return runs.map(([a, z]) => a === z ? lab(a) : `${lab(a)} ~ ${lab(z)}`).join(" · ");
  }
  const checkinWin = (b) => { const sp = spanOf(orderOf(b)); return [atMs(b.date, sp.start) - CHECKIN_EARLY * 60000, atMs(b.date, sp.end)]; };
  // 선생님: uid → 학생
  const studentsAll = () => opts.getStudents?.() || [];
  const stuOf = (uid) => studentsAll().find((s) => s.uid && s.uid === uid) || (st.uidNo[uid] ? studentsAll().find((s) => String(s.studentNo) === st.uidNo[uid]) || { studentNo: st.uidNo[uid], name: "" } : null);
  async function findMissingNames() {
    const miss = [...new Set(st.day.map((b) => b.uid))].filter((u) => u && !stuOf(u) && !(u in st.uidNo));
    if (!miss.length) return;
    await Promise.all(miss.map(async (u) => {
      st.uidNo[u] = "";
      try { const s = await getDoc(doc(db, "accounts", u)); if (s.exists() && s.data().role === "student") st.uidNo[u] = String(s.data().key || ""); } catch (_) {}
    }));
    renderGrid();
  }

  // ---- 그리기
  function render() {
    if (!st.ready) return;
    renderMine(); renderTop(); renderDays(); renderTools(); renderMode(); renderGrid(); renderLegend();
  }
  function renderMine() {
    const box = $("#srMine", root);
    if (!isStudent) { box.innerHTML = ""; return; }
    const t = now();
    const up = st.mine.filter((b) => checkinWin(b)[1] > t).sort((a, b) => (a.date + spanOf(orderOf(a)).start).localeCompare(b.date + spanOf(orderOf(b)).start));
    box.innerHTML = up.map((b) => {
      const ks = orderOf(b), sp = spanOf(ks), [w0, w1] = checkinWin(b);
      const canCancel = atMs(b.date, sp.start) - t >= st.bcfg.cancelMin * 60000;
      const ck = tsMs(b.checkinAt);
      const inBtn = ck ? `<span class="sr-in ok">✓ 출석 ${hm(ck)}</span>`
        : t >= w0 && t <= w1 ? `<button type="button" class="btn-sm sr-in go" data-in="${esc(b.id)}">✓ 출석하기</button>`
        : `<span class="sr-in wait" title="예약 시간(시작 ${CHECKIN_EARLY}분 전부터)에 누를 수 있어요">출석은 ${hm(w0)}부터</span>`;
      return `<div class="bb-my"><span class="ic">자습</span>
        <span class="t"><b>${dayText(b.date)} ${esc(rangeText(ks))}</b><small>${esc(sp.start)}–${esc(sp.end)} · ${esc(STUDY_ROOM.place)}</small></span>
        ${inBtn}${canCancel ? `<button type="button" class="btn-sm bb-cancel" data-cancel="${esc(b.id)}">취소</button>` : `<span class="bb-lock">취소 마감</span>`}</div>`;
    }).join("");
    $$("[data-cancel]", box).forEach((x) => x.onclick = () => cancelMine(st.mine.find((b) => b.id === x.dataset.cancel)));
    $$("[data-in]", box).forEach((x) => x.onclick = () => checkIn(st.mine.find((b) => b.id === x.dataset.in), x));
  }
  function renderTop() {
    const a = st.week, b = addDays(a, 4);
    $("#srTop", root).innerHTML = `<button type="button" class="btn-sm" data-wk="-1" aria-label="이전 주">‹</button>
      <b>${a.getMonth() + 1}월 ${a.getDate()}일 – ${b.getMonth() === a.getMonth() ? "" : b.getMonth() + 1 + "월 "}${b.getDate()}일</b>
      <button type="button" class="btn-sm" data-wk="1" aria-label="다음 주">›</button>${!isStudent ? `<button type="button" class="btn-sm" data-today="1">오늘</button>` : ""}`;
    $$("[data-wk]", root).forEach((x) => x.onclick = () => { st.week = addDays(st.week, 7 * Number(x.dataset.wk)); pickDate(isoDay(st.week)); });
    $("[data-today]", root)?.addEventListener("click", () => { st.week = mondayOf(first); pickDate(isoDay(first)); });
  }
  function renderDays() {
    const today = isoDay(), last = lastDay();
    $("#srDays", root).innerHTML = [0, 1, 2, 3, 4].map((k) => {
      const d = addDays(st.week, k), iso = isoDay(d);
      const dot = isStudent && st.mine.some((b) => b.date === iso);
      const far = isStudent && (iso < today || iso > last);
      return `<button type="button" class="${iso === st.date ? "on" : ""} ${far ? "far" : ""}" data-day="${iso}"><small>${WEEK[d.getDay()]}</small><b>${d.getDate()}</b>${dot ? '<i class="dot"></i>' : ""}</button>`;
    }).join("");
    $$("[data-day]", root).forEach((x) => x.onclick = () => pickDate(x.dataset.day));
  }
  function pickDate(iso) {
    if (iso === st.date) { render(); return; }
    st.date = iso; st.day = []; st.closed = []; st.picked.clear();
    watchDate(); render();
  }
  function renderTools() {
    const box = $("#srTools", root);
    const today = st.date === isoDay();
    if (isStudent) {
      const far = st.date > lastDay() ? `<span class="muted">${st.bcfg.aheadDays}일 뒤까지만 예약할 수 있어요.</span>` : st.date < isoDay() ? `<span class="muted">지난 날짜예요.</span>` : "";
      box.innerHTML = `${today ? `<button type="button" class="btn-sm" data-past="1">${st.showPast ? "지난 시간 숨기기" : "지난 시간 보기"}</button>` : ""}${far}`;
    } else {
      box.innerHTML = `<b class="bb-date">${dayText(st.date)}</b>${today ? `<button type="button" class="btn-sm" data-past="1">${st.showPast ? "지난 시간 숨기기" : "지난 시간 보기"}</button>` : ""}
        <div class="spacer"></div>
        <label class="inline-check"><input type="checkbox" id="srMineOnly" ${st.filterMine ? "checked" : ""}> 내 담당 학생만</label>
        <button type="button" class="btn-sm ${st.blockMode ? "btn-primary" : ""}" data-block="1">시간 막기</button>`;
      $("#srMineOnly", box).onchange = (e) => { st.filterMine = e.target.checked; renderGrid(); };
      $("[data-block]", box).onclick = () => { st.blockMode = !st.blockMode; st.picked.clear(); render(); };
    }
    $("[data-past]", box)?.addEventListener("click", () => { st.showPast = !st.showPast; render(); });
  }
  function renderMode() {
    const box = $("#srMode", root);
    box.hidden = isStudent || !st.blockMode;
    if (box.hidden) return;
    box.innerHTML = `<b>시간 막기</b><span>막거나 풀 교시를 누르세요 · ${st.picked.size}교시 고름</span><div class="spacer"></div>
      <button type="button" class="btn-sm bb-lime" data-do="close" ${st.picked.size ? "" : "disabled"}>막기</button>
      <button type="button" class="btn-sm" data-do="open" ${st.picked.size ? "" : "disabled"}>풀기</button>
      <button type="button" class="btn-sm bb-ghost" data-do="exit">닫기</button>`;
    $$("[data-do]", box).forEach((x) => x.onclick = () => x.dataset.do === "exit" ? (st.blockMode = false, st.picked.clear(), render()) : setClosed(x.dataset.do === "close"));
  }
  function renderLegend() {
    $("#srLegend", root).innerHTML = isStudent
      ? `<span><i class="lg free"></i>예약 가능 (숫자 = 그 교시 예약한 학생 수)</span><span><i class="lg me"></i>내 예약</span><span><i class="lg off"></i>선생님이 막음</span>`
      : `<span>✓ = 학생이 [출석하기]를 누름 (예약마다 한 번 — 첫 교시에 표시)</span><span>× 를 누르면 그 예약을 지우고 학생에게 알려요</span>`;
  }
  function renderGrid() {
    const box = $("#srGrid", root);
    const d = st.date, today = isoDay();
    if (isStudent && (d < today || d > lastDay())) { box.innerHTML = `<div class="empty">${d < today ? "지난 날짜는 예약할 수 없어요." : `${st.bcfg.aheadDays}일 뒤까지만 예약할 수 있어요.`}</div>`; return; }
    let list = blocks();
    if (d === today && !st.showPast) list = list.filter((b) => !pastBlock(d, b));
    if (!list.length) { box.innerHTML = `<div class="empty">오늘 남은 시간이 없어요.</div>`; return; }
    const mineSet = !isStudent && st.filterMine ? new Set(studentsAll().filter((s) => opts.isMine?.(s)).map((s) => String(s.studentNo))) : null;
    const head = `<div class="bb-row bb-hd"><div></div><div class="bb-h c3"><b>${esc(STUDY_ROOM.name)}</b><small>${esc(STUDY_ROOM.place)} · 인원 제한 없음</small></div></div>`;
    const rows = list.map((b, i) => `<div class="bb-row bb-sl${i % 2 ? " z" : ""}"><div class="bb-tm"><b>${esc(b.label)}</b><small>${esc(b.start)}–${esc(b.end)}${isClass(b) ? " · 수업" : ""}</small></div>
      <div class="bb-c">${isStudent ? studentCell(b, list) : teacherCell(b, mineSet)}</div></div>`).join("");
    box.innerHTML = `<div class="bb-place">장소 · <b>${esc(STUDY_ROOM.place)}</b>${isStudent ? " · 칸을 누르면 그 교시부터 예약해요" : ""}</div><div class="bb-tt">${head}${rows}</div>`;
    $$("[data-cell]", box).forEach((x) => x.onclick = () => onCell(x.dataset.cell));
    $$("[data-del]", box).forEach((x) => x.onclick = (e) => { e.stopPropagation(); teacherDelete(st.day.find((b) => b.id === x.dataset.del)); });
  }
  function studentCell(b, list) {
    const d = st.date, n = countAt(b.key), cnt = `<span class="n">· ${n}명</span>`;
    const mine = mineAt(d, b.key);
    if (mine) {
      // 같은 예약에서 위·아래 칸과 이어 보이게
      const i = list.indexOf(b), up = i > 0 && (mine.blocks || []).includes(list[i - 1].key), dn = i < list.length - 1 && (mine.blocks || []).includes(list[i + 1].key);
      const pos = up && dn ? " mid" : up ? " end" : dn ? " start" : "";
      return `<button type="button" class="bb-s me${pos}" data-cell="${esc(b.key)}">내 예약${tsMs(mine.checkinAt) ? " ✓" : ""} ${cnt}</button>`;
    }
    if (pastBlock(d, b)) return `<button type="button" class="bb-s past" disabled>지남 ${cnt}</button>`;
    if (closedAt(b.key)) return `<button type="button" class="bb-s off" disabled>선생님이 막음</button>`;
    return `<button type="button" class="bb-s free" data-cell="${esc(b.key)}">예약 ${cnt}</button>`;
  }
  function teacherCell(b, mineSet) {
    const bks = st.day.filter((x) => (x.blocks || []).includes(b.key));
    const picked = st.picked.has(b.key), closed = closedAt(b.key);
    const who = bks.map((x) => {
      const s = stuOf(x.uid), ks = orderOf(x), isFirst = ks[0] === b.key;
      const dim = mineSet && !(s && mineSet.has(String(s.studentNo)));
      const ck = tsMs(x.checkinAt);
      const tip = `${rangeText(ks)} ${spanOf(ks).start}–${spanOf(ks).end}${ck ? ` · ${hm(ck)} 출석` : ""}`;
      return `<span class="bb-who${isFirst ? "" : " cont"}${dim ? " dim" : ""}" title="${esc(tip)}">${isFirst && ck ? '<i class="bb-use ok">✓</i>' : ""}${s ? `${esc(s.studentNo)} ${esc(s.name || "")}` : '<span class="muted">알 수 없는 학생</span>'}${isFirst ? "" : "<em>이어서</em>"}<button type="button" data-del="${esc(x.id)}" aria-label="예약 지우기">×</button></span>`;
    }).join("");
    const cnt = bks.length ? `<span class="bb-cnt">${bks.length}명</span>` : "";
    const empty = !bks.length ? `<span class="bb-empty">${closed ? "막음" : "비어 있음"}</span>` : "";
    return `<div class="bb-tc${closed ? " off" : ""}${picked ? " picked" : ""}" data-cell="${esc(b.key)}" role="button" tabindex="0">${who}${empty}${cnt}</div>`;
  }

  // ---- 칸 누름
  function onCell(k) {
    const b = blockOf(k);
    if (!b) return;
    if (!isStudent) {
      if (st.blockMode) { st.picked.has(k) ? st.picked.delete(k) : st.picked.add(k); renderMode(); renderGrid(); }
      return;
    }
    const mine = mineAt(st.date, k);
    if (mine) return openMineSheet(mine, b);
    openSheet(b);
  }
  /** 학생: 고른 교시부터 이어서 잡을 수 있는 교시들 (지나지 않음·막히지 않음·내 예약 아님 — 표에서 붙어 있는 데까지) */
  function runFrom(b) {
    const list = blocks(), i = list.indexOf(list.find((x) => x.key === b.key)), out = [];
    for (let j = i; j < list.length; j++) {
      const x = list[j];
      if (pastBlock(st.date, x) || closedAt(x.key) || mineAt(st.date, x.key)) break;
      out.push(x);
    }
    return out;
  }
  /** 일과 통째로 = 1~7교시(사이 점심시간 포함) 중 지나지 않고·막히지 않고·내 예약 아닌 교시 */
  function wholeDay() {
    const list = blocks(), cls = list.map((x, i) => isClass(x) ? i : -1).filter((i) => i >= 0);
    if (!cls.length) return [];
    return list.slice(cls[0], cls[cls.length - 1] + 1).filter((x) => !pastBlock(st.date, x) && !closedAt(x.key) && !mineAt(st.date, x.key));
  }
  /** 같은 시간 내 모의면접·부스 예약 (안내만) */
  function clashes(keys) {
    const sp = spanOf(keys), d = st.date, a = toMin(sp.start), z = toMin(sp.end);
    const inRange = (s, e) => keys.some((k) => { const b = blockOf(k); return b && toMin(s) < toMin(b.end) && toMin(b.start) < toMin(e); }) && toMin(s) < z && a < toMin(e);
    const out = [];
    (opts.getInterviewBookings?.() || []).filter((b) => b.date === d && ACTIVE(b.status) && inRange(b.start, b.end))
      .forEach((b) => out.push(`${stageShort(b.stage)} 모의면접 ${b.start}–${b.end}`));
    st.booth.filter((b) => b.date === d && b.res !== "self" && inRange(b.start, b.end))
      .forEach((b) => out.push(`부스 예약 ${b.start}–${b.end}`));
    return out;
  }

  // ---- 예약 창 (아래에서 올라옴)
  function sheetShell(title, sub, inner) {
    document.getElementById("srSheet")?.remove();
    document.body.insertAdjacentHTML("beforeend", `<div class="bb-sheet-bg" id="srSheet"><form class="bb-sheet" role="dialog" aria-modal="true" aria-labelledby="srT" novalidate>
      <div class="bb-grip"></div><h3 id="srT">${title}</h3><div class="muted">${sub}</div>${inner}</form></div>`);
    const bg = $("#srSheet");
    requestAnimationFrame(() => bg.classList.add("on"));
    const close = () => { bg.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    bg.onclick = (e) => { if (e.target === bg) close(); };
    $("[data-x]", bg)?.addEventListener("click", close);
    return { bg, close };
  }
  function openSheet(b) {
    const run = runFrom(b), whole = wholeDay();
    if (!run.length) return toast("이 교시는 예약할 수 없어요.", "error");
    let pick = { kind: "run", n: 1 };   // run: 고른 교시부터 n개 · whole: 일과 통째로
    const { bg, close } = sheetShell("자습실 예약", `${dayText(st.date)} · ${esc(STUDY_ROOM.place)} · 인원 제한 없음`, `
      <label class="bb-l">언제까지 쓸까요? (${esc(b.label)}부터)</label>
      <div class="sr-opts" id="srOpts"></div>
      ${whole.length ? `<button type="button" class="sr-whole" id="srWhole">일과 통째로 (1~7교시) <small>${whole.length}개 교시 · ${esc(whole[0].start)}–${esc(whole[whole.length - 1].end)}</small></button>` : ""}
      <div id="srWarn"></div>
      <div class="bb-info">예약하면 바로 확정돼요. 막힌 교시를 건너서는 이어지지 않아요. 못 오면 <b>시작 ${st.bcfg.cancelMin}분 전까지</b> 취소해 주세요.
        자습실에 오면 위 '내 예약'에서 <b>[출석하기]</b>를 눌러 주세요 (시작 ${CHECKIN_EARLY}분 전부터).</div>
      <div class="bb-btns"><button type="button" data-x="1">닫기</button><button type="submit" class="btn-primary" id="srGo">예약하기</button></div>`);
    const keysNow = () => pick.kind === "whole" ? whole.map((x) => x.key) : run.slice(0, pick.n).map((x) => x.key);
    const draw = () => {
      $("#srOpts", bg).innerHTML = run.map((x, i) => `<button type="button" class="sr-opt${pick.kind === "run" && pick.n === i + 1 ? " on" : ""}" data-n="${i + 1}">
        <span class="rd"></span>${i ? `${esc(x.label)}까지` : `${esc(x.label)}만`}<small>${esc(b.start)}–${esc(x.end)}</small></button>`).join("");
      $$("[data-n]", bg).forEach((x) => x.onclick = () => { pick = { kind: "run", n: Number(x.dataset.n) }; draw(); });
      $("#srWhole", bg)?.classList.toggle("on", pick.kind === "whole");
      const keys = keysNow(), cl = clashes(keys);
      $("#srWarn", bg).innerHTML = cl.length ? `<div class="sr-warn">이 시간에 ${esc(cl.join(", "))}이 있어요. 예약은 할 수 있어요.</div>` : "";
      $("#srGo", bg).textContent = pick.kind === "whole" ? "일과 통째로 예약" : `${rangeText(keys)} 예약`;
    };
    $("#srWhole", bg)?.addEventListener("click", () => { pick = { kind: "whole" }; draw(); });
    draw();
    $("form", bg).onsubmit = async (e) => {
      e.preventDefault();
      const keys = keysNow();
      if (!keys.length) return;
      // 그 사이 막혔거나 지났는지 다시
      if (keys.some((k) => closedAt(k) || mineAt(st.date, k) || pastBlock(st.date, blockOf(k)))) { toast("그 사이 예약할 수 없게 된 교시가 있어요. 다시 골라 주세요.", "error"); close(); return; }
      const sp = spanOf(keys);
      $("#srGo", bg).disabled = true;
      try {
        await addDoc(collection(db, "studyBookings"), { uid: myUid, date: st.date, blocks: keys, start: sp.start, end: sp.end, createdAt: serverTimestamp() });
        close(); toast("예약했어요. 오면 [출석하기]를 눌러 주세요.");
      } catch (err) { $("#srGo", bg).disabled = false; showError(err, "자습실 예약"); }
    };
  }
  /** 내 예약 칸을 눌렀을 때: 이 교시만 빼기(예약 맨 앞·맨 끝 교시, 시작 전) · 전체 취소 */
  function openMineSheet(mine, b) {
    const ks = orderOf(mine), sp = spanOf(ks), t = now();
    const edge = ks.length > 1 && (ks[0] === b.key || ks[ks.length - 1] === b.key);
    const canTrim = edge && !tsMs(mine.checkinAt) && atMs(mine.date, b.start) - t >= st.bcfg.cancelMin * 60000;
    const canCancel = atMs(mine.date, sp.start) - t >= st.bcfg.cancelMin * 60000;
    const { bg, close } = sheetShell("내 자습실 예약", `${dayText(mine.date)} ${esc(rangeText(ks))} · ${esc(sp.start)}–${esc(sp.end)}`, `
      <div class="bb-info">${tsMs(mine.checkinAt) ? `✓ ${hm(tsMs(mine.checkinAt))}에 출석했어요.` : `출석은 위 '내 예약'의 [출석하기]로 해요 (시작 ${CHECKIN_EARLY}분 전부터).`}
        ${!canCancel ? `<br>시작 ${st.bcfg.cancelMin}분 전이 지나 취소할 수 없어요.` : ""}</div>
      <div class="bb-btns"><button type="button" data-x="1">닫기</button>
        ${edge ? `<button type="button" id="srTrim" ${canTrim ? "" : "disabled"}>${esc(b.label)}만 빼기</button>` : ""}
        <button type="button" class="btn-primary" id="srAll" ${canCancel ? "" : "disabled"}>전체 취소</button></div>`);
    $("#srTrim", bg)?.addEventListener("click", async () => {
      const rest = ks.filter((k) => k !== b.key), s2 = spanOf(rest);
      try { await updateDoc(doc(db, "studyBookings", mine.id), { blocks: rest, start: s2.start, end: s2.end }); close(); toast(`${b.label}을 뺐어요.`); }
      catch (e) { showError(e, "예약 고치기"); }
    });
    $("#srAll", bg).onclick = async () => { close(); await cancelMine(mine); };
  }

  // ---- 쓰기
  async function cancelMine(b) {
    if (!b) return;
    const ks = orderOf(b), sp = spanOf(ks);
    if (atMs(b.date, sp.start) - now() < st.bcfg.cancelMin * 60000) return toast(`시작 ${st.bcfg.cancelMin}분 전부터는 취소할 수 없어요. 선생님께 말씀해 주세요.`, "error");
    if (!(await confirmBox({ title: "이 예약을 취소할까요?", what: `<b>${dayText(b.date)} ${esc(rangeText(ks))}</b> · ${esc(sp.start)}–${esc(sp.end)}`, yes: "예약 취소" }))) return;
    try { await deleteDoc(doc(db, "studyBookings", b.id)); toast("예약을 취소했어요."); } catch (e) { showError(e, "예약 취소"); }
  }
  async function checkIn(b, btn) {
    if (!b) return;
    const [w0, w1] = checkinWin(b), t = now();
    if (t < w0 || t > w1) return toast(`출석은 예약 시간(시작 ${CHECKIN_EARLY}분 전부터 끝날 때까지)에만 할 수 있어요.`, "error");
    if (btn) btn.disabled = true;
    try { await updateDoc(doc(db, "studyBookings", b.id), { checkinAt: serverTimestamp() }); toast("출석했어요."); }
    catch (e) { if (btn) btn.disabled = false; showError(e, "출석"); }
  }
  const notifyRemoved = (b, what) => {
    const s = stuOf(b.uid);
    if (!s?.studentNo) return null;
    return queueNotify({ key: String(s.studentNo), title: "자습실 예약이 바뀌었어요",
      body: `${dayText(b.date)} ${what} · ${opts.myName ? opts.myName + " 선생님" : "선생님"}이 바꿨어요`, url: "student.html", tag: `sr_${b.id}` });
  };
  async function teacherDelete(b) {
    if (!b) return;
    const s = stuOf(b.uid), ks = orderOf(b), sp = spanOf(ks);
    if (!(await confirmBox({ title: "이 예약을 지울까요?", what: `<b>${s ? `${esc(s.studentNo)} ${esc(s.name || "")}` : "알 수 없는 학생"}</b> · ${dayText(b.date)} ${esc(rangeText(ks))} ${esc(sp.start)}–${esc(sp.end)}`, note: "학생 휴대폰으로 알림이 가요.", yes: "지우기" }))) return;
    try { await deleteDoc(doc(db, "studyBookings", b.id)); notifyRemoved(b, `${rangeText(ks)} 예약이 취소됐어요`); toast("예약을 지웠어요."); }
    catch (e) { showError(e, "예약 지우기"); }
  }
  // ---- 교사: 막기·풀기 (막을 교시에 예약이 있으면 그 교시만 예약에서 빼고 학생에게 알림)
  async function setClosed(close) {
    const keys = [...st.picked];
    if (!keys.length) return;
    const bks = close ? st.day.filter((b) => (b.blocks || []).some((k) => keys.includes(k))) : [];
    if (bks.length && !(await confirmBox({ title: `예약 ${bks.length}건에서 그 교시를 뺄까요?`,
      what: bks.map((b) => { const s = stuOf(b.uid); return `${s ? `${esc(s.studentNo)} ${esc(s.name || "")}` : "알 수 없는 학생"} · ${esc(rangeText(orderOf(b)))}`; }).join("<br>"),
      note: "남는 교시가 없으면 예약을 지워요. 학생에게 알림이 가요.", yes: "빼고 막기" }))) return;
    try {
      for (const b of bks) {
        const rest = orderOf(b).filter((k) => !keys.includes(k));
        if (rest.length) { const s2 = spanOf(rest); await updateDoc(doc(db, "studyBookings", b.id), { blocks: rest, start: s2.start, end: s2.end }); }
        else await deleteDoc(doc(db, "studyBookings", b.id));
        notifyRemoved(b, `${rangeText(orderOf(b).filter((k) => keys.includes(k)))}이 막혀 ${rest.length ? "그 교시만 빠졌어요" : "예약이 취소됐어요"}`);
      }
      const next = close ? [...new Set([...st.closed, ...keys])] : st.closed.filter((k) => !keys.includes(k));
      await setDoc(doc(db, "studyClosed", st.date), { blocks: next, by: opts.myName || "" });
      st.picked.clear(); toast(close ? `${keys.length}교시를 막았어요.` : `${keys.length}교시를 풀었어요.`); render();
    } catch (e) { showError(e, close ? "시간 막기" : "막기 풀기"); }
  }

  return {
    render,
    stop() { stopDay?.(); stopClosed?.(); stopMine?.(); stopCfg?.(); stopBooth?.(); }
  };
}
