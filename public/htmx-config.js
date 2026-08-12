// htmx는 기본값으로 4xx 응답을 갈아끼우지 않는다. 이 앱은 폼 검증 실패를 422 + 폼 조각으로
// 돌려주므로, 422만 swap 대상으로 열지 않으면 오류 문구가 화면에 아예 뜨지 않고 버튼이
// 먹통으로 보인다. 나머지 4xx/5xx는 기본대로 둔다.
//
// CSP가 script-src 'self'라 인라인 <script>로는 못 넣는다(실측: "Executing inline script
// violates ... Content Security Policy"). /static에서 받는 파일이어야 실행된다.
// htmx.min.js와 같이 defer로 실려 그 다음에 실행되고, htmx는 이 값을 요청 시점에 읽는다.
htmx.config.responseHandling = [
  { code: '204', swap: false },
  { code: '422', swap: true },
  { code: '[23]..', swap: true },
  { code: '[45]..', swap: false, error: true },
]
