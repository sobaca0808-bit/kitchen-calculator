/* Synthetic data and disposable loopback profiles only. Never navigate to production. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium}=require('playwright'),Seed=require('../js/seed.js');
const URL=process.env.KITCHEN_TEST_URL,origin=new globalThis.URL(URL||'http://invalid');
if(!URL||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))throw Error('Recovery checks require a disposable loopback server.');
const KEY='kitchen-calculator-v1',DRAFT='kitchen-calculator-drafts-v1',LEGACY='kitchen-calculator-pr2-browser-test-v1',LDRAFT='kitchen-calculator-pr2-browser-drafts-v1';
const PHOTO='kitchen-calculator-photos-v1',LPHOTO='kitchen-calculator-test-photos-v1',BACKUP='kitchen-calculator-recovery-backups-v1';
const launch={executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']};
const out=process.env.KITCHEN_TEST_ARTIFACT_DIR||path.join(os.tmpdir(),'kitchen-storage-recovery-proof');
const book=(name='Рабочая кухня')=>{const data=Seed.create();data.products[0].name=name;data.products[0].price=240;return data;};
const record=(name='Не закончено',id='draft-one',photoId)=>({id,type:'dish',isNew:true,updatedAt:100,data:{id,type:'dish',name,note:'Сохранить текст',portions:2,actualYield:null,technology:'1. Подготовить.',ingredients:[],...(photoId?{photoId}:{})},invalidValues:[['view-test','1,2,3']],errors:[['view-test','Ошибка ввода']],formValues:[{id:'item-name',value:name}],details:[{index:0,open:true}]});
const envelope=items=>JSON.stringify({version:1,items});
let browser,passed=0;const failures=[],proof=[];
async function seed(context,entries={},photoSets={}){
 const page=await context.newPage();await page.route('**/__storage_setup',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Temporary fictional fixture</title>'}));
 await page.goto(origin.origin+'/__storage_setup');
 await page.evaluate(async({entries,photoSets})=>{
  for(const [key,value]of Object.entries(entries))localStorage.setItem(key,value);
  localStorage.setItem('unrelated-storage-proof','fictional-protected');
  for(const [name,ids]of Object.entries(photoSets)){
   const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name,1);request.onupgradeneeded=()=>request.result.createObjectStore('photos',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
   for(const id of ids){
    const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;const ctx=canvas.getContext('2d');ctx.fillStyle=name.includes('test-')?'#6f8c5d':'#9d536a';ctx.fillRect(0,0,120,80);ctx.fillStyle='#ffeccc';ctx.fillRect(15,12,70,40);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    await new Promise((resolve,reject)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').add({id,blob,width:120,height:80,mime:blob.type});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
   }db.close();
  }
 },{entries,photoSets});await page.close();
}
async function guards(context){
 await context.addInitScript(({key,draft,legacy,legacyDraft,photo,legacyPhoto,backup})=>{
  if(location.pathname.startsWith('/__test-app/'))return;
  const nativeGet=Storage.prototype.getItem,nativeSet=Storage.prototype.setItem;
  window.__nativeRead=name=>nativeGet.call(localStorage,name);window.__nativeWrite=(name,value)=>nativeSet.call(localStorage,name,value);window.__storageOps=[];window.__dbOps=[];window.__allowRecovery=false;
  for(const method of ['getItem','setItem','removeItem','clear']){
   const original=Storage.prototype[method];Storage.prototype[method]=function(...args){
    if(this===localStorage){
     const name=args[0];window.__storageOps.push({method,key:name});
     if(method==='clear'||![key,draft].includes(name)&&!(method==='getItem'&&window.__allowRecovery&&[legacy,legacyDraft].includes(name)))throw Error('Forbidden storage access: '+method+' '+name);
     if(method==='setItem'&&name===key&&window.__blockMain)throw new DOMException('Fictional main quota','QuotaExceededError');
    }return original.apply(this,args);
   };
  }
  const open=IDBFactory.prototype.open;IDBFactory.prototype.open=function(name,...args){
   window.__dbOps.push({name});if(![photo,backup].includes(name)&&!(window.__allowRecovery&&name===legacyPhoto))throw Error('Forbidden DB access: '+name);return open.call(this,name,...args);
  };
  IDBFactory.prototype.deleteDatabase=function(){throw Error('Database deletion is forbidden');};
  const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(stores,mode,...args){
   if(this.name===legacyPhoto&&mode&&mode!=='readonly')throw Error('Legacy photos are read-only');return transaction.call(this,stores,mode,...args);
  };
  const add=IDBObjectStore.prototype.add;IDBObjectStore.prototype.add=function(...args){
   if(this.transaction.db.name===backup&&window.__blockBackup)throw new DOMException('Fictional backup quota','QuotaExceededError');return add.apply(this,args);
  };
 },{key:KEY,draft:DRAFT,legacy:LEGACY,legacyDraft:LDRAFT,photo:PHOTO,legacyPhoto:LPHOTO,backup:BACKUP});
}
async function fixture(entries={},photoSets={},width=1366){
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<768,hasTouch:width<768,acceptDownloads:true});await seed(context,entries,photoSets);await guards(context);
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));await page.goto(URL);
 return {context,page,errors};
}
async function test(name,entries,photoSets,fn,width){
 const f=await fixture(entries,photoSets,width);
 try{
  const result=await fn(f.page,f.context);assert.deepEqual(f.errors,[]);if(!result?.storageDenied)assert.equal(await f.page.evaluate(()=>window.__nativeRead('unrelated-storage-proof')),'fictional-protected');assert(await f.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  console.log('PASS recovery:',name);passed++;proof.push({name,width:width||1366,passed:true,consoleErrors:f.errors});
 }catch(error){console.error('FAIL recovery:',name,error.stack);failures.push(name+': '+error.message);}
 finally{await f.context.close();}
}
const raw=(page,key=KEY)=>page.evaluate(key=>window.__nativeRead(key),key);
async function inspect(page){await page.evaluate(()=>window.__allowRecovery=true);await page.locator('#storage-recovery-open').click();}
async function choose(page,id='legacy',accept=true){
 await page.locator('#recovery-ack').check();page.once('dialog',dialog=>accept?dialog.accept():dialog.dismiss());await page.locator(`[data-recover=${id}]`).click();
 await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');
}
async function downloaded(page,button){const event=page.waitForEvent('download');await button.click();const file=await event;return fs.readFile(await file.path(),'utf8');}
async function databaseCount(page,name,store){
 return page.evaluate(async({name,store})=>{
  if(!(await indexedDB.databases()).some(db=>db.name===name))return 0;
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readonly'),request=tx.objectStore(store).count();tx.oncomplete=()=>{db.close();resolve(request.result);};tx.onerror=()=>{db.close();reject(tx.error);};});
 },{name,store});
}
async function photoBytes(page,id){return page.evaluate(async id=>Array.from(new Uint8Array(await (await KitchenPhotos.get(id)).blob.arrayBuffer())),id);}
(async()=>{
 await fs.mkdir(out,{recursive:true});browser=await chromium.launch(launch);
 await test('old production alone is opened without initialization or legacy reads',{[KEY]:JSON.stringify(book('Старая кухня'))},{},async page=>{
  const before=await raw(page);assert.equal(await page.locator('#count-products').innerText(),'12');assert.match(await page.locator('#storage-notice').innerText(),/сохранена/);await page.reload();assert.equal(await raw(page),before);assert((await page.evaluate(()=>window.__storageOps)).every(op=>op.method==='getItem'&&[KEY,DRAFT].includes(op.key)));
 });
 await test('only legacy: active database stays absent; raw export and cancellation preserve it',{[LEGACY]:JSON.stringify(book('После релиза'))},{},async page=>{
  assert.equal(await raw(page),null);assert.equal(await page.locator('[data-open]').count(),0);assert.match(await page.locator('#storage-notice').innerText(),/отсутствует/);await inspect(page);
  const backup=await downloaded(page,page.locator('[data-raw=legacy]'));assert.equal(backup,JSON.stringify(book('После релиза')));
  await choose(page,'legacy',false);assert.match(await page.locator('#recovery-status').innerText(),/отменено/);assert.equal(await raw(page),null);assert.equal(await raw(page,LEGACY),backup);assert.equal(await databaseCount(page,BACKUP,'snapshots'),0);
 });
 await test('different nonempty sources show counts/names and can both be downloaded',{[KEY]:JSON.stringify(book('До релиза')),[LEGACY]:JSON.stringify(book('После релиза'))},{},async page=>{
  await inspect(page);assert.equal(await page.locator('.recovery-source').count(),2);assert.match(await page.locator('.recovery-source').first().innerText(),/Продуктов: 12.*Полуфабрикатов: 2.*Блюд: 1/);
  assert.match(await page.locator('.recovery-source').first().innerText(),/До релиза.*240/);assert.match(await page.locator('.recovery-source').last().innerText(),/После релиза.*240/);
  assert.equal(await downloaded(page,page.locator('[data-raw=production]')),await raw(page));assert.equal(await downloaded(page,page.locator('[data-raw=legacy]')),await raw(page,LEGACY));
  await page.locator('[data-recover=legacy]').click();assert.match(await page.locator('#recovery-status').innerText(),/Подтвердите/);assert.equal(JSON.parse(await raw(page)).products[0].name,'До релиза');
  await page.screenshot({path:path.join(out,'sources-desktop.png'),fullPage:true});
 });
 const photographed=book('После релиза с фото');photographed.recipes[2].photoIds=['old-first','old-second'];
 await test('two legacy photos are copied safely; repeated restoration and reload do not duplicate',{[KEY]:JSON.stringify(book('До релиза')),[LEGACY]:JSON.stringify(photographed)},{[LPHOTO]:['old-first','old-second']},async page=>{
  await inspect(page);const portable=JSON.parse(await downloaded(page,page.locator('[data-portable=legacy]'))),legacy=await raw(page,LEGACY);
  await choose(page);assert.match(await page.locator('#recovery-status').innerText(),/восстановлена/);assert.equal(await raw(page,LEGACY),legacy);
  const saved=JSON.parse(await raw(page)),ids=saved.recipes[2].photoIds;assert.equal(ids.length,2);assert(!ids.includes('old-first'));assert.equal(await databaseCount(page,LPHOTO,'photos'),2);assert.equal(await databaseCount(page,PHOTO,'photos'),2);
  assert.deepEqual(await page.evaluate(()=>KitchenPhotos.exportData(KitchenStorage.load().data)),portable);const before=await raw(page);
  await choose(page);assert.match(await page.locator('#recovery-status').innerText(),/уже сохранена/);assert.equal(await raw(page),before);assert.equal(await databaseCount(page,PHOTO,'photos'),2);assert.equal(await databaseCount(page,BACKUP,'snapshots'),1);
  await page.reload();assert.equal(await raw(page),before);assert.deepEqual(await photoBytes(page,ids[0]),await photoBytes(page,ids[1]));
  await inspect(page);await page.locator('#recovery-backups-open').click();await page.waitForSelector('#recovery-backups h3');assert.match(await page.locator('#recovery-backups').innerText(),/Копия/);
  const savedExport=JSON.parse(await downloaded(page,page.locator('#recovery-backups button').filter({hasText:'Скачать JSON с фото из копии'}).last()));assert.deepEqual(savedExport,portable);
 });
 await test('corrupt production is preserved literally in a backup before explicit recovery',{[KEY]:'{damaged',[LEGACY]:JSON.stringify(book('Новая'))},{},async page=>{
  assert.equal(await raw(page),'{damaged');assert.match(await page.locator('#message').innerText(),/заблокирована/);await inspect(page);assert.equal(await downloaded(page,page.locator('[data-raw=production]')),'{damaged');await choose(page);
  assert.equal(JSON.parse(await raw(page)).products[0].name,'Новая');await page.locator('#recovery-backups-open').click();assert.equal(await downloaded(page,page.locator('#recovery-backups button').filter({hasText:'Скачать исходный JSON'}).first()),'{damaged');
 });
 await test('corrupt legacy does not prevent working with production and remains downloadable',{[KEY]:JSON.stringify(book()),[LEGACY]:'{broken legacy'},{},async page=>{
  await inspect(page);assert(await page.locator('[data-recover=legacy]').isDisabled());assert.equal(await downloaded(page,page.locator('[data-raw=legacy]')),'{broken legacy');assert.equal(JSON.parse(await raw(page)).products[0].price,240);
 });
 await test('production recipes with old photo references can explicitly copy legacy assets without changing the test book',{[KEY]:JSON.stringify(photographed),[LEGACY]:JSON.stringify(book('Отдельный тест'))},{[LPHOTO]:['old-first','old-second']},async page=>{
  const legacy=await raw(page,LEGACY);assert((await page.evaluate(()=>window.__dbOps)).every(op=>op.name!== 'kitchen-calculator-test-photos-v1'));await inspect(page);await choose(page,'production');assert.match(await page.locator('#recovery-status').innerText(),/восстановлена/);
  const saved=JSON.parse(await raw(page));assert.notEqual(saved.recipes[2].photoIds[0],'old-first');assert.equal(saved.products[0].name,photographed.products[0].name);assert.equal(await raw(page,LEGACY),legacy);assert.equal(await databaseCount(page,PHOTO,'photos'),2);assert.equal(await databaseCount(page,LPHOTO,'photos'),2);
 });
 await test('no keys: no demonstration base is written; an explicit product save survives reload',{}, {},async page=>{
  assert.equal(await raw(page),null);assert((await page.evaluate(()=>window.__storageOps)).every(op=>op.method==='getItem'));await page.locator('[data-tab=products]').click();await page.locator('#create').click();await page.locator('#item-name').fill('Первый настоящий продукт');await page.locator('#price').fill('321,45');await page.locator('#save-item').click();
  assert.match(await page.locator('#message').innerText(),/Сохранено/);const saved=await raw(page);assert.equal(JSON.parse(saved).products[0].price,321.45);await page.reload();assert.equal(await raw(page),saved);assert.equal(await raw(page,LEGACY),null);
 });
 await test('denied localStorage is explicit and never looks like successful persistence',{}, {},async(page,context)=>{
  await context.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Fictional denial','SecurityError');}}));await page.reload();assert.match(await page.locator('#message').innerText(),/Не удалось прочитать/);await page.locator('#storage-recovery-open').click();assert.match(await page.locator('#recovery-sources').innerText(),/недоступно/);assert(await page.locator('[data-recover=legacy]').isDisabled());
  return {storageDenied:true};
 });
 await test('ordinary save quota preserves the old database and can export the in-memory changes',{[KEY]:JSON.stringify(book())},{},async page=>{
  const before=await raw(page);await page.locator('[data-tab=products]').click();await page.locator('#price').fill('999');await page.evaluate(()=>window.__blockMain=true);await page.locator('#save-item').click();assert.equal(await raw(page),before);assert.match(await page.locator('#save-state').innerText(),/В памяти/);
  const backup=JSON.parse(await downloaded(page,page.locator('#export')));assert.equal(backup.products[0].price,999);assert.equal(await raw(page),before);
 });
 await test('external production changes block stale saves but still allow exporting unsaved product input',{[KEY]:JSON.stringify(book())},{},async page=>{
  await page.locator('[data-tab=products]').click();await page.locator('#price').fill('876,54');const other=JSON.stringify(book('Другая вкладка'));
  await page.evaluate(({key,value})=>{window.__nativeWrite(key,value);dispatchEvent(new StorageEvent('storage',{key,newValue:value}));},{key:KEY,value:other});
  await page.locator('#save-item').click();assert.equal(await raw(page),other);const copy=JSON.parse(await downloaded(page,page.locator('#export')));assert.equal(copy.products[0].price,876.54);assert.equal(await raw(page),other);
 });
 await test('backup quota prevents all replacement and photo staging',{[KEY]:JSON.stringify(book('Старая')),[LEGACY]:JSON.stringify(photographed)},{[LPHOTO]:['old-first','old-second']},async page=>{
  const before=await raw(page);await inspect(page);await page.evaluate(()=>window.__blockBackup=true);await choose(page);assert.match(await page.locator('#recovery-status').innerText(),/quota/i);assert.equal(await raw(page),before);assert.equal(await databaseCount(page,PHOTO,'photos'),0);assert.equal(await databaseCount(page,LPHOTO,'photos'),2);
 });
 await test('main quota after staging keeps both bases/photos and the durable backup',{[KEY]:JSON.stringify(book('Старая')),[LEGACY]:JSON.stringify(photographed)},{[LPHOTO]:['old-first','old-second']},async page=>{
  const before=await raw(page),legacy=await raw(page,LEGACY);await inspect(page);await page.evaluate(()=>window.__blockMain=true);await choose(page);assert.match(await page.locator('#recovery-status').innerText(),/quota/i);assert.equal(await raw(page),before);assert.equal(await raw(page,LEGACY),legacy);assert.equal(await databaseCount(page,PHOTO,'photos'),0);assert.equal(await databaseCount(page,LPHOTO,'photos'),2);assert.equal(await databaseCount(page,BACKUP,'snapshots'),1);
 });
 await test('missing legacy photo blocks replacement and never creates a legacy database',{[KEY]:JSON.stringify(book()),[LEGACY]:JSON.stringify(photographed)},{},async page=>{
  const before=await raw(page);await inspect(page);await choose(page);assert.match(await page.locator('#recovery-status').innerText(),/фотограф/i);assert.equal(await raw(page),before);assert.equal(await databaseCount(page,LPHOTO,'photos'),0);assert(!(await page.evaluate(()=>indexedDB.databases())).some(db=>db.name===LPHOTO));
 });
 await test('another tab changing production during photo preparation aborts and rolls back staging',{[KEY]:JSON.stringify(book('Старая')),[LEGACY]:JSON.stringify(photographed)},{[LPHOTO]:['old-first','old-second']},async page=>{
  await inspect(page);await page.evaluate(()=>{const prepare=KitchenPhotos.prepareImport;KitchenPhotos.prepareImport=async data=>{const staged=await prepare(data);window.__stagedReady=true;await new Promise(resolve=>window.__releaseStaging=resolve);return staged;};});
  await page.locator('#recovery-ack').check();page.once('dialog',d=>d.accept());await page.locator('[data-recover=legacy]').click();await page.waitForFunction(()=>window.__stagedReady);const newer=JSON.stringify(book('Другая вкладка'));
  await page.evaluate(value=>window.__nativeWrite(KitchenStorage.KEY,value),newer);await page.evaluate(()=>window.__releaseStaging());await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');
  assert.match(await page.locator('#recovery-status').innerText(),/другой вкладке/);assert.equal(await raw(page),newer);assert.equal(await databaseCount(page,PHOTO,'photos'),0);
 });
 await test('legacy draft with a photo and conflicting ID is copied independently and only once',{[KEY]:JSON.stringify(book()),[DRAFT]:envelope([record('Своё незавершённое')]),[LDRAFT]:envelope([record('После релиза','draft-one','draft-photo')])},{[LPHOTO]:['draft-photo']},async page=>{
  const main=await raw(page),legacy=await raw(page,LDRAFT);await inspect(page);await page.locator('.recovery-source').last().locator('summary').click();page.once('dialog',d=>d.accept());await page.locator('[data-copy-draft]').click();await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');assert.match(await page.locator('#recovery-status').innerText(),/скопирован/);
  const saved=JSON.parse(await raw(page,DRAFT)).items;assert.equal(saved.length,2);assert.deepEqual(saved.find(r=>r.id==='draft-one'),record('Своё незавершённое'));const copied=saved.find(r=>r.id!=='draft-one');assert.equal(copied.data.id,copied.id);assert(copied.data.photoIds[0]!=='draft-photo');assert.deepEqual(copied.invalidValues,record().invalidValues);
  await page.locator('.recovery-source').last().locator('summary').click();page.once('dialog',d=>d.accept());await page.locator('[data-copy-draft]').click();await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');assert.equal(JSON.parse(await raw(page,DRAFT)).items.length,2);assert.equal(await raw(page),main);assert.equal(await raw(page,LDRAFT),legacy);
  await page.reload();assert.equal(await page.locator('#drafts-panel [data-restore-draft]').count(),2);
 });
 await test('ordinary JSON import backs up the book and photographs without reading legacy',{[KEY]:JSON.stringify(photographed),[LEGACY]:'{valuable test raw'},{[PHOTO]:['old-first','old-second']},async page=>{
  const old=await raw(page),legacy=await raw(page,LEGACY);page.once('dialog',d=>d.accept());await page.locator('#import-file').setInputFiles({name:'old-v1.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(book('Из файла')))});
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Данные импортированы'));assert.equal(JSON.parse(await raw(page)).products[0].name,'Из файла');assert.equal(await raw(page,LEGACY),legacy);assert.equal(await databaseCount(page,PHOTO,'photos'),2);
  assert((await page.evaluate(()=>window.__storageOps)).every(op=>[KEY,DRAFT].includes(op.key)));await inspect(page);await page.locator('#recovery-backups-open').click();const restored=JSON.parse(await downloaded(page,page.locator('#recovery-backups button').filter({hasText:'Скачать JSON с фото из копии'})));assert.equal(restored.products[0].name,JSON.parse(old).products[0].name);assert.equal(restored.recipes[2].photos.filter(Boolean).length,2);
 });
 const conflicted=record('Старое незавершённое блюдо','dish-gyro');conflicted.isNew=false;conflicted.data={...book().recipes[2],name:conflicted.data.name};
 const oldRow=conflicted.data.ingredients[0].id;conflicted.formValues=[{id:'item-name',value:conflicted.data.name},{id:'qty-'+oldRow,value:'1,2,3'}];conflicted.invalidValues=[['qty-'+oldRow,'1,2,3']];conflicted.errors=[['qty-'+oldRow,'Исправьте число']];
 await test('a conflicting copied recipe restores invalid row input and saves beside the original without duplicate IDs',{[KEY]:JSON.stringify(book()),[LEGACY]:JSON.stringify(book()),[DRAFT]:envelope([conflicted]),[LDRAFT]:envelope([conflicted])},{},async page=>{
  await inspect(page);await page.locator('.recovery-source').last().locator('summary').click();page.once('dialog',d=>d.accept());await page.locator('[data-copy-draft]').click();await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');
  const copied=JSON.parse(await raw(page,DRAFT)).items.find(r=>r.id!=='dish-gyro');assert(copied);const row=copied.data.ingredients[0].id;assert.notEqual(row,oldRow);await page.locator('#recovery-close').click();await page.locator(`[data-restore-draft="${copied.id}"]`).click();assert.equal(await page.locator('#qty-'+row).inputValue(),'1,2,3');
  await page.locator('#qty-'+row).fill('101');await page.locator('#save-item').click();assert.match(await page.locator('#message').innerText(),/Сохранено/);let saved=JSON.parse(await raw(page));assert.equal(saved.recipes.length,4);assert.deepEqual(saved.recipes.find(r=>r.id==='dish-gyro'),book().recipes[2]);assert.equal(saved.recipes.find(r=>r.id===copied.id).ingredients[0].quantity,101);
  await page.locator('#save-item').click();saved=JSON.parse(await raw(page));assert.equal(saved.recipes.filter(r=>r.id===copied.id).length,1);
 });
 await test('unknown future fields are downloadable but never silently discarded',{[KEY]:JSON.stringify(book()),[LEGACY]:JSON.stringify({...book('Будущая версия'),folders:[{id:'folder-a',name:'Ценное'}]})},{},async page=>{
  await inspect(page);assert.match(await page.locator('.recovery-source').last().innerText(),/не поддерживается/);assert(await page.locator('[data-recover=legacy]').isDisabled());assert.deepEqual(JSON.parse(await downloaded(page,page.locator('[data-raw=legacy]'))).folders,[{id:'folder-a',name:'Ценное'}]);
 });
 for(const width of [390,320])await test('recovery panel, backup list and source buttons fit '+width+'px',{[KEY]:JSON.stringify(book('Старая')),[LEGACY]:JSON.stringify(book('Новая'))},{},async page=>{
  await inspect(page);await choose(page);await page.locator('#recovery-backups-open').click();await page.waitForFunction(()=>document.querySelector('#storage-recovery').getAttribute('aria-busy')==='false');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'recovery-'+width+'.png'),fullPage:true});
  await page.emulateMedia({media:'print'});assert.equal(await page.locator('#storage-recovery').isVisible(),false);assert.equal(await page.locator('#storage-notice').isVisible(),false);
 },width);
 // Two actual namespace configurations of the same storage modules on one origin.
 // The fixture substitutes only constants; it is not a deployed test calculator.
 await test('same-origin production/test storage modules cannot overwrite or delete each other',{[KEY]:JSON.stringify({...book(),recipes:book().recipes.map((r,i)=>i===2?{...r,photoId:'same-photo-id'}:r)}),[LEGACY]:JSON.stringify(book('Тестовая'))},{[PHOTO]:['same-photo-id'],[LPHOTO]:['same-photo-id']},async(page,context)=>{
  const initial=await raw(page),bytes=await photoBytes(page,'same-photo-id');
  const base=path.resolve(__dirname,'..');const modules=Object.fromEntries(await Promise.all(['storage','drafts','photos'].map(async name=>[name,(await fs.readFile(path.join(base,'js',name+'.js'),'utf8')).replace("const KEY = '"+KEY+"'","const KEY = '"+LEGACY+"'").replace("const KEY = '"+DRAFT+"'","const KEY = '"+LDRAFT+"'").replace("const DB_NAME = '"+PHOTO+"'","const DB_NAME = '"+LPHOTO+"'")])));
  const other=await context.newPage();await other.route('**/__test-app/**',route=>{const name=new globalThis.URL(route.request().url()).pathname.split('/').pop();return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/html',body:name.endsWith('.js')?modules[name.slice(0,-3)]:'<!doctype html><script src="storage.js"></script><script src="drafts.js"></script><script src="photos.js"></script>'});});
  await other.goto(origin.origin+'/__test-app/index');
  await other.evaluate(async draft=>{
   const data=KitchenStorage.load().data;data.products[0].price=777;const saved=KitchenStorage.save(data);if(!saved.ok)throw Error(saved.error);
   const copied=KitchenDrafts.save(draft);if(!copied.ok)throw Error(copied.error);
   await KitchenPhotos.remove('same-photo-id');
   window.__testNamespaces=[KitchenStorage.KEY,KitchenDrafts.KEY,KitchenPhotos.DB_NAME];
  },record('Тестовый черновик'));
  assert.deepEqual(await other.evaluate(()=>window.__testNamespaces),[LEGACY,LDRAFT,LPHOTO]);assert.equal(await raw(page),initial);assert.equal(JSON.parse(await raw(page,LEGACY)).products[0].price,777);
  await page.locator('[data-tab=products]').click();await page.locator('#price').fill('444');await page.locator('#save-item').click();assert.equal(JSON.parse(await raw(page,LEGACY)).products[0].price,777);assert.deepEqual(await photoBytes(page,'same-photo-id'),bytes);
  assert.equal(await raw(page,DRAFT),null);assert.equal(JSON.parse(await raw(page,LDRAFT)).items[0].data.name,'Тестовый черновик');
  const portable=await page.evaluate(()=>KitchenPhotos.portablePhoto('same-photo-id'));
  const testPhoto=await other.evaluate(async photo=>{const prepared=await KitchenPhotos.prepareImport({version:1,products:[],recipes:[{id:'separate-test-photo',type:'dish',name:'Тест',note:'',actualYield:null,ingredients:[],photo}]});return prepared.data.recipes[0].photoId;},portable);
  await page.evaluate(()=>KitchenPhotos.remove('same-photo-id'));
  assert.equal(await other.evaluate(async id=>(await KitchenPhotos.get(id)).blob.size,testPhoto),bytes.length);
  await other.close();
 });
 await browser.close();browser=null;
 // Real browser process shutdown/restart, not just page.reload().
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'kitchen-production-restart-'));
 const restartErrors=[];
 async function watchRestart(context){
  await context.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
  context.on('page',page=>{page.on('pageerror',error=>restartErrors.push(error.message));page.on('console',message=>{if(message.type()==='error')restartErrors.push(message.text());});});
 }
 let persistent;
 try{
  persistent=await chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:844},acceptDownloads:true});await watchRestart(persistent);await seed(persistent,{[KEY]:JSON.stringify(book('До обновления')),[LEGACY]:JSON.stringify(photographed)},{[LPHOTO]:['old-first','old-second']});await guards(persistent);
  let page=await persistent.newPage();page.setDefaultTimeout(15000);await page.goto(URL);const before=await raw(page);assert.equal(JSON.parse(before).products[0].name,'До обновления');assert.equal(await raw(page,LEGACY),JSON.stringify(photographed));await inspect(page);await choose(page);
  await page.locator('#recovery-close').click();await page.locator('[data-tab=products]').click();await page.locator('#price').fill('654,32');await page.locator('#save-item').click();
  await page.locator('[data-tab=dish]').click();await page.locator('#create').click();await page.locator('#item-name').fill('Черновик до закрытия');await page.waitForFunction(()=>KitchenDrafts.load().items.some(r=>r.data.name==='Черновик до закрытия'));
  const saved=await raw(page),draftRaw=await raw(page,DRAFT),ids=JSON.parse(saved).recipes[2].photoIds,bytes=await photoBytes(page,ids[0]);await persistent.close();
  persistent=await chromium.launchPersistentContext(profile,{...launch,viewport:{width:390,height:844},acceptDownloads:true});await watchRestart(persistent);await guards(persistent);page=await persistent.newPage();await page.goto(URL);
  assert.equal(await raw(page),saved);assert.equal(await raw(page,DRAFT),draftRaw);assert.equal(JSON.parse(saved).products[0].price,654.32);assert.deepEqual(await photoBytes(page,ids[0]),bytes);assert.equal(await page.locator('#drafts-panel [data-restore-draft]').count(),1);
  await page.locator('#drafts-panel [data-restore-draft]').click();assert.equal(await page.locator('#item-name').inputValue(),'Черновик до закрытия');
  assert.deepEqual(restartErrors,[]);console.log('PASS recovery: real browser restart retains the updated production book, price, photographs and draft');passed++;proof.push({name:'real browser restart after version update',passed:true,consoleErrors:restartErrors});
 }catch(error){console.error('FAIL recovery: real restart',error.stack);failures.push('real restart: '+error.message);}
 finally{await persistent?.close();await fs.rm(profile,{recursive:true,force:true});}
 await fs.writeFile(path.join(out,'storage-recovery-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(`${passed} storage-recovery browser scenarios passed; ${failures.length} failures.`);if(failures.length)process.exitCode=1;
})().catch(async error=>{console.error(error);await browser?.close();process.exitCode=1;});
