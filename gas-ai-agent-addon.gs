/**
 * ============================================================
 * AI 에이전트 애드온 (Claude API · 수동 tool-use 루프)
 * ------------------------------------------------------------
 * 앱 안에서 동작하는 두 가지 에이전트:
 *
 *  1) aiTutor          — 문제 카드의 "🤖 AI 튜터". 학생 답과 풀이를 보고 소크라테스식으로
 *                        힌트/설명을 준다. 필요하면 도구로 같은 유형(family/단원)의
 *                        기존 문제를 찾아 "이 문제도 풀어보세요"라고 추천한다.
 *  2) aiMakeReviewSet  — 채점 결과 화면의 "🤖 AI 복습 세트". 틀린 문제들을 보고
 *                        변형 문제를 만들고 → validate_problems 도구로 스키마/정답을
 *                        스스로 검사·수정한 뒤 → submit_review_set 도구로
 *                        검토 대기열(data/_pending)에 올린다.
 *                        선생님이 review.html에서 승인해야 학생들에게 보인다(사람 검토 필수).
 *
 * 필요한 준비물
 *  1) gas-github-upload-addon.gs(ghGetFile_/ghPutFile_)와 gas-review-and-users-addon.gs가
 *     이미 병합되어 있어야 합니다. (aiMakeReviewSet이 handlePendingSubmitWorksheet_를 재사용)
 *  2) 스크립트 속성
 *       ANTHROPIC_API_KEY   (필수, ocrAnswer에서 이미 쓰는 키와 같은 것)
 *       ANTHROPIC_MODEL     (선택, 기본 'claude-opus-5-5')
 *  3) doPost() 안 action 분기에 아래 2개 케이스 추가:
 *
 *     if (action === 'aiTutor')         return jsonResponse_(handleAiTutor_(payload));
 *     if (action === 'aiMakeReviewSet') return jsonResponse_(handleAiMakeReviewSet_(payload));
 * ============================================================
 */

const AI_DEFAULT_MODEL = 'claude-opus-5-5';
const AI_MANIFEST_PATH = 'data/worksheets-manifest.json';
const AI_MAX_AGENT_TURNS = 8;
const AI_VALID_DIFF = ['low', 'mid', 'midhigh', 'high', 'top'];
const AI_VALID_TYPE = ['mc', 'mc_multi', 'fillin', 'subjective', 'essay'];


// ── Claude API 호출 ─────────────────────────────────────────

function aiConfig_() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 스크립트 속성이 없어요');
  return { key: key, model: props.getProperty('ANTHROPIC_MODEL') || AI_DEFAULT_MODEL };
}

/** POST /v1/messages 한 번. 응답 JSON을 그대로 돌려준다. */
function callClaude_(body) {
  const cfg = aiConfig_();
  body.model = body.model || cfg.model;
  // 안전 분류기가 거절하면 서버가 다른 모델로 자동 재시도 (Opus 5.5 권장 설정)
  body.fallbacks = 'default';
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) throw new Error('Claude API 오류(' + code + '): ' + text.slice(0, 300));
  return JSON.parse(text);
}

/**
 * 수동 에이전트 루프. stop_reason이 tool_use인 동안 도구를 실행하고 결과를 돌려준다.
 * opts: { system, messages, tools, handlers:{name: fn(input)→object}, effort, maxTokens }
 * 반환: { text, toolLog, stopReason }
 */
function runAgent_(opts) {
  const messages = opts.messages.slice();
  const toolLog = [];
  for (let turn = 0; turn < AI_MAX_AGENT_TURNS; turn++) {
    const resp = callClaude_({
      max_tokens: opts.maxTokens || 16000,
      system: opts.system,
      tools: opts.tools,
      output_config: { effort: opts.effort || 'medium' },
      messages: messages
    });
    if (resp.stop_reason === 'refusal') {
      return { text: '이 질문에는 답하기 어려워요. 선생님께 여쭤봐 주세요.', toolLog: toolLog, stopReason: 'refusal' };
    }
    // thinking 블록 포함 content 전체를 그대로 이어 붙여야 다음 턴이 유효하다
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { text: text, toolLog: toolLog, stopReason: resp.stop_reason };
    }

    // 한 응답에 여러 tool_use가 올 수 있음 → 결과를 하나의 user 메시지로 모아서 돌려준다
    const results = resp.content.filter(b => b.type === 'tool_use').map(b => {
      const handler = opts.handlers[b.name];
      try {
        if (!handler) throw new Error('알 수 없는 도구: ' + b.name);
        const out = handler(b.input || {});
        toolLog.push({ tool: b.name, ok: true });
        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) };
      } catch (e) {
        toolLog.push({ tool: b.name, ok: false, error: e.message });
        return { type: 'tool_result', tool_use_id: b.id, content: e.message, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  return { text: '', toolLog: toolLog, stopReason: 'max_turns' };
}


// ── 저장소 읽기 (GitHub) ────────────────────────────────────

function aiRepo_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  if (!token || !repo) throw new Error('GitHub 연동 설정이 안 되어있어요');
  return { token: token, repo: repo, branch: branch };
}

function aiReadJson_(path) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('ai:' + path);
  if (cached) return JSON.parse(cached);
  const r = aiRepo_();
  const f = ghGetFile_(r.token, r.repo, r.branch, path);
  if (!f) throw new Error('파일이 없어요: ' + path);
  if (f.content.length < 90000) cache.put('ai:' + path, f.content, 600); // CacheService 값 한도(100KB) 이내만
  return JSON.parse(f.content);
}

function aiManifest_() {
  return aiReadJson_(AI_MANIFEST_PATH).sets.filter(s => !s.hidden);
}

function aiCompactProblem_(setId, p) {
  return {
    set: setId,
    num: p.num !== undefined ? p.num : p.number,
    diff: p.diff, type: p.type, family: p.family || null,
    question: String(p.question || '').slice(0, 400)
  };
}


// ── 도구 정의 ──────────────────────────────────────────────

const AI_TOOL_FIND_SIMILAR = {
  name: 'find_similar_problems',
  description: '문제은행에서 같은 유형의 기존 문제를 찾는다. family가 있으면 family로, 없으면 단원 키워드로 찾는다. ' +
    '학생에게 추가 연습 문제를 추천할 때 사용. 최대 limit개 반환.',
  input_schema: {
    type: 'object',
    properties: {
      family: { type: 'string', description: '문제 유형 코드(예: symmetricThreeVar). 모르면 생략' },
      unit_keyword: { type: 'string', description: '단원/그룹 이름에 포함될 키워드(예: 복소수, 인수분해)' },
      exclude_set: { type: 'string', description: '제외할 문제지 id(지금 풀고 있는 문제지)' },
      limit: { type: 'integer', description: '최대 개수(기본 3, 최대 8)' }
    },
    required: []
  }
};

function aiFindSimilar_(input) {
  const limit = Math.min(Math.max(input.limit || 3, 1), 8);
  const kw = (input.unit_keyword || '').trim();
  const sets = aiManifest_().filter(s => s.id !== input.exclude_set &&
    (!kw || String(s.unit || '').indexOf(kw) >= 0 || String(s.group || '').indexOf(kw) >= 0 || String(s.title || '').indexOf(kw) >= 0));
  const found = [];
  for (let i = 0; i < sets.length && found.length < limit; i++) {
    let data;
    try { data = aiReadJson_('data/' + sets[i].file); } catch (e) { continue; }
    (data.problems || []).forEach(p => {
      if (found.length >= limit || !p) return;
      if (input.family && p.family !== input.family) return;
      const c = aiCompactProblem_(sets[i].id, p);
      c.setTitle = sets[i].title;
      c.link = 'player.html?set=' + encodeURIComponent(sets[i].id) + '&start=' + encodeURIComponent(c.num);
      found.push(c);
    });
  }
  return { count: found.length, problems: found };
}

const AI_TOOL_VALIDATE = {
  name: 'validate_problems',
  description: '만든 문제 배열이 앱 스키마에 맞는지 검사한다. submit_review_set 전에 반드시 호출해서 errors가 빈 배열인지 확인할 것.',
  input_schema: {
    type: 'object',
    properties: { problems: { type: 'array', items: { type: 'object' } } },
    required: ['problems']
  }
};

/** 스키마 검사 — scripts/validate_worksheets.py의 문제 단위 규칙과 같게 유지할 것 */
function aiValidateProblems_(problems) {
  const errors = [];
  if (!Array.isArray(problems) || problems.length === 0) return { errors: ['problems가 비어 있어요'] };
  const seen = {};
  problems.forEach((p, i) => {
    const at = '문제[' + i + '] ';
    if (!p || typeof p !== 'object') { errors.push(at + '객체가 아님'); return; }
    if (typeof p.num !== 'number') errors.push(at + 'num은 숫자여야 함');
    else if (seen[p.num]) errors.push(at + 'num 중복: ' + p.num);
    seen[p.num] = true;
    if (AI_VALID_DIFF.indexOf(p.diff) < 0) errors.push(at + 'diff는 ' + AI_VALID_DIFF.join('/') + ' 중 하나');
    if (AI_VALID_TYPE.indexOf(p.type) < 0) errors.push(at + 'type은 ' + AI_VALID_TYPE.join('/') + ' 중 하나');
    if (!p.question || typeof p.question !== 'string') errors.push(at + 'question 필요');
    if (!Array.isArray(p.solution) || p.solution.length === 0) errors.push(at + 'solution은 비어있지 않은 문자열 배열');
    if (p.type === 'mc' || p.type === 'mc_multi') {
      if (!Array.isArray(p.choices) || p.choices.length !== 5) errors.push(at + 'choices는 5개');
      const ok = c => Number.isInteger(c) && c >= 0 && c < 5;
      if (p.type === 'mc' && !ok(p.correct)) errors.push(at + 'correct는 0~4 정수(0-based)');
      if (p.type === 'mc_multi' && !(Array.isArray(p.correct) && p.correct.length && p.correct.every(ok))) errors.push(at + 'correct는 0~4 정수 배열');
    } else if (p.type === 'fillin' && (p.answer === undefined || p.answer === '')) {
      errors.push(at + 'fillin은 answer 필요');
    }
    const text = [p.question].concat(p.choices || [], p.solution || []).join(' ');
    if ((text.match(/\\\(/g) || []).length !== (text.match(/\\\)/g) || []).length) errors.push(at + '\\( \\) 짝이 안 맞음');
    // player.html은 solution 줄마다 따로 렌더링 — \[ … \] 블록이 여러 줄로 쪼개지면 글자 그대로 보인다
    const count = (s, re) => (String(s).match(re) || []).length;
    (Array.isArray(p.solution) ? p.solution : []).forEach((line, k) => {
      if (count(line, /\\\[/g) !== count(line, /\\\]/g) || count(line, /\\\(/g) !== count(line, /\\\)/g)) {
        errors.push(at + 'solution ' + (k + 1) + '번째 줄: 수식 \\[ \\] 또는 \\( \\)가 줄을 넘어감 — 한 줄에 써야 함');
      }
    });
  });
  return { errors: errors };
}


// ── action: aiTutor ────────────────────────────────────────

const AI_TUTOR_SYSTEM = [
  '너는 한국 중·고등학생의 수학 튜터다. 학생은 방금 앱에서 문제를 풀었다.',
  '규칙:',
  '- 한국어, 반말 아닌 부드러운 존댓말("~해요"). 3~8문장으로 짧게.',
  '- 수식은 반드시 \\( ... \\) 로 감싼 LaTeX로 쓴다(앱이 KaTeX로 렌더링). $ 기호는 쓰지 않는다.',
  '- mode가 hint이면 정답이나 최종 값을 절대 말하지 말고, 다음 한 걸음만 질문/힌트로 준다.',
  '- mode가 explain이면 학생 답이 어디서 틀렸는지 먼저 짚고, 핵심 개념과 올바른 풀이 흐름을 설명한다.',
  '- mode가 chat이면 학생 질문에 답하되, 아직 정답을 모르는 상태(answerRevealed=false)면 정답은 말하지 않는다.',
  '- 제공된 정답/풀이가 틀려 보이면 학생에게 단정하지 말고 "선생님께 확인해 보세요"라고 덧붙인다.',
  '- 비슷한 문제 연습이 도움이 될 것 같으면 find_similar_problems로 찾아 1~3개를 "<문제지 제목> N번" 형식으로 추천한다.',
  '  추천할 때만 도구를 쓰고, 찾은 결과가 없으면 언급하지 않는다.'
].join('\n');

/**
 * payload: {
 *   mode: 'hint'|'explain'|'chat',
 *   worksheetId, problem:{num,question,choices,answer,correct,solution,family,diff,type},
 *   studentAnswer, answerRevealed, question(학생 질문, chat일 때), history:[{role,text}]
 * }
 * 반환: { status:'ok', reply, recommendations:[...] }
 */
function handleAiTutor_(payload) {
  try {
    const p = payload.problem || {};
    const mode = ['hint', 'explain', 'chat'].indexOf(payload.mode) >= 0 ? payload.mode : 'hint';
    const revealed = !!payload.answerRevealed && mode !== 'hint';
    const problemForModel = {
      num: p.num, type: p.type, diff: p.diff, family: p.family || null,
      question: p.question, choices: p.choices || undefined,
      // 힌트 모드에서도 정답은 모델에게 준다(틀린 방향 힌트 방지). 출력 규칙으로 노출을 막는다.
      answer: p.answer, correct: p.correct, solution: p.solution
    };
    const intro = [
      'mode: ' + mode,
      'answerRevealed: ' + revealed,
      'worksheetId: ' + (payload.worksheetId || ''),
      '문제(JSON): ' + JSON.stringify(problemForModel),
      '학생 답: ' + (payload.studentAnswer || '(아직 없음)')
    ].join('\n');

    const messages = [{ role: 'user', content: intro }];
    (payload.history || []).slice(-6).forEach(h => {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text || '') });
    });
    const ask = payload.question || (mode === 'hint' ? '힌트 하나만 주세요.' : '제가 어디서 틀렸는지 설명해 주세요.');
    if (messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n\n' + ask;
    else messages.push({ role: 'user', content: ask });

    const recommendations = [];
    const result = runAgent_({
      system: AI_TUTOR_SYSTEM,
      messages: messages,
      tools: [AI_TOOL_FIND_SIMILAR],
      effort: 'medium',
      maxTokens: 8000,
      handlers: {
        find_similar_problems: function (input) {
          input.exclude_set = input.exclude_set || payload.worksheetId;
          const out = aiFindSimilar_(input);
          out.problems.forEach(x => recommendations.push({ set: x.set, setTitle: x.setTitle, num: x.num, link: x.link }));
          return out;
        }
      }
    });
    return { status: 'ok', reply: result.text, recommendations: recommendations };
  } catch (e) {
    return { status: 'error', message: 'AI 튜터 오류: ' + e.message };
  }
}


// ── action: aiMakeReviewSet ────────────────────────────────

const AI_REVIEW_SYSTEM = [
  '너는 수학 문제 출제 에이전트다. 학생이 틀린 문제들을 받아, 같은 개념을 다시 연습할 변형 문제 세트를 만든다.',
  '절차:',
  '1. 틀린 문제마다 핵심 개념과 오답 유형(reason)을 파악한다.',
  '2. 문제마다 변형 문제 2개씩 만든다: 하나는 같은 난이도, 하나는 한 단계 쉬운 난이도. 숫자·조건을 바꾸고 원문을 베끼지 않는다.',
  '3. 각 문제를 직접 끝까지 풀어서 정답을 확정하고, 객관식이면 오답 선지도 그럴듯하게 만든다. 정답은 한 개만 맞아야 한다.',
  '4. validate_problems를 호출해 errors가 빌 때까지 고친다.',
  '5. submit_review_set을 한 번 호출해 제출한다. 제출 후 학생에게 보여줄 한두 문장 요약을 쓴다.',
  '스키마(문제 하나): {num:1부터 연번, diff:"low|mid|midhigh|high|top", type:"mc|fillin", question, choices:[5개](mc만), ',
  'correct:0~4 정수(mc만, 0-based), answer:문자열(fillin만), solution:[줄 단위 문자열 배열], family:원문제 family가 있으면 그대로}',
  '수식은 \\( ... \\) LaTeX로 쓴다. 선택지 앞에 ①② 같은 번호를 붙이지 않는다.'
].join('\n');

const AI_TOOL_SUBMIT = {
  name: 'submit_review_set',
  description: '완성된 복습 세트를 선생님 검토 대기열에 제출한다. validate_problems가 통과한 뒤 한 번만 호출.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '세트 제목(예: "복소수 오답 복습")' },
      unit: { type: 'string', description: '단원 이름' },
      problems: { type: 'array', items: { type: 'object' } }
    },
    required: ['title', 'problems']
  }
};

/**
 * payload: {
 *   worksheetId, grade, unit,
 *   wrong: [{ problem:{...}, studentAnswer, reason }],
 *   studentId, studentName, school
 * }
 * 반환: { status:'ok', summary, id, count } — 실제 공개는 선생님 승인 후
 */
function handleAiMakeReviewSet_(payload) {
  try {
    const wrong = (payload.wrong || []).slice(0, 6); // 비용·시간 제한: 한 번에 6문제까지
    if (wrong.length === 0) return { status: 'error', message: '오답 문제가 없어요' };

    const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmm');
    const base = String(payload.worksheetId || 'set').replace(/[^A-Za-z0-9_\-]/g, '');
    const id = base + '-ai-review-' + stamp;
    let submitted = null;

    const result = runAgent_({
      system: AI_REVIEW_SYSTEM,
      messages: [{ role: 'user', content: '원래 문제지: ' + (payload.worksheetId || '') + '\n단원: ' + (payload.unit || '') +
        '\n틀린 문제들(JSON):\n' + JSON.stringify(wrong) }],
      tools: [AI_TOOL_VALIDATE, AI_TOOL_SUBMIT],
      effort: 'high',
      handlers: {
        validate_problems: function (input) { return aiValidateProblems_(input.problems); },
        submit_review_set: function (input) {
          if (submitted) throw new Error('이미 제출했어요');
          const check = aiValidateProblems_(input.problems);
          if (check.errors.length) throw new Error('검사 실패: ' + check.errors.join('; '));
          const res = handlePendingSubmitWorksheet_({
            isUpdate: false, id: id, file: id + '.json',
            category: 'tb', grade: payload.grade || '',
            title: '🤖 ' + (input.title || 'AI 오답 복습'),
            unit: input.unit || payload.unit || '',
            group: 'AI 오답 복습',
            source: 'AI 생성(검토 필요) · ' + (payload.worksheetId || ''),
            count: input.problems.length,
            problems: input.problems,
            studentId: payload.studentId, studentName: payload.studentName, school: payload.school
          });
          if (res.status !== 'ok') throw new Error(res.message || '제출 실패');
          submitted = { id: id, count: input.problems.length };
          return { status: 'ok', id: id };
        }
      }
    });

    if (!submitted) return { status: 'error', message: 'AI가 세트를 완성하지 못했어요. 다시 시도해 주세요.' };
    return { status: 'ok', summary: result.text, id: submitted.id, count: submitted.count };
  } catch (e) {
    return { status: 'error', message: 'AI 복습 세트 오류: ' + e.message };
  }
}
