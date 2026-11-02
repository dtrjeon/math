/**
 * ============================================================
 * 학습 팁(Instagram 큐레이션) 애드온
 * ------------------------------------------------------------
 * 선생님이 tools/admin-tips.html에서 Instagram 게시물 링크 + 요약 + 단원 태그를 저장하면
 * data/tips.json에 바로 커밋한다(관리자 직접 등록이라 검토대기 없음 — admin-examrange와 같은 방식).
 * 학생 화면(홈 "💡 학습 팁", player.html 관련 팁)은 data/tips.json을 정적으로 읽는다.
 *
 * 필요한 준비물
 *  1) gas-github-upload-addon.gs(ghGetFile_/ghPutFile_)가 이미 병합되어 있어야 합니다.
 *  2) Users 시트 H열(role)에 'admin'이 있는 사용자만 저장 가능.
 *  3) doPost() 안 action 분기에 아래 2개 케이스 추가:
 *
 *     if (action === 'getTips')  return jsonResponse_(handleGetTips_());
 *     if (action === 'saveTips') return jsonResponse_(handleSaveTips_(payload));
 * ============================================================
 */

const TIPS_PATH = 'data/tips.json';
// 게시물(p) / 릴스(reel)만 허용. 계정 페이지·외부 링크는 거절한다.
const TIPS_URL_RE = /^https:\/\/www\.instagram\.com\/(p|reel)\/[A-Za-z0-9_-]+\/$/;
const TIPS_MAX = 200;

function tipsRepo_() {
  const props = PropertiesService.getScriptProperties();
  return {
    token: props.getProperty('GITHUB_TOKEN'),
    repo: props.getProperty('GITHUB_REPO'),
    branch: props.getProperty('GITHUB_BRANCH') || 'main'
  };
}

/** Users 시트에서 requesterId의 role(H열)이 admin인지 확인 */
function tipsIsAdmin_(requesterId) {
  if (!requesterId) return false;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  if (!sheet) return false;
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(requesterId)) return String(rows[i][7] || '') === 'admin';
  }
  return false;
}

/** 링크를 표준형(https://www.instagram.com/p/코드/)으로 맞춘다. 맞출 수 없으면 null */
function tipsNormalizeUrl_(url) {
  const m = String(url || '').trim().match(/^https?:\/\/(?:www\.)?instagram\.com\/(p|reel|reels)\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  return 'https://www.instagram.com/' + (m[1] === 'reels' ? 'reel' : m[1]) + '/' + m[2] + '/';
}

/** 저장 전 정리·검사 — scripts/validate_worksheets.py의 check_tips()와 같은 규칙 */
function tipsClean_(tips) {
  if (!Array.isArray(tips)) throw new Error('tips 배열이 필요해요');
  if (tips.length > TIPS_MAX) throw new Error('팁은 최대 ' + TIPS_MAX + '개까지예요');
  const seen = {};
  return tips.map((t, i) => {
    const url = tipsNormalizeUrl_(t.url);
    if (!url) throw new Error((i + 1) + '번째 팁: Instagram 게시물 링크(instagram.com/p/… 또는 /reel/…)가 아니에요');
    if (seen[url]) throw new Error((i + 1) + '번째 팁: 같은 게시물이 이미 있어요');
    seen[url] = true;
    const title = String(t.title || '').trim();
    if (!title) throw new Error((i + 1) + '번째 팁: 한 줄 요약(제목)이 필요해요');
    const clip = (s, n) => String(s || '').trim().slice(0, n);
    const list = a => (Array.isArray(a) ? a : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 10);
    return {
      id: clip(t.id, 40) || ('t' + new Date().getTime() + '_' + i),
      url: url,
      account: clip(t.account, 40),
      title: clip(title, 80),
      summary: clip(t.summary, 400),
      units: list(t.units),
      grades: list(t.grades).filter(g => g === 'm0' || g === 'm1' || g === 'm2'),
      addedAt: clip(t.addedAt, 10) || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
    };
  });
}

/** action: 'getTips' — GitHub에서 최신 파일을 읽는다(Pages 배포 지연 없이 관리자 화면에 바로 반영) */
function handleGetTips_() {
  const r = tipsRepo_();
  if (!r.token || !r.repo) return { status: 'error', message: 'GitHub 연동 설정이 안 되어있어요' };
  const f = ghGetFile_(r.token, r.repo, r.branch, TIPS_PATH);
  if (!f) return { status: 'ok', tips: [] };
  return { status: 'ok', tips: JSON.parse(f.content).tips || [] };
}

/**
 * action: 'saveTips'
 * payload: { requesterId, tips:[{ id, url, account, title, summary, units:[], grades:[] }] }
 * 목록 전체를 받아서 덮어쓴다(admin-examrange의 saveExamRanges와 같은 방식).
 */
function handleSaveTips_(payload) {
  if (!tipsIsAdmin_(payload.requesterId)) return { status: 'error', message: '관리자만 저장할 수 있어요' };
  const r = tipsRepo_();
  if (!r.token || !r.repo) return { status: 'error', message: 'GitHub 연동 설정이 안 되어있어요' };
  try {
    const tips = tipsClean_(payload.tips);
    const f = ghGetFile_(r.token, r.repo, r.branch, TIPS_PATH);
    ghPutFile_(r.token, r.repo, r.branch, TIPS_PATH, JSON.stringify({ tips: tips }, null, 2) + '\n',
      '학습 팁 갱신 (' + tips.length + '개)', f ? f.sha : null);
    return { status: 'ok', tips: tips };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}
