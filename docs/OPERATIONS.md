# 운영

## 현재 배포

- Vercel 프로젝트: `senior-jobs-poc-mcp`
- 팀: `kaura24-7661s-projects`
- 공개 MCP: `https://senior-jobs-poc-mcp.vercel.app/api/mcp`
- 검증한 Production 배포: `dpl_AhLhW2zPLWBmnRM2UonGNWGKMCaf`
- 버전: 1.3.0

이 소스는 확인된 Production payload의 28개 파일과 바이트 단위로 일치합니다. 테스트·Git 문서를 추가했으며 런타임·데이터·인증·Cron 설정을 변경하지 않았습니다.

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

`vercel.json`은 기존 빌드·설치·함수 시간 제한·Queue trigger·Cron을 유지합니다. 빌드는 구성 확인과 정적 landing 출력만 수행하고 원천 수집을 실행하지 않습니다. 검토한 운영 소스 외의 변경을 자동 배포하지 않습니다.

## 갱신 상태 판독

HTTP trigger 수락만으로 갱신 성공을 주장하지 않습니다. 기존 ID의 target/confirmed/unverified 수와 게시시각, 탐색 cursor·누락 가능 구간·중단 사유를 따로 확인합니다. 반복 응답이나 접근 실패로 누락된 ID를 마감으로 판정하지 않습니다. 마지막 전체 성공이 없더라도 기존 ID 범위의 성공은 별도로 설명합니다.

원천 로그에는 요청별 HTTP/API 결과 코드·소요시간·진행 건수만 남기며 서비스 키나 원문 요청 URL은 기록하지 않습니다. 조회 응답은 partial coverage와 상세 미수집 범위를 표시합니다.
