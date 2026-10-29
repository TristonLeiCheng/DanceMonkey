const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {writePetCatalog,assertPetUpdateCompatible}=require('../electron/pet-package');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dm-pet-payload-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const app=path.join(root,'DanceMonkey.app'),source=path.join(app,'Contents/Resources/app');
  fs.mkdirSync(source,{recursive:true});
  const put=(file,bytes)=>{const target=path.join(source,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);};
  return {root,app,source,put};
}

test('release preflight indexes every real skin and refuses missing or modified artwork', t=>{
  const f=fixture(t),current=path.resolve(__dirname,'..');
  fs.cpSync(path.join(current,'src'),path.join(f.source,'src'),{recursive:true});
  fs.cpSync(path.join(current,'electron'),path.join(f.source,'electron'),{recursive:true});
  fs.cpSync(path.join(current,'assets/pets'),path.join(f.source,'assets/pets'),{recursive:true});
  fs.copyFileSync(path.join(current,'pet.html'),path.join(f.source,'pet.html'));
  const catalog=writePetCatalog(f.source);
  assert.deepEqual(catalog.interactions.desktopIconPlatforms, ['darwin']);
  for (const file of require('../electron/pet-package').INTERACTION_FILES) {
    assert.match(catalog.interactions.files[file], /^[a-f0-9]{64}$/);
    const bytes = fs.readFileSync(path.join(f.source,file));
    fs.unlinkSync(path.join(f.source,file));
    assert.throws(() => writePetCatalog(f.source), /ENOENT/, `reject missing ${file}`);
    f.put(file,bytes);
  }
  assert.equal(Object.values(catalog.animals).filter(entry=>!entry.retired).length,24);
  assert.deepEqual(catalog.animals['operator-rabbit'],{name:'已移除的话务员兔子',retired:true,replacement:'human'});
  assert.doesNotThrow(()=>assertPetUpdateCompatible(f.app,'operator-rabbit'));
  assert.equal(require('../electron/pet-model').normalizeSettings({petAnimal:'operator-rabbit'}).petAnimal,'human');
  assertPetUpdateCompatible(f.app,'otter');assertPetUpdateCompatible(f.app,'fluffy-rabbit');assertPetUpdateCompatible(f.app,'koala');assertPetUpdateCompatible(f.app,'hamster');assertPetUpdateCompatible(f.app,'seal');assertPetUpdateCompatible(f.app,'liangzi');assertPetUpdateCompatible(f.app,'realistic-cockroach');assertPetUpdateCompatible(f.app,'realistic-mosquito');
  const source=catalog.animals.otter.source;
  fs.appendFileSync(path.join(f.source,source),'tampered');
  assert.throws(()=>assertPetUpdateCompatible(f.app,'otter'),{code:'DM_PET_UPDATE_UNAVAILABLE'});
  assert.throws(()=>writePetCatalog(f.source),/图集校验失败/);
  fs.unlinkSync(path.join(f.source,source));
  assert.throws(()=>writePetCatalog(f.source),/ENOENT/);
});

test('update without current skin is rejected, including pre-catalog releases',t=>{
  const f=fixture(t);f.put('electron/pet-model.js',"const ANIMALS = {human:'小人', cat:'猫咪', 'engineer-fox':'工程师'};");
  assert.doesNotThrow(()=>assertPetUpdateCompatible(f.app,'cat'));
  assert.throws(()=>assertPetUpdateCompatible(f.app,'otter'),{code:'DM_PET_UPDATE_UNAVAILABLE'});
  f.put('assets/pets/catalog.json',JSON.stringify({format:1,animals:{cat:{name:'猫咪'}}}));
  assert.throws(()=>assertPetUpdateCompatible(f.app,'fluffy-rabbit'),{code:'DM_PET_UPDATE_UNAVAILABLE'});
  f.put('assets/pets/catalog.json','broken');
  assert.throws(()=>assertPetUpdateCompatible(f.app,'cat'),{code:'DM_PET_UPDATE_UNAVAILABLE'});
});
