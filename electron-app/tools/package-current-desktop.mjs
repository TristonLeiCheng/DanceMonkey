import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('请在目标 Mac 上运行，本命令只构建本机架构和 Windows x64。');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { extractFile } = createRequire(import.meta.url)('@electron/asar');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const arch = process.arch;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const requiredFeatures = ['keyboard-movement', 'jumping', 'icon-platforms', 'icon-carry'];

if (!process.argv.includes('--prepare-only')) {
  execFileSync('npm', ['run', 'package:mac', '--', arch], { cwd: root, stdio: 'inherit' });
  execFileSync('npm', ['run', 'publish:win'], { cwd: root, stdio: 'inherit' });
}

const builds = [
  path.join(root, `out/DanceMonkey-darwin-${arch}/DanceMonkey.app/Contents/Resources/app.asar`),
  path.join(root, 'out/DanceMonkey-win32-x64/resources/app.asar'),
];
for (const archive of builds) {
  assert(JSON.parse(extractFile(archive, 'package.json')).version === version, `包内版本不一致：${archive}`);
  const catalog = JSON.parse(extractFile(archive, 'assets/pets/catalog.json'));
  assert(Object.keys(catalog.animals).length === 19, '宠物清单不完整');
  const interactions = catalog.interactions;
  assert(interactions?.format === 1 && requiredFeatures.every(f => interactions.features.includes(f)), '缺少行走、跳跃或图标交互能力清单');
  for (const [file, expected] of Object.entries(interactions.files)) {
    const bytes = extractFile(archive, file);
    assert(hash(bytes) === expected && bytes.equals(fs.readFileSync(path.join(root, file))), `交互模块与源码不一致：${file}`);
  }
  for (const file of ['src/pet-sprites.js', 'src/pet-picker.js', 'src/workspace-modules.js']) {
    assert(extractFile(archive, file).equals(fs.readFileSync(path.join(root, file))), `像素或设置模块与源码不一致：${file}`);
  }
  for (const entry of Object.values(catalog.animals)) {
    if (entry.source) assert(hash(extractFile(archive, entry.source)) === entry.sha256, `宠物素材校验失败：${entry.source}`);
  }
}

const make = path.join(root, 'out/make');
const output = path.join(make, 'release', `v${version}`);
fs.mkdirSync(output, { recursive: true });
const packages = [
  [path.join(make, 'zip/darwin', arch, `DanceMonkey-darwin-${arch}-${version}.zip`), `DanceMonkey-darwin-${arch}-${version}.zip`],
  [path.join(make, `DanceMonkey-darwin-${arch}.dmg`), `DanceMonkey-mac-${arch}-${version}.dmg`],
  [path.join(make, 'release', `DanceMonkey-win-x64-${version}.zip`), `DanceMonkey-win-x64-${version}.zip`],
  [path.join(make, 'release/update-manifest.json'), 'update-manifest.json'],
];
const manifest = JSON.parse(fs.readFileSync(packages[3][0]));
assert(manifest.version === version && manifest.packageUrl === packages[2][1], 'Windows 更新清单指向错误版本');
assert(manifest.sha256.toLowerCase() === hash(fs.readFileSync(packages[2][0])), 'Windows 更新清单校验和不一致');
const expectedNames = new Set([...packages.map(([, name]) => name), 'SHA256SUMS.txt']);
assert(fs.readdirSync(output).every(name => expectedNames.has(name)), '发布目录包含本次范围外的旧产物，请使用新的版本号或整理该目录');
const assets = packages.map(([source, name]) => {
  const target = path.join(output, name); fs.copyFileSync(source, target);
  return { name, path: target, size: fs.statSync(target).size, sha256: hash(fs.readFileSync(target)) };
});
const sums = path.join(output, 'SHA256SUMS.txt');
fs.writeFileSync(sums, assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
assets.push({ name: 'SHA256SUMS.txt', path: sums, size: fs.statSync(sums).size, sha256: hash(fs.readFileSync(sums)) });
const report = { version, macArch: arch, windowsArch: 'x64', features: requiredFeatures, assets };
fs.writeFileSync(path.join(make, `release-v${version}.json`), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
