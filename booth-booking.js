// 면접 부스·셀프 연습 예약 (일정 탭 '부스 예약') — 학생 화면과 교사 화면이 같이 쓴다.
// 선착순 바로 확정(승인 없음). 칸은 일정 설정의 교시 칸을 30분씩 나눈 것이고, 바로 이어진 칸 2개(maxRun)까지 한 번에 잡는다.
//
// 저장 (firestore.rules '부스 예약' 참고)
//   boothSlots/{날짜_자리_HHMM}  자리 하나·칸 하나. ids: 그 칸을 잡은 예약 id 목록(학번·이름 없음 → 학생에게는 'n/정원'만 보임),
//                                closed: 교사가 막음
//   boothBookings/{id}           예약 하나: 학번·자리·날짜·시작~끝·slots(칸 문서 id 1~2개)
//   config/schedule.booth        자리 이름·장소·정원·켬, 매주 막는 시간, 며칠 앞까지, 취소 마감(분)
//   config/schedule.boothCaps    자리별 정원 (규칙이 읽음 — 없으면 규칙의 기본값)
// 예약·취소는 칸 문서와 예약 문서를 한 트랜잭션으로 함께 쓴다 (정원은 규칙과 트랜잭션이 함께 지킴).
import {
  db, collection, doc, getDocs, query, where, runTransaction, setDoc, onSnapshot, serverTimestamp,
  $, $$, esc, toast, showError, isoDay, toDate, confirmBox
} from "./common.js";
import { scheduleConfigOf, ACTIVE } from "./schedule.js";
import { queueNotify } from "./notify.js";

// ================= 설정 =================
export const DEFAULT_BOOTH = {
  resources: [
    { key: "booth1", name: "AI 부스 1", place: "진학상담실", cap: 1, on: true },
    { key: "booth2", name: "AI 부스 2", place: "진학상담실", cap: 1, on: true },
    { key: "self", name: "셀프 면접 연습", place: "진학상담실", cap: 4, on: true }
  ],
  weeklyOff: [],        // [{ dow: 1(월)~5, block: 칸 코드, res: "all" | 자리 key }]
  aheadDays: 14,        // 오늘부터 며칠 앞까지 예약
  cancelMin: 10,        // 학생은 시작 이만큼(분) 전까지 취소
  maxRun: 2             // 한 학생이 바로 이어서 잡을 수 있는 칸 수 (예약을 따로 잡아 이어 붙여도 같음)
};
const RES_KEYS = DEFAULT_BOOTH.resources.map((r) => r.key);
export function boothConfigOf(c = {}) {
  const b = c.booth && typeof c.booth === "object" ? c.booth : {};
  const saved = Array.isArray(b.resources) ? b.resources : [];
  const resources = DEFAULT_BOOTH.resources.map((d) => {
    const s = saved.find((x) => x && x.key === d.key) || {};
    const cap = Math.max(1, Math.min(10, Math.round(Number(s.cap) || d.cap)));
    return { key: d.key, name: String(s.name || d.name).trim() || d.name, place: String(s.place ?? d.place).trim(), cap, on: s.on !== false };
  });
  const num = (v, d, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  return {
    resources,
    weeklyOff: (Array.isArray(b.weeklyOff) ? b.weeklyOff : []).filter((w) => w && w.dow >= 0 && w.dow <= 6 && w.block),
    aheadDays: num(b.aheadDays, DEFAULT_BOOTH.aheadDays, 1, 60),
    cancelMin: num(b.cancelMin, DEFAULT_BOOTH.cancelMin, 0, 120),
    maxRun: DEFAULT_BOOTH.maxRun
  };
}

// ================= 시간 도우미 =================
const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const WEEK = "일월화수목금토";
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dayText = (iso) => { const d = toDate(iso); return d ? `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})` : iso; };
const atMs = (iso, hm) => { const d = toDate(iso); if (!d) return 0; const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime() + toMin(hm) * 60000; };
export const slotId = (date, res, start) => `${date}_${res}_${String(start).replace(":", "")}`;

/** 하루 칸 목록 — 교시 칸을 30분씩. 남는 시간이 20분 이상이면 따로 한 칸, 20분 미만이면 앞 칸에 붙인다 (50분 = 30+20, 70분 = 30+40) */
export function daySlots(blocks) {
  const out = [];
  [...blocks].sort((a, b) => a.start.localeCompare(b.start)).forEach((b) => {
    const s = toMin(b.start), e = toMin(b.end);
    for (let t = s; t < e;) {
      let n = t + 30;
      if (n >= e || e - n < 20) n = e;
      out.push({ i: out.length, block: b.key, blockLabel: b.label, start: fromMin(t), end: fromMin(n), len: n - t });
      t = n;
    }
  });
  return out;
}
const weeklyOffAt = (bcfg, date, block, res) => {
  const dow = toDate(date)?.getDay();
  return bcfg.weeklyOff.some((w) => Number(w.dow) === dow && w.block === block && (w.res === "all" || w.res === res));
};
/** 같은 날 칸 번호 목록에서 가장 긴 연속 길이 */
const maxRunOf = (idx) => { const s = [...new Set(idx)].sort((a, b) => a - b); let best = 0, run = 0; s.forEach((v, k) => { run = k && v === s[k - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); }); return best; };

// ================= 화면 =================
/**
 * opts: role("student"|"teacher"|"admin"), student(학생 화면: 프로필), getStudents(교사), myName(교사 이름),
 *       getInterviewBookings(학생: 면접 일정 — 겹침 확인), onBadge(n: 오늘 예약 수, 교사)
 */
export function mountBoothBooking(root, opts) {
  const isStudent = opts.role === "student", isAdmin = opts.role === "admin";
  const me = isStudent ? String(opts.student?.studentNo || "") : "";
  // 처음 보여 줄 날: 오늘 (토·일이면 다음 월요일)
  const first = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); const w = d.getDay(); return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d; })();
  const st = {
    cfg: scheduleConfigOf({}), bcfg: boothConfigOf({}), date: isoDay(first), week: mondayOf(first),
    slots: {}, dayBookings: [], mine: [], showPast: false, blockMode: false, picked: new Set(), filterMine: false, ready: false
  };
  let stopSlots = null, stopBk = null, stopMine = null, stopCfg = null;

  root.innerHTML = `<div class="bb">
    <div class="bb-mine" id="bbMine"></div>
    <div class="bb-top" id="bbTop"></div>
    <div class="bb-days" id="bbDays"></div>
    <div class="bb-tools" id="bbTools"></div>
    <div class="bb-mode" id="bbMode" hidden></div>
    <div id="bbGrid"><div class="empty">불러오는 중…</div></div>
    <div class="bb-legend" id="bbLegend"></div>
  </div>`;

  // ---- 읽기 (실시간)
  stopCfg = onSnapshot(doc(db, "config", "schedule"), (snap) => {
    const c = snap.exists() ? snap.data() : {};
    st.cfg = scheduleConfigOf(c); st.bcfg = boothConfigOf(c); st.ready = true; render();
  }, (e) => { console.warn("부스 예약 설정", e); st.ready = true; render(); });
  if (isStudent && me) {
    stopMine = onSnapshot(query(collection(db, "boothBookings"), where("studentNo", "==", me)), (snap) => {
      st.mine = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }, (e) => console.warn("내 부스 예약", e));
  }
  function watchDate() {
    stopSlots?.(); stopBk?.();
    const d = st.date;
    stopSlots = onSnapshot(query(collection(db, "boothSlots"), where("date", "==", d)), (snap) => {
      if (d !== st.date) return;
      st.slots = Object.fromEntries(snap.docs.map((x) => [x.id, x.data()]));
      render();
    }, (e) => showError(e, "부스 예약 불러오기"));
    if (!isStudent) {
      stopBk = onSnapshot(query(collection(db, "boothBookings"), where("date", "==", d)), (snap) => {
        if (d !== st.date) return;
        st.dayBookings = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
        render();
        if (d === isoDay()) opts.onBadge?.(st.dayBookings.length);
      }, (e) => showError(e, "부스 예약 불러오기"));
    }
  }
  watchDate();

  // ---- 계산
  const resources = () => st.bcfg.resources.filter((r) => r.on);
  const resOf = (key) => st.bcfg.resources.find((r) => r.key === key);
  const slotsOfDay = () => daySlots(st.cfg.blocks);
  const idsAt = (date, res, start) => st.slots[slotId(date, res, start)]?.ids || [];
  const closedAt = (date, res, start) => !!st.slots[slotId(date, res, start)]?.closed;
  const lastDay = () => isoDay(addDays(new Date(), st.bcfg.aheadDays));
  const nowMs = () => Date.now();
  const studentName = (no) => (opts.getStudents?.() || []).find((s) => String(s.studentNo) === String(no))?.name || "";
  /** 학생: 그날 내 예약이 차지한 칸 번호 (자리 상관없이) */
  function myIdx(date, exceptId = "") {
    const list = daySlots(st.cfg.blocks);
    return st.mine.filter((b) => b.date === date && b.id !== exceptId)
      .flatMap((b) => list.filter((x) => toMin(x.start) >= toMin(b.start) && toMin(x.end) <= toMin(b.end)).map((x) => x.i));
  }
  /** 학생: 내 면접 일정과 시간이 겹치는지 */
  const interviewClash = (date, s, e) => (opts.getInterviewBookings?.() || [])
    .some((b) => b.date === date && ACTIVE(b.status) && toMin(b.start) < toMin(e) && toMin(s) < toMin(b.end));
  /** 칸 하나의 상태 (학생 화면) */
  function cellState(sl, res) {
    const r = resOf(res), d = st.date, ids = idsAt(d, res, sl.start);
    const mine = st.mine.find((b) => b.date === d && b.res === res && toMin(b.start) <= toMin(sl.start) && toMin(sl.end) <= toMin(b.end));
    if (mine) return { k: "me", t: "내 예약", b: mine };
    if (d < isoDay() || (d === isoDay() && atMs(d, sl.end) <= nowMs())) return { k: "past", t: "지남" };
    if (closedAt(d, res, sl.start) || weeklyOffAt(st.bcfg, d, sl.block, res)) return { k: "off", t: "막음" };
    if (ids.length >= r.cap) return { k: "full", t: r.cap > 1 ? `${ids.length}/${r.cap}` : "마감" };
    if (myIdx(d).includes(sl.i) || interviewClash(d, sl.start, sl.end)) return { k: "clash", t: "겹침" };
    return { k: r.cap > 1 && ids.length ? "part" : "free", t: r.cap > 1 ? `${ids.length}/${r.cap}` : "예약" };
  }

  // ---- 그리기
  function render() {
    if (!st.ready) return;
    renderMine(); renderTop(); renderDays(); renderTools(); renderMode(); renderGrid(); renderLegend();
  }
  function renderMine() {
    const box = $("#bbMine", root);
    if (!isStudent) { box.innerHTML = ""; return; }
    const now = nowMs();
    const up = st.mine.filter((b) => atMs(b.date, b.end) > now).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    box.innerHTML = up.map((b) => {
      const r = resOf(b.res) || { name: b.res, place: "" };
      const canCancel = atMs(b.date, b.start) - now >= st.bcfg.cancelMin * 60000;
      const ic = b.res === "self" ? "셀프" : b.res === "booth2" ? "AI 2" : "AI 1";
      return `<div class="bb-my"><span class="ic">${ic}</span>
        <span class="t"><b>${dayText(b.date)} ${esc(b.start)}–${esc(b.end)}${(b.slots || []).length > 1 ? " · 2칸" : ""}</b><small>${esc(r.name)}${r.place ? " · " + esc(r.place) : ""}</small></span>
        ${canCancel ? `<button type="button" class="btn-sm bb-cancel" data-cancel="${esc(b.id)}">취소</button>` : `<span class="bb-lock">취소 마감</span>`}</div>`;
    }).join("");
    $$("[data-cancel]", box).forEach((x) => x.onclick = () => cancelMine(st.mine.find((b) => b.id === x.dataset.cancel)));
  }
  function renderTop() {
    const a = st.week, b = addDays(a, 4);
    $("#bbTop", root).innerHTML = `<button type="button" class="btn-sm" data-wk="-1" aria-label="이전 주">‹</button>
      <b>${a.getMonth() + 1}월 ${a.getDate()}일 – ${b.getMonth() === a.getMonth() ? "" : b.getMonth() + 1 + "월 "}${b.getDate()}일</b>
      <button type="button" class="btn-sm" data-wk="1" aria-label="다음 주">›</button>${!isStudent ? `<button type="button" class="btn-sm" data-today="1">오늘</button>` : ""}`;
    $$("[data-wk]", root).forEach((x) => x.onclick = () => { st.week = addDays(st.week, 7 * Number(x.dataset.wk)); pickDate(isoDay(st.week)); });
    $("[data-today]", root)?.addEventListener("click", () => { st.week = mondayOf(first); pickDate(isoDay(first)); });
  }
  function renderDays() {
    const today = isoDay(), last = lastDay();
    $("#bbDays", root).innerHTML = [0, 1, 2, 3, 4].map((k) => {
      const d = addDays(st.week, k), iso = isoDay(d);
      const dot = isStudent ? st.mine.some((b) => b.date === iso) : false;
      const far = isStudent && (iso < today || iso > last);
      return `<button type="button" class="${iso === st.date ? "on" : ""} ${far ? "far" : ""}" data-day="${iso}"><small>${WEEK[d.getDay()]}</small><b>${d.getDate()}</b>${dot ? '<i class="dot"></i>' : ""}</button>`;
    }).join("");
    $$("[data-day]", root).forEach((x) => x.onclick = () => pickDate(x.dataset.day));
  }
  function pickDate(iso) {
    if (iso === st.date) { render(); return; }
    st.date = iso; st.slots = {}; st.dayBookings = []; st.picked.clear();
    watchDate(); render();
  }
  function renderTools() {
    const box = $("#bbTools", root);
    const today = st.date === isoDay();
    if (isStudent) {
      const far = st.date > lastDay() ? `<span class="muted">${st.bcfg.aheadDays}일 뒤까지만 예약할 수 있어요.</span>` : st.date < isoDay() ? `<span class="muted">지난 날짜예요.</span>` : "";
      box.innerHTML = `${today ? `<button type="button" class="btn-sm" data-past="1">${st.showPast ? "지난 시간 숨기기" : "지난 시간 보기"}</button><span class="muted">오늘은 지금 시간부터 보여요</span>` : ""}${far}`;
    } else {
      box.innerHTML = `<b class="bb-date">${dayText(st.date)}</b>${today ? `<button type="button" class="btn-sm" data-past="1">${st.showPast ? "지난 시간 숨기기" : "지난 시간 보기"}</button>` : ""}
        <div class="spacer"></div>
        <label class="inline-check"><input type="checkbox" id="bbMineOnly" ${st.filterMine ? "checked" : ""}> 내 담당 학생만</label>
        <button type="button" class="btn-sm ${st.blockMode ? "btn-primary" : ""}" data-block="1">시간 막기</button>
        ${isAdmin ? `<button type="button" class="btn-sm" data-set="1">설정</button>` : ""}`;
      $("#bbMineOnly", box).onchange = (e) => { st.filterMine = e.target.checked; renderGrid(); };
      $("[data-block]", box).onclick = () => { st.blockMode = !st.blockMode; st.picked.clear(); render(); };
      $("[data-set]", box)?.addEventListener("click", openSettings);
    }
    $("[data-past]", box)?.addEventListener("click", () => { st.showPast = !st.showPast; render(); });
  }
  function renderMode() {
    const box = $("#bbMode", root);
    box.hidden = isStudent || !st.blockMode;
    if (box.hidden) return;
    box.innerHTML = `<b>시간 막기</b><span>막거나 풀 칸을 누르세요 · ${st.picked.size}칸 고름</span><div class="spacer"></div>
      <button type="button" class="btn-sm bb-lime" data-do="close" ${st.picked.size ? "" : "disabled"}>막기</button>
      <button type="button" class="btn-sm" data-do="open" ${st.picked.size ? "" : "disabled"}>풀기</button>
      <button type="button" class="btn-sm bb-ghost" data-do="exit">닫기</button>`;
    $$("[data-do]", box).forEach((x) => x.onclick = () => x.dataset.do === "exit" ? (st.blockMode = false, st.picked.clear(), render()) : setClosed(x.dataset.do === "close"));
  }
  function renderLegend() {
    $("#bbLegend", root).innerHTML = isStudent
      ? `<span><i class="lg free"></i>예약 가능</span><span><i class="lg me"></i>내 예약</span><span><i class="lg full"></i>마감</span><span><i class="lg clash"></i>내 다른 일정과 겹침</span><span><i class="lg off"></i>선생님이 막음</span>`
      : `<span><i class="lg off"></i>막음 (매주 막음은 설정에서)</span><span>× 를 누르면 예약을 지우고 학생에게 알려요</span>`;
  }
  function renderGrid() {
    const box = $("#bbGrid", root);
    const rs = resources();
    if (!rs.length) { box.innerHTML = `<div class="empty">켜 둔 자리가 없어요.${isAdmin ? " ‘설정’에서 켜 주세요." : ""}</div>`; return; }
    const d = st.date, today = isoDay(), nowM = new Date().getHours() * 60 + new Date().getMinutes();
    let list = slotsOfDay();
    if (d === today && !st.showPast) list = list.filter((s) => toMin(s.end) > nowM);
    if (isStudent && (d < today || d > lastDay())) { box.innerHTML = `<div class="empty">${d < today ? "지난 날짜는 예약할 수 없어요." : `${st.bcfg.aheadDays}일 뒤까지만 예약할 수 있어요.`}</div>`; return; }
    if (!list.length) { box.innerHTML = `<div class="empty">오늘 남은 시간이 없어요.</div>`; return; }
    const cols = `style="--bb-cols:${rs.length}"`;
    // 자리가 모두 같은 곳이면 장소는 표 위에 한 번만, 머리에는 정원만
    const places = [...new Set(rs.map((r) => r.place).filter(Boolean))], one = places.length === 1;
    const sub = (r) => [one ? "" : r.place, r.cap > 1 ? `최대 ${r.cap}명` : one ? "1명" : ""].filter(Boolean).join(" · ");
    const head = `<div class="bb-row bb-hd" ${cols}><div></div>${rs.map((r) => `<div class="bb-h c${RES_KEYS.indexOf(r.key) + 1}"><b>${esc(r.name)}</b><small>${esc(sub(r))}</small></div>`).join("")}</div>`;
    let html = head, lastBlock = "", nowDrawn = !(d === today), zebra = 0;
    const mineSet = st.filterMine ? new Set((opts.getStudents?.() || []).filter((s) => opts.isMine?.(s)).map((s) => String(s.studentNo))) : null;
    list.forEach((sl) => {
      if (!nowDrawn && toMin(sl.start) > nowM) { html += `<div class="bb-now"><span>지금 ${fromMin(nowM)}</span></div>`; nowDrawn = true; }
      if (sl.block !== lastBlock) {
        const b = st.cfg.blocks.find((x) => x.key === sl.block);
        const cls = /^p\d$/.test(sl.block);
        html += `<div class="bb-band${cls ? " cls" : ""}"><b>${esc(sl.blockLabel)}</b><small>${esc(b?.start || "")}–${esc(b?.end || "")}${cls ? " · 수업 시간" : ""}</small></div>`;
        lastBlock = sl.block;
      }
      html += `<div class="bb-row bb-sl${zebra++ % 2 ? " z" : ""}" ${cols}><div class="bb-tm">${esc(sl.start)}<small>${sl.len}분</small></div>${rs.map((r) => `<div class="bb-c">${isStudent ? studentCell(sl, r) : teacherCell(sl, r, mineSet)}</div>`).join("")}</div>`;
    });
    box.innerHTML = `${one ? `<div class="bb-place">장소 · <b>${esc(places[0])}</b></div>` : ""}<div class="bb-tt">${html}</div>`;
    $$("[data-cell]", box).forEach((x) => x.onclick = () => onCell(x.dataset.cell));
    $$("[data-del]", box).forEach((x) => x.onclick = (e) => { e.stopPropagation(); teacherDelete(st.dayBookings.find((b) => b.id === x.dataset.del)); });
  }
  function studentCell(sl, r) {
    const c = cellState(sl, r.key);
    const click = c.k === "free" || c.k === "part";
    return `<button type="button" class="bb-s ${c.k}" ${click ? `data-cell="${r.key}|${sl.i}"` : "disabled"}>${esc(c.t)}</button>`;
  }
  function teacherCell(sl, r, mineSet) {
    const d = st.date, id = slotId(d, r.key, sl.start), ids = idsAt(d, r.key, sl.start);
    const weekly = weeklyOffAt(st.bcfg, d, sl.block, r.key), closed = closedAt(d, r.key, sl.start);
    const bks = ids.map((x) => st.dayBookings.find((b) => b.id === x)).filter(Boolean);
    const who = bks.map((b) => {
      const two = (b.slots || []).length > 1, first = (b.slots || [])[0] === id;
      const dim = mineSet && !mineSet.has(String(b.studentNo));
      return `<span class="bb-who${dim ? " dim" : ""}" title="${esc(`${b.start}–${b.end}${b.createdBy && b.createdBy !== "student" ? " · " + b.createdBy + " 선생님이 예약" : ""}`)}">${esc(b.studentNo)} ${esc(b.studentName || studentName(b.studentNo))}${two ? `<em>${first ? "2칸" : "이어서"}</em>` : ""}<button type="button" data-del="${esc(b.id)}" aria-label="예약 지우기">×</button></span>`;
    }).join("");
    const picked = st.picked.has(id);
    const cnt = r.cap > 1 && bks.length ? `<span class="bb-cnt">${ids.length}/${r.cap}</span>` : "";
    if (weekly) return `<div class="bb-tc off">매주 막음</div>`;
    const cls = `bb-tc${closed ? " off" : ""}${picked ? " picked" : ""}`;
    const empty = !bks.length ? `<span class="bb-empty">${closed ? "막음" : r.cap > 1 ? `0/${r.cap}` : "비어 있음"}</span>` : "";
    return `<div class="${cls}" data-cell="${r.key}|${sl.i}" role="button" tabindex="0">${who}${empty}${cnt}</div>`;
  }

  // ---- 칸 누름
  function onCell(v) {
    const [res, i] = v.split("|"), sl = slotsOfDay()[Number(i)];
    if (!sl) return;
    if (!isStudent && st.blockMode) {
      const id = slotId(st.date, res, sl.start);
      st.picked.has(id) ? st.picked.delete(id) : st.picked.add(id);
      renderMode(); renderGrid(); return;
    }
    const r = resOf(res);
    if (!isStudent) {
      if (closedAt(st.date, res, sl.start)) return toast("막아 둔 칸이에요. ‘시간 막기’에서 풀 수 있어요.");
      if (idsAt(st.date, res, sl.start).length >= r.cap) return toast("정원이 찼어요.");
    }
    openSheet(r, sl);
  }
  /** 이어서 한 칸 더 잡을 수 있는지 (같은 자리 바로 다음 칸) */
  function nextOk(r, sl, who) {
    const nx = slotsOfDay()[sl.i + 1];
    if (!nx) return null;
    const d = st.date;
    if (closedAt(d, r.key, nx.start) || weeklyOffAt(st.bcfg, d, nx.block, r.key)) return null;
    if (idsAt(d, r.key, nx.start).length >= r.cap) return null;
    if (isStudent) {
      if (cellState(nx, r.key).k !== "free" && cellState(nx, r.key).k !== "part") return null;
      if (maxRunOf([...myIdx(d), sl.i, nx.i]) > st.bcfg.maxRun) return null;
    } else if (who && dayBookingsOf(who).some((b) => overlapIdx(b, nx))) return null;
    return nx;
  }
  const dayBookingsOf = (no) => st.dayBookings.filter((b) => String(b.studentNo) === String(no));
  const overlapIdx = (b, sl) => toMin(b.start) < toMin(sl.end) && toMin(sl.start) < toMin(b.end);

  // ---- 예약 창 (아래에서 올라옴)
  function openSheet(r, sl) {
    document.getElementById("bbSheet")?.remove();
    const d = st.date, stu = !isStudent ? (opts.getStudents?.() || []) : [];
    if (isStudent && maxRunOf([...myIdx(d), sl.i]) > st.bcfg.maxRun) return toast(`바로 이어진 칸은 ${st.bcfg.maxRun}개까지만 잡을 수 있어요.`, "error");
    document.body.insertAdjacentHTML("beforeend", `<div class="bb-sheet-bg" id="bbSheet"><form class="bb-sheet" role="dialog" aria-modal="true" aria-labelledby="bbT" novalidate>
      <div class="bb-grip"></div>
      <h3 id="bbT">${esc(r.name)} 예약</h3><div class="muted">${esc(r.place)}${r.cap > 1 ? ` · 최대 ${r.cap}명이 함께` : " · 혼자 사용"}</div>
      ${!isStudent ? `<label class="bb-l" for="bbWho">학생</label><select id="bbWho"><option value="">— 학생 선택 —</option>${stu.map((s) => `<option value="${esc(s.studentNo)}">${esc(s.studentNo)} ${esc(s.name || "")}</option>`).join("")}</select>` : ""}
      <div class="bb-kv"><span>날짜</span><b>${dayText(d)}</b><span>시간</span><b id="bbTime"></b>${r.cap > 1 ? `<span>자리</span><b>${idsAt(d, r.key, sl.start).length}/${r.cap}명</b>` : ""}</div>
      <div class="bb-pick" id="bbPick"></div>
      <div class="bb-info">${isStudent ? `예약하면 바로 확정돼요. 바로 이어진 칸은 ${st.bcfg.maxRun}개(최대 1시간)까지 잡을 수 있어요. 못 오면 <b>시작 ${st.bcfg.cancelMin}분 전까지</b> 취소해 주세요. 오래 독차지하면 선생님이 예약을 지울 수 있어요.` : "선생님이 대신 잡은 예약도 학생 화면 ‘내 예약’에 보여요."}</div>
      <div class="bb-btns"><button type="button" id="bbX">닫기</button><button type="submit" class="btn-primary" id="bbGo">예약하기</button></div>
    </form></div>`);
    const bg = $("#bbSheet");
    requestAnimationFrame(() => bg.classList.add("on"));
    let two = false;
    const draw = () => {
      const who = !isStudent ? $("#bbWho", bg).value : me;
      const nx = nextOk(r, sl, who);
      if (!nx) two = false;
      $("#bbTime", bg).textContent = `${sl.start}–${two && nx ? nx.end : sl.end} · ${sl.blockLabel}${two && nx && nx.block !== sl.block ? `·${nx.blockLabel}` : ""}${two ? " (2칸)" : ""}`;
      $("#bbPick", bg).innerHTML = `<button type="button" class="btn-sm ${two ? "" : "on"}" data-n="1">${sl.start}–${sl.end} 한 칸</button>
        <button type="button" class="btn-sm ${two ? "on" : ""}" data-n="2" ${nx ? "" : "disabled"}>${nx ? `${sl.start}–${nx.end} 두 칸` : "이어서 잡을 칸 없음"}</button>`;
      $$("[data-n]", bg).forEach((x) => x.onclick = () => { two = x.dataset.n === "2"; draw(); });
    };
    draw();
    $("#bbWho", bg)?.addEventListener("change", draw);
    const close = () => { bg.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    bg.onclick = (e) => { if (e.target === bg) close(); };
    $("#bbX", bg).onclick = close;
    $(".bb-sheet", bg).onsubmit = async (e) => {
      e.preventDefault();
      const who = isStudent ? me : $("#bbWho", bg).value;
      if (!who) return toast("학생을 골라 주세요.", "error");
      const nx = two ? nextOk(r, sl, who) : null;
      if (two && !nx) { two = false; draw(); return toast("이어서 잡을 칸이 방금 찼어요. 다시 골라 주세요.", "error"); }
      if (!isStudent && dayBookingsOf(who).some((b) => overlapIdx(b, sl))) return toast("그 학생은 같은 시간에 다른 부스 예약이 있어요.", "error");
      $("#bbGo", bg).disabled = true;
      try { await book(r, [sl, nx].filter(Boolean), who); close(); toast(isStudent ? "예약했어요." : "예약을 넣었어요."); }
      catch (err) { $("#bbGo", bg).disabled = false; if (err?.message?.startsWith("bb:")) toast(err.message.slice(3), "error"); else showError(err, "부스 예약"); }
    };
  }

  // ---- 쓰기
  async function book(r, sls, studentNo) {
    const d = st.date;
    const ref = doc(collection(db, "boothBookings"));
    const ids = sls.map((s) => slotId(d, r.key, s.start));
    await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(ids.map((id) => tx.get(doc(db, "boothSlots", id))));
      snaps.forEach((s, k) => {
        const x = s.exists() ? s.data() : {};
        if (x.closed) throw new Error("bb:방금 막힌 칸이에요. 다른 칸을 골라 주세요.");
        if ((x.ids || []).length >= r.cap) throw new Error("bb:방금 다른 학생이 예약했어요. 다른 칸을 골라 주세요.");
      });
      const base = { studentNo: String(studentNo), studentName: isStudent ? String(opts.student?.name || "") : studentName(studentNo),
        res: r.key, date: d, start: sls[0].start, end: sls[sls.length - 1].end, slots: ids,
        createdBy: isStudent ? "student" : (opts.myName || "선생님"), createdAt: serverTimestamp() };
      tx.set(ref, base);
      snaps.forEach((s, k) => {
        const sl = sls[k];
        // last = 이번에 넣은 예약 id (규칙이 그 예약이 내 것인지 확인)
        if (s.exists()) tx.update(s.ref, { ids: [...(s.data().ids || []), ref.id], last: ref.id });
        else tx.set(s.ref, { date: d, res: r.key, start: sl.start, end: sl.end, ids: [ref.id], last: ref.id });
      });
    });
  }
  /** 예약 하나 지우기 (학생 취소·교사 삭제 공용) — 예약 문서 삭제 + 칸 문서에서 id 빼기 */
  async function removeBooking(b) {
    await runTransaction(db, async (tx) => {
      const refs = (b.slots || []).map((id) => doc(db, "boothSlots", id));
      const snaps = await Promise.all(refs.map((x) => tx.get(x)));
      tx.delete(doc(db, "boothBookings", b.id));
      snaps.forEach((s) => { if (s.exists()) tx.update(s.ref, { ids: (s.data().ids || []).filter((x) => x !== b.id), last: b.id }); });
    });
  }
  async function cancelMine(b) {
    if (!b) return;
    if (atMs(b.date, b.start) - nowMs() < st.bcfg.cancelMin * 60000) return toast(`시작 ${st.bcfg.cancelMin}분 전부터는 취소할 수 없어요. 선생님께 말씀해 주세요.`, "error");
    const r = resOf(b.res) || { name: b.res };
    if (!(await confirmBox({ title: "이 예약을 취소할까요?", what: `<b>${dayText(b.date)} ${esc(b.start)}–${esc(b.end)}</b> · ${esc(r.name)}`, yes: "예약 취소" }))) return;
    try { await removeBooking(b); toast("예약을 취소했어요."); } catch (e) { showError(e, "예약 취소"); }
  }
  async function teacherDelete(b) {
    if (!b) return;
    const r = resOf(b.res) || { name: b.res };
    const name = b.studentName || studentName(b.studentNo);
    if (!(await confirmBox({ title: "이 예약을 지울까요?", what: `<b>${esc(b.studentNo)} ${esc(name)}</b> · ${dayText(b.date)} ${esc(b.start)}–${esc(b.end)} · ${esc(r.name)}`, note: "학생 휴대폰으로 알림이 가요.", yes: "지우기" }))) return;
    try { await removeBooking(b); notifyRemoved(b, r); toast("예약을 지웠어요."); } catch (e) { showError(e, "예약 지우기"); }
  }
  const notifyRemoved = (b, r) => queueNotify({ key: b.studentNo, title: "부스 예약이 취소됐어요",
    body: `${dayText(b.date)} ${b.start}–${b.end} ${r.name} · ${opts.myName ? opts.myName + " 선생님" : "선생님"}이 취소했어요`, url: "student.html", tag: `bb_${b.id}` });

  // ---- 교사: 막기·풀기 (막을 칸에 예약이 있으면 함께 지울지 먼저 묻는다)
  async function setClosed(close) {
    const ids = [...st.picked];
    if (!ids.length) return;
    const bks = close ? st.dayBookings.filter((b) => (b.slots || []).some((x) => ids.includes(x))) : [];
    if (bks.length && !(await confirmBox({ title: `예약 ${bks.length}건도 함께 지울까요?`, what: bks.map((b) => `${esc(b.studentNo)} ${esc(b.studentName || studentName(b.studentNo))} ${esc(b.start)}–${esc(b.end)}`).join("<br>"), note: "지우면 학생에게 알림이 가요.", yes: "지우고 막기" }))) return;
    try {
      for (const b of bks) { await removeBooking(b); notifyRemoved(b, resOf(b.res) || { name: b.res }); }
      const list = slotsOfDay();
      await Promise.all(ids.map((id) => {
        const [, res, hhmm] = id.split("_"), start = `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`, sl = list.find((s) => s.start === start);
        return setDoc(doc(db, "boothSlots", id), { date: st.date, res, start, end: sl?.end || start, closed: close, closedBy: close ? (opts.myName || "") : "" }, { merge: true });
      }));
      st.picked.clear(); toast(close ? `${ids.length}칸을 막았어요.` : `${ids.length}칸을 풀었어요.`); render();
    } catch (e) { showError(e, close ? "시간 막기" : "막기 풀기"); }
  }

  // ---- 관리자: 설정
  function openSettings() {
    const b = st.bcfg, blocks = st.cfg.blocks;
    document.getElementById("bbSheet")?.remove();
    const offRow = (w = {}) => `<div class="bb-off"><select data-w="dow">${[1, 2, 3, 4, 5].map((k) => `<option value="${k}" ${Number(w.dow) === k ? "selected" : ""}>${WEEK[k]}요일</option>`).join("")}</select>
      <select data-w="block">${blocks.map((x) => `<option value="${esc(x.key)}" ${w.block === x.key ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
      <select data-w="res"><option value="all">모든 자리</option>${b.resources.map((r) => `<option value="${r.key}" ${w.res === r.key ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
      <button type="button" class="btn-sm" data-rm="1" aria-label="지우기">×</button></div>`;
    document.body.insertAdjacentHTML("beforeend", `<div class="bb-sheet-bg" id="bbSheet"><form class="bb-sheet wide" role="dialog" aria-modal="true" novalidate>
      <div class="bb-grip"></div><h3>부스 예약 설정</h3>
      <div class="bb-set"><span>이름</span><span>장소</span><span>정원</span><span>사용</span>
        ${b.resources.map((r) => `<input data-r="${r.key}" data-f="name" value="${esc(r.name)}"><input data-r="${r.key}" data-f="place" value="${esc(r.place)}">
          <input data-r="${r.key}" data-f="cap" type="number" min="1" max="10" value="${r.cap}"><label class="bb-on"><input data-r="${r.key}" data-f="on" type="checkbox" ${r.on ? "checked" : ""}> 켬</label>`).join("")}</div>
      <label class="bb-l">매주 반복해서 막을 시간</label><div id="bbOffs">${b.weeklyOff.map(offRow).join("")}</div>
      <button type="button" class="btn-sm" id="bbAddOff">+ 추가</button>
      <div class="bb-set2"><label>예약은 오늘부터 <input type="number" id="bbAhead" min="1" max="60" value="${b.aheadDays}"> 일 앞까지</label>
        <label>학생 취소는 시작 <input type="number" id="bbCancel" min="0" max="120" value="${b.cancelMin}"> 분 전까지</label></div>
      <div class="bb-btns"><button type="button" id="bbX">닫기</button><button type="submit" class="btn-primary">저장</button></div></form></div>`);
    const bg = $("#bbSheet");
    requestAnimationFrame(() => bg.classList.add("on"));
    const bindRm = () => $$("[data-rm]", bg).forEach((x) => x.onclick = () => x.closest(".bb-off").remove());
    bindRm();
    $("#bbAddOff", bg).onclick = () => { $("#bbOffs", bg).insertAdjacentHTML("beforeend", offRow()); bindRm(); };
    const close = () => bg.remove();
    $("#bbX", bg).onclick = close; bg.onclick = (e) => { if (e.target === bg) close(); };
    $("form", bg).onsubmit = async (e) => {
      e.preventDefault();
      const val = (k, f) => $(`[data-r="${k}"][data-f="${f}"]`, bg);
      const resources = b.resources.map((r) => ({ key: r.key, name: val(r.key, "name").value.trim() || r.name, place: val(r.key, "place").value.trim(),
        cap: Math.max(1, Math.min(10, Math.round(Number(val(r.key, "cap").value) || r.cap))), on: val(r.key, "on").checked }));
      const weeklyOff = $$(".bb-off", bg).map((row) => ({ dow: Number($('[data-w="dow"]', row).value), block: $('[data-w="block"]', row).value, res: $('[data-w="res"]', row).value }));
      const booth = { resources, weeklyOff, aheadDays: Number($("#bbAhead", bg).value) || DEFAULT_BOOTH.aheadDays, cancelMin: Math.max(0, Number($("#bbCancel", bg).value) || 0) };
      const boothCaps = Object.fromEntries(resources.filter((r) => r.on).map((r) => [r.key, r.cap]));
      try { await setDoc(doc(db, "config", "schedule"), { booth, boothCaps }, { merge: true }); toast("부스 예약 설정을 저장했어요."); close(); }
      catch (err) { showError(err, "부스 예약 설정 저장"); }
    };
  }

  return {
    render,
    /** 화면을 떠날 때 실시간 구독 끊기 */
    stop() { stopSlots?.(); stopBk?.(); stopMine?.(); stopCfg?.(); }
  };
}

// ================= 일정 탭 위 '면접 일정 | 부스 예약' 슬라이드 알약 =================
/** el 안에 알약을 그리고 onChange(view) 를 부른다. 눌러도, 좌우로 밀어도 바뀐다 */
export function mountSchedSwitch(el, { value = "interview", onChange }) {
  let cur = value;
  el.classList.add("sc-seg");
  el.innerHTML = `<i aria-hidden="true"></i><button type="button" data-v="interview">면접 일정</button><button type="button" data-v="booth">부스 예약</button>`;
  const set = (v, fire = true) => {
    cur = v;
    el.classList.toggle("r", v === "booth");
    $$("button", el).forEach((b) => { b.classList.toggle("on", b.dataset.v === v); b.setAttribute("aria-pressed", String(b.dataset.v === v)); });
    if (fire) onChange?.(v);
  };
  $$("button", el).forEach((b) => b.onclick = () => set(b.dataset.v));
  let x0 = null;
  el.addEventListener("pointerdown", (e) => { x0 = e.clientX; });
  el.addEventListener("pointerup", (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 30) set(dx > 0 ? "booth" : "interview");
  });
  set(cur, false);
  return { set, get: () => cur };
}
