const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Called on the copied application, so release checks cover what will actually ship.
function writePetCatalog(root) {
  const { ANIMALS } = require(path.join(root, 'electron/pet-model.js'));
  const atlas = require(path.join(root, 'src/pet-atlas.js'));
  const sprites = require(path.join(root, 'src/pet-sprites.js'));
  const animals = {};
  for (const [id, name] of Object.entries(ANIMALS)) {
    const manifest = atlas.getManifest(id);
    if (!manifest && !sprites.animals.includes(id)) throw new Error(`宠物 ${id} 缺少渲染资源`);
    animals[id] = { name };
    if (!manifest) continue;
    const bytes = fs.readFileSync(path.join(root, manifest.source));
    if (bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== manifest.width || bytes.readUInt32BE(20) !== manifest.height || bytes[25] !== 6) throw new Error(`宠物 ${id} 图集无效`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (manifest.sha256 && manifest.sha256 !== sha256) throw new Error(`宠物 ${id} 图集校验失败`);
    animals[id] = { name, source: manifest.source, sha256 };
  }
  const catalog = { format: 1, animals };
  fs.writeFileSync(path.join(root, 'assets/pets/catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  return catalog;
}

function assertPetUpdateCompatible(bundle, animal, { readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (!animal) return;
  const roots = ['app.asar', 'app'].map(name => path.join(bundle, 'Contents/Resources', name));
  const read = relative => {
    const root = roots.find(root => exists(path.join(root, relative)));
    return root ? readFile(path.join(root, relative), 'utf8') : null;
  };
  const fail = () => {
    throw Object.assign(new Error('更新包不包含当前选择的宠物，已保留当前版本与宠物设置。请等待包含该角色的完整更新包。'), { code: 'DM_PET_UPDATE_UNAVAILABLE' });
  };
  const text = read('assets/pets/catalog.json');
  if (text !== null) {
    let catalog;
    try { catalog = JSON.parse(text); } catch { return fail(); }
    const entry = catalog?.format === 1 && Object.hasOwn(catalog.animals || {}, animal) && catalog.animals[animal];
    if (!entry) return fail();
    if (entry.source) {
      if (!/^assets\/pets\/[a-zA-Z0-9_./-]+\.png$/.test(entry.source) || entry.source.split('/').includes('..')) return fail();
      const root = roots.find(root => exists(path.join(root, entry.source)));
      if (!root || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) return fail();
      if (crypto.createHash('sha256').update(readFile(path.join(root, entry.source))).digest('hex') !== entry.sha256) return fail();
    }
    return;
  }
  // Older releases lack catalog.json. Read static IDs as data, never execute package code.
  const model = read('electron/pet-model.js') || '';
  const body = /const\s+ANIMALS\s*=\s*\{([^}]+)\}/.exec(model)?.[1] || '';
  const ids = Array.from(body.matchAll(/(?:'([^']+)'|"([^"]+)"|([a-z][a-z0-9-]*))\s*:/g), match => match[1] || match[2] || match[3]);
  if (!ids.includes(animal)) return fail();
}

module.exports = { writePetCatalog, assertPetUpdateCompatible };
