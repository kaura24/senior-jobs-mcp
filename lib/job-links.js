'use strict';

function detailLink(jobId) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId)) throw new Error('Unsupported source job ID for the cached detail tool.');
  const source = require('./job-context').datasetContext().snapshot.metadata.sourceLinksById?.[jobId];
  if (source && jobId === `SR_${source.projectType}_${source.sourceJobId}_${source.institutionId}`) {
    const params = new URLSearchParams({ jobId: source.sourceJobId, projType: source.projectType, instnId: source.institutionId });
    const url = `https://www.seniorro.or.kr/noin/jobDetail.do?${params}`;
    if (source.url === url) return { label: '공식 공고', url, jobId, sourceUrlState: 'observed_official_public_source',
      targetKind: 'official_source_posting', clientAction: 'open_source_url',
      tool: { name: 'get_job_details', arguments: { id: jobId } } };
  }
  return { label: '저장 상세 조회', url: null, jobId,
    sourceUrlState: 'not_available_in_stored_evidence',
    targetKind: 'cached_detail_tool_fallback',
    clientAction: 'call_tool_if_available_otherwise_disclose_not_queried',
    tool: { name: 'get_job_details', arguments: { id: jobId } } };
}

module.exports = { detailLink };

