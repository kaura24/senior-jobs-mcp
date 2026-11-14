# 운영

## 대상과 현재 상태

- Vercel 프로젝트: `senior-jobs-poc-mcp`
- 팀: `kaura24-7661s-projects`
- 공개 MCP: `https://senior-jobs-poc-mcp.vercel.app/api/mcp`
- 기존 Production 배포: `dpl_CPbMsATdbfnBNFaMe58DAz782gKD`
- 버전: 1.3.0

이 브랜치의 D1 전용 변경은 아직 운영에 배포하지 않았습니다. 전용 D1 `senior-jobs-mcp`에 공식 공개 원천의 실제 공고 718건을 적재하고 재조회했습니다. Vercel 운영 환경에는 D1 인증 연결이 없으므로 기존 권한 범위에서 배포를 완료할 수 없습니다.

## 수집·갱신 경로

Cron `/api/refresh`는 `0 21 * * *` UTC (06:00 KST)이며 기존 `CRON_SECRET`으로 인증합니다. Queue topic `senior-jobs-refresh`와 기존 worker를 유지합니다. `refresh/task.js`는 공식 공개 원천을 사용하는 `refresh/public-daily.js`만 실행합니다. 최초 작업은 지역 목록을 저장하고, 후속 작업은 한 페이지씩 검증·적재합니다. 접수중 상태와 KST 신청기간 및 사업연도를 검사합니다.

공고 ID·원본 근거·진행 위치를 전용 D1에 보존합니다. 게시와 페이지 cursor는 동일 SQL 변경으로 저장하고 revision과 lease로 중복 실행을 제어합니다. 원천 실패와 반복 페이지는 cursor를 진행시키지 않으며 오류 상태를 보존합니다. 일시 오류는 기존 큐 정책으로 최대 5회 시도합니다. 다음 작업은 저장된 위치에서 재개합니다.

기존 행을 삭제하지 않고 이번 실행에서 확인된 ID만 검색 범위에 넣습니다. 미관찰·마감 공고의 이전 자료는 남기되 검색에서 제외합니다. MCP 조회는 D1만 직접 사용하며 D1 오류·빈 저장소·구성 누락 시 명시적인 오류를 반환합니다. Blob 및 번들 샘플 대체 조회는 없습니다. Blob 재접근·복구·이관은 최종 사용자 정정으로 작업 대상에서 제외됐습니다.

기존에 발행된 큐 메시지는 원래 배포에 묶입니다. 새 코드로 전환하더라도 예전 배포의 실행까지 바뀌었다고 주장할 수 없습니다. 향후 운영 전환 시 예전 배포의 큐 전달과 후속 발행이 종료됐는지 배포별 로그·큐 상태를 확인해야 합니다. 이번 작업에서 예전 배포나 데이터를 삭제하지 않았습니다.

## 서버 구성

| 이름 | 용도 | 보관 위치 |
| --- | --- | --- |
| `CRON_SECRET` | 갱신 호출 인증 | 기존 Production Secret |
| `CLOUDFLARE_ACCOUNT_ID` | 지정된 프로젝트 계정 검증 | 현재 운영에 없음 |
| `D1_DATABASE_ID` | 지정된 전용 D1 검증 | 현재 운영에 없음 |
| `CLOUDFLARE_D1_API_TOKEN` | 서버 D1 읽기·쓰기 | 현재 운영에 없음 |
| Vercel OIDC | 기존 Queue 접근 | 서버가 자동 제공하는 단기 자격 |

공식 공개 원천에는 API 키가 필요하지 않습니다. 기존 source secret과 Blob 구성은 이 브랜치에서 사용하지 않습니다. 비밀 값을 문서·로그·URL에 기록하지 않으며, 로컬 Wrangler OAuth를 Vercel로 복사하지 않습니다. 새 자격증명·권한 확대·유료 전환은 승인되지 않았습니다.

## 배포와 Git

Vercel 프로젝트는 Git 저장소와 연결되어 있지 않습니다. 기능 브랜치 푸시는 운영 배포가 아닙니다. GitHub main 반영은 사전 사용자 승인이 필요합니다. GitHub Actions나 배포 webhook을 추가하지 않았습니다.

빌드는 전용 D1 구성·접근과 공식 원천의 공개 응답을 검사한 후 정적 landing을 만듭니다. D1 인증이 없으면 빌드를 실패시킵니다. 운영 전환 전 격리 테스트, 공식 원본 재생, 운영 D1 재조회가 필요합니다. 자세한 명령은 [D1-MIGRATION.md](D1-MIGRATION.md)를 참고하세요.

## 갱신 상태 판독

HTTP trigger 수락만으로 갱신 성공을 주장하지 않습니다. 저장된 `runPlan`의 지역 cursor·페이지·원천 호출 수·신규/변경/동일/실패 건수와 완료된 `public_ingestion_runs`를 확인합니다. 원천 미관찰을 마감으로 단정하지 않습니다. 공개 지역 목록과 A/C/B/E 유형의 관찰 범위는 전국 모든 일자리 원천의 완전한 수집을 뜻하지 않습니다.

조회 응답에는 원천 관찰 시각·갱신 범위·상세 미수집 상태를 표시합니다. 현재 완료된 것은 실제 D1 적재와 로컬/격리 MCP 검증이며, 운영 배포와 운영 자동갱신은 미완료입니다.

## 과거 운영 이력

아래는 D1 전용 전환 이전의 기록이며 이 브랜치의 현재 코드 설명이 아닙니다.

## 2026-11-13 전국 일일 갱신 재개

사용자 요청으로 전국 공고 자동 갱신을 재개했습니다. `lib/refresh-policy.js`는 활성 상태이며 `vercel.json`은 매일 21:00 UTC(다음 날 06:00 KST)에 `/api/refresh`를 호출합니다. Vercel Cron 화면에서 Active 상태를 확인했습니다. 2026-11-13 23:17 KST에 Run으로 즉시 갱신을 실행했고 Queue worker와 Blob 체크포인트에서 진행을 확인했습니다.

현재 한국 날짜가 접수 시작일과 종료일 사이이고 원천 `deadline`이 `접수중`인 공고만 저장·조회합니다. 기간 누락·형식 오류·마감·접수 전 공고는 제외합니다. 전국 목록은 과거 공고도 포함하므로 탐색한 원천 건수와 현재 유효 공고 수를 구분합니다. 원천이 보고한 목록 수는 실측 시 762,240건이며 전체 수집 완료를 뜻하지 않습니다. 반복 페이지와 미확인 ID는 기존 검증 정책에 따라 누락 범위로 표시합니다.

배포 빌드는 기존 서버 구성/Blob 접근 확인에 이어 실제 원천의 1·2페이지를 요청해 응답과 서로 다른 ID 집합을 검사합니다. 원천 실패 시 빌드가 실패합니다. 8초 제한으로는 타임아웃이 발생했으나 30초 제한에서 두 페이지 각각 1,000건, HTTP 200/API 00을 확인했습니다. 비밀 값은 서버에 유지하며 출력하지 않습니다. 운영 배포: `dpl_CPbMsATdbfnBNFaMe58DAz782gKD` (READY). 재개 관련 테스트 128개 통과(Node 26 로컬); 운영 빌드/런타임 Node 24입니다.

아래 중지 관련 내용은 2026-10-14의 이력이며 현재 설정이 아닙니다.


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

