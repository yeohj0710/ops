# 릴스 기획안 CLI

Node 22 이상 내장 모듈만 사용한다. 설치, 네트워크 호출, 유료 모델 호출, 노션 실행기가 없다.
현재 호스트 에이전트가 실제 대본을 쓰고 독립 검토를 받는다. 노션 실행은 기존 인증 커넥터가 맡는다.
명령은 `node pipeline.mjs --help`, 완전한 가상 JSON 예제는 `node schema.mjs`로 확인한다.

## 경로와 준비

설정, 원본 스냅샷, 대본, 실행 기록은 공개 저장소 밖에 둔다. 드라이브 복사본은 매뉴얼 코드
폴더 밖에 실행 폴더를 둔다. `.git`이 없는 드라이브 전체를 저장소로 취급하지 않는다.
설정의 상대경로는 설정 파일이 있는 폴더 기준이다. 원본 DB는 읽기만 한다.

```text
node pipeline.mjs prepare --config <설정.json> --run-dir <실행폴더>
node pipeline.mjs prepare --config <설정.json> --run-dir <실행폴더> --dry-run
```

`config` 필수값은 `account`, 고정 날짜 `asOf`, `sources.public`, `sources.private`,
`sources.beatsCsv`, `benchmarks`다. 계정이 여러 개면 `accounts`를 추가한다.
Jev 공개 자료는 `{rows:[...]}`, 비공개 자료는 `{rows:[...],sources:{shortcode:{story}}}`다.
실제 비트는 `beats.csv`의 `shortcode,번호,시작초,끝초,기능,할말,화면자막,화면`을 사용한다.
공통 형식 X번호의 슬롯으로 대체하지 않는다. CSV 파서는 따옴표와 여러 줄 대사를 보존한다.

기본 선정 기준은 조회수 50만, 달력 기준 최근 3개월, 내용과 형식 점수 각각 0.7이다.
`selection.maxAgeDays`가 있으면 일수 기준을 명시적으로 사용한다. 미래 게시일, 광고 여부
미확인, 잘린 대사, 실제 비트 누락은 후보 제외 이유로 남는다. 조회수 측정일은 갱신하지 않는다.

조합 점수는 슬롯 수 일치 45%, 길이 비율 20%, 내용 점수 15%, 형식 점수 15%, 같은 주제
5%를 더하고 제목 중복도를 최대 10% 뺀다. 내용 슬롯 수는 사실 카드 수, 내용 비트 수,
대사 두 줄당 한 슬롯 중 최댓값이다. 이는 검토 순서용 휴리스틱이며 의미 품질 점수가 아니다.
같은 ID, 같은 URL, 대사 2글자 묶음의 Jaccard 유사도 0.8 이상인 두 원본은 조합하지 않는다.
출력 묶음에는 같은 내용 원본이나 사실상 같은 대사를 중복 선정하지 않는다.

직접 확인한 조합은 `selection.pairs:[{content,format,account,reason,reviewedBy,reviewedAt}]`로
지정한다. 기계 선정 기준 밖이면 `eligibilityException`에 확인 범위와 예외 이유가 필요하다.
예외를 써도 동일 원본, 중복 대사, 없는 대사와 비트는 통과하지 않는다.

## 게시 완료 기준과 원본 보정

기준 파일은 `{benchmarks:[...]}`다. 항목은 `id,account,title,notionUrl,publishedUrl,
status:"published",accepted:true,screenplay,criteria:[{id,label,evidence}]`를 가진다.
실제 노션 스냅샷 형식도 지원한다: `page,url,status:"업로드 완료",verifiedAt,statusEvidence,
videoViewed,content,standards`와 파일 상위의 `criteria:["hook",...]`.
이때 기획안과 업로드 상태를 확인한 사실만 보존한다. `videoViewed:false`를 영상 확인으로 바꾸지 않는다.
원본 첨부를 읽지 못했다면 스냅샷에 그 한계를 남긴다.

외부 원본은 `{version:1,references:[...]}` JSON을 `externalReferences`에 등록한다.
`node pipeline.mjs ingest --config <설정> --run-dir <폴더> --file <원본JSON>`은 검증 후
등록할 파일 경로와 해시만 저장한다. 설정은 자동 수정하지 않는다.

새 원본 필수 필드는 `id,url,title,topic,posted,measured,views,ad,contentScore,formatScore,
lines:[{id,at,text}],beats:[{id,start,end,role,dialogue,caption,visual}],provenance`다.
`provenance`에는 `sourceUrl,reviewedBy,reviewedAt`와 아래 두 객체가 필요하다.

```json
{
  "transcript": {"verified": true, "method": "실제 확인한 방법", "artifact": "원본 파일 경로", "sha256": "실제 파일 해시"},
  "visual": {"verified": true, "method": "실제 화면 확인 방법", "artifact": "원본 파일 경로", "sha256": "실제 파일 해시"}
}
```

연속 재생 대신 프레임만 봤다면 그렇게 기록한다. 검증은 증거 파일의 존재와 해시 일치를
검사하며 관찰 자체의 진실성을 증명하지 않는다. 수정은 별도 `referenceOverlays` 파일에
같은 원본 ID와 보정 필드, 위 출처를 적는다. 대사를 바꾸면 `transcriptCorrectionReason`도
필요하다. 비트는 배열 전체를 넣는다. 원본과 보정 전 비트를 패킷에 함께 보존한다.

## 대본과 검토

```text
node pipeline.mjs lint --config <설정> --run-dir <폴더> --plan <대본.json>
node pipeline.mjs review-hash --plan <대본.json> --packet <패킷.json>
node pipeline.mjs render --config <설정> --run-dir <폴더> --plan <대본.json>
```

`prepare`는 `packets/<packetId>.json`, 빈 `plans/<packetId>.json`, `prepared.json`,
`source-ledger.jsonl`, `ledger.json`, `config.snapshot.json`을 만든다. 기존 `plans` 파일은 덮어쓰지 않는다.
회차 설정은 `config.snapshot.json`에 경로까지 보존한다. 이후 회차에서 공용 설정을 바꿔도
이전 회차 검사는 해당 스냅샷을 `--config`로 사용한다.
실제 대본은 `schema.mjs` 예제대로 작성한다. 모든 장면에 내용 ID와 형식 비트 ID를 연결한다.
장면 수를 고정하지 않는다. 기본 길이는 5~180초, 말속도 상한은 공백 제외 초당 9자다.
숫자 읽기와 숨 쉴 시간은 독립 검토자가 추가 확인한다. 문자 수 통과가 낭독 검증은 아니다.

`claims`는 외부 근거와 장면에 양방향으로 연결한다. 확인하지 못한 용량이나 순위는
`excluded-pending-verification`으로 제외하고 `verificationNeeded`에 할 일을 적는다.
이를 발화 장면에 연결하면 실패한다. 코드로 의미상 같은 재서술까지 검출할 수는 없다.
모든 원본 비트에 `formatComparison`을 적고 실제 유지·변경·생략 이유를 구분한다.

생성 문구에는 `·`, `—`를 금지한다. `brandNames` 사전에 있는 브랜드는 대사·자막·동작에서
금지한다. 원본 메타데이터의 브랜드는 보존한다. 누락된 브랜드는 독립 검토의 `brandFree`에서
찾는다. 브랜드 사전만으로 모든 브랜드가 검출됐다고 판단하지 않는다.

검토자는 작성자와 다른 실제 세션이어야 한다. `editorialReview`에 작성·검토 세션 ID,
검토일, `reviewedPlanHash`, `reviewedPacketHash`, 기준별 원문 근거와 해당 장면 근거를 기록한다.
`review-hash --packet`으로 받은 패킷 해시에는 원본과 게시 기준 스냅샷도 포함된다.
필수 항목은 `hook,formatFidelity,spokenKorean,shootability,factualGrounding,brandFree`다.
기준 스냅샷에 추가 항목이 있으면 함께 검토한다. 실제 검토하지 않은 `pass`를 복사하지 않는다.
미통과 검토는 `decision:"needs-revision"`, 해당 항목은 `verdict:"revise"`로 남긴다.
대본을 고치면 이전 검토 해시는 무효다. 의미 품질을 기계가 입증했다는 출력은 하지 않는다.

## 노션 요청과 조회 증거

노션 설정은 실제 조회한 `dataSourceId`, `schema`, `titleProperty`, `statusProperty`를 쓴다.
스키마는 `{properties:{속성이름:{type,options?}}}` 또는 속성 객체 자체다.
`identityProperty`는 text/rich_text 속성, `accountProperty`는 선택 사항이다.
추가 고정 속성은 `extraProperties`에 지정한다. 지원 속성은 title, text, rich_text, select,
status, url, number, checkbox, multi_select, relation이다. 없는 속성이나 선택지는 거부한다.
상태는 항상 `작성 완료(검토 대기)`다. 식별자 속성이 없으면 제목 끝에 `[rp-...]`를 붙인다.

`render`는 `drafts/<packetId>/`에 2열 촬영표 `기획안.md`, 대본, 검사 보고서,
`notion-requests.json`, `notion-dedupe-request.json`을 만든다. 요청은 `{tool,arguments}`다.
현재 호스트의 인증된 커넥터로 `tool`과 `arguments`를 그대로 실행한다. 별도 키나 가짜 실행기는 없다.

```text
node pipeline.mjs publish --config <설정> --run-dir <폴더> --plan <대본> --dedupe <중복조회.json>
node pipeline.mjs receipt --config <설정> --run-dir <폴더> --plan <대본> --evidence <페이지조회.json>
node pipeline.mjs check --config <설정> --run-dir <폴더>
```

원본 커넥터 결과는 다음 봉투로 저장한다. `response`를 성공처럼 새로 작성하지 않는다.

```json
{
  "tool": "실제로 호출한 도구 이름",
  "arguments": {"실제로 전달한": "인자"},
  "fetchedAt": "실제 조회 ISO 시각",
  "response": {"원본 도구 응답": "전체 객체"}
}
```

15분 이내의 정확한 중복 조회가 빈 배열이면 `publish`가 `notion-create-request.json`을 만든다.
스크립트는 게시하지 않는다. 커넥터 생성 후 `mcp__codex_apps__notion_fetch`로 페이지를
다시 읽는다. `receipt`가 ID, 데이터 소스 부모, 모든 요청 속성, 본문 식별자와 전체 내용을
대조한 뒤에만 원장을 `complete`로 바꾼다. 기존 중복 페이지도 동일한 재조회 검증으로 복구할 수 있다.
본문 비교는 빈 줄과 Notion 표의 줄바꿈·열 너비 직렬화만 정규화한다. 단어·셀·순서는 보존한다.
잘림, 알 수 없는 블록, 잘못된 상태, 빠진 본문은 완료로 처리하지 않는다.

`check`는 보존한 원본 조회 증거를 다시 검증한다. 노션의 이후 변경을 온라인으로 재조회하지 않는다.
로컬 JSON은 암호학적으로 인증된 영수증이 아니다. 신뢰 경계는 실제 인증 커넥터 응답을
변형 없이 저장하는 호스트 에이전트다. 최신 상태가 필요하면 다시 fetch하고 receipt를 실행한다.
외부 쓰기는 원자적이지 않다. 두 에이전트가 동시에 같은 식별자를 생성하지 않게 한 작성자가
중복 조회부터 생성·재조회까지 맡는다. 결과가 불명확하면 create를 재실행하지 말고 조회한다.

## 복구와 완료 검사

변경 파일은 실행 폴더의 `etc/backup/`에 원본 내용 해시별로 보존한다. 같은 입력을 다시 쓰면
파일과 시각이 바뀌지 않는다. `--dry-run`은 폴더·잠금·원장도 쓰지 않는다.
원장은 항목마다 준비, 검토, 노션 대기, 완료를 기록한다. 대기 중 대본을 바꾸지 않는다.
보정 자료 변경은 `prepare`부터 다시 반영한다. 게시 대기·완료 패킷의 변경은 새 실행이 필요하다.
파일 잠금이 남으면 PID가 실제 종료했는지 확인하고 복구한다. 실행 중 잠금을 지우지 않는다.

`checks.mjs`는 `ops done`이 전달한 task 파일의 `inputs.config`, `inputs.runDir`을 읽는다.
독립 실행은 `node checks.mjs --config <설정> --run-dir <폴더>`다.
모든 선정 패킷의 실제 노션 조회 검증이 완료돼야 통과한다.

```text
node --test manuals/reels-planning/tests/pipeline.test.mjs
```

테스트는 가상 자료를 임시 폴더에 만들고 종료 시 제거한다. 실제 원문, 계정, 자격증명을 쓰지 않는다.
