import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { writePetCatalog, INTERACTION_FILES } = require('../electron/pet-package');
const { version, dependencies } = require('../package.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeOnly = process.argv.includes('--native-only');
const arches = nativeOnly ? [process.arch] : ['arm64', 'x64'];
assert.equal(process.platform, 'darwin', 'Mac releases must be prepared on macOS');
const expectedCatalog = writePetCatalog(root);
const activePets = Object.keys(expectedCatalog.animals).filter(id => !expectedCatalog.animals[id].retired);
assert.equal(activePets.length, 24);
assert.equal(expectedCatalog.animals['operator-rabbit'].retired, true);
const directories = ['electron', 'src', 'assets', 'vendor'];
function walk(folder) {
  return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const file = `${folder}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const files = [...directories.flatMap(walk), 'index.html', 'pet.html', 'package.json'];
// The previous release is an explicit feature baseline, beyond the current branch.
const baseline = execFileSync('git', ['ls-tree', '-r', '--name-only', 'v3.12.0', ...directories.map(dir => `electron-app/${dir}`), 'electron-app/index.html', 'electron-app/pet.html'], { cwd: path.dirname(root), encoding: 'utf8' }).trim().split('\n');
for (const file of baseline) assert.ok(files.includes(file.slice('electron-app/'.length)), `3.12.0 runtime file lost: ${file}`);

if (!process.argv.includes('--prepare-only')) {
  for (const arch of arches) execFileSync('npm', ['run', `package:mac:${arch}`], { cwd: root, stdio: 'inherit' });
  execFileSync('npm', ['run', 'publish:win'], { cwd: root, stdio: 'inherit' });
}
const report = [];
for (const platform of [...arches.map(arch => `darwin-${arch}`), 'win32-x64']) {
  const folder = path.join(root, 'out', `DanceMonkey-${platform}`), mac = platform.startsWith('darwin');
  const archive = path.join(folder, mac ? 'DanceMonkey.app/Contents/Resources/app.asar' : 'resources/app.asar');
  const read = file => asar.extractFile(archive, file);
  const listing = asar.listPackage(archive);
  assert.equal(JSON.parse(read('package.json')).version, version);
  for (const file of files) assert.ok(read(file).equals(fs.readFileSync(path.join(root, file))), `${platform} runtime differs: ${file}`);
  assert.ok(!listing.some(file => /^\/(test|docs)\//.test(file)), 'development fixtures included');
  for (const dep of Object.keys(dependencies)) assert.ok(listing.includes(`/node_modules/${dep}/package.json`), `missing dependency ${dep}`);
  const catalog = JSON.parse(read('assets/pets/catalog.json'));
  assert.deepEqual(catalog, expectedCatalog);
  for (const file of INTERACTION_FILES) assert.equal(hash(read(file)), catalog.interactions.files[file]);
  for (const pet of Object.values(catalog.animals)) if (pet.source) assert.equal(hash(read(pet.source)), pet.sha256);
  const executable = path.join(folder, mac ? 'DanceMonkey.app/Contents/MacOS/DanceMonkey' : 'DanceMonkey.exe');
  const kind = execFileSync('file', [executable], { encoding: 'utf8' });
  assert.ok(kind.includes(mac ? (platform.endsWith('arm64') ? 'arm64' : 'x86_64') : 'PE32+'));
  if (mac) execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(folder, 'DanceMonkey.app')]);
  report.push({ platform, version, runtimeFiles: files.length, pets: activePets.length, baseline: 'v3.12.0', result: 'verified' });
  console.log(`Verified ${platform}: ${files.length} runtime files, 24 pets and 3.12.0 baseline`);
}

const make = path.join(root, 'out/make'), output = path.join(root, 'out/releases', `v${version}`);
fs.mkdirSync(output, { recursive: true });
const packages = arches.flatMap(arch => [
  [path.join(make, 'zip/darwin', arch, `DanceMonkey-darwin-${arch}-${version}.zip`), `DanceMonkey-darwin-${arch}-${version}.zip`],
  [path.join(make, `DanceMonkey-darwin-${arch}.dmg`), `DanceMonkey-mac-${arch}-${version}.dmg`],
]);
packages.push([path.join(make, 'release', `DanceMonkey-win-x64-${version}.zip`), `DanceMonkey-win-x64-${version}.zip`]);
packages.push([path.join(make, 'release/update-manifest.json'), 'update-manifest.json']);
const manifest = JSON.parse(fs.readFileSync(packages.at(-1)[0]));
assert.equal(manifest.version, version);
assert.equal(manifest.packageUrl, `DanceMonkey-win-x64-${version}.zip`);
assert.equal(manifest.sha256.toLowerCase(), hash(fs.readFileSync(packages.at(-2)[0])));
const assets = packages.map(([source, name]) => {
  const target = path.join(output, name); fs.copyFileSync(source, target);
  return { name, size: fs.statSync(target).size, sha256: hash(fs.readFileSync(target)) };
});
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
fs.writeFileSync(path.join(output, 'package-verification.json'), JSON.stringify({ version, baseline: 'v3.12.0', platforms: report, assets }, null, 2) + '\n');
console.log(`Prepared ${output}`);
