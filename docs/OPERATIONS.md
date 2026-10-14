# 운영

## 중지 배포 검증

- 런타임 커밋: `bff9f7dd74df316b714154fd68c9cfd83aabcfa2`
- Production 배포: `dpl_85TVqcKd7pBjbHzVKBp7xX7Bgng5`, READY
- 배포 URL: `https://senior-jobs-poc-eruopfe5u-kaura24-7661s-projects.vercel.app`
- 운영 alias: `https://senior-jobs-poc-mcp.vercel.app/api/mcp`, 위 배포로 전환 확인
- Production 소스 29개 파일은 검증한 런타임 커밋의 SHA-1과 모두 일치합니다. `crons: []` 및 기존 Private Queue trigger를 확인했습니다.
- Node 24.21.0: 테스트 132개 통과. 인증된 중지 GET·POST, 저장소/원천 생성 전 청크 반환, Queue 콜백 정상 반환, enqueue·재시도 승인, 관찰시각 보존을 가짜 의존성으로 검증했습니다. 실제 인증된 갱신 호출이나 새 운영 큐 메시지는 보내지 않았습니다.
- 추가 offline 검증: 실제 `@vercel/queue` 0.8.0 SDK와 운영 worker 코드를 사용하고 네트워크를 실패하도록 막은 상태에서 오늘·지난 날짜·잘못된 날짜 메시지 3개가 HTTP 200으로 끝나고 SDK가 각각 승인했습니다. 네트워크 호출은 0회입니다.
- 2026-10-14 10:59:47 UTC 운영 검증: initialize·tools/list·조회 3개 도구 HTTP 200, Private Blob 공고 318건, `paused_by_request`, `schedulerEnabled: false`.
- 배포 전후 관찰시각 `2026-10-13T23:16:51.646Z`, 기존 기준일 `2026-10-14` KST, 공고 수·샘플 digest·원천 호출 누적수·마지막 시도/성공은 모두 동일합니다. 기준일은 이번 중지 작업에서 갱신하지 않았습니다.
- 인증 없는 `/api/refresh`는 이전과 동일하게 HTTP 401입니다. 비밀 값·인증·보호 설정·데이터를 변경하지 않았습니다.
- 10:05–11:00 UTC 대상 프로젝트 갱신 로그와 이전 운영 배포 로그에 기록이 없고 최근 30분 runtime error가 없습니다. 이는 큐 빈 상태의 증거가 아닙니다. 조회된 최신 체크포인트는 중지 전 `completed_with_discovery_gaps`, phase `done`이지만 이전 배포의 큐 잔여 메시지·실행 전체는 미확인입니다.
- 큐 지표 확인은 Observability schema API 404 및 Vercel CLI의 대상 팀 접근 권한 오류로 막혔습니다. 이전 배포를 삭제하거나 프로젝트 전체를 pause하지 않았습니다.

## 중지 전 운영 기준선

- Vercel 프로젝트: `senior-jobs-poc-mcp`
- 팀: `kaura24-7661s-projects`
- 공개 MCP: `https://senior-jobs-poc-mcp.vercel.app/api/mcp`
- 검증한 Production 배포: `dpl_AhLhW2zPLWBmnRM2UonGNWGKMCaf`
- 버전: 1.3.0

중지 변경의 기준 커밋은 `ebd788a1b3fb16844119b8d6b9dc6b2a0299478f`입니다. 그 커밋의 런타임·구성·데이터 28개 파일은 위 Production 소스의 SHA-1과 모두 일치합니다.

## 사용자 요청으로 갱신 중지

`lib/refresh-policy.js`의 `isRefreshPaused()`가 고정된 중지 상태를 반환합니다. `vercel.json`의 cron은 빈 배열입니다. 인증된 GET·POST 갱신 요청, 청크 실행, 직접 enqueue·후속 발행, 재시도는 중지 상태를 확인합니다. 중지된 청크는 Blob 저장소와 원천 클라이언트를 만들기 전에 정상 반환하며, 큐 소비자는 그대로 유지해 메시지를 승인합니다. 재시도는 `{ acknowledge: true }`로 종료합니다. 자동 재개 시각이나 환경변수에 의한 재개는 없습니다.

MCP 조회는 기존 저장 snapshot을 읽습니다. 조회 응답에는 `paused_by_request`와 `schedulerEnabled: false`를 표시하고 이전 체크포인트 상태는 `refreshObservedState`로 보존합니다. 데이터·관찰 기준일·마지막 시도/성공·원천 관찰 시각은 수정하지 않습니다. 테스트는 가짜 저장소·원천·큐만 사용하며 수집을 실행하지 않습니다.

재개는 별도 사용자 요청 후 정책 코드와 cron을 명시적으로 변경하여 다시 배포해야 합니다. 중지 전 배포로 롤백하면 갱신이 다시 가능해지므로 중지 유지 목적의 롤백으로 사용하지 않습니다.

Vercel의 기존 큐 메시지는 발행한 배포에 묶입니다. 새 배포는 예전 배포의 작업을 변경하지 않습니다. 로그가 없거나 3600초 보관 시간이 지났다는 이유만으로 큐가 비었다고 판단하지 않습니다. 특히 예전 청크가 새 후속 메시지를 발행할 수 있습니다. 예전 배포의 큐 잔여 실행은 배포별 로그와 큐 지표를 별도로 확인해야 합니다. 공식 문서에서 제시한 즉시 중지는 해당 예전 배포 삭제이며, 원본 데이터 보존·최소 가역 변경 범위와 구분해 다룹니다: https://vercel.com/docs/queues/concepts#stopping-deliveries-to-a-deployment

## 서버 구성

| 이름 | 용도 | 보관 위치 |
| --- | --- | --- |
| `DATA_GO_KR_SERVICE_KEY` | 공식 원천 갱신 요청 | 기존 Production Secret |
| `CRON_SECRET` | 갱신 호출 인증 | 기존 Production Secret |
| `BLOB_STORE_ID` | 기존 Private Blob 저장소 식별 | 기존 Production 구성 |
| Vercel OIDC | Blob 및 Queue 접근 | 서버가 자동 제공하는 단기 자격 |

값을 로컬로 내려받거나 문서·로그·URL에 기록하지 않습니다. 장기 Blob RW 토큰이나 추가 AI·크롤링 키는 필요하지 않습니다.

## 배포와 Git

현재 Vercel 프로젝트는 Git 저장소와 연결되어 있지 않습니다. 이 저장소를 만들거나 푸시하는 작업은 기존 Vercel 연결·경로를 바꾸지 않습니다. GitHub Actions나 배포 webhook도 추가하지 않았습니다. 향후 Git 연결을 별도 승인하여 추가하면 배포 브랜치와 Production 환경을 다시 확인해야 합니다.

`vercel.json`은 기존 빌드·설치·함수 시간 제한·Queue trigger를 유지하고 Cron만 제거했습니다. 빌드는 구성 확인과 정적 landing 출력만 수행하고 원천 수집을 실행하지 않습니다. 검토한 운영 소스 외의 변경을 자동 배포하지 않습니다.

## 갱신 상태 판독

HTTP trigger 수락만으로 갱신 성공을 주장하지 않습니다. 기존 ID의 target/confirmed/unverified 수와 게시시각, 탐색 cursor·누락 가능 구간·중단 사유를 따로 확인합니다. 반복 응답이나 접근 실패로 누락된 ID를 마감으로 판정하지 않습니다. 마지막 전체 성공이 없더라도 기존 ID 범위의 성공은 별도로 설명합니다.

원천 로그에는 요청별 HTTP/API 결과 코드·소요시간·진행 건수만 남기며 서비스 키나 원문 요청 URL은 기록하지 않습니다. 조회 응답은 partial coverage와 상세 미수집 범위를 표시합니다.
