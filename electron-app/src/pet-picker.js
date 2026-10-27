// Settings-only preview: selecting and playing cards never writes desktop preferences.
(() => {
  const actions = { idle:'待机', right:'向右行走', left:'向左行走', wave:'招手', jump:'跳跃', failed:'失落', waiting:'休息', working:'忙碌', review:'好奇 / 阅读' };
  const pixelMoods = { idle:'normal', jump:'happy', failed:'bored', waiting:'sleepy', working:'working', review:'reading' };
  const descriptions = { 'realistic-cockroach':'栗褐色翅鞘 · 随机快爬与停步探路', 'realistic-mosquito':'半透明薄翅 · 曲线飞行与悬停', liangzi:'经典黄纹短袖 · 写实人物动作', hamster:'鼓鼓腮帮子 · 抱着瓜子的奶油团子', seal:'雪白小团子 · 拍拍肚皮陪着你', koala:'圆圆绒耳朵 · 抱着桉树叶慢慢陪你', 'fluffy-rabbit':'奶油白绒毛 · 软乎乎的小尾巴', otter:'抱着贝壳，慢慢陪你', 'red-panda':'圈圈尾巴与一杯暖咖啡', 'baby-dragon':'圆滚滚的小翅膀', 'engineer-fox':'戴上护目镜，一起开工', cat:'灵巧好奇的猫咪工程师', dog:'温暖活泼的狗狗工程师', capybara:'吃草、发呆，悠闲自在' };
  const characterActions = {
    'realistic-cockroach': {idle:'摆触须',right:'右爬',left:'左爬',wave:'抬前足',jump:'窜一下',failed:'伏低',waiting:'静伏',working:'梳触须',review:'探路'},
    'realistic-mosquito': {idle:'悬停',right:'右飞',left:'左飞',wave:'抬前足',jump:'上飞',failed:'缓降',waiting:'落地',working:'梳理',review:'警觉'},
    liangzi: {idle:'待机',right:'右走',left:'左走',wave:'招手',jump:'小跳',waiting:'休息',working:'吃面',review:'点赞'},
    hamster: {idle:'眨眼',wave:'挥爪',jump:'蹦一下',waiting:'抱着睡',working:'嗑瓜子',review:'揉脸'},
    seal: {idle:'眨眼',right:'右挪',left:'左挪',wave:'挥鳍',jump:'弹一下',waiting:'趴平',working:'拍肚皮',review:'捂脸'},
    koala: {idle:'眨眼',wave:'挥爪',jump:'小跳',waiting:'打盹',working:'嚼叶子',review:'嗅叶子'},
    'fluffy-rabbit': {idle:'眨眼',right:'右蹦',left:'左蹦',wave:'挥爪',jump:'蹦高',waiting:'打盹',working:'洗脸',review:'嗅嗅'},
    otter: {wave:'挥爪',waiting:'躺平',working:'开贝壳',review:'看贝壳'},
    'red-panda': {working:'磨咖啡',review:'品咖啡'},
    'baby-dragon': {wave:'挥爪',jump:'扑翼跳',waiting:'盘尾睡',working:'练翅膀',review:'歪头'},
    capybara: {idle:'发呆',waiting:'打盹',working:'嚼叶子',review:'嗅嗅'},
  };
  const compactActions = {idle:'待机',right:'右行',left:'左行',wave:'招手',jump:'跳跃',failed:'失落',waiting:'休息',working:'忙碌',review:'阅读'};
  function mount(root, { animals, input, active = true }) {
    const atlas = window.DMPetAtlas, sprites = window.DMPetSprites;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let group = atlas.getManifest(input.value) || !Object.hasOwn(animals, input.value) ? 'animated' : 'pixel';
    let paused = false, elapsed = 0, lastTime = performance.now(), timer = null, disposed = false;
    const cards = [], cleanups = [];
    const listen = (target, event, fn) => { target.addEventListener(event,fn); cleanups.push(()=>target.removeEventListener(event,fn)); };
    const node = (tag, cls, text) => { const el=document.createElement(tag); if(cls)el.className=cls; if(text)el.textContent=text; return el; };
    root.classList.add('pet-picker');
    const header=node('div','pet-picker-header'), groups=node('div','pet-picker-groups');
    groups.setAttribute('role','group'); groups.setAttribute('aria-label','宠物风格');
    const selected=node('p','pet-picker-selection'); selected.setAttribute('aria-live','polite');
    const groupButtons = new Map();
    for(const [id,label] of [['animated','动画伙伴'],['pixel','像素伙伴']]) {
      const b=node('button','',label); b.type='button'; b.dataset.petGroup=id;
      listen(b,'click',()=>{group=id;sync();});
      groupButtons.set(id,b);groups.append(b);
    }
    header.append(groups,selected);root.append(header);
    const grid=node('div','pet-picker-grid');grid.setAttribute('role','radiogroup');grid.setAttribute('aria-label','宠物外形');
    const order=['realistic-cockroach','realistic-mosquito','liangzi','hamster','seal','koala','fluffy-rabbit','otter','red-panda','baby-dragon','engineer-fox','cat','dog','capybara',...Object.keys(animals)];
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries){const card=cards.find(c=>c.card===entry.target);if(card){card.visible=entry.isIntersecting;card.frame=null;}}
      refresh();
    },{root:grid});
    for(const animal of [...new Set(order)].filter(id=>Object.hasOwn(animals,id))) {
      const spec=atlas.getManifest(animal), card=node('article','pet-picker-card'), button=node('button','pet-picker-select');button.type='button';button.setAttribute('role','radio');button.setAttribute('aria-label',animals[animal]);button.dataset.petChoice=animal;
      const stage=node('span','pet-picker-stage'), canvas=node('canvas');canvas.setAttribute('aria-hidden','true');
      const badge=node('span','pet-picker-badge','已选');badge.setAttribute('aria-hidden','true');stage.append(canvas,badge);
      const info=node('span','pet-picker-info'), name=node('strong','',animals[animal]);
      const detail=node('small','',descriptions[animal]||'经典像素 · 四帧表情');info.append(name,detail);button.append(stage,info);card.append(button);grid.append(card);
      const c={animal,spec,card,button,action:'idle',started:elapsed,actionButtons:new Map(),canvas,ctx:canvas.getContext('2d'),detail,visible:false,frame:null,image:null,status:spec?'pending':'ready'};cards.push(c);observer.observe(card);
      const controls=node('div','pet-picker-card-actions');controls.setAttribute('role','group');controls.setAttribute('aria-label',`${animals[animal]}的动作预览`);
      for(const [id,label] of Object.entries(actions)) {
        if(!spec&&!pixelMoods[id])continue;
        const actionButton=node('button','',characterActions[animal]?.[id]||compactActions[id]);
        actionButton.type='button';actionButton.dataset.petPreviewAction=id;actionButton.dataset.petPreviewAnimal=animal;
        actionButton.setAttribute('aria-label',`${animals[animal]}：${actionButton.textContent}`);actionButton.title=label;
        actionButton.setAttribute('aria-pressed',String(id==='idle'));
        listen(actionButton,'click',()=>{
          c.action=id;c.started=elapsed;c.frame=null;
          for(const [key,b] of c.actionButtons)b.setAttribute('aria-pressed',String(key===id));
          // Previewing a gesture never changes the chosen pet or another card's action.
          refresh();
        });
        c.actionButtons.set(id,actionButton);controls.append(actionButton);
      }
      card.append(controls);
      listen(button,'click',()=>{input.value=animal;input.dispatchEvent(new Event('change',{bubbles:true}));});
      listen(button,'keydown',event=>{
        const visible=cards.filter(c=>!c.card.hidden);let index=visible.indexOf(c);
        if(['ArrowRight','ArrowDown'].includes(event.key))index=(index+1)%visible.length;
        else if(['ArrowLeft','ArrowUp'].includes(event.key))index=(index+visible.length-1)%visible.length;
        else if(event.key==='Home')index=0;else if(event.key==='End')index=visible.length-1;else return;
        event.preventDefault();event.stopPropagation();visible[index].button.focus();visible[index].button.click();
      });
    }
    root.append(grid);
    const footer=node('div','pet-picker-footer'), hint=node('span','','点击卡片选择，保存设置后应用到桌面。');
    const pause=node('button','','暂停动画'), background=node('button','','深色背景');pause.type=background.type='button';pause.dataset.petPreviewPause='';background.dataset.petPreviewBackground='';
    listen(pause,'click',()=>{paused=!paused;sync();});listen(background,'click',()=>{const dark=root.classList.toggle('pet-picker-dark');background.setAttribute('aria-pressed',String(dark));background.textContent=dark?'浅色背景':'深色背景';});
    background.setAttribute('aria-pressed','false');footer.append(hint,pause,background);root.append(footer);
    function invalidate(){for(const c of cards)c.frame=null;}
    function syncSelection(){
      selected.textContent=Object.hasOwn(animals,input.value) ? `已选择：${animals[input.value]}` : `已保留：${input.value}（当前版本暂不支持）`;
      const shown=cards.filter(c=>!c.card.hidden), focus=shown.find(c=>c.animal===input.value)||shown[0];
      for(const c of cards){const chosen=c.animal===input.value;c.card.dataset.selected=String(chosen);c.button.setAttribute('aria-checked',String(chosen));c.button.tabIndex=c===focus?0:-1;}
    }
    function sync(){
      root.dataset.group=group;
      for(const [id,b] of groupButtons)b.setAttribute('aria-pressed',String(id===group));
      for(const c of cards)c.card.hidden=c.button.hidden=Boolean(c.spec)!==(group==='animated');
      pause.textContent=paused?'播放动画':'暂停动画';pause.setAttribute('aria-pressed',String(paused));
      syncSelection();refresh();
    }
    function load(c){
      if(c.status!=='pending')return;c.status='loading';c.detail.textContent='正在加载…';
      atlas.loadImage(c.animal).then(image=>{if(disposed)return;c.image=image;c.status='ready';c.detail.textContent=descriptions[c.animal];c.frame=null;refresh();}).catch(()=>{
        if(disposed)return;c.status='failed';c.detail.textContent=c.spec.fallback?'图集未能加载，显示像素外形':'图集未能加载';c.frame=null;refresh();
      });
    }
    function draw(){
      for(const c of cards){
        if(c.card.hidden||!c.visible)continue;
        load(c);
        const spec=c.spec, action=c.action, motionFrame=motion.matches?0:Math.max(0,elapsed-c.started);
        const frames=spec?.actions[action], frame=frames?Math.floor(motionFrame*frames.fps/1000)%frames.frames:Math.floor(motionFrame/420)%4;
        const key=`${action}/${frame}/${c.status}/${window.devicePixelRatio}`;if(c.frame===key)continue;c.frame=key;
        c.canvas.dataset.action=action;c.canvas.dataset.frame=String(frame);c.canvas.dataset.status=c.status;
        if(c.image){
          const size=Math.round(160*Math.min(3,window.devicePixelRatio||1));if(c.canvas.width!==size){c.canvas.width=c.canvas.height=size;}
          const ctx=c.ctx;ctx.clearRect(0,0,size,size);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
          const scale=size/spec.cellHeight,offset=(size-spec.cellWidth*scale)/2;
          atlas.drawFrame(ctx,c.image,spec,frames.row,frame,spec.cellWidth*scale,size,offset);
        }else if(!spec||(c.status==='failed'&&spec.fallback)){
          c.canvas.width=c.canvas.height=32;c.canvas.classList.add('pet-picker-pixel');
          c.ctx.putImageData(new ImageData(sprites.render(spec?.fallback||c.animal,pixelMoods[action]||'normal',frame%4),32,32),0,0);
        }
      }
    }
    function refresh(){
      clearTimeout(timer);timer=null;
      if(disposed)return;
      if(!root.isConnected){destroy();return;}
      const now=performance.now();
      if(active&&!document.hidden&&!paused&&!motion.matches)elapsed+=Math.min(now-lastTime,150);
      lastTime=now;
      if(!active||document.hidden)return;
      draw();
      if(!paused&&!motion.matches&&cards.some(c=>c.visible&&!c.card.hidden))timer=setTimeout(refresh,100);
    }
    function setActive(value){active=value;lastTime=performance.now();refresh();}
    function externalSync(){group=atlas.getManifest(input.value)||!Object.hasOwn(animals,input.value)?'animated':'pixel';invalidate();sync();}
    function destroy(){if(disposed)return;disposed=true;clearTimeout(timer);observer.disconnect();cleanups.forEach(fn=>fn());}
    listen(input,'change',externalSync);listen(document,'visibilitychange',()=>{lastTime=performance.now();refresh();});
    listen(motion,'change',()=>{invalidate();refresh();});listen(window,'unload',destroy);
    sync();return {setActive,sync:externalSync,destroy};
  }
  window.DMPetPicker={mount};
})();
