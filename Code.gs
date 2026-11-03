/**
 * ============================================================
 * math_practices — Apps Script 기본 백엔드 (Code.gs)
 * ------------------------------------------------------------
 * 웹앱의 모든 요청이 이 파일의 doGet/doPost로 들어온다. 요청 본문의 action 값으로 처리 함수를 고른다.
 * 이 파일 + 아래 애드온 3개를 같은 Apps Script 프로젝트에 넣으면 앱 전체가 동작한다.
 *
 *   Code.gs                         ← 이 파일: 라우터, 풀이 기록, GitHub 연동, AI(사진→문제·손글씨·LaTeX),
 *                                      시험범위, 사용자 관리(목록·권한·계정찾기), 즉시 등록
 *   gas-review-and-users-addon.gs   ← 가입·로그인·비밀번호, 검토 대기열(승인/반려)
 *   gas-ai-agent-addon.gs           ← AI 튜터, AI 복습 세트
 *   gas-tips-addon.gs               ← 학습 팁
 *
 * 준비물
 *  1) 이 스크립트가 붙어 있는 Google Sheet에 탭 3개 (없으면 첫 요청 때 헤더와 함께 자동 생성)
 *       Results  : date | studentName | worksheetId | score | timeTaken | wrongNums | startNum | imageLinks
 *       Attempts : date | studentName | worksheetId | problemId | correct | reason
 *       Users    : studentId | name | school | grade | phone | passwordHash | createdAt | role
 *  2) 프로젝트 설정 → 스크립트 속성
 *       GITHUB_TOKEN      (필수) contents 쓰기 권한이 있는 토큰
 *       GITHUB_REPO       (필수) 예: dtrjeon/math
 *       GITHUB_BRANCH     (선택) 기본 main
 *       ANTHROPIC_API_KEY (AI 기능용)
 *       ANTHROPIC_MODEL   (선택) 기본 claude-opus-5-5
 *       TEACHER_EMAIL     (선택) 검토 대기 알림 메일
 *  3) 배포 → 새 배포 → 유형 "웹 앱", 실행: 나, 액세스: 모든 사용자.
 *     이미 배포가 있으면 "배포 관리 → 수정 → 새 버전"으로 올려야 URL(SHEET_WEBHOOK_URL)이 유지된다.
 *
 * 함수 이름이 다른 파일과 겹치지 않도록, 이 파일에만 있는 상수는 CODE_ 로 시작한다.
 * ============================================================
 */

const CODE_RESULTS_SHEET = 'Results';
const CODE_ATTEMPTS_SHEET = 'Attempts';
const CODE_USERS_SHEET = 'Users';
const CODE_DEFAULT_MODEL = 'claude-opus-5-5';
const CODE_MASTER_STREAK = 3;   // 연속 3회 정답이면 오답노트에서 빠진다(index_mathc1.html과 같은 기준)
const CODE_SHEET_HEADERS = {
  Results: ['date', 'studentName', 'worksheetId', 'score', 'timeTaken', 'wrongNums', 'startNum', 'imageLinks'],
  Attempts: ['date', 'studentName', 'worksheetId', 'problemId', 'correct', 'reason'],
  Users: ['studentId', 'name', 'school', 'grade', 'phone', 'passwordHash', 'createdAt', 'role']
};


// ── 진입점 ────────────────────────────────────────────────

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'list') return jsonResponse_(codeListResults_());
    if (action === 'wrongStats') return jsonResponse_(codeWrongStats_(e.parameter.studentName));
    return jsonResponse_({ status: 'ok', message: 'math_practices backend' });
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

function doPost(e) {
  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ status: 'error', message: '요청 형식이 잘못됐어요' });
  }
  const action = payload.action || '';
  try {
    return jsonResponse_(codeRoute_(action, payload));
  } catch (err) {
    return jsonResponse_({ status: 'error', message: err.message });
  }
}

/** action → 처리 함수. 애드온 함수는 그 파일이 없으면 안내 메시지를 돌려준다. */
function codeRoute_(action, payload) {
  // 가입·로그인 애드온은 Users 탭이 없으면 멈추므로, 처음 쓰는 시트에서도 되도록 먼저 만들어 둔다
  if (action === 'registerUser' || action === 'loginUser' || action === 'changePassword') codeSheet_(CODE_USERS_SHEET);
  switch (action) {
    // 풀이 기록 (Code.gs)
    case '':                 return codeSaveResult_(payload);   // action 없음 = 퀴즈 종료 결과 저장
    case 'logAttempt':       return codeLogAttempts_(payload.studentName, payload.worksheetId, [payload]);
    case 'logAttempts':      return codeLogAttempts_(payload.studentName, payload.worksheetId, payload.attempts || []);
    case 'updateReason':     return codeUpdateReason_(payload);
    // AI (Code.gs)
    case 'ocrAnswer':        return codeOcrAnswer_(payload);
    case 'visionExtract':    return codeVisionExtract_(payload);
    case 'convertToLatex':   return codeConvertToLatex_(payload);
    // 문제지 즉시 등록 (Code.gs) — 학생 업로드는 검토 대기(pendingSubmitWorksheet)를 쓴다
    case 'submitWorksheet':  return codeSubmitWorksheet_(payload);
    // 시험범위 (Code.gs)
    case 'getExamRanges':    return codeGetExamRanges_();
    case 'saveExamRanges':   return codeSaveExamRanges_(payload);
    // 사용자 관리 (Code.gs)
    case 'listUsers':        return codeListUsers_(payload);
    case 'setUserRole':      return codeSetUserRole_(payload);
    case 'findAccountByName':return codeFindAccountByName_(payload);
    // gas-review-and-users-addon.gs
    case 'registerUser':           return codeAddon_('handleRegisterUser_', payload);
    case 'loginUser':              return codeAddon_('handleLoginUser_', payload);
    case 'changePassword':         return codeAddon_('handleChangePassword_', payload);
    case 'pendingSubmitWorksheet': return codeAddon_('handlePendingSubmitWorksheet_', payload);
    case 'listPending':            return codeAdminOnly_(payload) || codeAddon_('handleListPending_', payload);
    case 'approveWorksheet':       return codeAdminOnly_(payload) || codeAddon_('handleApproveWorksheet_', payload);
    case 'rejectWorksheet':        return codeAdminOnly_(payload) || codeAddon_('handleRejectWorksheet_', payload);
    // gas-ai-agent-addon.gs
    case 'aiTutor':          return codeAddon_('handleAiTutor_', payload);
    case 'aiMakeReviewSet':  return codeAddon_('handleAiMakeReviewSet_', payload);
    // gas-tips-addon.gs
    case 'getTips':          return codeAddon_('handleGetTips_', payload);
    case 'saveTips':         return codeAddon_('handleSaveTips_', payload);
    default:
      return { status: 'error', message: '알 수 없는 요청이에요: ' + action };
  }
}

function codeAddon_(fnName, payload) {
  const g = (typeof globalThis !== 'undefined') ? globalThis : (function () { return this; })();
  const fn = g[fnName];
  if (typeof fn !== 'function') {
    return { status: 'error', message: '서버에 ' + fnName + ' 함수가 없어요 — 해당 애드온(.gs) 파일을 추가하세요' };
  }
  return fn(payload);
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


// ── 시트 공통 ──────────────────────────────────────────────

/** 시트가 없으면 헤더와 함께 만든다 */
function codeSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(CODE_SHEET_HEADERS[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function codeRows_(name) {
  const values = codeSheet_(name).getDataRange().getValues();
  return values.slice(1);   // 헤더 제외
}

function codeIso_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}


// ── 풀이 기록 ──────────────────────────────────────────────

/**
 * action 없음 — player.html saveResultsToSheet()
 * payload: { studentName, worksheetId, timeTaken, correctCount, total, startNum, wrongNums:[], images:[{problemNum,dataUrl}] }
 */
function codeSaveResult_(p) {
  if (!p.worksheetId) return { status: 'error', message: '문제지 id가 없어요' };
  const links = codeSaveImages_(p);
  codeSheet_(CODE_RESULTS_SHEET).appendRow([
    new Date(),
    p.studentName || '학생',
    p.worksheetId,
    (p.correctCount || 0) + '/' + (p.total || 0),
    p.timeTaken || '',
    (p.wrongNums || []).join(','),
    p.startNum || '',
    links.join('\n')
  ]);
  return { status: 'ok' };
}

/** 풀이 필기 이미지를 Drive 폴더에 저장하고 링크를 돌려준다. 실패해도 기록 저장은 계속한다. */
function codeSaveImages_(p) {
  const images = (p.images || []).slice(0, 60);
  if (images.length === 0) return [];
  try {
    const folderName = 'math_practices 풀이 이미지';
    const it = DriveApp.getFoldersByName(folderName);
    const folder = it.hasNext() ? it.next() : DriveApp.createFolder(folderName);
    const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd-HHmmss');
    return images.map(img => {
      const m = String(img.dataUrl || '').match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m) return '';
      const name = [stamp, p.studentName || '학생', p.worksheetId, img.problemNum].join('_') + '.png';
      const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
      return img.problemNum + ': ' + file.getUrl();
    }).filter(Boolean);
  } catch (err) {
    return ['이미지 저장 실패: ' + err.message];
  }
}

/** logAttempt / logAttempts — 문제 하나 단위 채점 로그 */
function codeLogAttempts_(studentName, worksheetId, attempts) {
  const sheet = codeSheet_(CODE_ATTEMPTS_SHEET);
  const now = new Date();
  const rows = attempts.filter(a => a && a.problemId).map(a => [
    now, studentName || '학생', a.worksheetId || worksheetId || '', a.problemId, a.correct ? true : false, a.reason || ''
  ]);
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  return { status: 'ok', count: rows.length };
}

/** updateReason — 같은 학생·같은 문제의 가장 최근 오답 행에 오답 유형만 채운다(새 행 안 만듦) */
function codeUpdateReason_(p) {
  const sheet = codeSheet_(CODE_ATTEMPTS_SHEET);
  const rows = codeRows_(CODE_ATTEMPTS_SHEET);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]) === String(p.studentName || '학생') && String(rows[i][3]) === String(p.problemId) && rows[i][4] !== true) {
      sheet.getRange(i + 2, 6).setValue(p.reason || '');
      return { status: 'ok' };
    }
  }
  return { status: 'ok', updated: false };
}

/** GET ?action=list — 홈 학습 기록판·이어서 풀기·재구성 화면 */
function codeListResults_() {
  return codeRows_(CODE_RESULTS_SHEET).map(r => ({
    date: codeIso_(r[0]),
    studentName: String(r[1] || ''),
    worksheetId: String(r[2] || ''),
    score: String(r[3] || ''),
    timeTaken: String(r[4] || ''),
    wrongNums: String(r[5] || ''),
    startNum: String(r[6] || '')
  }));
}

/**
 * GET ?action=wrongStats — 오답노트. 문제(problemId)마다 시도 횟수·오답 수·현재 연속 정답 수를 계산해서,
 * 한 번이라도 틀렸고 아직 연속 3회 정답이 안 된 문제만 돌려준다. studentName을 주면 그 학생 것만.
 */
function codeWrongStats_(studentName) {
  const byKey = {};
  codeRows_(CODE_ATTEMPTS_SHEET).forEach(r => {
    if (studentName && String(r[1]) !== String(studentName)) return;
    const problemId = String(r[3] || '');
    if (!problemId) return;
    const key = r[1] + '|' + problemId;
    const s = byKey[key] || (byKey[key] = {
      studentName: String(r[1] || ''), worksheetId: String(r[2] || ''), problemId: problemId,
      totalAttempts: 0, totalWrong: 0, currentStreak: 0, lastDate: '', lastReason: ''
    });
    const correct = r[4] === true || String(r[4]).toUpperCase() === 'TRUE';
    s.totalAttempts++;
    if (correct) s.currentStreak++;
    else { s.totalWrong++; s.currentStreak = 0; if (r[5]) s.lastReason = String(r[5]); }
    s.lastDate = codeIso_(r[0]);
  });
  return Object.keys(byKey).map(k => byKey[k])
    .filter(s => s.totalWrong > 0 && s.currentStreak < CODE_MASTER_STREAK)
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
}


// ── GitHub 연동 ────────────────────────────────────────────

function codeRepo_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('GITHUB_TOKEN');
  const repo = props.getProperty('GITHUB_REPO');
  if (!token || !repo) throw new Error('GitHub 연동 설정(GITHUB_TOKEN, GITHUB_REPO)이 안 되어있어요');
  return { token: token, repo: repo, branch: props.getProperty('GITHUB_BRANCH') || 'main' };
}

function codeGhUrl_(repo, path) {
  return 'https://api.github.com/repos/' + repo + '/contents/' + encodeURIComponent(path).replace(/%2F/g, '/');
}

/** 저장소 파일 읽기. 없으면 null, 있으면 { content(UTF-8 문자열), sha } */
function ghGetFile_(token, repo, branch, path) {
  const res = UrlFetchApp.fetch(codeGhUrl_(repo, path) + '?ref=' + encodeURIComponent(branch), {
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 404) return null;
  if (code !== 200) throw new Error('GitHub 읽기 실패(' + code + '): ' + res.getContentText().slice(0, 200));
  const json = JSON.parse(res.getContentText());
  let content;
  if (json.content) {
    content = Utilities.newBlob(Utilities.base64Decode(json.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  } else {
    // 1MB 넘는 파일은 contents API가 본문을 안 준다 → raw로 다시 받는다
    const raw = UrlFetchApp.fetch(codeGhUrl_(repo, path) + '?ref=' + encodeURIComponent(branch), {
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github.raw' },
      muteHttpExceptions: true
    });
    content = raw.getContentText('UTF-8');
  }
  return { content: content, sha: json.sha };
}

/** 저장소 파일 쓰기(커밋). sha를 안 주면 현재 sha를 찾아서 덮어쓴다. */
function ghPutFile_(token, repo, branch, path, content, message, sha) {
  if (!sha) {
    const existing = ghGetFile_(token, repo, branch, path);
    if (existing) sha = existing.sha;
  }
  const body = {
    message: message,
    content: Utilities.base64Encode(Utilities.newBlob(content, 'text/plain').getBytes()),
    branch: branch
  };
  if (sha) body.sha = sha;
  const res = UrlFetchApp.fetch(codeGhUrl_(repo, path), {
    method: 'put',
    contentType: 'application/json',
    headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200 && code !== 201) throw new Error('GitHub 저장 실패(' + code + '): ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

/**
 * submitWorksheet — 관리자가 바로 등록(검토 대기 없이). 문제지 파일 저장 + manifest 등록.
 * payload: { requesterId, id, file, category, grade, title, unit, group, source, problems }
 */
function codeSubmitWorksheet_(p) {
  const denied = codeAdminOnly_(p);
  if (denied) return denied;
  if (!p.id || !p.file || !Array.isArray(p.problems) || p.problems.length === 0) {
    return { status: 'error', message: '문제지 id/파일명/문제가 필요해요' };
  }
  const r = codeRepo_();
  const data = { id: p.id, title: p.title || p.id, unit: p.unit || '', source: p.source || '', problems: p.problems };
  ghPutFile_(r.token, r.repo, r.branch, 'data/' + p.file, JSON.stringify(data, null, 2) + '\n', '문제지 등록: ' + p.id);
  codeUpsertManifest_(r, {
    id: p.id, file: p.file, category: p.category || 'tb', title: p.title || p.id, unit: p.unit || '',
    count: p.problems.length, group: p.group || p.title || p.id, grade: p.grade || '', source: p.source || ''
  }, '목록 반영: ' + p.id);
  return { status: 'ok' };
}

function codeUpsertManifest_(r, entry, message) {
  const path = 'data/worksheets-manifest.json';
  const f = ghGetFile_(r.token, r.repo, r.branch, path);
  const manifest = f ? JSON.parse(f.content) : { sets: [], categories: {} };
  const idx = manifest.sets.findIndex(s => s.id === entry.id);
  if (idx >= 0) manifest.sets[idx] = Object.assign({}, manifest.sets[idx], entry);
  else manifest.sets.push(entry);
  ghPutFile_(r.token, r.repo, r.branch, path, JSON.stringify(manifest, null, 2) + '\n', message, f ? f.sha : null);
}


// ── 시험범위 공지 ──────────────────────────────────────────

function codeGetExamRanges_() {
  const r = codeRepo_();
  const f = ghGetFile_(r.token, r.repo, r.branch, 'data/exam-ranges.json');
  return { status: 'ok', schools: f ? (JSON.parse(f.content).schools || []) : [] };
}

/** payload: { requesterId, schools:[...] } — 목록 전체를 덮어쓴다 */
function codeSaveExamRanges_(p) {
  const denied = codeAdminOnly_(p);
  if (denied) return denied;
  if (!Array.isArray(p.schools)) return { status: 'error', message: 'schools 배열이 필요해요' };
  const r = codeRepo_();
  ghPutFile_(r.token, r.repo, r.branch, 'data/exam-ranges.json',
    JSON.stringify({ schools: p.schools }, null, 2) + '\n', '시험범위 공지 갱신 (' + p.schools.length + '개 학교)');
  return { status: 'ok' };
}


// ── 사용자 관리 ────────────────────────────────────────────

function codeUsers_() {
  return codeRows_(CODE_USERS_SHEET).map((r, i) => ({
    rowIndex: i + 2, studentId: String(r[0]), name: String(r[1] || ''), school: String(r[2] || ''),
    grade: String(r[3] || ''), phone: String(r[4] || ''), role: String(r[7] || '') === 'admin' ? 'admin' : 'student'
  }));
}

/** 관리자가 아니면 오류 응답, 관리자면 null */
function codeAdminOnly_(p) {
  const me = codeUsers_().find(u => u.studentId === String(p.requesterId || ''));
  if (!me || me.role !== 'admin') return { status: 'error', message: '관리자만 할 수 있어요' };
  return null;
}

/** listUsers — 관리자 화면. 전화번호·비밀번호는 내보내지 않는다 */
function codeListUsers_(p) {
  const denied = codeAdminOnly_(p);
  if (denied) return denied;
  return {
    status: 'ok',
    users: codeUsers_().map(u => ({ studentId: u.studentId, name: u.name, school: u.school, grade: u.grade, role: u.role }))
  };
}

/** setUserRole — payload: { requesterId, targetId, role:'admin'|'student' } */
function codeSetUserRole_(p) {
  const denied = codeAdminOnly_(p);
  if (denied) return denied;
  if (p.role !== 'admin' && p.role !== 'student') return { status: 'error', message: 'role은 admin 또는 student' };
  if (String(p.targetId) === String(p.requesterId) && p.role !== 'admin') {
    return { status: 'error', message: '내 관리자 권한은 직접 해제할 수 없어요' };
  }
  const target = codeUsers_().find(u => u.studentId === String(p.targetId));
  if (!target) return { status: 'error', message: '사용자를 찾을 수 없어요' };
  codeSheet_(CODE_USERS_SHEET).getRange(target.rowIndex, 8).setValue(p.role === 'admin' ? 'admin' : '');
  return { status: 'ok' };
}

/** findAccountByName — 이름·학교·학년이 맞는 계정의 전화번호를 가려서(010-****-5678) 보여준다 */
function codeFindAccountByName_(p) {
  const name = String(p.name || '').trim();
  if (!name) return { status: 'error', message: '이름을 입력해주세요' };
  const school = String(p.school || '').trim();
  const grade = String(p.grade || '').trim();
  const candidates = codeUsers_()
    .filter(u => u.name === name && (!school || u.school === school) && (!grade || u.grade === grade))
    .map(u => {
      const d = u.phone.replace(/\D/g, '');
      return { maskedPhone: d.length >= 8 ? d.slice(0, 3) + '-****-' + d.slice(-4) : '****' };
    });
  if (candidates.length === 0) return { status: 'error', message: '일치하는 계정이 없어요' };
  return { status: 'ok', candidates: candidates };
}


// ── AI (Claude) ────────────────────────────────────────────

/** 텍스트 응답 한 번. content는 문자열 또는 content 블록 배열 */
function codeClaude_(system, content, maxTokens, effort) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 스크립트 속성이 없어요');
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    payload: JSON.stringify({
      model: props.getProperty('ANTHROPIC_MODEL') || CODE_DEFAULT_MODEL,
      max_tokens: maxTokens || 8000,
      system: system,
      output_config: { effort: effort || 'low' },
      fallbacks: 'default',
      messages: [{ role: 'user', content: content }]
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('Claude API 오류(' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  const json = JSON.parse(res.getContentText());
  if (json.stop_reason === 'refusal') throw new Error('AI가 이 요청을 처리하지 않았어요');
  return json.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function codeImageBlock_(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!m) throw new Error('이미지 형식을 읽을 수 없어요');
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

/** 응답 텍스트에서 JSON 부분만 꺼낸다(``` 코드블록으로 감싸 오는 경우 대비) */
function codeParseJson_(text) {
  const t = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.search(/[\[{]/);
  if (start < 0) throw new Error('AI 응답에서 JSON을 찾지 못했어요');
  return JSON.parse(t.slice(start, Math.max(t.lastIndexOf(']'), t.lastIndexOf('}')) + 1));
}

/** ocrAnswer — 손글씨 정답 한 줄 인식. 반환 { status, recognized, text } */
function codeOcrAnswer_(p) {
  const text = codeClaude_(
    '학생이 손글씨로 쓴 수학 답 하나를 읽는다. 답만 한 줄로 출력한다(설명 금지). ' +
    '분수는 3/4, 근호는 √, 거듭제곱은 ^ 로 쓴다. 읽을 수 없거나 비어 있으면 정확히 NONE 이라고만 출력한다.',
    [codeImageBlock_(p.imageDataUrl), { type: 'text', text: '이 답을 읽어줘.' }], 200, 'low');
  const clean = text.split('\n')[0].trim();
  if (!clean || clean === 'NONE') return { status: 'ok', recognized: false, text: '' };
  return { status: 'ok', recognized: true, text: clean };
}

/**
 * visionExtract — 문제 사진(여러 장) → 문제 배열. upload.html normalizeIncomingProblem()이 받는 형태로 돌려준다.
 * payload: { images:[dataUrl], meta:{ grade, category, unit, title } }
 */
function codeVisionExtract_(p) {
  const images = (p.images || []).slice(0, 8);
  if (images.length === 0) return { status: 'error', message: '사진이 없어요' };
  const meta = p.meta || {};
  const content = images.map(codeImageBlock_);
  content.push({ type: 'text', text: '단원: ' + (meta.unit || '') + ' / 제목: ' + (meta.title || '') + '\n사진 속 문제를 모두 JSON 배열로 옮겨줘.' });
  const text = codeClaude_([
    '수학 문제 사진을 앱용 JSON으로 옮긴다. 원문을 그대로 옮기고 문장·숫자를 바꾸지 않는다.',
    'JSON 배열만 출력한다. 각 원소: {"num":문제번호(숫자), "diff":"low|mid|midhigh|high|top", "type":"mc|fillin",',
    '"question":"…", "choices":["보기5개, 앞의 ①② 번호 제거"](mc만), "correct":0~4 정답 인덱스(0-based, 사진에 정답 표시가 있을 때만),',
    '"answer":"단답형 정답"(fillin이고 사진에 있을 때만), "solution":["풀이 줄"](사진에 있을 때만)}',
    '수식은 \\( … \\) LaTeX로 쓴다. $는 쓰지 않는다. 그림이 필요한 문제는 question 끝에 [그림 필요]를 붙인다.'
  ].join('\n'), content, 16000, 'medium');
  const problems = codeParseJson_(text);
  if (!Array.isArray(problems)) throw new Error('문제 배열이 아니에요');
  return { status: 'ok', problems: problems };
}

/** convertToLatex — 평문 수식("x^2+2x+1=0, 루트3")을 앱 표기(\( … \))로 바꾼다 */
function codeConvertToLatex_(p) {
  const raw = String(p.text || '');
  if (!raw.trim()) return { status: 'error', message: '변환할 내용이 없어요' };
  const text = codeClaude_(
    '수학 문장의 수식 부분만 \\( … \\) LaTeX로 감싸 바꾼다. 한글 문장·줄바꿈·내용은 그대로 둔다. ' +
    '$는 쓰지 않는다. 변환된 텍스트만 출력한다(설명 금지).', raw, 4000, 'low');
  return { status: 'ok', text: text };
}
