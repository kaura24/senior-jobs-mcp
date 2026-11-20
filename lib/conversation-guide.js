'use strict';
const { normalize } = require('./regions');
const sampleLimit = 3;
const compactLimit = 6;
const clean = input => String(input ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
const md = input => clean(input).replace(/[\\`*_{}\[\]()<>#!|]/g, '\\$&');
const count = n => Number(n).toLocaleString('ko-KR');
const baseCondition = state => Object.fromEntries(Object.entries(state).filter(([, v]) => v !== null && v !== false));
const links = sample => sample.detailLink?.url
  ? `[공식 공고](${sample.detailLink.url})`
  : '공식 공고 링크 미확인 · 공고 ID로 저장 상세 조회 가능';

function districtChoices(rows, state) {
  if (!state.region || state.anyRegion) return [];
  const supplied = normalize(state.region);
  if (supplied.state !== 'province_only' || !supplied.province ||
      !/^[가-힣]+$/.test(state.region)) return [];
  const grouped = new Map();
  for (const row of rows) {
    const actual = normalize(row.workPlcNm);
    if (actual.province !== supplied.province || !actual.cityDistrict) continue;
    const item = grouped.get(actual.cityDistrict) || { count: 0 };
    item.count++;
    grouped.set(actual.cityDistrict, item);
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([value, item]) => ({
    value, count: item.count,
    searchArguments: { ...baseCondition(state), region: supplied.province + ' ' + value, limit: sampleLimit }
  }));
}

function buildConversationGuide(data, { rows, samples, mode }) {
  const { conditionState: state, nextQuestion, uiGuidance } = data;
  const total = data.candidateCounts.confirmedAfterFilters;
  const shown = samples.slice(0, sampleLimit).map((job, i) => ({
    number: i + 1, id: job.id, title: job.title, region: job.region, organization: job.organization || null,
    applicationFrom: job.applicationFrom, applicationTo: job.applicationTo, applicationMethod: job.applicationMethod || null,
    detailLink: job.detailLink
  }));
  const districts = districtChoices(rows, state);
  const options = (uiGuidance?.options || []).map(({ value, count }) => ({ value, count }));
  let action = data.nextAction;
  let next = nextQuestion ? { key: nextQuestion.key, text: nextQuestion.text } : null;
  if (total && mode === 'search') {
    if (!shown.length) {
      action = 'offer_previous_or_first_page';
      next = { key: 'page', text: '지금 페이지에 표시할 공고가 없어요. 첫 목록을 다시 볼까요?' };
    } else if (!state.region && !state.anyRegion && next?.key === 'region') action = 'present_matches_then_optionally_refine';
    else if (!state.keyword && !state.anyWork && next?.key === 'keyword') {
      action = 'present_matches_then_optionally_refine';
      if (districts.length) next = { key: 'keyword_or_district',
        text: `${md(state.region)} 전체 기준으로 봤어요. 원하는 시·군·구나 일 종류가 있나요? 없으면 전체 공고에서 골라도 돼요.` };
    } else if (districts.length) {
      action = 'present_matches_then_optionally_refine';
      next = { key: 'district_or_selection', text: '아래 공고를 고르거나, 특정 시·군·구로 좁혀 볼까요?' };
    } else next = { key: 'selection', text: '어느 공고가 궁금하세요? 아래 번호나 제목을 골라주세요.' };
  } else if (total && mode === 'describe' && districts.length && next?.key === 'keyword') {
    next = { key: 'keyword_or_district',
      text: `${md(state.region)} 기준으로 봤어요. 원하는 시·군·구나 일 종류가 있나요? 없으면 이 범위 그대로 볼 수 있어요.` };
  }
  const choiceRows = districts.length && ['keyword_or_district', 'district_or_selection'].includes(next?.key) ? districts :
    ['region', 'keyword'].includes(next?.key) ? options : [];
  const hasSelection = shown.length > 0;
  let countText = `저장된 공고 중 조건에 맞는 건 **${count(total)}건**이에요.`;
  if (data.candidateCounts.unknownAfterFilters) countText += ` ${count(data.candidateCounts.unknownAfterFilters)}건은 조건을 확인할 정보가 부족해요.`;
  const lines = [countText];
  if (hasSelection) {
    lines.push(`공고 예시 ${shown.length}건 (추천 순위 아님):`);
    for (const x of shown) {
      const fields = [x.region || '근무지 미기재',
        x.applicationFrom && x.applicationTo ? `${x.applicationFrom}~${x.applicationTo}` : null,
        x.applicationMethod].filter(Boolean).map(md).join(' · ');
      lines.push(`${x.number}. ${md(x.title)} · ${fields} · ${links(x)}${x.detailLink?.url ? '' : ` · ID: ${md(x.id)}`}`);
    }
    lines.push('궁금한 공고의 번호나 제목을 고르면 이 목록의 ID로 저장 상세를 조회할 수 있어요.');
  }
  const includeWork = next?.key === 'keyword_or_district';
  function appendOptions(label, values) {
    const shownOptions = values.slice(0, compactLimit).map(x => md(x.value) + '(' + count(x.count) + '건)').join(', ');
    const overflow = values.length > compactLimit ? ' 외 ' + (values.length - compactLimit) + '개 (전체 선택지는 MCP 응답에 있음)' : '';
    if (values.length) lines.push(label + ': ' + shownOptions + overflow);
  }
  appendOptions(next?.key === 'region' ? '지역 선택지' : next?.key === 'keyword' ? '확인된 직종' : '시·군·구 선택지', choiceRows);
  if (includeWork) {
    appendOptions('확인된 직종', options);
    lines.push('직종 선택지에 없어도 공고 제목에서 찾을 일 이름을 직접 입력할 수 있어요.');
  }
  if (next) lines.push(next.text);
  if (mode === 'search' && shown.length && data.offset + shown.length < total) lines.push('“다음 3건”이라고 하면 같은 조건의 다음 목록을 볼 수 있어요.');
  return { nextAction: action, nextQuestion: next, districtOptions: districts, observedOptions: options,
    optionsDisplay: { included: Math.min(compactLimit, choiceRows.length), total: choiceRows.length,
      workIncluded: includeWork ? Math.min(compactLimit, options.length) : 0,
      workTotal: includeWork ? options.length : 0 },
    examples: shown,
    nextPage: mode === 'search' && shown.length && data.offset + shown.length < total ? { tool: 'search_jobs',
      arguments: { ...baseCondition(state), offset: data.offset + shown.length, limit: sampleLimit } } : null,
    searchExample: { tool: 'search_jobs', arguments: { ...baseCondition(state), limit: sampleLimit } },
    sourceFooter: data.answerNotice.text, displayPolicy: 'offer_helpful_choices_unless_user_explicitly_requests_count_only',
    text: lines.join('\n') };
}

function detailText(data) {
  if (!data.found) return '저장된 목록에 없는 공고 ID예요. 검색 결과의 번호나 제목을 다시 골라주세요.';
  const job = data.job;
  const detail = data.cachedDetailSummary ? '저장된 상세 요약이 있어요. 전체 원문을 조회한 것은 아니에요.' :
    '저장된 상세 요약이 없어요. 급여·근무시간·지원조건은 원문에서 확인이 필요해요.';
  return `${md(job.title)} · ${md(job.region || '근무지 미기재')} · ${links(job)}\n${detail}`;
}
module.exports = { buildConversationGuide, detailText };
