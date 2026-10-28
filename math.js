// 제시문 수식 (2026-10-28) — 글 안의 `$ … $`(줄 안) · `$$ … $$`(크게 한 줄)를 KaTeX 로 그린다. 돈 표시 '$' 는 `\$`
// · 수식이 든 글이 처음 나올 때만 KaTeX(jsdelivr)를 불러온다. 불러오기 전·실패하면 `$…$` 글자 그대로 보인다
// · 수식 하나씩 따로 그려서, 틀린 수식은 그 부분만 빨갛게(.mt-err) 나머지는 그대로
// · 소리로 읽을 때(speakText)는 수식 부분을 '수식'으로 읽는다
// 불러오기만 해서는 아무것도 그리거나 받지 않는다 (부스도 빌려 쓸 수 있게)
const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/";
const PART = /(\$\$[\s\S]+?\$\$|\$(?:\\\$|[^$\n])+?\$)/g;   // 수식 조각 ($…$ 는 한 줄 안에서만)
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let loading = null, failedAt = 0;
const RETRY_MS = 30 * 1000;   // 못 불러왔으면 이만큼 지난 뒤 다시 시도 (학교망이 잠깐 막힌 경우)

/** 글에 수식(`$…$`)이 있는지 */
export const hasMath = (text) => { PART.lastIndex = 0; return PART.test(String(text || "")); };

/** KaTeX 불러오기 (한 번만). 다 불러오면 화면에 기다리던 수식을 모두 그린다 */
export function loadMath() {
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < RETRY_MS) return Promise.resolve(null);
  loading = new Promise((ok, no) => {
    if (!document.querySelector('link[data-katex]')) {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = KATEX + "katex.min.css"; css.dataset.katex = "1";
      document.head.appendChild(css);
    }
    const js = document.createElement("script");
    js.src = KATEX + "katex.min.js"; js.async = true;
    // 받아졌는데 수식 도구가 없으면(막힌 망에서 빈 파일 등) 실패로 본다
    js.onload = () => { if (window.katex) { typesetMath(document); ok(window.katex); } else { js.remove(); no(new Error("수식 도구가 비어 있어요")); } };
    js.onerror = () => { js.remove(); no(new Error("수식 도구를 불러오지 못했어요")); };
    document.head.appendChild(js);
  }).catch((e) => { console.warn("math", e); failedAt = Date.now(); loading = null; return null; });
  return loading;
}

function texHtml(part) {
  const disp = part.startsWith("$$"), tex = disp ? part.slice(2, -2) : part.slice(1, -1);
  if (!window.katex) return `<span class="mt" data-tex="${esc(tex)}" data-d="${disp ? 1 : 0}">${esc(part)}</span>`;
  try { return window.katex.renderToString(tex, { displayMode: disp, throwOnError: true }); }
  catch (e) { return `<span class="mt-err" title="${esc(e.message || "수식 오류")}">${esc(part)}</span>`; }
}

/** 글 → HTML (수식은 그림, 나머지는 글자 그대로 · 줄바꿈 유지는 감싼 칸의 white-space 로) */
export function mathHtml(text) {
  const s = String(text ?? "");
  if (!hasMath(s)) return esc(s.replace(/\\\$/g, "$"));
  if (!window.katex) loadMath();
  return s.split(PART).map((part, i) => i % 2 ? texHtml(part) : esc(part.replace(/\\\$/g, "$"))).join("");
}

/** 기다리던 수식(.mt) 그리기 — loadMath 가 끝나면 저절로 부른다 */
export function typesetMath(root = document) {
  if (!window.katex) return;
  root.querySelectorAll(".mt[data-tex]").forEach((el) => {
    const tex = el.dataset.tex, disp = el.dataset.d === "1";
    el.outerHTML = texHtml(disp ? `$$${tex}$$` : `$${tex}$`);
  });
}

/** 소리로 읽을 글 — 수식 부분은 '수식'으로 */
export function speakText(text) {
  return String(text ?? "").replace(PART, " 수식 ").replace(/\\\$/g, "달러").replace(/\s+/g, " ").trim();
}

/** 질문은행 입력 창: 넣기 단추 · 자주 쓰는 수식 */
export const MATH_INSERTS = [
  ["분수", "$\\frac{a}{b}$"], ["제곱", "$x^{2}$"], ["첨자", "$x_{1}$"], ["루트", "$\\sqrt{x}$"], ["∑", "$\\sum_{k=1}^{n} a_k$"],
  ["∫", "$\\int_{a}^{b} f(x)\\,dx$"], ["lim", "$\\lim_{x \\to 0}$"], ["화학식", "$\\mathrm{H_2O}$"], ["×", "$\\times$"], ["≤", "$\\le$"]
];
export const MATH_HELP = [
  ["분수", "$\\frac{a}{b}$"], ["제곱 · 거듭제곱", "$x^{2}$, $e^{-x}$"], ["아래 첨자", "$a_{n}$, $x_{1}$"], ["루트", "$\\sqrt{2}$, $\\sqrt[3]{x}$"],
  ["시그마", "$\\sum_{k=1}^{n} k$"], ["적분", "$\\int_{0}^{1} x^2\\,dx$"], ["극한", "$\\lim_{x \\to 0} \\frac{\\sin x}{x}$"], ["미분", "$f'(x)$, $\\frac{dy}{dx}$"],
  ["로그 · 삼각", "$\\log_2 8$, $\\sin\\theta$"], ["부등호 · 곱", "$\\le$ $\\ge$ $\\ne$ $\\times$ $\\div$ $\\pm$"], ["그리스 문자", "$\\alpha$ $\\beta$ $\\theta$ $\\pi$ $\\Delta$"],
  ["화학식 · 반응", "$\\mathrm{H_2SO_4}$, $\\mathrm{A} \\rightleftharpoons \\mathrm{B}$"], ["벡터 · 행렬", "$\\vec{a}$, $\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$"]
];
