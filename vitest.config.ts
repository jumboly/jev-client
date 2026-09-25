import { defineConfig } from 'vitest/config'

// 作業ディレクトリ内に別プロジェクトを置いた場合でも、そのテストを拾わないようにする
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
