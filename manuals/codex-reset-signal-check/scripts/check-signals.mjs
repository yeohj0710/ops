#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TIBO_EVENTS_URL = 'https://tibo.modelyard.dev/api/events';
const TIBO_STATUS_URL = 'https://tibo.modelyard.dev/api/status';
const RESET_STATUS_URL = 'https://codex-resets.com/api/v1/status';
const RESET_HISTORY_URL = 'https://codex-resets.com/api/v1/resets';
const OFFICIAL_HELP = 'https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work';
const SIGNAL_WINDOW_HOURS = 72;

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

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizedText(event) {
  return decodeHtml(event?.source_text || event?.text || event?.summary_en || event?.title_en || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFingerprint(event) {
  return normalizedText(event)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resetTypeFromText(text, fallback = 'regular') {
  const value = String(text || '').toLowerCase();
  if (/\b(?:hard|full) reset\b/.test(value)) return 'regular';
  const grantsBanked = [
    /\b(?:add(?:ed)?|credit(?:ed)?|grant(?:ed)?|giving|give|receive|use)\b.{0,100}\bbanked reset\b/,
    /\bbanked reset\b.{0,80}\b(?:account|credit|use|apply|own schedule)\b/,
  ].some((pattern) => pattern.test(value));
  return grantsBanked ? 'banked' : fallback;
}

function classify(event) {
  const text = normalizedText(event).toLowerCase();
  const resetType = resetTypeFromText(text, 'regular');
  const completed = [
    /\bwe have now reset\b/, /\bhave reset usage\b/, /\bhas been reset\b/,
    /\breset has been propagated\b/, /\breset has landed\b/, /\bbrand new usage\b/,
    /\bwe are reset(?:t)?ing usage\b/, /\busage limits have (?:now )?been reset\b/,
    /\breset button pressed\b/,
  ].some((pattern) => pattern.test(text));
  if (completed) return { kind: resetType === 'banked' ? 'completed_banked' : 'completed_hard', score: null };

  const explicitPlan = [
    /\breset will land\b/, /\bwill (?:fully )?reset\b/, /\bwill be reset\b/,
    /\breset incoming\b/,
    /\breset .*(?:tomorrow|today|next hour|in a bit|within \d+ hours?|by \d|at \d)/,
    /\bwill be there by\b/,
    /\bto reset .*(?:tomorrow|today|in a bit|within \d+ hours?)\b/,
    /\banother (?:reset|one) will come\b/,
    /\b(?:during the day|today|tomorrow|will)\b.{0,100}\b(?:credit|grant|add|give)\b.{0,100}\bbanked reset\b/,
    /\bwill credit\b.{0,100}\breset\b.{0,50}\bbank\b/,
  ].some((pattern) => pattern.test(text));
  if (explicitPlan) return { kind: resetType === 'banked' ? 'planned_banked' : 'planned_hard', score: 95 };

  const strongHint = [
    /\bmilestone to celebrate tomorrow\b/, /\bhold on to your codex\b/,
    /\breset button.*\btomorrow\b/, /\blittle surprise.*\btomorrow\b/,
    /\bcelebration is moved to tomorrow\b/, /\byou know what comes next\b/,
  ].some((pattern) => pattern.test(text));
  if (strongHint) return { kind: 'strong_hint', score: 80 };

  const context = /\b(?:usage|rate limit|cache).*(?:drain|faster|issue|fix|investigat|incident|outage)/.test(text)
    || /\b(?:investigat|fix|incident|outage).*(?:usage|rate limit|cache|codex)/.test(text);
  if (context) return { kind: 'context_only', score: 20 };
  return { kind: 'other', score: 0 };
}

async function fetchJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} ${response.status} ${response.statusText}`);
  return response.json();
}

function requireTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} 시각이 없거나 잘못됐다`);
  }
}

function requireUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('HTTPS가 아님');
  } catch {
    throw new Error(`${label} URL이 없거나 잘못됐다`);
  }
}

function validateResetRecord(reset, label) {
  if (!reset || typeof reset.id !== 'string' || typeof reset.text !== 'string') {
    throw new Error(`${label} 초기화 항목 형식이 다르다`);
  }
  requireTimestamp(reset.announced_at, `${label}.announced_at`);
  if (reset.source?.type === 'x_post') requireUrl(reset.source.url, `${label} X 원문`);
}

async function fetchAllEvents(fetchImpl = fetch) {
  const events = [];
  let url = TIBO_EVENTS_URL;
  const seenCursors = new Set();
  for (let page = 0; page < 10 && url; page += 1) {
    const body = await fetchJson(url, fetchImpl);
    if (!Array.isArray(body.data)) throw new Error('Tibo 이벤트 API 응답에 data 배열이 없다');
    for (const [index, event] of body.data.entries()) {
      requireTimestamp(event?.published_at, `Tibo 이벤트 ${events.length + index}.published_at`);
      if (event?.source_quality === 'DIRECT') {
        requireUrl(event.source_url, `Tibo 이벤트 ${events.length + index} X 원문`);
      }
    }
    events.push(...body.data);
    if (!body.nextCursor || seenCursors.has(body.nextCursor)) break;
    seenCursors.add(body.nextCursor);
    url = `${TIBO_EVENTS_URL}?cursor=${encodeURIComponent(body.nextCursor)}`;
  }
  return events.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}

async function fetchMonitorStatus(fetchImpl = fetch) {
  const body = await fetchJson(TIBO_STATUS_URL, fetchImpl);
  const checkedAt = body?.lastSourceFetch || body?.lastSuccessfulCron;
  requireTimestamp(checkedAt, 'Tibo 모니터 최신성');
  return body;
}

async function fetchResetStatus(fetchImpl = fetch) {
  const body = await fetchJson(RESET_STATUS_URL, fetchImpl);
  if (!body?.data || !body?.meta) throw new Error('Codex Resets 상태 API 응답 형식이 다르다');
  if (body.data.latest_reset) validateResetRecord(body.data.latest_reset, 'Codex Resets 상태');
  if (body.data.active_watch) {
    requireTimestamp(body.data.active_watch.observed_at, 'active_watch.observed_at');
    requireTimestamp(body.data.active_watch.expires_at, 'active_watch.expires_at');
    if (body.data.active_watch.source?.type === 'x_post') {
      requireUrl(body.data.active_watch.source.url, 'active_watch X 원문');
    }
  }
  requireTimestamp(body.meta.generated_at, 'Codex Resets meta.generated_at');
  return body;
}

async function fetchResetHistory(fetchImpl = fetch) {
  const resets = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ limit: '100', order: 'desc' });
    if (cursor) query.set('cursor', cursor);
    const body = await fetchJson(`${RESET_HISTORY_URL}?${query}`, fetchImpl);
    if (!Array.isArray(body.data)) throw new Error('Codex Resets 이력 API 응답에 data 배열이 없다');
    for (const [index, reset] of body.data.entries()) {
      validateResetRecord(reset, `Codex Resets 이력 ${resets.length + index}`);
    }
    resets.push(...body.data);
    if (!body.pagination?.has_more || !body.pagination?.next_cursor) break;
    cursor = body.pagination.next_cursor;
  }
  if (resets.length === 0) throw new Error('Codex Resets 이력 API가 빈 목록을 반환했다');
  return resets.sort((a, b) => Date.parse(b.announced_at) - Date.parse(a.announced_at));
}

function isDirect(event) {
  return event?.source_quality === 'DIRECT' && event?.verification_status === 'DIRECT_VERIFIED';
}

function canonicalReset(reset) {
  if (!reset) return null;
  const text = decodeHtml(reset.text);
  const resetType = resetTypeFromText(text, reset.reset_type || 'regular');
  return {
    id: reset.id,
    published_at: reset.announced_at,
    source_text: text,
    source_url: reset.source?.url || null,
    source_quality: reset.source?.type === 'x_post' ? 'DIRECT' : 'OBSERVED',
    verification_status: reset.source?.type === 'x_post' ? 'DIRECT_VERIFIED' : 'OBSERVED',
    reset_type: resetType,
    source_catalog: 'codex-resets.com',
    analysis: { kind: resetType === 'banked' ? 'completed_banked' : 'completed_hard', score: null },
  };
}

function sameReset(event, reset) {
  const eventUrl = event?.source_url || event?.source?.url || null;
  const resetUrl = reset?.source_url || reset?.source?.url || null;
  if (eventUrl && resetUrl && eventUrl === resetUrl) return true;
  const a = textFingerprint(event);
  const b = textFingerprint(reset);
  if (!a || !b || Math.min(a.length, b.length) < 30) return false;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  const similarity = union ? intersection / union : 0;
  if (!(a === b || a.includes(b) || b.includes(a) || similarity >= 0.85)) return false;
  const eventAt = Date.parse(event.published_at || event.announced_at);
  const resetAt = Date.parse(reset.published_at || reset.announced_at);
  return Number.isFinite(eventAt) && Number.isFinite(resetAt)
    && Math.abs(eventAt - resetAt) <= 30 * 60_000;
}

function activeWatchSignal(watch, latestResetAt, now) {
  if (!watch) return null;
  if (!['strong', 'elevated'].includes(watch.level)) return null;
  const observedAt = Date.parse(watch.observed_at);
  const expiresAt = Date.parse(watch.expires_at);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)) return null;
  if (observedAt <= latestResetAt || expiresAt <= now.getTime()) return null;
  const strong = watch.level === 'strong';
  return {
    kind: strong ? 'tracker_strong' : 'tracker_elevated',
    score: strong ? 85 : 60,
    trackerChancePercent: Number.isInteger(watch.reset_chance_percent) ? watch.reset_chance_percent : null,
    forecastWindow: watch.forecast_window,
    published_at: watch.observed_at,
    expires_at: watch.expires_at,
    source_text: watch.text,
    source_url: watch.source?.url || null,
    source_quality: watch.source?.type === 'x_post' ? 'DIRECT' : 'OBSERVED',
    verification_status: 'THIRD_PARTY_FORECAST',
    source_catalog: 'codex-resets.com active_watch',
  };
}

function buildCalibration(events, resets) {
  const canonical = resets.map(canonicalReset);
  const buckets = {
    explicit_plan: { total: 0, followedWithin72h: 0 },
    strong_hint: { total: 0, followedWithin72h: 0 },
    context_only: { total: 0, followedWithin72h: 0 },
  };
  for (const event of events) {
    if (!isDirect(event) || canonical.some((reset) => sameReset(event, reset))) continue;
    const analysis = classify(event);
    const bucket = analysis.kind.startsWith('planned_')
      ? buckets.explicit_plan
      : analysis.kind === 'strong_hint'
        ? buckets.strong_hint
        : analysis.kind === 'context_only'
          ? buckets.context_only
          : null;
    if (!bucket) continue;
    bucket.total += 1;
    const at = Date.parse(event.published_at);
    const nextReset = canonical.find((reset) => {
      const resetAt = Date.parse(reset.published_at);
      return resetAt > at && resetAt - at <= SIGNAL_WINDOW_HOURS * 3_600_000;
    });
    if (nextReset) bucket.followedWithin72h += 1;
  }
  return buckets;
}

function analyze(events, resetStatus, resetHistory, now = new Date(), monitorStatus = null) {
  const canonicalHistory = resetHistory.map(canonicalReset);
  const statusReset = canonicalReset(resetStatus?.data?.latest_reset);
  const latestCompleted = canonicalHistory[0] || null;
  const latestCompletedAt = latestCompleted ? Date.parse(latestCompleted.published_at) : -Infinity;
  const enriched = events.map((event) => ({ ...event, analysis: classify(event) }));

  const completionInconsistencies = enriched
    .filter((event) => event.analysis.kind.startsWith('completed_'))
    .filter((event) => !canonicalHistory.some((reset) => sameReset(event, reset)))
    .filter((event) => Date.parse(event.published_at) > latestCompletedAt)
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  if (statusReset && canonicalHistory[0] && !sameReset(statusReset, canonicalHistory[0])) {
    completionInconsistencies.unshift(statusReset);
  }

  const signalCutoff = now.getTime() - SIGNAL_WINDOW_HOURS * 3_600_000;
  const futureSignals = enriched
    .filter(isDirect)
    .filter((event) => !canonicalHistory.some((reset) => sameReset(event, reset)))
    .filter((event) => {
      const publishedAt = Date.parse(event.published_at);
      return publishedAt > latestCompletedAt && publishedAt >= signalCutoff;
    })
    .filter((event) => ['planned_hard', 'planned_banked', 'strong_hint', 'context_only'].includes(event.analysis.kind));

  const directActionable = futureSignals
    .filter((event) => event.analysis.kind !== 'context_only')
    .sort((a, b) => b.analysis.score - a.analysis.score || Date.parse(b.published_at) - Date.parse(a.published_at))[0] || null;
  const contextSignals = futureSignals.filter((event) => event.analysis.kind === 'context_only');
  const trackerWatch = activeWatchSignal(resetStatus?.data?.active_watch, latestCompletedAt, now);
  const candidates = [];
  if (directActionable) candidates.push({
    ...directActionable,
    kind: directActionable.analysis.kind,
    score: directActionable.analysis.score,
    source_catalog: 'Tibo 원문',
  });
  if (trackerWatch) candidates.push(trackerWatch);
  const primary = candidates.sort((a, b) => b.score - a.score)[0] || null;

  let verdict = '새 조짐 없음';
  let score = 10;
  if (primary?.kind?.startsWith('planned_')) {
    verdict = '초기화 예정이 확인됨';
    score = primary.score;
  } else if (primary?.kind === 'tracker_strong' || primary?.kind === 'strong_hint') {
    verdict = '강한 조짐 있음';
    score = primary.score;
  } else if (primary?.kind === 'tracker_elevated') {
    verdict = '관찰 신호 있음';
    score = primary.score;
  } else if (!latestCompleted) {
    verdict = '판정 자료 부족';
    score = 0;
  }

  const sourceCheckedAt = monitorStatus?.lastSourceFetch
    || monitorStatus?.lastSuccessfulCron
    || enriched.map((event) => event.observed_at || event.verified_at || event.published_at)
      .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    || null;
  const trackerCheckedAt = resetStatus?.meta?.generated_at || null;
  const ageHours = (value) => value ? Math.max(0, (now.getTime() - Date.parse(value)) / 3_600_000) : null;
  return {
    checkedAt: now.toISOString(),
    eventCount: enriched.length,
    resetCatalogCount: canonicalHistory.length,
    verdict,
    score,
    scoreMeaning: '공개 신호 강도이며 발생 확률이 아님',
    primary,
    trackerWatch,
    contextSignals,
    completionInconsistencies,
    latestCompleted,
    tiboFreshnessHours: ageHours(sourceCheckedAt),
    trackerFreshnessHours: ageHours(trackerCheckedAt),
    sourceCheckedAt,
    trackerCheckedAt,
    signalWindowHours: SIGNAL_WINDOW_HOURS,
    calibration: buildCalibration(events, resetHistory),
    recent: enriched.slice(0, 10),
  };
}

function resultSignature(result) {
  return JSON.stringify({
    verdict: result.verdict,
    score: result.score,
    primary: result.primary?.source_url || null,
    primaryKind: result.primary?.kind || null,
    trackerChancePercent: result.primary?.trackerChancePercent ?? null,
    forecastWindow: result.primary?.forecastWindow || null,
    latestCompleted: result.latestCompleted?.source_url || null,
  });
}

function toCompact(result, changed = true) {
  const tiboAge = result.tiboFreshnessHours == null ? '?' : result.tiboFreshnessHours.toFixed(1);
  const trackerAge = result.trackerFreshnessHours == null ? '?' : result.trackerFreshnessHours.toFixed(1);
  const source = result.primary?.source_url || result.latestCompleted?.source_url || '원문 없음';
  const trackerMarker = result.primary?.kind?.startsWith('tracker_') ? ' | 제3자 예측' : '';
  return `${changed ? 'CHANGED' : 'UNCHANGED'} | ${result.verdict} | 근거 ${result.score}/100`
    + `${trackerMarker} | Tibo ${tiboAge}h / tracker ${trackerAge}h | ${source}`;
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
    trackerCheckedAt: result.trackerCheckedAt,
  }, null, 2), 'utf8');
  return changed;
}

function formatKst(value) {
  if (!value) return '확인 안 됨';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function shortEvidence(event) {
  if (!event) return '없음';
  const source = event.source_catalog || (isDirect(event) ? 'Tibo 원문 직접 검증' : '보조 자료');
  return `${formatKst(event.published_at)} · ${source}\n  - ${normalizedText(event).slice(0, 280)}\n  - ${event.source_url || '원문 URL 없음'}`;
}

function calibrationLine(calibration) {
  const item = (name, value) => `${name} ${value.followedWithin72h}/${value.total}`;
  return [
    item('명시 예고', calibration.explicit_plan),
    item('은유 신호', calibration.strong_hint),
    item('장애·조사만', calibration.context_only),
  ].join(' · ');
}

function toMarkdown(result) {
  const primary = result.primary ? shortEvidence(result.primary) : '최근 완료 뒤에 나온 행동 가능한 미래 신호가 없음';
  const signalType = result.primary?.kind === 'planned_banked'
    ? 'banked'
    : result.primary?.kind === 'planned_hard'
      ? 'hard/global'
      : result.primary
        ? '미확정'
        : '없음';
  const resetType = result.latestCompleted?.reset_type
    || (result.latestCompleted?.analysis?.kind === 'completed_banked' ? 'banked' : 'regular/hard');
  const trackerChance = result.primary?.trackerChancePercent == null
    ? ''
    : `\n- tracker 예측값: **${result.primary.trackerChancePercent}%** (제3자 분류값이며 OpenAI 약속이 아님)`;
  const context = result.contextSignals.length
    ? `\n- 참고 신호: 장애·사용량 조사 ${result.contextSignals.length}건. 이것만으로는 초기화 조짐으로 알리지 않음`
    : '';
  return `# Codex 초기화 조짐\n\n`
    + `- 결론: **${result.verdict}**\n`
    + `- 근거 점수: **${result.score}/100** (${result.scoreMeaning})${trackerChance}\n`
    + `- 데이터 최신성: Tibo ${result.tiboFreshnessHours?.toFixed(1) ?? '?'}시간 · tracker ${result.trackerFreshnessHours?.toFixed(1) ?? '?'}시간\n`
    + `- 수집 범위: Tibo 분류 이벤트 ${result.eventCount}개 · codex-resets.com 초기화 ${result.resetCatalogCount}개\n`
    + `- 과거 72시간 연결: ${calibrationLine(result.calibration)}${context}\n\n`
    + `## 현재 근거\n\n예상 종류: ${signalType}\n\n${primary}\n\n`
    + `## 최근 초기화\n\n종류: ${resetType}\n\n${shortEvidence(result.latestCompleted)}\n\n`
    + `## 판정 주의\n\n`
    + `- 완료 시각은 codex-resets.com 이력을 기준으로 하고 Tibo 중복 게시물은 제거했다.\n`
    + `- active_watch는 현재 예측 보조 신호다. Tibo의 명시적 미래 약속보다 낮게 취급한다.\n`
    + `- 장애·사용량 조사만 있는 게시물은 단독 경보로 쓰지 않는다.\n`
    + `- 공개 공지는 개인 계정 반영을 보장하지 않는다. 개인 상태는 Codex Settings → Usage에서 확인한다.\n`
    + `- hard/global reset과 banked reset은 다르다. 공식 설명: ${OFFICIAL_HELP}\n`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`SELF-TEST FAIL: ${message}`);
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

async function runSelfTest() {
  const base = {
    source_quality: 'DIRECT', verification_status: 'DIRECT_VERIFIED',
    observed_at: '2026-08-31T03:00:00.000Z', source_url: 'https://x.com/example',
  };
  const siteReset = {
    id: 'reset-1', announced_at: '2026-08-31T02:29:00.000Z', reset_type: 'regular',
    text: 'We have now reset usage for all paid users.',
    source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/reset-1' },
  };
  const duplicate = {
    ...base, published_at: '2026-08-31T02:34:00.000Z', source_url: 'https://x.com/duplicate',
    source_text: 'We have now reset usage for all paid users.',
  };
  const hint = {
    ...base, published_at: '2026-08-31T02:32:00.000Z', source_url: 'https://x.com/hint',
    source_text: 'We might hit a new milestone to celebrate tomorrow. Hold on to your Codex.',
  };
  const plan = {
    ...base, published_at: '2026-08-31T06:00:00.000Z', source_url: 'https://x.com/plan',
    source_text: 'Your Codex reset will land at 6pm PST.',
  };
  const status = {
    data: { latest_reset: siteReset, active_watch: null },
    meta: { generated_at: '2026-08-31T06:55:00.000Z' },
  };
  const monitor = { status: 'ok', lastSourceFetch: '2026-08-31T06:55:00.000Z' };
  const now = new Date('2026-08-31T07:00:00.000Z');
  assert(sameReset(duplicate, canonicalReset(siteReset)), '같은 원문의 지연 중복을 제거해야 한다');
  assert(analyze([duplicate, hint], status, [siteReset], now, monitor).verdict === '강한 조짐 있음', '지연 중복이 새 힌트를 가리면 안 된다');
  assert(analyze([plan], status, [siteReset], now, monitor).verdict === '초기화 예정이 확인됨', '명시적 일정을 잡아야 한다');
  const conflictingStatus = structuredClone(status);
  conflictingStatus.data.latest_reset = {
    ...siteReset,
    id: 'status-duplicate',
    announced_at: '2026-08-31T02:34:00.000Z',
    source: { ...siteReset.source, url: 'https://x.com/status-duplicate' },
  };
  assert(
    analyze([], conflictingStatus, [siteReset], now, monitor).latestCompleted.source_url === 'https://x.com/reset-1',
    '상태 API가 충돌해도 이력 API의 완료 기준선을 바꾸면 안 된다',
  );
  assert(analyze([], status, [], now, monitor).latestCompleted === null, '이력이 비었을 때 상태 API를 완료 기준선으로 쓰면 안 된다');

  const watchStatus = {
    data: {
      latest_reset: siteReset,
      active_watch: {
        level: 'strong', reset_chance_percent: 82, forecast_window: 'within 24h',
        observed_at: '2026-08-31T05:00:00.000Z', expires_at: '2026-09-01T05:00:00.000Z',
        text: 'Hold on to your Codex',
        source: { type: 'x_post', author: 'thsottiaux', url: 'https://x.com/watch' },
      },
    },
    meta: { generated_at: '2026-08-31T06:55:00.000Z' },
  };
  const watchResult = analyze([], watchStatus, [siteReset], now, monitor);
  assert(watchResult.verdict === '강한 조짐 있음', '유효한 strong active_watch를 반영해야 한다');
  assert(watchResult.primary.trackerChancePercent === 82, 'tracker 예측값을 별도 보존해야 한다');
  assert(toCompact(watchResult).includes('제3자 예측'), 'compact tracker 출력에 제3자 예측을 표시해야 한다');
  assert(analyze([plan], watchStatus, [siteReset], now, monitor).primary.kind === 'planned_hard', 'Tibo 명시 예고가 tracker watch보다 우선해야 한다');
  const elevatedWatchStatus = structuredClone(watchStatus);
  elevatedWatchStatus.data.active_watch.level = 'elevated';
  assert(analyze([], elevatedWatchStatus, [siteReset], now, monitor).verdict === '관찰 신호 있음', 'elevated watch를 강한 조짐과 구분해야 한다');
  for (const level of ['none', 'low', 'unknown', undefined]) {
    const unknownWatchStatus = structuredClone(watchStatus);
    unknownWatchStatus.data.active_watch.level = level;
    assert(analyze([], unknownWatchStatus, [siteReset], now, monitor).verdict === '새 조짐 없음', `알 수 없는 watch 등급을 무시해야 한다: ${level}`);
  }
  const expiredWatchStatus = structuredClone(watchStatus);
  expiredWatchStatus.data.active_watch.expires_at = '2026-08-31T06:00:00.000Z';
  assert(analyze([], expiredWatchStatus, [siteReset], now, monitor).verdict === '새 조짐 없음', '만료된 watch를 쓰면 안 된다');

  const context = {
    ...base, published_at: '2026-08-31T05:00:00.000Z', source_url: 'https://x.com/context',
    source_text: 'We are investigating an issue where Codex usage drains faster than expected.',
  };
  const contextResult = analyze([context], status, [siteReset], now, monitor);
  assert(contextResult.verdict === '새 조짐 없음', '장애·조사만으로 경보를 올리면 안 된다');
  assert(contextResult.contextSignals.length === 1, '장애·조사는 참고 신호로 남겨야 한다');
  assert(resetTypeFromText("We have added a banked reset to everyone's account", 'regular') === 'banked', 'banked 지급 본문을 보정해야 한다');
  const futureBanked = {
    ...base,
    published_at: '2026-08-31T05:30:00.000Z',
    source_text: 'During the day we will credit every Codex user with a BANKED reset that you can use at your own schedule.',
  };
  assert(classify(futureBanked).kind === 'planned_banked', '미래형 banked 지급 문구를 명시 예고로 잡아야 한다');
  assert(resetTypeFromText('This is a hard reset because users stacked three banked resets', 'regular') === 'regular', 'hard reset의 banked 비교 설명을 오분류하면 안 된다');
  assert(resetTypeFromText('You get a full reset and one into the reset bank', 'regular') === 'regular', '복합 지급의 주 reset을 banked로 바꾸면 안 된다');
  assertThrows(() => requireUrl('not a url', '테스트'), '잘못된 URL을 거부해야 한다');
  assertThrows(() => requireUrl('', '테스트'), '빈 URL을 거부해야 한다');
  assertThrows(() => requireTimestamp('not-a-time', '테스트'), '잘못된 최신성 시각을 거부해야 한다');
  let emptyHistoryFailed = false;
  try {
    await fetchResetHistory(async () => ({
      ok: true,
      json: async () => ({ data: [], pagination: { has_more: false, next_cursor: null } }),
    }));
  } catch {
    emptyHistoryFailed = true;
  }
  assert(emptyHistoryFailed, '빈 이력 API 응답은 명시적으로 실패해야 한다');
  console.log('PASS — Codex 초기화 조짐 판정 self-test');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return runSelfTest();
  const [events, monitorStatus, resetStatus, resetHistory] = await Promise.all([
    fetchAllEvents(), fetchMonitorStatus(), fetchResetStatus(), fetchResetHistory(),
  ]);
  const result = analyze(events, resetStatus, resetHistory, new Date(), monitorStatus);
  const changed = args.state ? await updateState(args.state, result) : true;
  const output = args.json
    ? JSON.stringify({ ...result, changed }, null, 2)
    : args.compact ? toCompact(result, changed) : toMarkdown(result);
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
