// pm2 설정. package.json이 "type": "module"이라 pm2가 require로 읽을 수 있게 .cjs 로 둔다.
//
//   pnpm build && pm2 start ecosystem.config.cjs
//
const path = require('node:path')

module.exports = {
  apps: [
    {
      name: 'mega-sso-portal',
      namespace: 'sso',
      script: 'dist/server.js',
      // load-env.ts가 cwd 기준 상대경로로 .env를 읽고, server.ts는 dist/../src 에서
      // .eta 템플릿을 읽는다. 어디서 pm2를 실행하든 프로젝트 루트로 고정한다.
      cwd: __dirname,

      // fork 1개. cluster로 늘리면 인스턴스마다 세션 정리 타이머(1시간 주기)가 따로 돌고,
      // ESM + pm2 cluster 조합도 안정적이지 않다. 수평 확장이 필요해지면 그때 검토한다.
      exec_mode: 'fork',
      instances: 1,

      // 운영 로그는 pino의 JSON 그대로 남긴다(pino-pretty는 devDependency다).
      env: {
        NODE_ENV: 'production',
      },

      // .env 값은 load-env가 직접 읽으므로 여기에 secret을 넣지 않는다.

      autorestart: true,
      max_restarts: 10,
      // 기동 직후 죽고 다시 뜨는 무한 루프를 막는다. env 검증 실패는 즉시 exit(1)이다.
      min_uptime: '10s',
      restart_delay: 3000,
      max_memory_restart: '512M',

      // SIGINT/SIGTERM 핸들러가 app.close() → closeDb() 를 거친다.
      kill_timeout: 10000,

      watch: false,
      merge_logs: true,
      time: true,
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/error.log'),
    },
  ],
}
