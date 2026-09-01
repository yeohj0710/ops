#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const API_URL = 'https://tibo.modelyard.dev/api/events';
const STATUS_URL = 'https://tibo.modelyard.dev/api/status';
const OFFICIAL_HELP = 'https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work';

function parseArgs(argv) {
  const args = { out: null, state: null, json: false, compact: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--state') args.state = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--compact') args.compact = true;
    else if (argv[i] === '--self-test') args.selfTest = true;
    else throw new Error(`알 수 없는 인자: ${argv[i]}`);
  }
  return args;
}

function normalizedText(event) {
  return String(event.source_text || event.summary_en || event.title_en || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(event) {
  const text = normalizedText(event).toLowerCase();
  const banked = /\bbanked\b/.test(text);

  const completed = [
    /\bwe have now reset\b/,
    /\bhave reset usage\b/,
    /\bhas been reset\b/,
    /\breset has been propagated\b/,
    /\breset has landed\b/,
    /\bbrand new usage\b/,
    /\bwe are reset(?:t)?ing usage\b/,
    /\busage limits have (?:now )?been reset\b/,
  ].some((pattern) => pattern.test(text));

  if (completed) return { kind: banked ? 'completed_banked' : 'completed_hard', score: null };

  const explicitPlan = [
    /\breset will land\b/,
    /\bwill (?:fully )?reset\b/,
    /\breset .*\b(?:tomorrow|today|next hour|by \d)/,
    /\bwill be there by\b/,
    /\bto reset .*\b(?:tomorrow|today|in a bit|within 24 hours)\b/,
  ].some((pattern) => pattern.test(text));

  if (explicitPlan) return { kind: banked ? 'planned_banked' : 'planned_hard', score: 95 };

  const strongHint = [
    /\bmilestone to celebrate tomorrow\b/,
    /\bhold on to your codex\b/,
    /\breset button.*\btomorrow\b/,
    /\blittle surprise.*\btomorrow\b/,
    /\bcelebration is moved to tomorrow\b/,
  ].some((pattern) => pattern.test(text));

  if (strongHint) return { kind: 'strong_hint', score: 80 };

  const support = /\b(?:usage|rate limit|cache).*(?:drain|faster|issue|fix|investigat)/.test(text)
    || /\b(?:investigat|fix).*(?:usage|rate limit|cache)/.test(text);
  if (support) return { kind: 'support_signal', score: 45 };

  return { kind: 'other', score: 0 };
}

async function fetchAllEvents(fetchImpl = fetch) {
  const events = [];
  let url = API_URL;
  const seenCursors = new Set();

  for (let page = 0; page < 10 && url; page += 1) {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`공개 이벤트 API ${response.status} ${response.statusText}`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('공개 이벤트 API 응답에 data 배열이 없다');
    events.push(...body.data);

    if (!body.nextCursor || seenCursors.has(body.nextCursor)) break;
    seenCursors.add(body.nextCursor);
    url = `${API_URL}?cursor=${encodeURIComponent(body.nextCursor)}`;
  }

  return events.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function fetchMonitorStatus(fetchImpl = fetch) {
  const response = await fetchImpl(STATUS_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`공개 모니터 상태 API ${response.status} ${response.statusText}`);
  return response.json();
}

function isDirect(event) {
  return event.source_quality === 'DIRECT'
    && event.verification_status === 'DIRECT_VERIFIED';
}

function analyze(events, now = new Date(), monitorStatus = null) {
  const enriched = events.map((event) => ({ ...event, analysis: classify(event) }));
  const completed = enriched.filter((event) => event.analysis.kind.startsWith('completed_'));
  const latestCompleted = completed[0] || null;
  const completedAt = latestCompleted ? Date.parse(latestCompleted.published_at) : -Infinity;
  const signalCutoff = now.getTime() - (72 * 3_600_000);

  const laterSignals = enriched.filter((event) => {
    const publishedAt = Date.parse(event.published_at);
    return publishedAt > completedAt
      && publishedAt >= signalCutoff
      && ['planned_hard', 'planned_banked', 'strong_hint', 'support_signal'].includes(event.analysis.kind);
  });

  const primary = laterSignals.sort((a, b) => {
    const score = b.analysis.score - a.analysis.score;
    return score || Date.parse(b.published_at) - Date.parse(a.published_at);
  })[0] || null;

  let verdict = '새 조짐 없음';
  let score = 10;
  if (primary?.analysis.kind.startsWith('planned_')) {
    verdict = '초기화 예정이 확인됨';
    score = primary.analysis.score;
  } else if (primary?.analysis.kind === 'strong_hint') {
    verdict = '강한 조짐 있음';
    score = primary.analysis.score;
  } else if (primary?.analysis.kind === 'support_signal') {
    verdict = '보조 조짐만 있음';
    score = primary.analysis.score;
  } else if (!latestCompleted) {
    verdict = '판정 자료 부족';
    score = 0;
  }

  const newestObservedEvent = enriched
    .map((event) => event.observed_at || event.verified_at || event.published_at)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
  const sourceCheckedAt = monitorStatus?.lastSourceFetch
    || monitorStatus?.lastSuccessfulCron
    || newestObservedEvent;
  const freshnessHours = sourceCheckedAt
    ? Math.max(0, (now.getTime() - Date.parse(sourceCheckedAt)) / 3_600_000)
    : null;

  return {
    checkedAt: now.toISOString(),
    eventCount: enriched.length,
    resetLabeledCount: enriched.filter((event) => String(event.category).startsWith('RESET_')).length,
    verdict,
    score,
    scoreMeaning: '공개 신호 강도이며 발생 확률이 아님',
    primary,
    latestCompleted,
    freshnessHours,
    sourceStatus: monitorStatus?.status || null,
    sourceCheckedAt,
    newestObservedEvent,
    signalWindowHours: 72,
    recent: enriched.slice(0, 8),
  };
}

function resultSignature(result) {
  return JSON.stringify({
    verdict: result.verdict,
    score: result.score,
    primary: result.primary?.source_url || null,
    latestCompleted: result.latestCompleted?.source_url || null,
  });
}

function toCompact(result, changed = true) {
  const freshness = result.freshnessHours == null ? '?' : result.freshnessHours.toFixed(1);
  const source = result.primary?.source_url || result.latestCompleted?.source_url || '원문 없음';
  return `${changed ? 'CHANGED' : 'UNCHANGED'} | ${result.verdict} | 근거 ${result.score}/100`
    + ` | 소스 확인 ${freshness}시간 전 | ${source}`;
}

async function updateState(statePath, result) {
  let previous = null;
  try {
    previous = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const signature = resultSignature(result);
  const changed = previous?.signature !== signature;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({
    signature,
    checkedAt: result.checkedAt,
    sourceCheckedAt: result.sourceCheckedAt,
  }, null, 2), 'utf8');
  return changed;
}

function formatKst(value) {
  if (!value) return '확인 안 됨';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function shortEvidence(event) {
  if (!event) return '없음';
  const direct = isDirect(event) ? '직접 검증' : '보조 자료';
  const text = normalizedText(event).slice(0, 240);
  return `${formatKst(event.published_at)} · ${direct}\n  - ${text}\n  - ${event.source_url || '원문 URL 없음'}`;
}

function toMarkdown(result) {
  const freshness = result.freshnessHours == null
    ? '확인 안 됨'
    : `${result.freshnessHours.toFixed(1)}시간 전`;
  const currentMeaning = result.primary
    ? shortEvidence(result.primary)
    : '최근 완료 뒤에 나온 미래형 원문이 없음';

  return `# Codex 초기화 조짐\n\n`
    + `- 결론: **${result.verdict}**\n`
    + `- 근거 점수: **${result.score}/100** (${result.scoreMeaning})\n`
    + `- 데이터 최신성: ${freshness} · 확인 ${formatKst(result.checkedAt)}\n`
    + `- 수집 범위: 공개 이벤트 ${result.eventCount}개, reset 계열 ${result.resetLabeledCount}개\n\n`
    + `## 현재 근거\n\n${currentMeaning}\n\n`
    + `## 최근 완료\n\n${shortEvidence(result.latestCompleted)}\n\n`
    + `## 판정 주의\n\n`
    + `- 공개 공지는 개인 계정 반영을 보장하지 않는다. 개인 상태는 Codex Settings → Usage에서 확인한다.\n`
    + `- hard/global reset과 banked reset은 다르다. 공식 설명: ${OFFICIAL_HELP}\n`
    + `- 제3자 category보다 원문 시제를 우선했다.\n`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`SELF-TEST FAIL: ${message}`);
}

function runSelfTest() {
  const base = {
    source_quality: 'DIRECT', verification_status: 'DIRECT_VERIFIED',
    observed_at: '2026-08-31T03:00:00.000Z', source_url: 'https://x.com/example',
  };
  const completed = { ...base, published_at: '2026-08-31T02:29:00.000Z', source_text: 'We have now reset usage for all paid users.' };
  const mislabeledDuplicate = { ...base, published_at: '2026-08-31T02:34:00.000Z', category: 'RESET_PLANNED', source_text: 'We have now reset usage for all paid users.' };
  const hint = { ...base, published_at: '2026-08-31T05:00:00.000Z', source_text: 'We might hit a new milestone to celebrate tomorrow. Hold on to your Codex.' };
  const plan = { ...base, published_at: '2026-08-31T06:00:00.000Z', source_text: 'Your Codex reset will land at 6pm PST.' };
  const staleHint = { ...base, published_at: '2026-08-20T05:00:00.000Z', source_text: 'We might hit a new milestone to celebrate tomorrow. Hold on to your Codex.' };
  const now = new Date('2026-08-31T07:00:00.000Z');
  const monitorStatus = { status: 'ok', lastSourceFetch: '2026-08-31T06:55:00.000Z' };

  assert(classify(mislabeledDuplicate).kind === 'completed_hard', 'category보다 완료 시제를 우선해야 한다');
  assert(analyze([mislabeledDuplicate, completed], now, monitorStatus).verdict === '새 조짐 없음', '완료 중복을 미래 신호로 세면 안 된다');
  assert(analyze([hint, completed], now).verdict === '강한 조짐 있음', '은유적 내일 언지를 잡아야 한다');
  assert(analyze([plan, completed], now).verdict === '초기화 예정이 확인됨', '명시적 미래 일정을 잡아야 한다');
  assert(analyze([staleHint], now).verdict === '판정 자료 부족', '72시간이 지난 언지를 현재 신호로 세면 안 된다');
  console.log('PASS — Codex 초기화 조짐 판정 self-test');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return runSelfTest();

  const [events, monitorStatus] = await Promise.all([fetchAllEvents(), fetchMonitorStatus()]);
  const result = analyze(events, new Date(), monitorStatus);
  const changed = args.state ? await updateState(args.state, result) : true;
  const output = args.json
    ? JSON.stringify({ ...result, changed }, null, 2)
    : args.compact
      ? toCompact(result, changed)
      : toMarkdown(result);

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, output, 'utf8');
    console.log(`저장: ${args.out}`);
  } else {
    console.log(output);
  }
}

main().catch((error) => {
  console.error(`FAIL — ${error.message}`);
  process.exitCode = 1;
});
