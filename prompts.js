// Claude에 붙여넣을 프롬프트 모음. 문구를 바꾸고 싶으면 이 파일만 고치면 됩니다.
import { TYPES } from "./common.js";

export function personalQuestionPrompt({ record, major, targets, n = 15, existing = [] }) {
  return `너는 대한민국 대학 학생부종합전형 면접관이다. 아래 학생부 내용을 근거로 서류기반 면접 예상질문을 만들어라.

[지원 정보]
- 희망 전공: ${major || "(미정)"}
- 지원 대학·전형: ${targets || "(미정)"}

[학생부 내용]
${record.trim()}

[작성 원칙]
1. 모든 질문은 학생부의 특정 활동·기록에 근거한다. 누구에게나 물을 수 있는 일반론 질문은 쓰지 않는다.
2. 영역을 고르게 배분한다: 활동의 동기·과정·결과 확인(진위 검증), 교과 개념 이해의 깊이(학업역량), 전공·진로와의 연결, 협업·갈등 해결, 한계와 후속 탐구.
3. 기록을 외웠는지 실제로 이해했는지 드러나도록 구체적 개념·방법·수치를 묻는 질문을 포함한다.
4. 질문마다 꼬리질문 2~3개를 단다. 첫 답변을 파고드는 방향(왜 그 방법인가, 결과가 달랐다면, 다른 변인은)으로 쓴다.
5. 실제 면접관 말투(~인가요?, ~설명해 주세요)로, 한 문장에 하나만 묻는다.
6. ${n}개를 작성한다.${existing.length ? `\n7. 아래 이미 만든 질문과 겹치지 않게 한다.\n${existing.map((q) => `- ${q}`).join("\n")}` : ""}

[출력 형식]
설명 없이 JSON 배열만 출력한다.
[{"text":"질문","category":"영역(예: 세특-화학Ⅱ, 동아리, 진로활동, 행동특성)","basis":"근거가 된 학생부 기록 요약(25자 이내)","intent":"평가하려는 역량","followUps":["꼬리질문1","꼬리질문2"]}]`;
}

export function feedbackPrompt(session) {
  const blocks = (session.items || []).map((it, i) => {
    const lines = [`Q${i + 1}. [${TYPES[it.type]?.label || it.type}] ${it.text}`];
    if (it.passage) lines.push(`(제시문)\n${it.passage}`);
    lines.push(`제한 ${it.answerSec}초 / 사용 ${it.usedSec}초`);
    lines.push(`답변: ${it.answer || "(무응답)"}`);
    if (it.followUp) lines.push(`꼬리질문: ${it.followUp}\n꼬리질문 답변: ${it.followAnswer || "(무응답)"}`);
    return lines.join("\n");
  }).join("\n\n");
  return `너는 대학 입학 면접 코치다. 고등학생의 모의면접 답변을 평가하고 개선 방향을 제시하라.

[학생 정보]
- 희망 전공: ${session.major || "(미정)"}
- 면접 유형: ${session.modeLabel || session.mode}

[모의면접 답변]
${blocks}

[피드백 원칙]
- 답변은 음성 받아쓰기로 기록되어 오탈자가 있을 수 있다. 표기보다 내용을 평가한다.
- 문항별로 ① 잘한 점 1가지 ② 가장 중요한 개선점 1~2가지(어느 부분을 어떻게 바꿀지 구체적으로) ③ 면접관이 이어서 물을 만한 질문 1개를 쓴다.
- 모범답안 전문은 쓰지 않는다. 학생이 스스로 고칠 수 있도록 방향과 예시 문장 1개만 준다.
- 제시문 문항은 개념 오류가 있으면 반드시 짚는다.
- 마지막에 논리성·구체성·전공적합성·전달력 관점의 총평을 3줄로 쓴다.
- 학생에게 그대로 전달되므로 존댓말로, 격려하되 솔직하게 쓴다.
- 마크다운 기호(#, **)는 쓰지 말고 일반 텍스트로 출력한다.`;
}

export function bankPrompt({ type, track, majors, n = 10 }) {
  const t = TYPES[type];
  const typeGuide = {
    document: "학생부종합전형 공통 서류기반 질문(학업 태도, 진로 탐색 과정, 전공 관심 계기, 독서, 대학 입학 후 계획 등). passage는 빈 문자열.",
    passage: "과학/사회 제시문 기반 면접. passage에 고교 교육과정 수준의 제시문(자료·실험 상황·그래프 설명 포함 가능, 400~800자)을 새로 작성하고, text에는 (1)(2) 형태의 세부 문항 2~3개를 쓴다. 교과서·기출 문장을 그대로 옮기지 않는다.",
    personality: "인성 면접 질문(공동체 의식, 책임감, 성실성, 갈등 경험, 윤리적 판단). passage는 빈 문자열.",
    mmi: "MMI 상황 제시형. passage에 판단이 갈리는 구체적 상황(150~300자)을 쓰고, text에는 '당신이라면 어떻게 하겠습니까? 그 이유는?' 같은 질문을 쓴다."
  }[type];
  return `너는 대한민국 대입 면접 문항 출제위원이다. 모의면접용 질문은행 문항을 만들어라.

[조건]
- 유형: ${t.label} — ${typeGuide}
- 계열: ${track}${majors ? `\n- 대상 학과: ${majors}` : ""}
- 문항 수: ${n}개
- 각 문항마다 평가 의도와 꼬리질문 2개를 단다.
- 서로 겹치지 않게, 쉬운 것부터 어려운 것까지 섞는다.

[출력 형식]
설명 없이 JSON 배열만 출력한다.
[{"type":"${type}","track":"${track}","majors":[${majors ? majors.split(/[,，]/).map((m) => `"${m.trim()}"`).join(",") : ""}],"text":"질문","passage":"${type === "passage" || type === "mmi" ? "제시문 또는 상황" : ""}","prepSec":${t.prep},"answerSec":${t.answer},"intent":"평가 의도","followUps":["꼬리질문1","꼬리질문2"]}]`;
}
