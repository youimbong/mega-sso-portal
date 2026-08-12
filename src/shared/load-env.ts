import { existsSync } from 'node:fs'

/**
 * 로컬 개발용 .env 로딩. 컨테이너 배포에서는 .env가 없고 환경변수가 직접 주입되므로 건너뛴다.
 * Node 내장 기능이라 dotenv 의존성이 필요 없다.
 */
if (existsSync('.env')) process.loadEnvFile('.env')
