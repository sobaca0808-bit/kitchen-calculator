'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../js/storage.js'),D=require('../js/drafts.js'),Photos=require('../js/photos.js'),Seed=require('../js/seed.js'),R=require('../js/storage-recovery.js');
const clone=value=>JSON.parse(JSON.stringify(value));
function book(name='Рабочая кухня'){const data=Seed.create();data.products[0].name=name;data.products[0].price=123.45;return data;}
function memory(entries=[]){const values=new Map(entries),ops=[];return {values,ops,getItem(key){ops.push(['get',key]);return values.get(key)??null;},setItem(key,value){ops.push(['set',key]);values.set(key,value);}};}
function setup(entries=[]){
 const storage=memory(entries),backups=[],rolled=[];
 const photos={ids:Photos.ids,exportData:async data=>clone(data),prepareImport:async data=>({data:clone(data),createdIds:['staged-only']}),rollback:async ids=>rolled.push(...ids)};
 return {storage,backups,rolled,photos,options:{storage,photos,confirmed:true,writeBackup:async backup=>backups.push(backup)}};
}
const serialized=name=>S.stringify(book(name));
const draft=(name='Черновик',id='draft-a')=>({id,type:'dish',isNew:true,updatedAt:100,data:{id,type:'dish',name,ingredients:[],note:'незавершённая работа'},invalidValues:[['qty','не число']],errors:[['qty','Исправьте']],formValues:[{id:'item-name',value:name}],details:[{index:0,open:true}]});
const drafts=record=>JSON.stringify({version:1,items:[record]});

test('production book, drafts, photos and recovery copies have distinct fixed namespaces',()=>{
 assert.equal(S.KEY,'kitchen-calculator-v1');assert.equal(D.KEY,'kitchen-calculator-drafts-v1');assert.equal(Photos.DB_NAME,'kitchen-calculator-photos-v1');
 assert.equal(new Set([S.KEY,D.KEY,Photos.DB_NAME,R.BACKUP_DB,R.LEGACY_KEY,R.LEGACY_DRAFT_KEY,R.LEGACY_PHOTO_DB]).size,7);
});
test('normal load/save touches production only, even with a valuable legacy database',()=>{
 const storage=memory([[R.LEGACY_KEY,serialized('Новая кухня')]]);assert.equal(S.load(storage).data,null);
 assert(S.save(book(),storage,null).ok);assert(storage.ops.every(op=>op[1]===S.KEY));assert.equal(storage.values.get(R.LEGACY_KEY),serialized('Новая кухня'));
});
for(const [name,entries,counts]of [
 ['only old production',[[S.KEY,serialized('Старая')]], [true,false]],
 ['only erroneous-release/test source',[[R.LEGACY_KEY,serialized('После релиза')]], [false,true]],
 ['two different valuable databases',[[S.KEY,serialized('Старая')],[R.LEGACY_KEY,serialized('Новая')]], [true,true]],
 ['neither database',[],[false,false]]
])test('read-only inspection: '+name,()=>{
 const storage=memory(entries),before=[...storage.values],sources=R.inspect(storage);
 assert.deepEqual(sources.map(s=>!!s.data),counts);assert.deepEqual([...storage.values],before);assert(storage.ops.every(op=>op[0]==='get'));
 for(const source of sources.filter(s=>s.data)){assert.equal(source.counts.products,source.data.products.length);assert.equal(source.counts.prep,2);assert.equal(source.counts.dish,1);}
});
for(const key of [S.KEY,R.LEGACY_KEY])test('a corrupt source remains byte-for-byte intact: '+key,()=>{
 const storage=memory([[S.KEY,serialized('Рабочая')],[R.LEGACY_KEY,serialized('Общая')],[key,'{broken']]);
 const sources=R.inspect(storage);assert(sources.find(s=>s.key===key).error);assert(sources.find(s=>s.key!==key).data);assert.equal(storage.values.get(key),'{broken');
});
test('read denial is reported and cannot authorize a replacement',async()=>{
 const storage={getItem(){throw Error('SecurityError');},setItem(){throw Error('must not write');}};
 const sources=R.inspect(storage);assert(sources.every(s=>s.readError));
 await assert.rejects(R.replace(book(),sources,{storage,confirmed:true}),/исходники|прочитать/);
});
test('inspection can avoid all legacy reads for an ordinary JSON import',()=>{
 const storage=memory([[S.KEY,serialized('Рабочая')]]);assert.equal(R.inspect(storage,false).length,1);
 assert(storage.ops.every(op=>[S.KEY,D.KEY].includes(op[1])));
});
test('manual recovery requires confirmation and cannot run as an automatic migration',async()=>{
 const env=setup([[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage);
 await assert.rejects(R.restore(sources[1],sources,{...env.options,confirmed:false}),/подтверждения/);
 assert.equal(env.storage.values.get(S.KEY),undefined);assert.equal(env.backups.length,0);
});
test('manual recovery creates durable literal copies before replacing only production',async()=>{
 const entries=[[S.KEY,serialized('Старая')],[R.LEGACY_KEY,serialized('Новая')],[D.KEY,drafts(draft('Рабочий черновик'))],[R.LEGACY_DRAFT_KEY,drafts(draft('Общий черновик'))]];
 const env=setup(entries),sources=R.inspect(env.storage);
 env.options.writeBackup=async backup=>{assert.equal(env.storage.values.get(S.KEY),entries[0][1]);env.backups.push(backup);};
 const result=await R.restore(sources[1],sources,env.options);assert(result.changed);assert.equal(S.load(env.storage).data.products[0].name,'Новая');
 assert.equal(env.backups.length,1);assert.equal(env.backups[0].sources[0].raw,entries[0][1]);assert.equal(env.backups[0].sources[1].raw,entries[1][1]);
 for(const [key,value]of entries.slice(1))assert.equal(env.storage.values.get(key),value);
 assert.deepEqual(env.storage.ops.filter(op=>op[0]==='set').map(op=>op[1]),[S.KEY]);
});
test('a missing production record stays absent if backup storage fails',async()=>{
 const env=setup([[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage);
 await assert.rejects(R.restore(sources[1],sources,{...env.options,writeBackup:async()=>{throw Error('backup quota');}}),/backup quota/);
 assert(!env.storage.values.has(S.KEY));assert.equal(env.storage.values.get(R.LEGACY_KEY),sources[1].raw);
});
test('corrupt production can be explicitly replaced only after preserving its literal bytes',async()=>{
 const env=setup([[S.KEY,'{damaged'],[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage);
 await R.restore(sources[1],sources,env.options);assert.equal(env.backups[0].sources[0].raw,'{damaged');assert.equal(S.load(env.storage).data.products[0].name,'Новая');
});
test('quota failure rolls back only newly staged photos and preserves both databases/drafts',async()=>{
 const env=setup([[S.KEY,serialized('Старая')],[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage),before=[...env.storage.values];
 env.storage.setItem=()=>{throw Error('QuotaExceededError');};
 await assert.rejects(R.restore(sources[1],sources,env.options),/QuotaExceededError/);assert.deepEqual([...env.storage.values],before);assert.deepEqual(env.rolled,['staged-only']);assert.equal(env.backups.length,1);
});
test('photo preparation failure cannot replace a database',async()=>{
 const env=setup([[S.KEY,serialized('Старая')],[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage);
 env.photos.prepareImport=async()=>{throw Error('photo damaged');};
 await assert.rejects(R.restore(sources[1],sources,env.options),/photo damaged/);assert.equal(env.storage.values.get(S.KEY),sources[0].raw);
});
for(const key of [S.KEY,R.LEGACY_KEY,D.KEY,R.LEGACY_DRAFT_KEY])test('source changes during preparation abort commit: '+key,async()=>{
 const env=setup([[S.KEY,serialized('Старая')],[R.LEGACY_KEY,serialized('Новая')]]),sources=R.inspect(env.storage);
 env.photos.prepareImport=async data=>{env.storage.values.set(key,'other-tab');return {data,createdIds:['staged-only']};};
 await assert.rejects(R.restore(sources[1],sources,env.options),/другой вкладке/);
 assert.equal(env.storage.values.get(key),'other-tab');if(key!==S.KEY)assert.equal(env.storage.values.get(S.KEY),sources[0].raw);assert.deepEqual(env.rolled,['staged-only']);
});
test('repeated recovery neither duplicates records/photos nor creates another backup',async()=>{
 const env=setup([[R.LEGACY_KEY,serialized('Новая')]]);let sources=R.inspect(env.storage);
 await R.restore(sources[1],sources,env.options);const before=env.storage.values.get(S.KEY);sources=R.inspect(env.storage);
 assert.equal((await R.restore(sources[1],sources,env.options)).changed,false);assert.equal(env.storage.values.get(S.KEY),before);assert.equal(env.backups.length,1);
});
test('unknown fields are preserved in raw export and block lossy restoration',async()=>{
 const data=book();data.futureField={folder:'Ценная категория'};const raw=JSON.stringify(data),env=setup([[R.LEGACY_KEY,raw]]),sources=R.inspect(env.storage);
 assert.match(sources[1].error,/не поддерживается/);assert.equal(sources[1].raw,raw);await assert.rejects(R.restore(sources[1],sources,env.options),/не поддерживается/);assert.equal(env.backups.length,0);
});
test('old version-1 JSON without photos, packaging or portions still restores',async()=>{
 const env=setup([[R.LEGACY_KEY,JSON.stringify(Seed.create())]]),sources=R.inspect(env.storage);
 await R.restore(sources[1],sources,env.options);assert.deepEqual(S.load(env.storage).data,Seed.create());
});
test('conditional ordinary save rejects a different production source without overwriting it',()=>{
 const storage=memory([[S.KEY,serialized('Другая вкладка')]]),before=storage.values.get(S.KEY);
 assert.equal(S.save(book(),storage,null).ok,false);assert.equal(storage.values.get(S.KEY),before);
 const corrupt=memory([[S.KEY,'{bad']]);assert.equal(S.snapshot(corrupt).source,'{bad');assert.equal(S.snapshot(memory()).source,null);
});
test('legacy drafts preserve invalid fields and are copied once, leaving the source untouched',async()=>{
 const raw=drafts(draft()),env=setup([[R.LEGACY_DRAFT_KEY,raw]]);let sources=R.inspect(env.storage);
 const result=await R.copyDraft(sources[1],'draft-a','dish',sources,env.options);assert(result.changed);
 const saved=D.load(env.storage).items[0];assert.deepEqual(saved.invalidValues,draft().invalidValues);assert.deepEqual(saved.formValues,draft().formValues);assert.equal(env.storage.values.get(R.LEGACY_DRAFT_KEY),raw);
 sources=R.inspect(env.storage);assert.equal((await R.copyDraft(sources[1],'draft-a','dish',sources,env.options)).changed,false);assert.equal(D.load(env.storage).items.length,1);
});
test('a conflicting production draft is retained and the copied draft receives a new identity',async()=>{
 const own=draft('Своё незавершённое'),env=setup([[D.KEY,drafts(own)],[R.LEGACY_DRAFT_KEY,drafts(draft('После релиза'))]]),sources=R.inspect(env.storage);
 await R.copyDraft(sources[1],'draft-a','dish',sources,env.options);const saved=D.load(env.storage).items;
 assert.equal(saved.length,2);assert.deepEqual(saved.find(r=>r.id==='draft-a'),own);const copy=saved.find(r=>r.id!=='draft-a');assert.equal(copy.id,copy.data.id);assert.equal(copy.isNew,true);assert.equal(copy.data.name,'После релиза');
});
test('invalid draft JSON does not get cleared or prevent exporting its raw bytes',()=>{
 const env=setup([[R.LEGACY_DRAFT_KEY,'{broken drafts']]),source=R.inspect(env.storage)[1];assert(source.draftError);assert.equal(source.draftRaw,'{broken drafts');assert.equal(env.storage.values.get(R.LEGACY_DRAFT_KEY),source.draftRaw);
});
