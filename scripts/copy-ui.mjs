// Copies the answer view into dist/ and marks the CLI executable.
import { chmodSync, cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/ui', { recursive: true });
cpSync('src/ui/answer.html', 'dist/ui/answer.html');
chmodSync('dist/index.js', 0o755);
