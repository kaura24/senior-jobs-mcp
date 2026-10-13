# 하나의 프로젝트와 Git 이력

기본 조회와 자동갱신을 한 저장소에서 관리하며 최신 작업 트리는 하나만 둡니다.

| Git 기준 | 원래 소스 | 보존 범위 |
| --- | --- | --- |
| `basic-mcp-v1.1.1` | `deployments/public-static-poc-mcp-20261012` | 기본 MCP의 실제 소스·19개 테스트 |
| `main` / `production-mcp-20261013` | `deployments/blob-refresh-mcp-20261012` | 검증된 운영 MCP 1.3.0·125개 테스트·운영 문서 |

기본 소스는 첫 커밋에 그대로 보존하고 자동갱신·Private Blob·Queue·클라이언트 조사 안내를 같은 파일 경로의 다음 커밋으로 이어갑니다. 중복 배포 디렉터리와 다른 프로젝트의 이력은 가져오지 않습니다. 기존 외부 저장소를 삭제하거나 기존 이력을 덮어쓰지 않았습니다.

과거 기본 버전을 검토할 때는 현재 작업을 덮어쓰는 checkout 대신 `git show basic-mcp-v1.1.1:lib/protocol.js` 또는 별도 임시 worktree를 사용하세요. 기본 태그를 현재 운영 배포로 착각하지 않습니다.
