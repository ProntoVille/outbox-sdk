import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { build } from 'esbuild';
execFileSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', platform: 'node', target: 'node20', format: 'cjs', sourcemap: true });
copyFileSync('dist/index.d.ts', 'dist/index.d.cts');
