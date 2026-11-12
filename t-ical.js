// 교사 화면 · 일정 탭 · '면접 일정' (2026-11-12): 학생들의 실제 대학 면접 날짜를 월·주 달력으로 (선생님만)
//  데이터 = 이미 불러온 학생 지원 대학(st.universities = interviews) — 새로 읽는 것 없음. 1차 불합격한 대학은 뺌
//  칸 = 그날 면접 보는 대학마다 한 줄 (같은 대학에 여럿이면 'n명'). 칸 높이는 같고 넘치면 '+N개 대학 더 보기'
//  날짜를 누르면 그날 대학·학생이 펼쳐짐 (컴퓨터: 칸 위에 떠서 / 휴대폰: 달력 아래 목록). 학생 이름 → 학생 상세
import { S, myRoles } from "./t-core.js";
import { openStudent } from "./t-students.js";
import { $, $$, esc, isoDay, toDate, univName, announceFailed } from "./common.js";

const WD = ["월", "화", "수", "목", "금", "토", "일"];
const PAL = 6;   // 대학 색 (.ic-c0 ~ .ic-c5)
const KEY = "icView";   // 이 기기에만 기억: 월/주 · 내 담당만 · 주말
const short = (u) => univName(u).replace(/대학교/g, "대");
const colorOf = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return "ic-c" + (h % PAL); };
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const small = () => window.matchMedia("(max-width: 720px)").matches;

export function mountInterviewCalendar(root) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { return {}; } })();
  const now = new Date();
  const st = {
    mode: saved.mode === "w" ? "w" : "m", mine: !!saved.mine, weekend: saved.weekend !== false,
    month: new Date(now.getFullYear(), now.getMonth(), 1), week: mondayOf(now), sel: isoDay(now)
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ mode: st.mode, mine: st.mine, weekend: st.weekend })); } catch (_) {} };

  root.innerHTML = `
    <div class="card sc-card ic">
      <div class="sc-bar">
        <div class="row">
          <button class="btn-sm" id="icPrev" aria-label="앞으로">◀</button>
          <b id="icRange"></b>
          <button class="btn-sm" id="icNext" aria-label="뒤로">▶</button>
          <button class="btn-sm" id="icToday">오늘</button>
        </div>
        <div class="row sc-view">
          <label class="inline-check"><input type="checkbox" id="icWeekend"> 주말</label>
          <div class="seg-mini"><button data-icm="m">월</button><button data-icm="w">주</button></div>
        </div>
        <div class="row sc-filt"><label class="inline-check"><input type="checkbox" id="icMine"> 내 담당 학생만</label></div>
      </div>
      <div class="ic-sum" id="icSum"></div>
      <div class="sc-legend"><div class="l2">칸 하나 = 그날 면접 보는 <b>대학</b> (같은 대학에 여럿이면 'n명') · 날짜를 누르면 그날 대학·학생이 모두 펼쳐져요 · 1차 불합격한 대학은 빼요 · 학생 화면에는 없어요</div></div>
      <div class="ic-cal" id="icCal"></div>
      <div class="ic-list" id="icList"></div>
    </div>`;
  $("#icWeekend", root).checked = st.weekend;
  $("#icMine", root).checked = st.mine;
  $("#icPrev", root).onclick = () => move(-1);
  $("#icNext", root).onclick = () => move(1);
  $("#icToday", root).onclick = () => { const n = new Date(); st.month = new Date(n.getFullYear(), n.getMonth(), 1); st.week = mondayOf(n); st.sel = isoDay(n); render(); };
  $$("[data-icm]", root).forEach((b) => b.onclick = () => { st.mode = b.dataset.icm; save(); render(); });
  $("#icWeekend", root).onchange = (e) => { st.weekend = e.target.checked; save(); render(); };
  $("#icMine", root).onchange = (e) => { st.mine = e.target.checked; save(); render(); };
  function move(dir) {
    if (st.mode === "m") st.month = new Date(st.month.getFullYear(), st.month.getMonth() + dir, 1);
    else st.week = addDays(st.week, 7 * dir);
    render();
  }
  // 바깥을 누르거나 Esc 면 펼친 칸 닫기
  document.addEventListener("click", (e) => { if (!e.target.closest(".ic-pop, .ic-cell")) closePop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
  const closePop = () => $(".ic-pop", root)?.remove();

  // 날짜별 면접 { "YYYY-MM-DD": [{ s, u }] }
  function byDay() {
    const m = {};
    for (const s of S.students || []) {
      if (st.mine && !myRoles(s).length) continue;
      for (const u of s.universities || []) {
        if (!u?.date || announceFailed(u)) continue;
        const d = isoDay(u.date); if (!d) continue;
        (m[d] ||= []).push({ s, u });
      }
    }
    return m;
  }
  const groups = (list) => {
    const g = new Map();
    for (const e of list) { const k = univName(e.u.univ) || "(대학 없음)"; if (!g.has(k)) g.set(k, { name: k, list: [] }); g.get(k).list.push(e); }
    return [...g.values()].map((x) => ({ ...x, list: x.list.sort((a, b) => String(a.s.studentNo).localeCompare(String(b.s.studentNo))) }))
      .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name, "ko"));
  };
  const chip = (g, week) => {
    const one = g.list.length === 1 ? g.list[0] : null;
    const sub = one ? (week ? `${one.s.name || ""} · ${one.u.dept || ""}` : `· ${one.s.name || ""}`) : (week ? g.list.map((e) => e.s.name || "").join(" · ") : `${g.list.length}명`);
    return `<div class="ic-chip ${colorOf(g.name)}" title="${esc(g.name)}"><b>${esc(short(g.name))}</b><span>${esc(sub)}</span></div>`;
  };
  const today = () => isoDay(new Date());
  function cell(d, M, { out = false, week = false } = {}) {
    const list = M[d] || [], gs = groups(list), cap = week ? 5 : 2, rest = gs.length - cap, dt = toDate(d);
    const wd = WD[(dt.getDay() + 6) % 7];
    return `<div class="ic-cell${out ? " out" : ""}${d === today() ? " today" : ""}${d < today() ? " past" : ""}${list.length ? " has" : ""}${d === st.sel ? " sel" : ""}" data-d="${d}" ${list.length ? 'role="button" tabindex="0"' : ""}>
      <div class="ic-dn"><b>${week ? `${dt.getMonth() + 1}/${dt.getDate()}` : dt.getDate()}</b><span class="ic-wd">${wd}</span>${list.length ? `<span class="ic-n">${list.length}명</span>` : ""}</div>
      <div class="ic-chips">${gs.slice(0, cap).map((g) => chip(g, week)).join("")}${rest > 0 ? `<span class="ic-more">+${rest}개 대학 더 보기</span>` : ""}</div>
      ${list.length ? `<div class="ic-dots">${gs.slice(0, 4).map((g) => `<i class="${colorOf(g.name)}"></i>`).join("")}</div>` : ""}
    </div>`;
  }
  function dayHtml(d, M, { close = true } = {}) {
    const list = M[d] || [], gs = groups(list), dt = toDate(d);
    const head = `<div class="ic-ph"><b>${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WD[(dt.getDay() + 6) % 7]})</b><small>${gs.length}개 대학 · ${list.length}명</small>${close ? '<button type="button" class="ic-x" aria-label="닫기">✕</button>' : ""}</div>`;
    if (!list.length) return head + `<div class="muted ic-empty">이 날은 면접이 없어요</div>`;
    return head + gs.map((g) => `<div class="ic-grp ${colorOf(g.name)}"><div class="ic-gt">${esc(g.name)}<small>${g.list.length}명</small></div>
      ${g.list.map((e) => `<button type="button" class="ic-stu" data-icno="${esc(e.s.studentNo)}"><span class="nm">${esc(e.s.name || "")}</span><span class="no">${esc(e.s.studentNo)}</span>${myRoles(e.s).length ? '<span class="ic-mine">내 담당</span>' : ""}<span class="dp">${esc(e.u.dept || "")}${e.u.admission ? `<small>${esc(e.u.admission)}</small>` : ""}</span></button>`).join("")}</div>`).join("");
  }
  const bindDay = (box) => {
    $$("[data-icno]", box).forEach((b) => b.onclick = () => { closePop(); openStudent(b.dataset.icno); });
    $(".ic-x", box)?.addEventListener("click", closePop);
  };
  function openDay(c, M) {
    const d = c.dataset.d;
    if (small() && st.mode === "m") { st.sel = d; render(); $("#icList", root)?.scrollIntoView({ behavior: "smooth", block: "nearest" }); return; }
    closePop();
    const cal = $("#icCal", root), p = document.createElement("div");
    p.className = "ic-pop"; p.innerHTML = dayHtml(d, M);
    const r = c.getBoundingClientRect(), R = cal.getBoundingClientRect();
    const w = Math.min(360, R.width - 8);
    p.style.width = w + "px";
    p.style.left = Math.max(0, Math.min(r.left - R.left - 4, R.width - w - 4)) + "px";
    p.style.top = Math.max(0, r.top - R.top - 4) + "px";
    cal.append(p); bindDay(p);
    // 아래쪽 날이면 달력 안에 들어오게 위로 올림
    const over = p.offsetTop + p.offsetHeight - cal.clientHeight;
    if (over > 0) p.style.top = Math.max(0, p.offsetTop - over - 4) + "px";
  }

  function render() {
    closePop();
    const M = byDay(), cols = st.weekend ? 7 : 5, cal = $("#icCal", root);
    $$("[data-icm]", root).forEach((b) => b.classList.toggle("active", b.dataset.icm === st.mode));
    let days;
    if (st.mode === "m") {
      const y = st.month.getFullYear(), mo = st.month.getMonth();
      $("#icRange", root).textContent = `${y}년 ${mo + 1}월`;
      const start = mondayOf(new Date(y, mo, 1));
      let h = `<div class="ic-hd" style="--c:${cols}">${WD.slice(0, cols).map((w) => `<div>${w}</div>`).join("")}</div>`;
      days = [];
      for (let k = 0; k < 6; k++) {
        const wk = Array.from({ length: 7 }, (_, i) => addDays(start, k * 7 + i));
        if (k > 3 && wk[0].getMonth() !== mo) break;
        h += `<div class="ic-row" style="--c:${cols}">${wk.slice(0, cols).map((x) => cell(isoDay(x), M, { out: x.getMonth() !== mo })).join("")}</div>`;
        days.push(...wk.filter((x) => x.getMonth() === mo).map(isoDay));
      }
      cal.className = "ic-cal ic-m"; cal.innerHTML = h;
    } else {
      const wk = Array.from({ length: cols }, (_, i) => addDays(st.week, i));
      $("#icRange", root).textContent = `${wk[0].getMonth() + 1}/${wk[0].getDate()} – ${wk.at(-1).getMonth() + 1}/${wk.at(-1).getDate()}`;
      cal.className = "ic-cal ic-w";
      cal.innerHTML = `<div class="ic-hd" style="--c:${cols}">${wk.map((x, i) => `<div>${WD[i]}</div>`).join("")}</div><div class="ic-row" style="--c:${cols}">${wk.map((x) => cell(isoDay(x), M, { week: true })).join("")}</div>`;
      days = wk.map(isoDay);
    }
    // 요약
    const L = days.flatMap((d) => M[d] || []), t = today();
    $("#icSum", root).innerHTML = `<span>${st.mode === "m" ? "이번 달" : "이번 주"} 면접 <b>${L.length}건</b></span><span>학생 <b>${new Set(L.map((e) => e.s.studentNo)).size}명</b></span><span>대학 <b>${new Set(L.map((e) => univName(e.u.univ))).size}곳</b></span><span>남은 면접 <b>${days.filter((d) => d >= t).flatMap((d) => M[d] || []).length}건</b></span>`;
    // 휴대폰: 고른 날 목록 (월 보기)
    $("#icList", root).innerHTML = st.mode === "m" ? dayHtml(st.sel, M, { close: false }) : "";
    bindDay($("#icList", root));
    $$(".ic-cell.has", cal).forEach((c) => {
      c.onclick = (e) => { e.stopPropagation(); openDay(c, M); };
      c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDay(c, M); } };
    });
    // 휴대폰 월 보기에서는 빈 날도 고를 수 있게 (그날 '면접이 없어요')
    $$(".ic-m .ic-cell:not(.has)", cal).forEach((c) => c.onclick = () => { if (small()) { st.sel = c.dataset.d; render(); } });
  }
  return { render };
}
