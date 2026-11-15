(function(root){
  'use strict';
  const R=root.KitchenStorageRecovery,S=root.KitchenStorage;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function download(text,name){
    const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'})),link=document.createElement('a');
    link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function mount(callbacks){
    const panel=document.querySelector('#storage-recovery'),open=document.querySelector('#storage-recovery-open'),list=panel.querySelector('#recovery-sources'),status=panel.querySelector('#recovery-status');
    let sources=[],busy=false;
    const report=(text,error=false)=>{status.textContent=text;status.classList.toggle('inline-error',error);};
    const rawDownload=(source,draft=false)=>download(draft?source.draftRaw:source.raw,'kitchen-calculator-'+source.id+(draft?'-drafts-raw':'-raw')+'-'+Date.now()+'.json');
    function checkpoint(){
      const fresh=R.inspect();
      for(const previous of sources){
        const next=fresh.find(s=>s.id===previous.id);
        if(next.raw!==previous.raw||next.readError||next.id==='legacy'&&next.draftRaw!==previous.draftRaw)throw Error('Источник изменился. Обновите список и проверьте его заново.');
      }
      // canStart may have just flushed the open production draft. Include it in backup.
      sources=fresh;
    }
    async function run(action){
      if(busy)return;
      busy=true;panel.setAttribute('aria-busy','true');
      for(const button of panel.querySelectorAll('button'))button.disabled=true;
      try{await action();}catch(error){report(error.message+' Исходные базы не очищены. При изменении источников нажмите «Обновить список».',true);}
      finally{busy=false;panel.setAttribute('aria-busy','false');render();}
    }
    function render(){
      list.innerHTML=sources.map(source=>{
        const c=source.counts;
        return `<article class="recovery-source"><h3>${esc(source.name)}</h3><code>${esc(source.key)}</code><p>${source.error?'<span class="inline-error">'+esc(source.error)+'</span>':source.raw===null?'Сохранённой базы нет.':`Продуктов: ${c.products} · Полуфабрикатов: ${c.prep} · Блюд: ${c.dish} · Упаковки: ${c.packaging}`}</p>${source.data?'<p class="field-help">Примеры рецептов: '+esc(source.data.recipes.slice(0,5).map(r=>r.name).join('; ')||'нет')+'</p>':''}<div class="recovery-actions"><button data-raw="${source.id}" ${typeof source.raw!=='string'?'disabled':''}>Скачать исходный JSON</button><button data-portable="${source.id}" ${!source.data?'disabled':''}>Скачать JSON с фото</button><button data-recover="${source.id}" ${!source.data?'disabled':''}>Восстановить эту базу</button></div><details><summary>Черновики: ${source.items.length}${source.draftError?' · ошибка':''}</summary><p>${source.draftError?esc(source.draftError):'Основная карточка не изменится при копировании черновика. Если такой черновик уже есть, создаётся отдельная копия.'}</p><button data-draft-raw="${source.id}" ${typeof source.draftRaw!=='string'?'disabled':''}>Скачать исходные черновики</button>${source.id==='legacy'?source.items.map(record=>`<div class="recovery-draft"><span>${esc(record.data.name||'Без названия')} · ${record.type==='prep'?'Полуфабрикат':'Блюдо'}</span><button data-copy-draft="${esc(record.id)}" data-type="${record.type}">Копировать черновик в рабочую версию</button></div>`).join(''):''}</details></article>`;
      }).join('');
      list.querySelectorAll('[data-raw]').forEach(button=>button.onclick=()=>rawDownload(sources.find(s=>s.id===button.dataset.raw)));
      list.querySelectorAll('[data-draft-raw]').forEach(button=>button.onclick=()=>rawDownload(sources.find(s=>s.id===button.dataset.draftRaw),true));
      list.querySelectorAll('[data-portable]').forEach(button=>button.onclick=()=>run(async()=>{
        const source=sources.find(s=>s.id===button.dataset.portable),data=await R.portable(source);
        download(S.stringify(data),'kitchen-calculator-'+source.id+'-with-photos-'+Date.now()+'.json');report('JSON с фотографиями подготовлен. Убедитесь, что файл появился в загрузках.');
      }));
      list.querySelectorAll('[data-recover]').forEach(button=>button.onclick=()=>run(async()=>{
        const source=sources.find(s=>s.id===button.dataset.recover);
        if(!document.querySelector('#recovery-ack').checked){report('Подтвердите, что проверили источник: общая база может принадлежать тестовому сайту.',true);return;}
        if(!callbacks.canStart())return;
        checkpoint();
        const c=source.counts;
        if(!confirm(`Восстановить «${source.name}» в рабочей версии? Продуктов: ${c.products}, полуфабрикатов: ${c.prep}, блюд: ${c.dish}. Текущая рабочая база будет заменена только после резервного копирования. Общая база и прежние черновики останутся без изменений. Автоматического объединения нет.`)){report('Восстановление отменено. Обе базы сохранены.');return;}
        callbacks.begin();
        try{
          const result=await R.restore(source,sources,{confirmed:true});callbacks.restored(result);
          sources=R.inspect();report(result.changed?'База восстановлена и сохранена в рабочем хранилище. Предыдущие записи доступны в резервных копиях. Черновики копируются отдельно.':'Эта база уже сохранена. Повторные записи и фотографии не созданы.');
        }finally{callbacks.end();}
      }));
      list.querySelectorAll('[data-copy-draft]').forEach(button=>button.onclick=()=>run(async()=>{
        if(!callbacks.canStart())return;
        checkpoint();
        if(!confirm('Скопировать выбранный черновик и его фотографии в рабочую версию? Прежние черновики не удаляются и не заменяются.')){report('Копирование отменено.');return;}
        callbacks.begin();
        try{
          const result=await R.copyDraft(sources.find(s=>s.id==='legacy'),button.dataset.copyDraft,button.dataset.type,sources,{confirmed:true});
          callbacks.draftsChanged();sources=R.inspect();report(result.changed?'Черновик скопирован. Откройте его в разделе «Незавершённые рецепты».':'Этот черновик уже скопирован. Дубликат не создан.');
        }finally{callbacks.end();}
      }));
      for(const button of panel.querySelectorAll('button'))if(!list.contains(button))button.disabled=false;
    }
    open.addEventListener('click',()=>{
      if(busy)return;
      panel.hidden=false;open.setAttribute('aria-expanded','true');sources=R.inspect();render();report('Выберите и проверьте источник. Ничего не переносится автоматически.');panel.querySelector('h2').focus({preventScroll:true});
    });
    document.querySelector('#recovery-refresh').onclick=()=>{sources=R.inspect();render();report('Список источников обновлён. Запись в базы не выполнялась.');};
    const close=()=>{if(busy)return;panel.hidden=true;open.setAttribute('aria-expanded','false');open.focus();};
    document.querySelector('#recovery-close').onclick=close;
    panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
    document.querySelector('#recovery-backups-open').onclick=()=>run(async()=>{
      const backups=await R.listBackups(),host=document.querySelector('#recovery-backups');
      host.hidden=false;host.replaceChildren();
      if(!backups.length){host.textContent='Сохранённых копий пока нет.';return;}
      for(const backup of backups){
        const article=document.createElement('article'),heading=document.createElement('h3');heading.textContent='Копия '+new Date(backup.createdAt).toLocaleString('ru-RU');article.append(heading);
        for(const source of backup.sources){
          const label=document.createElement('p');label.textContent=source.name;article.append(label);
          if(typeof source.raw==='string'){
            const raw=document.createElement('button');raw.textContent='Скачать исходный JSON';raw.onclick=()=>rawDownload(source);article.append(raw);
          }
          if(source.data){
            const portable=document.createElement('button');portable.textContent='Скачать JSON с фото из копии';portable.onclick=async()=>{
              try{download(S.stringify(await R.portable(source)),'kitchen-calculator-backup-'+backup.id+'-'+source.id+'.json');report('JSON из резервной копии подготовлен. Его можно проверить и импортировать обычной кнопкой «Импорт JSON».');}catch(error){report(error.message,true);}
            };article.append(portable);
          }
          if(typeof source.draftRaw==='string'){
            const drafts=document.createElement('button');drafts.textContent='Скачать исходные черновики';drafts.onclick=()=>rawDownload(source,true);article.append(drafts);
          }
          if(source.missingPhotos?.length){const warning=document.createElement('p');warning.textContent='В момент копирования не найдены фото: '+source.missingPhotos.map(p=>p.id).join(', ')+'. Исходные ссылки сохранены в JSON.';article.append(warning);}
        }
        host.append(article);
      }
      report('Копии открыты. Их просмотр и скачивание не меняют базы.');
    });
  }
  root.KitchenStorageRecoveryUI={mount};
})(globalThis);
