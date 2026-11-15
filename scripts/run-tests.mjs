#!/usr/bin/env node
/**
 * 跨平台测试运行器（与 nea-boot 使用同一套策略）。
 *
 * 为什么不用 `tsx --test "test/**\/*.test.ts"`：
 * `**` 的展开依赖 shell 的 globstar 或 Node 内置 glob，
 * 在 CI 的 sh 上不生效，会把字面量传给程序导致失败。
 * 这里用 Node 自己遍历目录收集文件，再显式传给测试运行器。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) out.push(...collect(path.relative(ROOT, full)));
        else if (entry.isFile() && /\.test\.ts$/.test(entry.name)) out.push(path.relative(ROOT, full));
    }
    return out.sort();
}

const files = collect('test');

if (files.length === 0) {
    console.error('没有找到任何测试文件（test/**/*.test.ts）');
    process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件:`);
files.forEach(f => console.log(`  ${f}`));
console.log('');

const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(process.execPath, [tsx, '--test', ...files], {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
});

child.on('exit', code => process.exit(code ?? 1));
child.on('error', err => {
    console.error('启动测试运行器失败:', err.message);
    process.exit(1);
});
