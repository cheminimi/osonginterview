// 지도 일지 — 불가시간 달력 (선생님 화면 · 관리자 '달력 보기' 같이 씀)
// 저장 모양: days = { 'YYYY-MM-DD': ['16:30','17:00', …] }  — 그날 지도할 수 '없는' 30분 칸의 시작 시각
// 지도는 30분 칸 단위: 평일 8칸(16:30·17:00·17:30 | 19:00~21:00 시작), 주말 15칸(09:00~16:00 시작). 그 밖의 시간은 배정이 안 되니 받지 않는다.
import { WEEKDAY_30, WEEKEND_30, minToStr } from "./guidance-engine.js";

export const WD = WEEKDAY_30.map(minToStr), WE = WEEKEND_30.map(minToStr);
const W = "일월화수목금토";
const DAY = 86400000;
const dnum = (s) => { const [y, m, d] = s.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / DAY); };
const dstr = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const dow = (s) => new Date(dnum(s) * DAY).getUTCDay();
export const isWeekend = (s) => { const w = dow(s); return w === 0 || w === 6; };
export const slotsOf = (s) => isWeekend(s) ? WE : WD;
export const end30 = (t) => { const [h, m] = t.split(":").map(Number); return minToStr(h * 60 + m + 30); };
const lab = (s) => `${+s.slice(5, 7)}/${+s.slice(8)}(${W[dow(s)]})`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 이상한 날짜·칸을 버리고 칸 순서대로 정리 (빈 날은 뺌) */
export function cleanDays(days) {
  const out = {};
  Object.entries(days || {}).forEach(([d, l]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Array.isArray(l)) return;
    const all = slotsOf(d), v = all.filter((t) => l.includes(t));
    if (v.length) out[d] = v;
  });
  return out;
}
export const isFull = (days, d) => (days[d]?.length || 0) === slotsOf(d).length;
export function countOf(days) { const ds = Object.values(days || {}).filter((l) => l.length); return { days: ds.length, slots: ds.reduce((n, l) => n + l.length, 0) }; }
/** 배정 엔진·검사에 넣을 꼴: 칸마다 [시작, 시작+30] */
export function toUnavailRows(teacher, days) {
  const out = [];
  Object.entries(days || {}).forEach(([d, l]) => (l || []).forEach((t) => out.push({ teacher, from: d, to: d, start: t, end: end30(t) })));
  return out;
}
/** ['16:30','17:00','17:30'] → '16:30~18:00' (이어진 칸 묶기) */
export function blocksText(d, list) {
  const all = slotsOf(d), on = all.filter((t) => list.includes(t));
  const parts = []; let st = null, pv = null;
  on.forEach((t) => { if (pv && end30(pv) === t) pv = t; else { if (st) parts.push(`${st}~${end30(pv)}`); st = t; pv = t; } });
  if (st) parts.push(`${st}~${end30(pv)}`);
  return parts.join(", ");
}
/** 같은 칸 모양이 이어지는 날을 한 줄로: [{from,to,text}] */
export function rangesOf(days) {
  const ds = Object.keys(days).filter((d) => days[d]?.length).sort();
  const key = (d) => isFull(days, d) ? "종일" : days[d].join(",");
  const out = [];
  ds.forEach((d) => {
    const last = out[out.length - 1];
    if (last && dnum(d) === dnum(last.to) + 1 && last.key === key(d) && isWeekend(d) === isWeekend(last.from)) last.to = d;
    else out.push({ from: d, to: d, key: key(d) });
  });
  return out.map((r) => ({ from: r.from, to: r.to, text: r.key === "종일" ? "종일" : blocksText(r.from, days[r.from]) }));
}

let styled = false;
function injectStyle() {
  if (styled || document.getElementById("gdcStyle")) return; styled = true;
  const st = document.createElement("style"); st.id = "gdcStyle";
  st.textContent = `
body.nd .gdc{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px;align-items:start;min-width:0}
@media (max-width:820px){body.nd .gdc{grid-template-columns:minmax(0,1fr)}}
body.nd .gdc>div{min-width:0}
body.nd .gdc-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
body.nd .gdc-head b{flex:1;text-align:center;font-size:17px}
body.nd .gdc-nav{border:0;background:var(--soft,#f1f2f5);border-radius:99px;width:36px;height:36px;font-size:18px;cursor:pointer;color:inherit}
body.nd .gdc-nav:disabled{opacity:.3;cursor:default}
body.nd .gdc-week,body.nd .gdc-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
body.nd .gdc-week div{text-align:center;font-size:12px;color:var(--muted,#7b8190);padding:2px 0}
body.nd .gdc-week div:first-child{color:#dc2626} body.nd .gdc-week div:last-child{color:#2563eb}
body.nd .gdc-day{position:relative;border:1px solid var(--line,#e3e6ec);border-radius:12px;background:#fff;min-height:56px;padding:5px 6px;text-align:left;cursor:pointer;font:inherit;color:inherit;min-width:0}
body.nd .gdc-day .n{display:block;font-weight:700;font-size:14px}
body.nd .gdc-day .s{display:block;font-size:11px;line-height:1.2;margin-top:3px;color:#ea580c;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.nd .gdc-day.sa .n{color:#2563eb} body.nd .gdc-day.su .n{color:#dc2626}
body.nd .gdc-day.part{background:#ffedd5;border-color:#fdba74}
body.nd .gdc-day.full{background:#ea580c;border-color:#ea580c;color:#fff}
body.nd .gdc-day.full .n,body.nd .gdc-day.full .s{color:#fff}
body.nd .gdc-day.off{background:repeating-linear-gradient(45deg,#f3f4f6,#f3f4f6 5px,#e9ebef 5px,#e9ebef 10px);color:#9aa0ab;cursor:default}
body.nd .gdc-day.off .s{color:#9aa0ab;font-weight:400}
body.nd .gdc-day.blank{visibility:hidden}
body.nd .gdc-day.today::after{content:"오늘";position:absolute;right:5px;top:4px;font-size:10px;color:var(--muted,#7b8190)}
body.nd .gdc-day.full.today::after{color:#fff}
body.nd .gdc-day.sel{outline:3px solid var(--black,#17181b);outline-offset:-2px}
body.nd .gdc-day.pick::before{content:"✓";position:absolute;right:6px;bottom:4px;font-weight:800}
body.nd .gdc-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted,#7b8190);margin-top:10px}
body.nd .gdc-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:4px;border:1px solid var(--line,#e3e6ec)}
body.nd .gdc-multi{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}
body.nd .gdc-multi label{display:inline-flex;align-items:center;gap:8px;cursor:pointer}
body.nd .gdc-multi input{width:18px;height:18px}
body.nd .gdc-grp{margin-top:12px}
body.nd .gdc-gh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
body.nd .gdc-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:6px}
body.nd .gdc-slot{border:1px solid var(--line,#e3e6ec);border-radius:10px;background:#fff;padding:9px 0;font:inherit;font-size:14px;cursor:pointer;color:inherit}
body.nd .gdc-slot.x{background:#ea580c;border-color:#ea580c;color:#fff;text-decoration:line-through}
body.nd .gdc-slot:disabled{cursor:default;opacity:.7}
body.nd .gdc-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
body.nd .gdc-hint{font-size:13px;color:var(--muted,#7b8190);margin:8px 0 0;line-height:1.55}
body.nd .gdc-panel h4{margin:0 0 4px;font-size:16px}
body.nd .gdc-panel h4 small{font-weight:400;color:var(--muted,#7b8190);font-size:13px}
`;
  document.head.appendChild(st);
}

/**
 * el 에 달력 + 그날 칸 고르기를 그린다.
 * opts: { cfg:{periodStart,periodEnd,earlyStart,excluded}, days, today:'YYYY-MM-DD', readOnly, onChange(days, changed:[날짜]) }
 */
export function mountCal(el, opts) {
  injectStyle();
  const cfg = opts.cfg, off = new Set(cfg.excluded || []);
  const lo = cfg.earlyStart && cfg.earlyStart < cfg.periodStart ? cfg.earlyStart : cfg.periodStart, hi = cfg.periodEnd;
  const months = []; for (let m = lo.slice(0, 7); m <= hi.slice(0, 7);) { months.push(m); const [y, mm] = m.split("-").map(Number); m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`; }
  const today = opts.today || dstr(Math.floor((Date.now() + 9 * 3600e3) / DAY));
  let days = cleanDays(opts.days), month = months.includes(today.slice(0, 7)) ? today.slice(0, 7) : months[0], sel = null, multi = false;
  const picked = new Set();
  const inRange = (d) => d >= lo && d <= hi;
  const ro = !!opts.readOnly;

  function calHtml() {
    const [y, m] = month.split("-").map(Number), first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(`<div class="gdc-day blank"></div>`);
    for (let k = 1; k <= n; k++) {
      const d = `${month}-${String(k).padStart(2, "0")}`;
      if (!inRange(d)) { cells.push(`<div class="gdc-day blank"></div>`); continue; }
      const c = days[d]?.length || 0, full = c && isFull(days, d), w = dow(d);
      const cls = ["gdc-day", off.has(d) ? "off" : full ? "full" : c ? "part" : "", w === 6 ? "sa" : w === 0 ? "su" : "", d === today ? "today" : "", (!multi && sel === d) || picked.has(d) ? "sel" : "", picked.has(d) ? "pick" : ""].filter(Boolean).join(" ");
      const sub = off.has(d) ? "쉬는 날" : full ? "종일" : c ? `${c}칸` : "";
      cells.push(`<button type="button" class="${cls}" data-d="${d}" ${off.has(d) ? "disabled" : ""} aria-label="${lab(d)} ${sub || "가능"}"><span class="n">${k}</span><span class="s">${sub}</span></button>`);
    }
    const i = months.indexOf(month);
    return `<div class="gdc-head"><button type="button" class="gdc-nav" data-mv="-1" ${i <= 0 ? "disabled" : ""} aria-label="이전 달">‹</button><b>${y}년 ${m}월</b><button type="button" class="gdc-nav" data-mv="1" ${i >= months.length - 1 ? "disabled" : ""} aria-label="다음 달">›</button></div>
      <div class="gdc-week">${[...W].map((x) => `<div>${x}</div>`).join("")}</div><div class="gdc-days">${cells.join("")}</div>
      <div class="gdc-legend"><span><i style="background:#ffedd5;border-color:#fdba74"></i>일부 불가</span><span><i style="background:#ea580c;border-color:#ea580c"></i>종일 불가</span><span><i style="background:#e9ebef"></i>운영 안 하는 날</span></div>
      ${ro ? "" : `<div class="gdc-multi"><label><input type="checkbox" class="gdc-mt" ${multi ? "checked" : ""}> 여러 날 한꺼번에 고르기</label>${multi ? `<span class="muted">${picked.size}일 골랐어요</span>${picked.size ? '<button type="button" class="btn-sm gdc-unpick">고른 날 풀기</button>' : ""}` : ""}</div>`}`;
  }
  const targets = () => multi ? [...picked].sort() : sel ? [sel] : [];
  function panelHtml() {
    const ts = targets();
    if (!ts.length) return `<h4>날짜를 눌러 주세요</h4><p class="gdc-hint">${ro ? "날짜를 누르면 그날 불가 칸이 보여요." : `달력에서 날짜를 누르면 그날 지도할 수 있는 30분 칸이 나와요. <b>지도할 수 없는 칸만 눌러 끄면</b> 돼요. 누를 때마다 바로 저장돼요.<br>출장·연수처럼 며칠 이어지면 '여러 날 한꺼번에 고르기'를 켜고 날짜를 여러 개 누른 뒤 [종일 불가]를 누르세요.`}</p>`;
    const title = ts.length === 1 ? `${lab(ts[0])} <small>${isWeekend(ts[0]) ? "주말" : "평일"}</small>` : `${ts.length}일 <small>${lab(ts[0])} 외</small>`;
    if (new Set(ts.map(isWeekend)).size > 1) return `<h4>${title}</h4><p class="gdc-hint">평일과 주말은 칸이 달라요. [종일 불가]·[모두 지우기]만 할 수 있어요.</p>
      <div class="gdc-acts"><button type="button" class="btn-primary" data-all="on">고른 날 모두 종일 불가</button><button type="button" data-all="off">모두 지우기</button></div>`;
    const has = (t) => ts.every((d) => days[d]?.includes(t));
    const grp = (name, list) => `<div class="gdc-grp"><div class="gdc-gh"><b>${name}</b>${ro ? "" : `<button type="button" class="btn-sm" data-grp="${list.join(",")}">${list.every(has) ? "모두 켜기" : "모두 끄기"}</button>`}</div>
      <div class="gdc-slots">${list.map((t) => `<button type="button" class="gdc-slot ${has(t) ? "x" : ""}" data-t="${t}" ${ro ? "disabled" : ""} title="${t}~${end30(t)}" aria-pressed="${has(t)}">${t}</button>`).join("")}</div></div>`;
    const body = isWeekend(ts[0]) ? grp("주말 09:00 ~ 16:30", WE) : grp("방과후 16:30 ~ 18:00", WD.slice(0, 3)) + grp("야자 19:00 ~ 21:30", WD.slice(3));
    return `<h4>${title}</h4><p class="gdc-hint" style="margin-top:0">주황색 = 지도할 수 <b>없는</b> 칸${ro ? "" : ". 누를 때마다 바뀌어요"}.</p>${body}
      ${ro ? "" : `<div class="gdc-acts"><button type="button" class="btn-primary" data-all="on">종일 불가</button><button type="button" data-all="off">모두 지우기</button></div>`}`;
  }
  function draw() {
    el.innerHTML = `<div class="gdc"><div class="card gdc-cal">${calHtml()}</div><div class="card gdc-panel">${panelHtml()}</div></div>`;
    bind();
  }
  function change(ds, fn) {
    ds.forEach((d) => { const v = fn(d, new Set(days[d] || [])); if (v.size) days[d] = slotsOf(d).filter((t) => v.has(t)); else delete days[d]; });
    opts.onChange?.(cleanDays(days), ds);
    draw();
  }
  function bind() {
    el.querySelectorAll("[data-mv]").forEach((b) => b.onclick = () => { month = months[months.indexOf(month) + Number(b.dataset.mv)]; draw(); });
    el.querySelectorAll(".gdc-day[data-d]").forEach((b) => b.onclick = () => {
      const d = b.dataset.d;
      if (multi) picked.has(d) ? picked.delete(d) : picked.add(d); else sel = d;
      draw();
      if (!multi && window.innerWidth <= 820) el.querySelector(".gdc-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const mt = el.querySelector(".gdc-mt");
    if (mt) mt.onchange = () => { multi = mt.checked; picked.clear(); if (multi && sel) picked.add(sel); draw(); };
    el.querySelector(".gdc-unpick")?.addEventListener("click", () => { picked.clear(); draw(); });
    if (ro) return;
    el.querySelectorAll(".gdc-slot").forEach((b) => b.onclick = () => {
      const t = b.dataset.t, ts = targets(), on = !ts.every((d) => days[d]?.includes(t));
      change(ts, (d, s) => { on ? s.add(t) : s.delete(t); return s; });
    });
    el.querySelectorAll("[data-grp]").forEach((b) => b.onclick = () => {
      const list = b.dataset.grp.split(","), ts = targets(), on = !list.every((t) => ts.every((d) => days[d]?.includes(t)));
      change(ts, (d, s) => { list.forEach((t) => on ? s.add(t) : s.delete(t)); return s; });
    });
    el.querySelectorAll("[data-all]").forEach((b) => b.onclick = () => {
      const ts = targets(), on = b.dataset.all === "on";
      if (multi) picked.clear();
      change(ts, (d) => new Set(on ? slotsOf(d) : []));
    });
  }
  draw();
  return {
    get: () => cleanDays(days),
    set(v) { days = cleanDays(v); draw(); },
    goto(d) { if (months.includes(d.slice(0, 7))) { month = d.slice(0, 7); sel = d; multi = false; picked.clear(); draw(); } }
  };
}
export { lab as dayLab };
