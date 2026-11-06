import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const python = ['.venv/Scripts/python.exe', '.venv/bin/python'].find(existsSync) ?? 'python'
for (const args of [['-m', 'ruff', 'check', 'collector'], ['-m', 'ruff', 'format', '--check', 'collector']]) {
  const lint = spawnSync(python, args, { stdio: 'inherit' })
  if (lint.status !== 0) process.exit(lint.status ?? 1)
}
const result = spawnSync(python, ['-m', 'pytest', 'collector/tests', '-q'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
