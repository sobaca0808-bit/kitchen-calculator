(function(root,factory){
  const node=typeof module==='object'&&module.exports;
  const api=factory(root,node?require('./storage.js'):root.KitchenStorage,node?require('./drafts.js'):root.KitchenDrafts,node?require('./photos.js'):root.KitchenPhotos,node?require('./packaging.js'):root.KitchenPackaging);
  if(node)module.exports=api;else root.KitchenStorageRecovery=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root,S,D,Photos,P){
  'use strict';
  const LEGACY_KEY='kitchen-calculator-pr2-browser-test-v1';
  const LEGACY_DRAFT_KEY='kitchen-calculator-pr2-browser-drafts-v1';
  const LEGACY_PHOTO_DB='kitchen-calculator-test-photos-v1';
  const BACKUP_DB='kitchen-calculator-recovery-backups-v1';
  const SOURCES=Object.freeze([
    Object.freeze({id:'production',key:S.KEY,draftKey:D.KEY,name:'Рабочая база'}),
    Object.freeze({id:'legacy',key:LEGACY_KEY,draftKey:LEGACY_DRAFT_KEY,name:'Общая база ошибочного релиза и тестового сайта'})
  ]);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const storageOf=storage=>storage===undefined?root.localStorage:storage;
  const uid=prefix=>prefix+'-'+root.crypto.randomUUID();
  const assertSupported=S.assertSupported;
  // No legacy key is read until the user opens recovery. Normal operations use S/D.
  function inspect(storage,includeLegacy=true){
    return SOURCES.slice(0,includeLegacy?2:1).map(meta=>{
      const source={...meta,allowLegacyPhotos:includeLegacy,raw:undefined,draftRaw:undefined,data:null,items:[],error:null,draftError:null,readError:null,counts:null};
      try{
        const target=storageOf(storage);source.raw=target.getItem(meta.key);source.draftRaw=target.getItem(meta.draftKey);
        if(source.raw!==null){
          try{
            source.data=S.parseJSON(source.raw);
            source.counts={products:source.data.products.length,prep:source.data.recipes.filter(r=>r.type==='prep').length,dish:source.data.recipes.filter(r=>r.type==='dish').length,packaging:(source.data.packaging||[]).length};
            assertSupported(JSON.parse(source.raw),source.data);
          }catch(error){source.error=error.message;source.data=null;}
        }
        const drafts=D.load({getItem:()=>source.draftRaw});source.items=drafts.items;source.draftError=drafts.error;
      }catch(error){source.readError=error.message;source.error='Хранилище недоступно: '+error.message;}
      return source;
    });
  }
  function unchanged(sources,storage){
    const target=storageOf(storage);
    for(const source of sources){
      if(source.readError||source.raw===undefined||source.draftRaw===undefined)throw Error('Не удалось прочитать исходники. Запись заблокирована.');
      if(target.getItem(source.key)!==source.raw||target.getItem(source.draftKey)!==source.draftRaw)throw Error('Данные изменились в другой вкладке. Обновите список источников и повторите выбор.');
    }
  }
  // Opening a missing legacy DB is aborted, never creating/upgrading a test store.
  function readLegacyPhoto(id){
    return new Promise((resolve,reject)=>{
      let request,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(Error('Не удалось прочитать прежнее хранилище фото. Закройте другие вкладки и повторите.')),8000);
      try{request=root.indexedDB.open(LEGACY_PHOTO_DB);}catch(error){finish(error);return;}
      request.onupgradeneeded=()=>request.transaction.abort();
      request.onerror=()=>finish(Error('Прежняя фотография не найдена. Нужна резервная копия JSON с фото.'));
      request.onsuccess=()=>{
        const db=request.result;if(settled){db.close();return;}
        let tx,read;
        try{tx=db.transaction('photos','readonly');read=tx.objectStore('photos').get(id);}catch(error){db.close();finish(error);return;}
        tx.oncomplete=()=>{db.close();const record=read.result;finish(record?.blob?null:Error('Прежняя фотография не найдена: '+id),record);};
        tx.onerror=tx.onabort=()=>{db.close();finish(tx.error||Error('Не удалось прочитать прежнюю фотографию.'));};
      };
    });
  }
  function reader(source,photos=Photos){
    if(source.photoRecords)return async id=>{
      const record=source.photoRecords.find(r=>r.id===id);
      if(!record)throw Error('В копии нет фотографии '+id+'. Исходный JSON можно скачать отдельно.');
      return record;
    };
    return source.id==='legacy'?readLegacyPhoto:async id=>{
      try{return await photos.get(id);}catch(error){if(!source.allowLegacyPhotos)throw error;return readLegacyPhoto(id);}
    };
  }
  async function portable(source,photos=Photos){
    if(!source.data)throw Error(source.error||'В этом источнике нет сохранённой базы.');
    return photos.exportData(source.data,reader(source,photos));
  }
  async function archive(sources,{storage,photos=Photos,writeBackup=storeBackup}={}){
    unchanged(sources,storage);
    const saved=[];
    for(const source of sources){
      const photoRecords=[],missingPhotos=[],ids=new Set([...(source.data?.recipes||[]),...source.items.map(item=>item.data)].flatMap(recipe=>photos.ids(recipe)).filter(Boolean));
      for(const id of ids){
        try{const record=await reader(source,photos)(id);photoRecords.push({...record,id});}
        catch(error){missingPhotos.push({id,error:error.message});}
      }
      saved.push({...source,photoRecords,missingPhotos});
    }
    unchanged(sources,storage);
    const backup={id:uid('recovery'),createdAt:Date.now(),version:1,sources:saved};
    await writeBackup(backup);return backup;
  }
  async function replace(candidate,sources,options={}){
    if(options.confirmed!==true)throw Error('Восстановление требует явного подтверждения.');
    const photos=options.photos||Photos,target=storageOf(options.storage),current=sources.find(s=>s.key===S.KEY);
    if(!current)throw Error('Нет снимка рабочей базы.');
    // Same existing import boundary as app.persist; preserve packaging identities.
    const clean=P.resolveLinks(S.validate(candidate));assertSupported(candidate,clean);unchanged(sources,target);
    // Identical repeated restoration neither stages photos nor creates duplicates/backups.
    if(current.data){
      try{if(S.stringify(await photos.exportData(current.data))===S.stringify(clean))return {changed:false,data:current.data,source:current.raw};}catch(_){}
    }
    const backup=await archive(sources,{...options,storage:target});
    let prepared;
    try{
      prepared=await photos.prepareImport(clean);unchanged(sources,target);
      const result=S.save(prepared.data,target,current.raw);
      if(!result.ok)throw Error(result.error);
      // The only commit is one atomic production setItem, after durable backup.
      return {changed:true,data:prepared.data,source:S.stringify(prepared.data),backupId:backup.id};
    }catch(error){
      if(prepared)await photos.rollback(prepared.createdIds).catch(()=>{});
      throw error;
    }
  }
  async function restore(source,sources,options={}){
    unchanged(sources,options.storage);
    return replace(await portable(source,options.photos||Photos),sources,options);
  }
  async function copyDraft(source,id,type,sources,options={}){
    if(options.confirmed!==true)throw Error('Копирование черновика требует подтверждения.');
    unchanged(sources,options.storage);
    const original=source.items.find(r=>r.id===id&&r.type===type);
    if(!original||source.draftError)throw Error('Черновик недоступен. Скачайте исходную запись.');
    const digest=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(original)));
    const tag=source.key+':'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    const current=D.load(options.storage);if(current.error)throw Error(current.error);
    if(current.items.some(r=>r.recoverySource===tag))return {changed:false};
    const record=clone(original);record.recoverySource=tag;
    const ownRecipe=sources.find(s=>s.key===S.KEY)?.data?.recipes.find(r=>r.id===id),oldRecipe=source.data?.recipes.find(r=>r.id===id);
    const withoutPhotos=recipe=>{const value=clone(recipe);for(const key of ['photoId','photoIds','photo','photos'])delete value[key];return JSON.stringify(value);};
    if(current.items.some(r=>r.id===id&&r.type===type)||ownRecipe&&(!oldRecipe||withoutPhotos(ownRecipe)!==withoutPhotos(oldRecipe))){
      record.id=uid('recovered-draft');record.data.id=record.id;record.isNew=true;
    }
    // Row IDs are globally unique in the saved book. A copied draft must remain
    // saveable alongside the original recipe, including its raw invalid input.
    const rowIds=new Map();
    for(const row of [...record.data.ingredients,...(record.data.packaging||[])])if(typeof row.id==='string'){
      const next=uid('recovered-row');rowIds.set(row.id,next);row.id=next;
    }
    const fieldId=value=>{
      for(const [old,next]of [...rowIds].sort((a,b)=>b[0].length-a[0].length))if(value===old||value.endsWith('-'+old))return value.slice(0,value.length-old.length)+next;
      return value;
    };
    for(const field of record.formValues)field.id=fieldId(field.id);
    for(const field of ['invalidValues','errors'])for(const entry of record[field])entry[0]=fieldId(entry[0]);
    const photos=options.photos||Photos,values=photos.ids(original.data);
    let prepared;
    const snapshot=await archive(sources,options);
    try{
      const images=[];
      if(original.data.photos)images.push(...original.data.photos);
      else if(original.data.photo)images.push(original.data.photo,null);
      else for(const photoId of values)images.push(photoId?await photos.portablePhoto(photoId,reader(source,photos)):null);
      if(images.some(Boolean)){
        prepared=await photos.prepareImport({version:1,products:[],recipes:[{id:'draft-photos',type:'dish',name:'Фото черновика',note:'',actualYield:null,ingredients:[],photos:images}]});
        delete record.data.photo;delete record.data.photos;delete record.data.photoId;
        record.data.photoIds=prepared.data.recipes[0].photoIds;
      }
      unchanged(sources,options.storage);
      const target=storageOf(options.storage),expected=sources.find(s=>s.key===S.KEY).draftRaw;
      const guarded={getItem:key=>target.getItem(key),setItem:(key,value)=>{
        if(key!==D.KEY||target.getItem(D.KEY)!==expected)throw Error('Черновики изменились в другой вкладке. Обновите список источников.');
        target.setItem(key,value);
      }};
      const result=D.save(record,guarded);if(!result.ok)throw Error(result.error);
      return {changed:true,id:record.id,backupId:snapshot.id};
    }catch(error){if(prepared)await photos.rollback(prepared.createdIds).catch(()=>{});throw error;}
  }
  function backupOperation(mode,action){
    return new Promise((resolve,reject)=>{
      let request,settled=false;
      const timer=setTimeout(()=>{settled=true;reject(Error('Не удалось открыть резервные копии. Операция отменена.'));},8000);
      try{request=root.indexedDB.open(BACKUP_DB,1);}catch(error){clearTimeout(timer);reject(error);return;}
      request.onupgradeneeded=()=>request.result.createObjectStore('snapshots',{keyPath:'id'});
      request.onerror=()=>{clearTimeout(timer);reject(request.error||Error('Ошибка резервной копии.'));};
      request.onsuccess=()=>{
        const db=request.result;if(settled){db.close();return;}
        clearTimeout(timer);let tx,op;
        try{tx=db.transaction('snapshots',mode);op=action(tx.objectStore('snapshots'));}catch(error){db.close();reject(error);return;}
        tx.oncomplete=()=>{db.close();resolve(op.result);};
        tx.onerror=tx.onabort=()=>{db.close();reject(tx.error||op.error||Error('Резервная копия не сохранена. Возможно, недостаточно места.'));};
      };
    });
  }
  function storeBackup(backup){return backupOperation('readwrite',store=>store.add(backup));}
  async function listBackups(){
    const records=await backupOperation('readonly',store=>store.getAll());
    return records.sort((a,b)=>b.createdAt-a.createdAt);
  }
  return {LEGACY_KEY,LEGACY_DRAFT_KEY,LEGACY_PHOTO_DB,BACKUP_DB,SOURCES,assertSupported,inspect,unchanged,readLegacyPhoto,portable,archive,restore,replace,copyDraft,listBackups};
});
