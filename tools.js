/* Upload requests and review workspace. Credentials and database writes stay on the server. */
(() => {
  const esc = escapeHtml;
  const state = { role: null, area: 'uploader', member: null, configured: false, adminReady: false, queue: [], filter: 'pending', shots: [], edit: null, busy: false, setupToken: '' };
  const labels = { pending: '승인 대기', approved: '승인 완료', changes_requested: '수정 요청', rejected: '반려', archived: '공개 중지' };
  // 서버(lib/tools-core.js SUBJECTS)와 같은 목록
  const SUBJECTS=['국어','수학','사회','과학','영어','도덕','실과(정보)','음악','미술','체육','통합교과','창의적 체험활동','교과 무관'];
  const inquiryLabels = { pending: '접수', answered: '답변 완료', closed: '종료' };
  const devLabels = { pending: '접수', reviewing: '검토 중', in_progress: '개발 중', done: '완료', rejected: '보류' };
  const workspace = document.createElement('dialog');
  workspace.id = 'workspace'; workspace.className = 'workspace'; workspace.setAttribute('aria-labelledby','workspaceTitle');
  document.body.append(workspace);
  const banner = document.createElement('p'); banner.className = 'sync-notice'; banner.hidden = true;
  document.querySelector('main.wrap').prepend(banner);
  const draftKey = 'chamcoding-upload-draft';
  let lastFocus, viewRevision=0, sessionFlight=null, sessionCheckedAt=0, sessionEpoch=0;
  function invalidateSession(){sessionEpoch++;sessionCheckedAt=0;sessionFlight=null;}

  async function api(action, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/tools?action=${action}`, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data;
    try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    if (!response.ok) {
      if (response.status === 401) {state.role = null;invalidateSession();}
      throw new Error(data.error || '요청을 처리하지 못했어요.');
    }
    if(['login','logout','setup','member-login','member-signup','member-logout'].includes(action))invalidateSession();
    return data;
  }
  function date(value) { return new Date(value).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'}); }
  function calendarDate(value) { return new Date(value).toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}); }
  function normalize(row) {
    return { ...row, cat: row.category, desc: row.description, created: calendarDate(row.created_at), updated: calendarDate(row.updated_at), uses: Number(row.uses || 0), notes: row.notes || [], subjects: row.subjects || [], screenshots: row.screenshots || [] };
  }
  async function loadApps() {
    try {
      const data = await api('apps');
      apps.splice(0, apps.length, ...data.apps.map(normalize));
      appsLoading = false; renderCatalog(); layout(); banner.hidden = true;
    } catch {
      // 서버 목록을 못 불러올 때만 예시 목록을 보여 준다
      apps.splice(0, apps.length, ...EXAMPLE_APPS.map(a => ({ ...a, is_example: true })));
      appsLoading = false; renderCatalog(); layout();
      banner.textContent = '최신 목록을 불러오지 못했어요. 연결을 확인한 뒤 새로고침해 주세요. 현재는 예시 목록을 보여드려요.';
      banner.hidden = false;
    }
  }
  function openShell(title, subtitle, active) {
    const revision=++viewRevision;
    const adminView=state.role==='admin' && state.area==='admin';
    hideAll();
    if (!workspace.open) { lastFocus = document.activeElement; workspace.showModal(); }
    document.body.style.overflow = 'hidden';
    workspace.innerHTML = `<header class="workspace-head"><div><span class="eyebrow">참코딩 · 함께 만드는 수업 도구</span><h2 id="workspaceTitle">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="close-workspace" aria-label="작업 창 닫기">✕</button></header>
      ${state.role && !['login','member','setup','devreq','inquiry'].includes(active) ? `<nav class="workspace-nav" aria-label="업로드 관리"><button type="button" data-view="upload" class="${active==='upload'?'active':''}">업로드 요청</button>${BULK_ENABLED?`<button type="button" data-view="bulk" class="${active==='bulk'?'active':''}">업로드 요청(Excel)</button>`:'<button type="button" disabled aria-disabled="true" title="아직 준비 중이에요">업로드 요청(Excel) <span class="wip">공사중</span></button>'}<button type="button" data-view="queue" class="${active==='queue'?'active':''}">${adminView?'요청 검토 · 앱 관리':'대기 목록'}</button>${adminView?`<button type="button" data-view="devqueue" class="${active==='devqueue'?'active':''}">앱 개발 요청</button><button type="button" data-view="inquiries" class="${active==='inquiries'?'active':''}">기타 문의</button><button type="button" data-view="settings" class="${active==='settings'?'active':''}">업로드 비밀번호</button>`:''}<span class="role-chip">${adminView?'관리자':'업로더'}</span><button type="button" class="logout">로그아웃</button></nav>`:''}
      <div class="workspace-content"><div id="workspaceBody"></div></div>`;
    return revision;
  }
  function closeWorkspace() {
    if (state.busy) return;
    workspace.close(); document.body.style.overflow = ''; lastFocus?.focus();
  }
  workspace.addEventListener('cancel', e => { if (state.busy) e.preventDefault(); });
  workspace.addEventListener('close', () => { viewRevision++; document.body.style.overflow = ''; state.shots.forEach(revokePreview); state.shots = []; state.bulk = null; });
  function errorIn(form, error) {
    const target = form.querySelector('.form-error');
    if (target) { target.textContent = error.message; target.hidden = false; target.scrollIntoView({block:'nearest'}); }
    else toast(error.message);
  }
  async function withBusy(form, task) {
    if (state.busy) return;
    state.busy = true;
    form.setAttribute('aria-busy','true');
    const buttons = [...form.querySelectorAll('button[type="submit"]')], labels=buttons.map(b=>b.textContent); buttons.forEach(b => {b.disabled = true;b.textContent='처리 중…';});
    try { await task(); } catch (error) { errorIn(form,error); }
    finally { state.busy = false; form.removeAttribute('aria-busy'); buttons.forEach((b,i) => {b.disabled = false;b.textContent=labels[i];}); }
  }
  function refreshSession(force=false) {
    if(!force && sessionCheckedAt && Date.now()-sessionCheckedAt<15000)return Promise.resolve(state);
    if(sessionFlight)return sessionFlight;
    const epoch=sessionEpoch;
    const flight=api('session').then(session=>{
      if(epoch!==sessionEpoch)return refreshSession();
      Object.assign(state,session);sessionCheckedAt=Date.now();
      syncChrome();
      return session;
    }).finally(()=>{if(sessionFlight===flight)sessionFlight=null;});
    sessionFlight=flight;return flight;
  }
  function syncChrome(){
    $('#adminMenuButton').hidden=state.role!=='admin';
    $('#memberButton').textContent=state.member?'내 계정':'로그인';
  }
  function loadingShell(title,active='loading'){
    const revision=openShell(title,'잠시만 기다려 주세요.',active);
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">접속 상태를 확인하고 있어요…</p><p class="form-error" role="alert" hidden></p>';
    return revision;
  }
  async function enter(view) {
    state.area=view==='admin'?'admin':'uploader';
    const revision=loadingShell(view==='admin'?'관리자':'업로드 요청','login');
    try {
      await refreshSession();
      if(revision!==viewRevision||!workspace.open)return;
      if(view==='admin'&&state.role!=='admin')return login('admin','queue');
      if(!state.role)return login('uploader',view);
      if(view==='upload')uploadForm();else await queueView();
    } catch(error){if(revision===viewRevision)errorIn($('#workspaceBody'),error);}
  }
  function login(kind, next) {
    const admin = kind === 'admin';
    openShell(admin ? '관리자 로그인' : '업로더 입장', admin ? '승인과 수정은 관리자 계정으로 진행해요.' : '연구회 공통 비밀번호를 입력해 주세요.','login');
    $('#workspaceBody').innerHTML = `<form id="loginForm" class="entry-form">
      <div class="entry-icon">${admin?'🔑':'📤'}</div>
      ${admin?'<label class="field"><span>관리자 아이디</span><input name="username" autocomplete="username" maxlength="80" required></label>':''}
      <label class="field"><span>${admin?'관리자 비밀번호':'공통 비밀번호'}</span><input name="password" type="password" autocomplete="${admin?'current-password':'off'}" required maxlength="256"></label>
      <p class="form-error" role="alert" hidden></p><button class="btn solid submit" type="submit">${admin?'관리자 로그인':'업로더 입장하기'}</button>
      ${admin&&!state.adminReady?'<p class="field-help">관리자 계정은 아직 등록되지 않았어요. 소유자 전용 등록 링크에서 마지막 설정을 마쳐 주세요.</p>':''}
      <p class="field-help">${admin?'등록된 관리자만 요청을 승인하거나 수정할 수 있어요.':'요청한 앱은 관리자 승인 후 공개돼요.'}</p></form>`;
    const form = $('#loginForm');
    form.addEventListener('submit', e => { e.preventDefault(); withBusy(form,async()=>{
      const body = Object.fromEntries(new FormData(form)); body.kind = kind;
      const data = await api('login',{method:'POST',body}); state.role=data.role; syncChrome(); form.reset();
      // Leave withBusy before rendering the next form.
      if (next==='upload') uploadForm(); else await queueView();
    }); });
    form.querySelector('input')?.focus();
  }
  // 관리자 로그인은 회원 로그인 창(로그인 상태면 내 계정 창) 아래에서 들어간다
  const adminEntry='<div class="admin-entry"><span>참코딩 운영자이신가요?</span><button type="button" class="btn line" data-admin-login>관리자로 로그인</button></div>';
  async function memberEntry(mode='login') {
    const revision=loadingShell(mode==='signup'?'회원가입':'회원 로그인','member');
    try {await refreshSession();} catch(error){if(revision===viewRevision)errorIn($('#workspaceBody'),error);return;}
    if(revision!==viewRevision||!workspace.open)return;
    if(state.member){
      openShell('내 계정','참코딩 회원 정보와 콘텐츠 이용 권한을 확인해요.','member');
      $('#workspaceBody').innerHTML=`<div class="entry-form"><div class="entry-icon">👤</div><h3>${esc(state.member.name)}님</h3><p class="field-help">${esc(state.member.email)}</p><p class="membership-state">${state.member.contentAccess?'회원 전용 콘텐츠 이용 권한이 있어요.':'콘텐츠 이용 권한 확인이 필요해요.'}</p><p class="field-help">회원 전용 콘텐츠는 준비되는 대로 추가돼요.</p><button type="button" class="btn line" id="memberLogout">회원 로그아웃</button></div>${adminEntry}`;
      $('#memberLogout').onclick=async()=>{try{await api('member-logout',{method:'POST',body:{}});state.member=null;await refreshSession();closeWorkspace();toast('로그아웃했어요.');}catch(error){toast(error.message);}};
      return;
    }
    const signup=mode==='signup';
    openShell(signup?'회원가입':'회원 로그인','참코딩 회원으로 로그인하고 회원 전용 콘텐츠를 이용하세요.','member');
    $('#workspaceBody').innerHTML=`<form id="memberForm" class="entry-form"><div class="tabs"><button type="button" data-member-mode="login" class="${!signup?'on':''}">로그인</button><button type="button" data-member-mode="signup" class="${signup?'on':''}">회원가입</button></div>${signup?field('이름','name','',{max:60}):''}${field('이메일','email','',{type:'email',max:254})}<label class="field"><span>비밀번호 *</span><input type="password" name="password" minlength="8" maxlength="256" autocomplete="${signup?'new-password':'current-password'}" required></label>${signup?'<label class="field"><span>비밀번호 확인 *</span><input type="password" name="confirm" minlength="8" maxlength="256" autocomplete="new-password" required></label><p class="field-help">가입 후 받은 인증 메일의 링크를 눌러 이메일을 확인해 주세요.</p>':''}<p class="form-error" role="alert" hidden></p><button type="submit" class="btn solid submit">${signup?'회원가입':'로그인'}</button></form>${signup?'':adminEntry}`;
    $('#memberForm').onsubmit=e=>{e.preventDefault();const form=e.target;withBusy(form,async()=>{
      const data=Object.fromEntries(new FormData(form));
      if(signup&&data.password!==data.confirm)throw new Error('비밀번호 확인이 일치하지 않아요.');
      const result=await api(signup?'member-signup':'member-login',{method:'POST',body:data});form.reset();
      if(signup&&result.needsConfirmation){$('#workspaceBody').innerHTML='<div class="success-state"><span>✉️</span><h3>이메일을 확인해 주세요</h3><p>인증 메일의 링크를 누른 뒤 다시 로그인해 주세요.</p><button class="btn solid" data-member-mode="login">로그인으로 이동</button></div>';}
      else{await refreshSession();await memberEntry();}
    });};
  }
  async function passwordSettings() {
    if(state.role!=='admin'||state.area!=='admin')return;
    const revision=openShell('업로드 비밀번호 변경','업로더가 요청 폼에 입장할 때 사용하는 공통 비밀번호를 관리해요.','settings');
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">설정을 불러오고 있어요…</p>';
    try {
      const settings=await api('upload-password');
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<form id="uploadPasswordForm" class="entry-form"><div class="entry-icon">🔐</div><p class="field-help">${settings.updatedAt?`마지막 변경: ${esc(new Date(settings.updatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}`:'아직 웹앱에서 비밀번호를 변경하지 않았어요.'}</p>
        <label class="field"><span>현재 관리자 비밀번호</span><input name="adminPassword" type="password" autocomplete="current-password" maxlength="256" required></label>
        <label class="field"><span>새 업로드 비밀번호</span><input name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required><small class="field-help">앞뒤 공백 없이 8자 이상 입력해 주세요.</small></label>
        <label class="field"><span>새 업로드 비밀번호 확인</span><input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="256" required></label>
        <p class="soon">저장하면 즉시 적용돼요. 기존 업로더는 새 비밀번호로 다시 입장해야 해요.</p><p class="form-error" role="alert" hidden></p><p class="password-result" role="status" aria-live="polite"></p><button class="btn solid submit" type="submit">업로드 비밀번호 변경</button></form>`;
      const form=$('#uploadPasswordForm');
      form.addEventListener('submit',e=>{e.preventDefault();withBusy(form,async()=>{
        const body=Object.fromEntries(new FormData(form));
        if(body.newPassword!==body.confirmPassword)throw new Error('새 비밀번호 확인이 일치하지 않아요.');
        const result=await api('upload-password',{method:'POST',body:{...body,expectedUpdatedAt:settings.updatedAt}});
        settings.updatedAt=result.updatedAt;form.reset();form.querySelector('.form-error').hidden=true;
        form.querySelector('.password-result').textContent='비밀번호를 변경했어요. 새 비밀번호부터 사용할 수 있어요.';
        toast('업로드 비밀번호를 변경했어요.');
      });});
    } catch(error) {
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<p class="form-error" role="alert">${esc(error.message)}</p><button type="button" data-view="settings" class="btn line">다시 불러오기</button>`;
    }
  }
  function loadDraft() { try { return JSON.parse(sessionStorage.getItem(draftKey) || '{}'); } catch { return {}; } }
  function saveDraft(form) {
    if (state.edit) return;
    const data = Object.fromEntries(new FormData(form)); delete data.screenshots; data.subjects=new FormData(form).getAll('subjects');
    try { sessionStorage.setItem(draftKey,JSON.stringify(data)); } catch {}
  }
  /* 적용 학년: 학교급과 시작·끝 학년을 골라 '초등학교 4-6학년'처럼 저장한다(홈 화면의 학교급 분류에 쓰임). */
  const SCHOOL_LEVELS={'초등학교':6,'중학교':3,'고등학교':3};
  function parseGrade(value=''){
    const text=String(value).trim(),level=Object.keys(SCHOOL_LEVELS).find(l=>text.startsWith(l))||'초등학교',max=SCHOOL_LEVELS[level];
    const m=text.match(/(\d)\s*[-~]\s*(\d)/)||text.match(/(\d)\s*학년/);
    let from=m?Number(m[1]):1,to=m?Number(m[2]||m[1]):max;
    if(!m&&/전학년/.test(text)){from=1;to=max;}
    from=Math.min(Math.max(from,1),max);to=Math.min(Math.max(to,from),max);
    return {level,from,to,text:`${level} ${from}-${to}학년`,valid:!!m||/전학년/.test(text)};
  }
  function gradeField(value){
    const g=parseGrade(value),opts=(max,sel)=>Array.from({length:max},(_,i)=>`<option value="${i+1}" ${sel===i+1?'selected':''}>${i+1}학년</option>`).join('');
    return `<div class="field grade-pick"><span>적용 학년 <b class="required">*</b></span><div class="grade-row">
      <select data-grade-level aria-label="학교급">${Object.keys(SCHOOL_LEVELS).map(l=>`<option ${g.level===l?'selected':''}>${l}</option>`).join('')}</select>
      <select data-grade-from aria-label="시작 학년">${opts(SCHOOL_LEVELS[g.level],g.from)}</select><span class="grade-dash">–</span>
      <select data-grade-to aria-label="끝 학년">${opts(SCHOOL_LEVELS[g.level],g.to)}</select></div>
      <input type="hidden" name="grade" value="${esc(g.text)}"><small class="field-help">학교급과 학년 범위를 골라 주세요. 예: 4-6학년(4~6학년), 3-3학년(3학년만)</small></div>`;
  }
  // 학교급을 바꾸면 학년 목록(초 1~6, 중·고 1~3)을 다시 만들고, 끝 학년이 시작 학년보다 앞서지 않게 맞춘다
  workspace.addEventListener('change',e=>{
    const box=e.target.closest('.grade-pick');if(!box)return;
    const level=box.querySelector('[data-grade-level]').value,max=SCHOOL_LEVELS[level],fromEl=box.querySelector('[data-grade-from]'),toEl=box.querySelector('[data-grade-to]');
    if(e.target.matches('[data-grade-level]')){
      const keep=(el,v)=>{el.innerHTML=Array.from({length:max},(_,i)=>`<option value="${i+1}">${i+1}학년</option>`).join('');el.value=String(Math.min(v,max));};
      keep(fromEl,Number(fromEl.value));keep(toEl,Number(toEl.value));
    }
    if(Number(toEl.value)<Number(fromEl.value)){if(e.target===toEl)fromEl.value=toEl.value;else toEl.value=fromEl.value;}
    const hidden=box.querySelector('input[name="grade"]');hidden.value=`${level} ${fromEl.value}-${toEl.value}학년`;
    hidden.dispatchEvent(new Event('input',{bubbles:true}));   // 임시 저장(초안)도 갱신
  });
  const field = (label,name,value,{required=true,type='text',max=200,placeholder='',help=''}={}) => `<label class="field"><span>${label}${required?' <b class="required">*</b>':''}</span><input name="${name}" type="${type}" value="${esc(value||'')}" ${required?'required':''} maxlength="${max}" placeholder="${esc(placeholder)}">${help?`<small class="field-help">${help}</small>`:''}</label>`;
  function uploadForm(row = null) {
    state.area=row?'admin':'uploader';
    state.shots.forEach(revokePreview);
    state.edit = row;
    const value = row ? {...row,cat:row.category,notes:row.notes.join('\n')} : loadDraft();
    state.shots = (row?.screenshots || []).map(s=>({...s,key:crypto.randomUUID()}));
    openShell(row?'요청 검토 · 내용 수정':'웹앱 업로드 요청',row?'내용을 확인하고 상태를 선택해 저장해 주세요.':'만든 웹앱을 소개해 주세요. 승인 후 참코딩에 함께 올라가요.','upload');
    $('#workspaceBody').innerHTML = `<form id="appForm" class="app-form">${row?'':`<div class="bulk-entry"><div><b>엑셀로 여러 개 한 번에 올리기</b><p>양식은 다음 화면에서 받을 수 있어요. AI에게 작성을 맡기고, 작성된 엑셀과 이미지를 함께 올리면 바로 승인 대기로 등록돼요.</p></div>${BULK_ENABLED?'<button type="button" class="btn solid" data-view="bulk">업로드 요청(Excel)</button>':'<button type="button" class="btn solid" disabled aria-disabled="true">업로드 요청(Excel) <span class="wip">공사중</span></button>'}</div>`}
      <div class="form-intro"><span>01</span><div><h3>기본 정보</h3><p>예시 앱의 카드와 상세 화면에 표시될 내용이에요.</p></div></div>
      <div class="form-grid">${field('앱 이름','name',value.name,{max:60,placeholder:'예: 우리 반 모둠 뽑기'})}${field('제작자 이름','author_name',value.author_name,{max:60,placeholder:'이름 또는 연구회 이름'})}</div>
      ${field('웹앱 주소','web_url',value.web_url,{required:!row?.is_example,type:'url',max:2000,placeholder:'https://my-app.vercel.app',help:'승인 후 ‘열기’ 버튼에 연결돼요. 공개된 https 주소를 입력해 주세요.'})}
      ${field('체험하기 주소','demo_url',value.demo_url,{required:false,type:'url',max:2000,placeholder:'https://…',help:'체험용 주소가 따로 있는 경우에만 입력해 주세요.'})}
      ${field('소개 영상 주소','video_url',value.video_url,{required:false,type:'url',max:2000,placeholder:'https://youtu.be/…',help:'앱을 소개하는 영상 링크예요. 유튜브·비메오 주소는 상세 화면 안에서 바로 재생돼요.'})}
      <div class="form-grid"><label class="field"><span>카테고리 <b class="required">*</b></span><select name="cat" required>${CATS.filter(c=>c.k!=='all').map(c=>`<option value="${c.k}" ${value.cat===c.k?'selected':''}>${c.icon} ${c.name}</option>`).join('')}</select></label>
      ${gradeField(value.grade)}</div>
      <fieldset class="field subject-pick"><legend>교과 <b class="required">*</b> <small>여러 개 고를 수 있어요</small></legend><div class="subject-list">${SUBJECTS.map(v=>`<label><input type="checkbox" name="subjects" value="${esc(v)}" ${(value.subjects||[]).includes(v)?'checked':''}><span>${esc(v)}</span></label>`).join('')}</div></fieldset>
      ${field('대표 색상','color',value.color||'#ffd23f',{type:'color',max:7})}
      <label class="file-drop thumbnail-drop"><span>대표 썸네일 사진 *</span><small>정사각형 3D 카드에 표시돼요. 첫 번째 이미지가 대표 썸네일이에요.</small><input id="thumbnailFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
      ${field('한 줄 소개','short',value.short,{max:160,placeholder:'어떤 수업에서 어떻게 쓰는 앱인지 짧게 알려 주세요.'})}
      <label class="field"><span>상세 설명 <b class="required">*</b></span><textarea name="description" rows="6" maxlength="6000" required placeholder="앱의 목적, 사용 방법, 준비물과 수업 활용 팁을 적어 주세요.">${esc(value.description||'')}</textarea></label>
      <label class="field"><span>새로운 소식 · 변경 사항</span><textarea name="notes" rows="3" maxlength="3000" placeholder="상세 화면의 ‘새로운 소식’에 보여요. 한 줄에 한 가지씩, 최대 12개">${esc(value.notes||'')}</textarea></label>
      <div class="form-intro"><span>02</span><div><h3>스크린샷과 설명</h3><p>썸네일을 포함해 최대 6장을 등록해 주세요. 첫 사진을 대표 썸네일로 사용해요. 학생의 개인정보는 가려 주세요.</p></div></div>
      <div id="shotEditor" class="shot-editor"></div>
      <label class="file-drop"><span>＋ 스크린샷 추가</span><small>PNG · JPG · WebP / 한 번에 최대 6장 / 자동 크기 조정</small><input id="screenshotFiles" name="screenshots" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>
      <div class="form-intro"><span>03</span><div><h3>연락과 검토</h3><p>연락 이메일은 관리자에게만 보여요.</p></div></div>
      ${field('연락 이메일','contact_email',value.contact_email,{type:'email',required:false,max:254,placeholder:'teacher@school.kr'})}
      ${row?`<div class="review-box"><div class="form-grid"><label class="field"><span>처리 상태 <b class="required">*</b></span><select name="status">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${row.status===key?'selected':''}>${label}</option>`).join('')}</select></label><p class="field-help">승인 완료로 저장하면 공개 목록에 표시돼요. 반려·공개 중지는 목록에서 숨겨져요.</p></div><label class="consent featured-check"><input name="featured" type="checkbox" ${row.featured?'checked':''}> 메인 홍보 배너에 표시 <small>승인된 앱만 최상단 배너에 나와요. 여러 개를 고르면 번갈아 보여줘요.</small></label><label class="field"><span>검토 메모 · 수정 요청 사유</span><textarea name="review_note" rows="3" maxlength="2000">${esc(row.review_note)}</textarea></label><p class="field-help">등록 ${date(row.created_at)} · 최종 수정 ${date(row.updated_at)}</p></div>`:
      '<p class="field-help">등록일과 업데이트일은 자동으로 기록해요. 입력한 내용과 스크린샷은 관리자 승인 후 공개돼요.</p><label class="consent"><input name="consent" type="checkbox" required> 앱과 스크린샷을 공개할 권한이 있으며, 학생의 개인정보가 포함되지 않았음을 확인했어요.</label>'}
      <p class="form-error" role="alert" hidden></p><p class="upload-progress" role="status" aria-live="polite"></p>
      <footer class="form-actions"><button type="button" class="btn line" data-preview>미리보기</button>${row?'<button type="submit" name="decision" value="approved" class="btn line">승인하여 공개</button>':''}<button type="submit" class="btn solid">${row?'수정 내용 저장':'업로드 요청 보내기'}</button></footer>
    </form>`;
    renderShotEditor();
    const form = $('#appForm');
    form.addEventListener('input',()=>saveDraft(form));
    $('#screenshotFiles').addEventListener('change', e => addFiles(e.target.files));
    $('#thumbnailFile').addEventListener('change', e => addThumbnail(e.target.files[0]));
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const decision = e.submitter?.value;
      withBusy(form,()=>submitApp(form,decision));
    });
    $('#workspaceTitle').scrollIntoView({block:'start'});
  }
  function revokePreview(shot) { if (shot.preview?.startsWith('blob:')) URL.revokeObjectURL(shot.preview); }
  function renderShotEditor() {
    $('#shotEditor').innerHTML = state.shots.map((s,i)=>`<article class="shot-edit" data-shot="${s.key}"><img src="${esc(s.preview||s.url||'')}" alt="스크린샷 ${i+1} 미리보기"><div><label class="field"><span>${i===0?'대표 썸네일 설명':`스크린샷 ${i+1} 설명`} <b class="required">*</b></span><textarea data-caption="${s.key}" rows="2" maxlength="250" required placeholder="예: 학생 이름을 입력하고 모둠 수를 선택하는 시작 화면">${esc(s.caption||'')}</textarea></label><div class="shot-controls"><button type="button" data-shot-move="${s.key}" data-direction="-1" ${i===0?'disabled':''} aria-label="스크린샷 ${i+1} 앞으로">↑</button><button type="button" data-shot-move="${s.key}" data-direction="1" ${i===state.shots.length-1?'disabled':''} aria-label="스크린샷 ${i+1} 뒤로">↓</button><button type="button" data-shot-remove="${s.key}">삭제</button></div></div></article>`).join('');
  }
  function addThumbnail(file) {
    if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024)return errorIn($('#appForm'),new Error('15MB 이하의 이미지 사진을 선택해 주세요.'));
    if(state.shots.length)revokePreview(state.shots.shift());
    state.shots.unshift({file,preview:URL.createObjectURL(file),key:crypto.randomUUID(),caption:'대표 썸네일'});
    renderShotEditor();
  }
  async function addFiles(files) {
    const form = $('#appForm');
    if (state.shots.length + files.length > 6) return errorIn(form,new Error('스크린샷은 최대 6장까지 등록할 수 있어요.'));
    for (const file of files) {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 15*1024*1024) {
        errorIn(form,new Error('15MB 이하의 PNG, JPG, WebP 이미지를 선택해 주세요.')); continue;
      }
      state.shots.push({file,preview:URL.createObjectURL(file),key:crypto.randomUUID(),caption:''});
    }
    renderShotEditor(); $('#screenshotFiles').value='';
  }
  async function imageData(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const result=canvas.toDataURL('image/jpeg',.85).split(',')[1];
    if (result.length>2800000) throw new Error('이미지가 너무 커요. 크기를 줄여 다시 선택해 주세요.');
    return result;
  }
  function values(form) {
    const data=Object.fromEntries(new FormData(form));
    const result={...data,subjects:new FormData(form).getAll('subjects'),notes:data.notes.split('\n').map(s=>s.trim()).filter(Boolean),screenshots:state.shots.map(s=>({path:s.path,caption:s.caption}))};
    if(form.elements.featured)result.featured=form.elements.featured.checked;
    return result;
  }
  async function submitApp(form,decision) {
    if (!state.shots.length && !state.edit?.is_example) throw new Error('스크린샷을 1장 이상 등록해 주세요.');
    if (state.shots.some(s=>!s.caption?.trim())) throw new Error('모든 스크린샷에 설명을 적어 주세요.');
    if (!state.edit && !new FormData(form).getAll('subjects').length) throw new Error('교과를 하나 이상 골라 주세요.');
    const progress=form.querySelector('.upload-progress');
    for (let i=0;i<state.shots.length;i++) {
      const shot=state.shots[i]; if (shot.path) continue;
      progress.textContent=`스크린샷 저장 중 · ${i+1} / ${state.shots.length}`;
      const result=await api('upload',{method:'POST',body:{data:await imageData(shot.file)}}); shot.path=result.path;
    }
    progress.textContent='요청 내용을 저장하고 있어요…';
    const body=values(form);
    if (state.edit) {
      if (decision==='approved') body.status='approved';
      body.id=state.edit.id; body.version=state.edit.version;
      await api('review',{method:'PATCH',body});
      toast('검토 내용을 저장했어요.'); await loadApps(); await queueView();
    } else {
      const result=await api('submit',{method:'POST',body});
      try {sessionStorage.removeItem(draftKey);}catch{}
      state.shots.forEach(revokePreview); state.shots=[];
      openShell('업로드 요청을 보냈어요','관리자가 내용을 확인하면 공개 목록에 올라가요.','queue');
      $('#workspaceBody').innerHTML=`<div class="success-state"><span>✓</span><h3>승인 대기 중이에요</h3><p>요청 번호 ${esc(result.id.slice(0,8).toUpperCase())}</p><p>대기 목록에서 처리 상태와 검토 메모를 확인할 수 있어요.</p><button type="button" data-view="queue" class="btn solid">대기 목록 보기</button><button type="button" data-view="upload" class="btn line">다른 앱 요청하기</button></div>`;
    }
  }
  async function queueView() {
    const admin=state.role==='admin' && state.area==='admin';
    const revision=openShell(admin?'요청 검토 · 앱 관리':'업로드 대기 목록',admin?'요청을 열어 설명과 스크린샷을 수정하고 승인해 주세요.':'업로드 요청의 처리 상태를 확인해요. 승인된 앱은 공개 목록에서 볼 수 있어요.','queue');
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">목록을 불러오고 있어요…</p>';
    try {
      const data=await api('queue');
      if(revision!==viewRevision||!workspace.open)return;
      state.queue=admin?data.apps:data.apps.filter(r=>!r.is_example);
      renderQueue();
    } catch(error) {
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<div class="error-state" role="alert">${esc(error.message)}<button type="button" data-view="queue" class="btn line">다시 불러오기</button></div>`;
    }
  }
  function renderQueue() {
    const admin=state.role==='admin' && state.area==='admin', rows=state.queue.filter(r=>state.filter==='all'||r.status===state.filter);
    $('#workspaceBody').innerHTML=`<div class="queue-heading"><div class="status-filters" aria-label="상태별 요청 목록">${[['pending','승인 대기'],['changes_requested','수정 요청'],['approved','승인 완료'],['rejected','반려'],...(admin?[['archived','공개 중지']]:[]),['all','전체']].map(([key,label])=>`<button type="button" data-filter="${key}" aria-pressed="${state.filter===key}" class="${state.filter===key?'selected':''}">${label} <b>${state.queue.filter(r=>key==='all'||r.status===key).length}</b></button>`).join('')}</div><button type="button" data-view="queue" class="btn line">새로고침</button></div>
      <div class="queue-list">${rows.length?rows.map(r=>`<article class="request-row"><div class="request-main"><span class="status-badge status-${r.status}">${labels[r.status]}</span>${r.is_example?'<span class="example-label">예시 앱</span>':''}<h3>${esc(r.name)}</h3><p>${esc(r.category)} · ${esc(r.grade)} · ${date(r.created_at)}</p>${r.review_note?`<p class="review-note"><b>검토 메모</b> ${esc(r.review_note)}</p>`:''}</div>${admin?`<button type="button" class="btn solid" data-review="${r.id}">검토 · 수정</button>`:`<span class="request-number">#${r.id.slice(0,8).toUpperCase()}</span>`}</article>`).join(''):`<div class="empty-state"><span>📭</span><h3>${state.filter==='pending'?'승인 대기 중인 요청이 없어요':'이 상태의 요청이 없어요'}</h3><p>새 요청을 보내면 이곳에서 확인할 수 있어요.</p><button type="button" data-view="upload" class="btn line">업로드 요청하기</button></div>`}</div>`;
  }
  function preview() {
    const form=$('#appForm'), data=values(form);
    const preview=document.createElement('dialog'); preview.className='preview-dialog';
    preview.innerHTML=`<button type="button" class="x" aria-label="미리보기 닫기">✕</button><div class="preview-inner"><span class="eyebrow">공개 전 미리보기</span><div class="preview-title"><span style="background:${esc(data.color)}">${state.shots[0]?`<img class="preview-thumb" src="${esc(state.shots[0].preview||state.shots[0].url||'')}" alt="대표 썸네일">`:'사진'}</span><div><h2>${esc(data.name||'앱 이름')}</h2><p>${esc(data.short||'한 줄 소개')}</p></div></div><p class="preview-meta">${esc((data.subjects||[]).join('·')||'교과')} · ${esc(data.cat)} · ${esc(data.grade||'대상 학년')} · 제작 ${esc(data.author_name||'제작자')}</p>${data.video_url?`<p class="preview-meta">소개 영상 · ${esc(data.video_url)}</p>`:''}<div class="preview-shots">${state.shots.map(s=>`<figure><img src="${esc(s.preview||s.url||'')}" alt="${esc(s.caption)}"><figcaption>${esc(s.caption||'스크린샷 설명')}</figcaption></figure>`).join('')}</div><p class="multiline">${esc(data.description||'상세 설명')}</p>${data.notes.length?`<h3>새로운 소식</h3><ul>${data.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}</div>`;
    workspace.append(preview); preview.showModal();
    preview.querySelector('button').onclick=()=>preview.close();preview.addEventListener('close',()=>preview.remove());
  }
  /* ===== 엑셀 일괄 업로드 =====
     양식(assets/chamcoding-upload-template.xlsx, scripts/make-upload-template.py로 생성)의 '웹앱 목록' 시트를 브라우저에서 읽고,
     '이미지 파일' 열에 적힌 이름과 함께 고른 이미지 파일을 짝지어 한 줄씩 업로드 요청을 보낸다. 서버 검증은 일반 요청과 같다. */
  // 엑셀 일괄 업로드는 아직 쓰지 않는다(사용자 결정). 버튼은 '공사중'으로 보여주고 막아 둔다. 다시 열 때 true로 바꾼다.
  const BULK_ENABLED=false;
  const TEMPLATE_URL='/assets/chamcoding-upload-template.xlsx';
  const BULK_COLUMNS={'앱 이름':'name','제작자 이름':'author_name','웹앱 주소':'web_url','체험하기 주소':'demo_url','소개 영상 주소':'video_url','카테고리':'cat','교과':'subjects','적용 학년':'grade','대표 색상':'color','한 줄 소개':'short','상세 설명':'description','새로운 소식':'notes','연락 이메일':'contact_email','이미지 파일':'images','이미지 설명':'captions'};
  // 양식의 '작성 안내' 시트(scripts/make-upload-template.py)에 넣은 안내문과 같은 내용
  const AI_PROMPT=`첨부한 엑셀 양식의 ‘웹앱 목록’ 시트를 채워 줘. 앱 하나당 한 줄이고, 1행의 열 이름과 열 순서는 바꾸지 마. ‘작성 안내’ 시트의 규칙을 지켜 줘: 필수 열(*)은 모두 채우고, 주소는 https://로 시작해야 해. 카테고리는 ${CATS.filter(c=>c.k!=='all').map(c=>c.k).join(', ')} 중 하나, 교과는 ${SUBJECTS.join(', ')} 중에서 쉼표로 구분해 골라. 이미지 파일은 실제로 함께 올릴 파일 이름을 | 로 구분해 최대 6개 적고(첫 번째가 대표 썸네일), 이미지 설명도 같은 순서로 | 로 구분해 적어. 적용 학년은 ‘초등학교 4-6학년’, ‘중학교 1-3학년’, ‘고등학교 3-3학년’처럼 학교급과 학년 범위로 적어. 학생 이름 등 개인정보는 넣지 마. 2번째 줄 (예시)는 지워도 돼. 완성한 파일은 .xlsx로 저장해서 줘.

[앱 정보]
(여기에 앱 주소, 소개, 사용 방법, 이미지 파일 이름 등을 붙여 넣으세요)`;
  const BULK_MAX_APPS=12, BULK_MAX_IMAGES=36;   // 서버의 시간당 요청 제한(제출 12회·이미지 36장)에 맞춘다

  // .xlsx는 zip 안의 XML이다. 외부 라이브러리 없이 필요한 시트만 풀어서 읽는다.
  async function readXlsx(file){
    if(file.size>5*1024*1024)throw new Error('엑셀 파일은 5MB 이하로 올려 주세요.');
    const buf=new Uint8Array(await file.arrayBuffer()),view=new DataView(buf.buffer),utf8=new TextDecoder();
    let end=-1;
    for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(view.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0)throw new Error('엑셀(.xlsx) 파일을 읽지 못했어요. 양식을 엑셀에서 저장한 파일인지 확인해 주세요.');
    const entries={};let p=view.getUint32(end+16,true);
    for(let n=view.getUint16(end+10,true);n>0;n--){
      if(view.getUint32(p,true)!==0x02014b50)throw new Error('엑셀 파일 구조를 읽지 못했어요.');
      const nameLen=view.getUint16(p+28,true);
      entries[utf8.decode(buf.subarray(p+46,p+46+nameLen))]={method:view.getUint16(p+10,true),size:view.getUint32(p+20,true),local:view.getUint32(p+42,true)};
      p+=46+nameLen+view.getUint16(p+30,true)+view.getUint16(p+32,true);
    }
    const text=async name=>{
      const e=entries[name.replace(/^\//,'')];if(!e)return null;
      const start=e.local+30+view.getUint16(e.local+26,true)+view.getUint16(e.local+28,true),data=buf.subarray(start,start+e.size);
      if(e.method===0)return utf8.decode(data);
      if(e.method!==8||!('DecompressionStream' in window))throw new Error('이 브라우저에서는 엑셀 파일을 읽을 수 없어요. 최신 크롬이나 엣지로 열어 주세요.');
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    };
    const xml=s=>new DOMParser().parseFromString(s,'application/xml');
    // '웹앱 목록' 시트를 찾고, 없으면 첫 시트를 읽는다
    let sheetPath='xl/worksheets/sheet1.xml';
    const wb=await text('xl/workbook.xml'),rels=await text('xl/_rels/workbook.xml.rels');
    if(wb&&rels){
      const sheet=[...xml(wb).getElementsByTagName('sheet')].find(s=>s.getAttribute('name')==='웹앱 목록')||xml(wb).getElementsByTagName('sheet')[0];
      const rid=sheet?.getAttribute('r:id'),rel=[...xml(rels).getElementsByTagName('Relationship')].find(r=>r.getAttribute('Id')===rid);
      if(rel){const target=rel.getAttribute('Target');sheetPath=target.startsWith('/')?target.slice(1):'xl/'+target.replace(/^\.\//,'');}
    }
    const shared=[...xml(await text('xl/sharedStrings.xml')||'<sst/>').getElementsByTagName('si')].map(si=>[...si.getElementsByTagName('t')].map(t=>t.textContent).join(''));
    const sheetXml=await text(sheetPath);if(!sheetXml)throw new Error('‘웹앱 목록’ 시트를 찾지 못했어요.');
    const col=ref=>[...ref.replace(/\d+/g,'')].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0)-1;
    const grid=[...xml(sheetXml).getElementsByTagName('row')].map(row=>{
      const cells=[];
      for(const c of row.getElementsByTagName('c')){
        const type=c.getAttribute('t'),v=c.getElementsByTagName('v')[0]?.textContent??'';
        const value=type==='s'?shared[Number(v)]??'':type==='inlineStr'?[...c.getElementsByTagName('t')].map(t=>t.textContent).join(''):v;
        cells[col(c.getAttribute('r')||'A')]=String(value).replace(/_x000D_/g,'').replace(/\r\n?/g,'\n').trim();
      }
      return cells;
    });
    const header=(grid[0]||[]).map(h=>BULK_COLUMNS[String(h||'').replace(/\s*\*$/,'').trim()]);
    if(!header.includes('name'))throw new Error('양식의 1행 열 이름을 확인해 주세요. 참코딩 양식을 받아 그대로 사용해 주세요.');
    return grid.slice(1).map((cells,i)=>({line:i+2,...Object.fromEntries(header.map((key,j)=>[key,cells[j]||'']).filter(([key])=>key))}))
      .filter(r=>Object.values(r).some((v,i)=>i>0&&v)&&!r.name.startsWith('(예시)'));
  }
  const split=(value,pattern)=>String(value||'').split(pattern).map(s=>s.trim()).filter(Boolean);
  function bulkRow(raw,images){
    const errors=[],https=v=>!v||/^https:\/\/[^\s/]+\.[^\s]+/.test(v);
    const row={line:raw.line,name:raw.name,author_name:raw.author_name,web_url:raw.web_url,demo_url:raw.demo_url,video_url:raw.video_url,cat:raw.cat,
      subjects:[...new Set(split(raw.subjects,/[,，、\n]/))],grade:raw.grade?parseGrade(raw.grade).text:'',color:raw.color||'#ffd23f',short:raw.short,description:raw.description,
      notes:split(raw.notes,/[|\n]/),contact_email:raw.contact_email,files:split(raw.images,/[|\n]/),captions:split(raw.captions,/[|\n]/)};
    for(const [key,label] of [['name','앱 이름'],['author_name','제작자 이름'],['web_url','웹앱 주소'],['grade','적용 학년'],['short','한 줄 소개'],['description','상세 설명']])if(!row[key])errors.push(`‘${label}’ 칸이 비어 있어요.`);
    for(const [key,label] of [['web_url','웹앱 주소'],['demo_url','체험하기 주소'],['video_url','소개 영상 주소']])if(row[key]&&!https(row[key]))errors.push(`${label}는 https://로 시작해야 해요.`);
    if(raw.grade&&!parseGrade(raw.grade).valid)errors.push('적용 학년은 ‘초등학교 4-6학년’처럼 적어 주세요.');
    if(!CATS.some(c=>c.k===row.cat&&c.k!=='all'))errors.push('카테고리를 목록에서 골라 주세요.');
    if(!row.subjects.length)errors.push('교과를 하나 이상 적어 주세요.');
    const unknown=row.subjects.filter(v=>!SUBJECTS.includes(v));if(unknown.length)errors.push(`목록에 없는 교과: ${unknown.join(', ')}`);
    if(!/^#[0-9a-f]{6}$/i.test(row.color))errors.push('대표 색상은 #과 6자리로 적어 주세요.');
    if(row.contact_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.contact_email))errors.push('연락 이메일을 확인해 주세요.');
    if(row.notes.length>12)errors.push('새로운 소식은 12개까지예요.');
    if(!row.files.length)errors.push('이미지 파일 이름을 1개 이상 적어 주세요.');
    if(row.files.length>6)errors.push('이미지는 6개까지예요.');
    if(row.captions.length!==row.files.length)errors.push(`이미지 ${row.files.length}개와 설명 ${row.captions.length}개의 수가 달라요.`);
    const key=n=>n.split(/[\\/]/).pop().toLowerCase();
    row.images=row.files.map(n=>images.get(key(n)));
    const missing=row.files.filter((n,i)=>!row.images[i]);if(missing.length)errors.push(`선택하지 않은 이미지: ${missing.join(', ')}`);
    row.errors=errors;return row;
  }
  function bulkView(){
    state.bulk={raw:[],rows:[],images:new Map(),sheet:'',sending:false};
    openShell('업로드 요청(Excel)','양식에 적은 웹앱들을 한 번에 승인 대기로 보내요. 관리자 승인 후 공개돼요.','bulk');
    $('#workspaceBody').innerHTML=`<div class="app-form bulk-form">
      <div class="form-intro"><span>01</span><div><h3>양식 받기</h3><p>‘작성 안내’ 시트에 AI에게 그대로 줄 수 있는 안내문이 있어요.</p></div></div>
      <a class="btn line" href="${TEMPLATE_URL}" download>📄 참코딩 업로드 양식 받기 (.xlsx)</a>
      <div class="prompt-box"><div class="prompt-head"><b>AI에게 함께 줄 프롬프트</b><button type="button" class="btn line" id="copyPrompt">프롬프트 복사</button></div><textarea id="aiPrompt" readonly rows="7" aria-label="AI에게 함께 줄 프롬프트">${esc(AI_PROMPT)}</textarea></div>
      <div class="form-intro"><span>02</span><div><h3>작성한 엑셀 올리기</h3><p>앱 하나가 한 줄이에요. 한 번에 ${BULK_MAX_APPS}개 앱, 이미지 ${BULK_MAX_IMAGES}장까지 보낼 수 있어요.</p></div></div>
      <label class="file-drop"><span>엑셀 파일 선택</span><small id="bulkSheetName">.xlsx 파일</small><input id="bulkSheet" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
      <div class="form-intro"><span>03</span><div><h3>이미지 함께 올리기</h3><p>엑셀 ‘이미지 파일’ 열에 적은 이름의 이미지를 한꺼번에 선택해 주세요. PNG · JPG · WebP</p></div></div>
      <label class="file-drop"><span>이미지 파일 선택</span><small id="bulkImageCount">여러 장을 한 번에 고를 수 있어요</small><input id="bulkImages" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>
      <div id="bulkPreview" class="bulk-preview" aria-live="polite"></div>
      <label class="consent"><input id="bulkConsent" type="checkbox"> 앱과 스크린샷을 공개할 권한이 있으며, 학생의 개인정보가 포함되지 않았음을 확인했어요.</label>
      <p class="form-error" role="alert" hidden></p>
      <footer class="form-actions"><button type="button" class="btn solid" id="bulkSend" disabled>업로드 요청 보내기</button></footer></div>`;
    $('#bulkSheet').addEventListener('change',async e=>{
      const file=e.target.files[0];if(!file||state.bulk.sending)return;
      const error=workspace.querySelector('.bulk-form .form-error');error.hidden=true;
      try{state.bulk.raw=await readXlsx(file);state.bulk.sheet=file.name;$('#bulkSheetName').textContent=file.name;checkBulk();}
      catch(err){state.bulk.raw=[];checkBulk();error.textContent=err.message;error.hidden=false;}
    });
    $('#bulkImages').addEventListener('change',e=>{
      if(state.bulk.sending)return;
      for(const file of e.target.files){
        if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024)continue;
        state.bulk.images.set(file.name.toLowerCase(),file);
      }
      $('#bulkImageCount').textContent=`이미지 ${state.bulk.images.size}장 선택됨`;e.target.value='';checkBulk();
    });
    $('#bulkConsent').addEventListener('change',renderBulk);
    $('#copyPrompt').addEventListener('click',async()=>{
      const box=$('#aiPrompt');
      try{await navigator.clipboard.writeText(AI_PROMPT);}catch{box.select();document.execCommand('copy');}
      toast('프롬프트를 복사했어요. 양식 파일과 함께 AI에게 붙여 넣어 주세요.');
    });
    $('#bulkSend').addEventListener('click',sendBulk);
    renderBulk();
  }
  // 엑셀이나 이미지를 새로 고를 때만 다시 검사한다. 보낸 결과(완료·오류)는 화면을 다시 그려도 유지한다.
  function checkBulk(){const b=state.bulk;b.rows=b.raw.map(r=>bulkRow(r,b.images));renderBulk();}
  function renderBulk(){
    const b=state.bulk;if(!b||!$('#bulkPreview'))return;
    const ready=b.rows.filter(r=>!r.errors.length&&!r.done),images=ready.reduce((n,r)=>n+r.files.length,0);
    const limit=ready.length>BULK_MAX_APPS?`한 번에 ${BULK_MAX_APPS}개까지 보낼 수 있어요. 엑셀을 나눠 주세요.`:images>BULK_MAX_IMAGES?`이미지는 한 번에 ${BULK_MAX_IMAGES}장까지예요. 엑셀을 나눠 주세요.`:'';
    $('#bulkPreview').innerHTML=b.rows.length?`<p class="bulk-summary">${esc(b.sheet)} · 앱 ${b.rows.length}개 중 <b>${ready.length}개 준비됨</b>${b.rows.length-ready.length?` · 확인 필요 ${b.rows.filter(r=>r.errors.length).length}개`:''}</p>${limit?`<p class="form-error">${esc(limit)}</p>`:''}
      <div class="bulk-list">${b.rows.map(r=>`<article class="bulk-row ${r.done?'done':r.errors.length?'bad':'ok'}"><header><span class="bulk-line">${r.line}행</span><b>${esc(r.name||'(이름 없음)')}</b><small>${esc([r.cat,r.subjects.join('·'),r.grade].filter(Boolean).join(' · '))}</small><span class="bulk-state">${r.done?`✓ 요청 완료 #${esc(r.done)}`:r.status?esc(r.status):r.errors.length?'확인 필요':`이미지 ${r.files.length}장 · 준비됨`}</span></header>${r.errors.length?`<ul>${r.errors.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>`:''}</article>`).join('')}</div>`
      :'<p class="field-help">엑셀을 올리면 여기에서 내용을 미리 확인할 수 있어요.</p>';
    const send=$('#bulkSend');
    send.disabled=b.sending||!ready.length||!!limit||!$('#bulkConsent').checked;
    send.textContent=b.sending?'보내는 중…':ready.length?`${ready.length}개 업로드 요청 보내기`:'업로드 요청 보내기';
  }
  async function sendBulk(){
    const b=state.bulk;if(!b||b.sending)return;
    b.sending=true;state.busy=true;renderBulk();
    try{
      for(const row of b.rows.filter(r=>!r.errors.length&&!r.done)){
        try{
          const shots=[];
          for(let i=0;i<row.images.length;i++){
            row.status=`이미지 저장 중 ${i+1}/${row.images.length}`;renderBulk();
            const result=await api('upload',{method:'POST',body:{data:await imageData(row.images[i])}});
            shots.push({path:result.path,caption:row.captions[i]});
          }
          row.status='요청 저장 중';renderBulk();
          const {files,captions,images,errors,status,line,done,...app}=row;
          const result=await api('submit',{method:'POST',body:{...app,icon:'🧩',screenshots:shots}});
          row.done=result.id.slice(0,8).toUpperCase();row.status='';
        }catch(error){row.status='';row.errors=[error.message];if(error.message.includes('다시 로그인')||error.message.includes('너무 많아요'))break;}
        renderBulk();
      }
    }finally{b.sending=false;state.busy=false;renderBulk();}
    const sent=b.rows.filter(r=>r.done).length,failed=b.rows.filter(r=>r.errors.length).length;
    toast(failed?`${sent}개 요청을 보냈어요. ${failed}개는 확인이 필요해요.`:`${sent}개 업로드 요청을 보냈어요.`);
  }

  const devDraftKey='chamcoding-dev-request-draft';
  function devRequestForm() {
    state.area='uploader';
    let draft={};try{draft=JSON.parse(sessionStorage.getItem(devDraftKey)||'{}');}catch{}
    openShell('앱 개발 요청','수업에 필요한 앱 아이디어를 알려 주세요. 참쌤스쿨 개발진이 검토한 뒤 연락드려요.','devreq');
    $('#workspaceBody').innerHTML=`<form id="devForm" class="app-form">
      <div class="form-intro"><span>01</span><div><h3>어떤 앱이 필요한가요?</h3><p>업로드 요청과 같은 기준으로 카테고리와 적용 학년을 알려 주세요.</p></div></div>
      <div class="form-grid">${field('만들고 싶은 앱 이름','title',draft.title,{max:60,placeholder:'가칭도 괜찮아요. 예: 받아쓰기 자동 채점기'})}${field('요청자 이름','requester_name',draft.requester_name,{max:60,placeholder:'이름 또는 학교·연구회 이름'})}</div>
      <div class="form-grid"><label class="field"><span>카테고리 <b class="required">*</b></span><select name="cat" required>${CATS.filter(c=>c.k!=='all').map(c=>`<option value="${c.k}" ${draft.cat===c.k?'selected':''}>${c.icon} ${c.name}</option>`).join('')}</select></label>
      ${gradeField(draft.grade)}</div>
      <label class="field"><span>활용 상황과 목적 <b class="required">*</b></span><textarea name="purpose" rows="5" maxlength="3000" required placeholder="어떤 수업·활동에서, 어떤 불편을 해결하고 싶은지 적어 주세요.">${esc(draft.purpose||'')}</textarea></label>
      <label class="field"><span>필요한 기능 <b class="required">*</b></span><textarea name="features" rows="5" maxlength="3000" required placeholder="한 줄에 한 가지씩 적어 주세요.&#10;예: 학생별 점수 저장&#10;예: 교사 화면에서 결과 한눈에 보기">${esc(draft.features||'')}</textarea></label>
      <div class="form-intro"><span>02</span><div><h3>참고 자료와 일정</h3><p>비슷한 사이트나 원하는 시기가 있으면 알려 주세요.</p></div></div>
      ${field('참고 주소','reference_url',draft.reference_url,{required:false,type:'url',max:2000,placeholder:'https://…',help:'비슷한 앱, 참고 영상, 수업 자료 등의 링크를 적어 주세요.'})}
      ${field('희망 시기','wanted_by',draft.wanted_by,{required:false,max:80,placeholder:'예: 12월 수업 전, 2학기 중'})}
      <div class="form-intro"><span>03</span><div><h3>연락처</h3><p>연락 이메일은 관리자에게만 보여요.</p></div></div>
      ${field('연락 이메일','contact_email',draft.contact_email,{type:'email',max:254,placeholder:'teacher@school.kr'})}
      <label class="consent"><input name="consent" type="checkbox" required> 학생 이름 등 개인정보를 적지 않았고, 답변을 위해 연락 이메일을 관리자에게 전달하는 데 동의해요.</label>
      <p class="form-error" role="alert" hidden></p>
      <footer class="form-actions"><button type="submit" class="btn solid">개발 요청 보내기</button></footer></form>`;
    const form=$('#devForm');
    form.addEventListener('input',()=>{const data=Object.fromEntries(new FormData(form));delete data.consent;try{sessionStorage.setItem(devDraftKey,JSON.stringify(data));}catch{}});
    form.addEventListener('submit',e=>{e.preventDefault();withBusy(form,async()=>{
      const data=Object.fromEntries(new FormData(form));data.consent=form.elements.consent.checked;
      const result=await api('dev-request',{method:'POST',body:data});
      try{sessionStorage.removeItem(devDraftKey);}catch{}
      openShell('개발 요청을 보냈어요','관리자가 검토한 뒤 적어 주신 이메일로 연락드려요.','devreq');
      $('#workspaceBody').innerHTML=`<div class="success-state"><span>✓</span><h3>요청이 접수됐어요</h3><p>요청 번호 ${esc(result.id.slice(0,8).toUpperCase())}</p><p>진행 상황은 이메일로 안내해 드려요.</p><button type="button" data-view="devreq" class="btn line">다른 요청 보내기</button></div>`;
    });});
    form.querySelector('input')?.focus();
  }
  async function devQueueView() {
    if(state.role!=='admin'||state.area!=='admin')return;
    const revision=openShell('앱 개발 요청','선생님들이 보낸 앱 아이디어를 확인하고 진행 상태를 기록해요.','devqueue');
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">요청을 불러오고 있어요…</p>';
    try {
      const data=await api('dev-requests');
      if(revision!==viewRevision||!workspace.open)return;
      state.devRequests=data.requests;
      $('#workspaceBody').innerHTML=`<div class="queue-heading"><p class="field-help">전체 ${data.requests.length}건 · ${Object.entries(devLabels).map(([k,l])=>`${l} ${data.requests.filter(r=>r.status===k).length}`).join(' · ')}</p><button type="button" data-view="devqueue" class="btn line">새로고침</button></div>
        <div class="queue-list">${data.requests.length?data.requests.map(r=>`<article class="request-row dev-row"><div class="request-main"><span class="status-badge dev-status-${r.status}">${devLabels[r.status]}</span><h3>${esc(r.title)}</h3><p>${esc(r.category)} · ${esc(r.grade)} · ${esc(r.requester_name)} · ${date(r.created_at)}</p>
          <dl class="dev-detail"><dt>연락 이메일</dt><dd>${esc(r.contact_email)}</dd><dt>활용 상황과 목적</dt><dd class="multiline">${esc(r.purpose)}</dd><dt>필요한 기능</dt><dd class="multiline">${esc(r.features)}</dd>${r.reference_url?`<dt>참고 주소</dt><dd><a href="${esc(r.reference_url)}" target="_blank" rel="noopener noreferrer">${esc(r.reference_url)}</a></dd>`:''}${r.wanted_by?`<dt>희망 시기</dt><dd>${esc(r.wanted_by)}</dd>`:''}</dl>
          <div class="dev-edit"><label class="field"><span>진행 상태</span><select data-dev-status="${r.id}">${Object.entries(devLabels).map(([k,l])=>`<option value="${k}" ${r.status===k?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>관리자 메모</span><textarea data-dev-note="${r.id}" rows="2" maxlength="2000">${esc(r.admin_note)}</textarea></label><button type="button" class="btn solid" data-dev-save="${r.id}">저장</button></div></div></article>`).join(''):'<div class="empty-state"><span>🛠️</span><h3>아직 받은 개발 요청이 없어요</h3><p>선생님들이 사이드바의 ‘앱 개발 요청’으로 아이디어를 보내면 이곳에 모여요.</p></div>'}</div>`;
    } catch(error) {
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<div class="error-state" role="alert">${esc(error.message)}<button type="button" data-view="devqueue" class="btn line">다시 불러오기</button></div>`;
    }
  }
  async function saveDevRequest(button) {
    const id=button.dataset.devSave;
    state.busy=true;button.disabled=true;button.textContent='저장 중…';
    try {
      await api('dev-request',{method:'PATCH',body:{id,status:workspace.querySelector(`[data-dev-status="${id}"]`).value,admin_note:workspace.querySelector(`[data-dev-note="${id}"]`).value}});
      toast('개발 요청을 저장했어요.');
    } catch(error){toast(error.message);}
    finally{state.busy=false;button.disabled=false;button.textContent='저장';}
    const badge=button.closest('.dev-row')?.querySelector('.status-badge'),status=workspace.querySelector(`[data-dev-status="${id}"]`).value;
    if(badge){badge.className=`status-badge dev-status-${status}`;badge.textContent=devLabels[status];}
  }

  /* 기타 문의: 로그인 없이 보내고, 관리자는 작업 창의 '기타 문의' 탭에서 확인·처리한다. */
  function inquiryForm() {
    openShell('기타 문의','사이트 이용, 협업, 연수 등 궁금한 점을 남겨 주세요. 적어 주신 이메일로 답변드려요.','inquiry');
    $('#workspaceBody').innerHTML=`<form id="inquiryForm" class="app-form inquiry-form">
      <div class="form-grid">${field('이름','name','',{required:false,max:60,placeholder:'이름 또는 학교 (선택)'})}${field('연락 이메일','contact_email','',{type:'email',max:254,placeholder:'teacher@school.kr',help:'답변을 받을 주소예요. 관리자에게만 보여요.'})}</div>
      ${field('제목','subject','',{max:100,placeholder:'예: 연수 자료로 소개해도 될까요?'})}
      <label class="field"><span>문의 내용 <b class="required">*</b></span><textarea name="body" rows="7" maxlength="3000" required placeholder="궁금한 점을 자유롭게 적어 주세요."></textarea></label>
      <label class="consent"><input name="consent" type="checkbox" required> 답변을 위해 연락 이메일을 관리자에게 전달하는 데 동의해요. 학생 개인정보는 적지 않았어요.</label>
      <p class="form-error" role="alert" hidden></p>
      <footer class="form-actions"><button type="submit" class="btn solid">문의 보내기</button></footer></form>`;
    const form=$('#inquiryForm');
    form.addEventListener('submit',e=>{e.preventDefault();withBusy(form,async()=>{
      const data=Object.fromEntries(new FormData(form));data.consent=form.elements.consent.checked;
      const result=await api('inquiry',{method:'POST',body:data});
      openShell('문의를 보냈어요','관리자가 확인한 뒤 적어 주신 이메일로 답변드려요.','inquiry');
      $('#workspaceBody').innerHTML=`<div class="success-state"><span>✓</span><h3>문의가 접수됐어요</h3><p>문의 번호 ${esc(result.id.slice(0,8).toUpperCase())}</p><button type="button" data-view="inquiry" class="btn line">다른 문의 남기기</button></div>`;
    });});
    form.querySelector('input')?.focus();
  }
  async function inquiryQueueView() {
    if(state.role!=='admin'||state.area!=='admin')return;
    const revision=openShell('기타 문의','방문자가 남긴 문의를 확인하고 처리 상태를 기록해요.','inquiries');
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">문의를 불러오고 있어요…</p>';
    try {
      const {inquiries}=await api('inquiries');
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<div class="queue-heading"><p class="field-help">전체 ${inquiries.length}건 · ${Object.entries(inquiryLabels).map(([k,l])=>`${l} ${inquiries.filter(r=>r.status===k).length}`).join(' · ')}</p><button type="button" data-view="inquiries" class="btn line">새로고침</button></div>
        <div class="queue-list">${inquiries.length?inquiries.map(r=>`<article class="request-row dev-row"><div class="request-main"><span class="status-badge inquiry-status-${r.status}">${inquiryLabels[r.status]}</span><h3>${esc(r.subject)}</h3><p>${esc(r.name||'이름 없음')} · ${date(r.created_at)}</p>
          <dl class="dev-detail"><dt>연락 이메일</dt><dd><a href="mailto:${esc(r.contact_email)}">${esc(r.contact_email)}</a></dd><dt>문의 내용</dt><dd class="multiline">${esc(r.body)}</dd></dl>
          <div class="dev-edit"><label class="field"><span>처리 상태</span><select data-inquiry-status="${r.id}">${Object.entries(inquiryLabels).map(([k,l])=>`<option value="${k}" ${r.status===k?'selected':''}>${l}</option>`).join('')}</select></label><label class="field"><span>관리자 메모</span><textarea data-inquiry-note="${r.id}" rows="2" maxlength="2000">${esc(r.admin_note)}</textarea></label><button type="button" class="btn solid" data-inquiry-save="${r.id}">저장</button></div></div></article>`).join(''):'<div class="empty-state"><span>💬</span><h3>아직 받은 문의가 없어요</h3><p>사이드바의 ‘기타 문의’로 남긴 내용이 이곳에 모여요.</p></div>'}</div>`;
    } catch(error) {
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<div class="error-state" role="alert">${esc(error.message)}<button type="button" data-view="inquiries" class="btn line">다시 불러오기</button></div>`;
    }
  }
  async function saveInquiry(button) {
    const id=button.dataset.inquirySave,status=workspace.querySelector(`[data-inquiry-status="${id}"]`).value;
    state.busy=true;button.disabled=true;button.textContent='저장 중…';
    try{
      await api('inquiry',{method:'PATCH',body:{id,status,admin_note:workspace.querySelector(`[data-inquiry-note="${id}"]`).value}});
      const badge=button.closest('.dev-row')?.querySelector('.status-badge');
      if(badge){badge.className=`status-badge inquiry-status-${status}`;badge.textContent=inquiryLabels[status];}
      toast('문의 처리 상태를 저장했어요.');
    }catch(error){toast(error.message);}
    finally{state.busy=false;button.disabled=false;button.textContent='저장';}
  }

  /* 상세 화면 리뷰: 누구나 별점(5점 만점)과 함께 익명으로 남긴다. 회원은 자기 리뷰를 고칠 수 있다. */
  let reviewRevision=0;
  const stars=n=>`<span class="stars" aria-label="5점 만점에 ${n}점">${[1,2,3,4,5].map(i=>`<i class="${i<=Math.round(n)?'on':''}">★</i>`).join('')}</span>`;
  async function mountReviews(box, app) {
    const target=box.querySelector('.review-body'),revision=++reviewRevision;
    if(!/^[a-f0-9-]{36}$/.test(String(app.id))){target.innerHTML='<p class="muted">예시 앱에는 리뷰를 남길 수 없어요.</p>';return;}
    try {
      const data=await api(`reviews&app=${app.id}`);
      if(revision!==reviewRevision||!box.isConnected)return;
      const {summary}=data,max=Math.max(1,...summary.dist);
      box.querySelector('h4').innerHTML=`평가 및 리뷰 <small>${summary.count}개</small>`;
      target.innerHTML=`<div class="rating-summary"><div class="rating-big"><b>${summary.count?summary.average.toFixed(1):'—'}</b><small>5점 만점</small></div>
          <div class="rating-bars" aria-label="별점 분포">${[5,4,3,2,1].map(n=>`<div><span>${'★'.repeat(n)}</span><i><em style="width:${summary.dist[n-1]/max*100}%"></em></i></div>`).join('')}<small>${summary.count}개의 평가</small></div></div>
        ${data.reviews.length?`<div class="review-list">${data.reviews.map(r=>`<article class="review-item"><header>${r.rating?stars(r.rating):''}<b>${esc(r.name)}</b>${r.mine?'<span class="mine">내 리뷰</span>':''}${data.admin?`<button type="button" class="hide-review" data-hide-review="${r.id}">숨기기</button>`:''}<time datetime="${esc(r.updated_at)}">${date(r.updated_at)}</time></header><p>${esc(r.body)}</p></article>`).join('')}</div>`:'<p class="muted">아직 리뷰가 없어요. 수업에 써 본 경험을 처음으로 남겨 주세요.</p>'}
        <form class="review-form"><fieldset class="star-pick"><legend>별점</legend><span class="star-row">${[5,4,3,2,1].map(n=>`<input type="radio" id="star${n}" name="rating" value="${n}" ${data.mine?.rating===n?'checked':''} required><label for="star${n}" title="${n}점" aria-label="${n}점">★</label>`).join('')}</span></fieldset>
          <label class="sr-only" for="reviewText">리뷰 내용</label><textarea id="reviewText" maxlength="1000" required placeholder="수업에서 써 본 경험, 좋았던 점, 바라는 점을 적어 주세요.">${esc(data.mine?.body||'')}</textarea>
          <footer><small>${data.member?'익명으로 공개돼요. 내 리뷰는 다시 쓰면 고쳐져요.':'로그인하지 않아도 익명으로 남길 수 있어요.'}</small><button type="submit" class="btn solid">${data.mine?'리뷰 수정':'리뷰 남기기'}</button></footer></form>`;
      target.querySelectorAll('[data-hide-review]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;
        try{await api('app-review',{method:'PATCH',body:{id:button.dataset.hideReview,hidden:true}});toast('리뷰를 숨겼어요.');mountReviews(box,app);}catch(error){button.disabled=false;toast(error.message);}
      }));
      const form=target.querySelector('.review-form');
      form.addEventListener('submit',async e=>{
        e.preventDefault();const button=form.querySelector('button[type=submit]');button.disabled=true;
        try{await api('app-review',{method:'POST',body:{appId:app.id,rating:Number(form.elements.rating.value),body:form.querySelector('textarea').value}});toast('리뷰를 남겼어요.');mountReviews(box,app);}
        catch(error){button.disabled=false;toast(error.message);}
      });
    } catch(error) {
      if(revision===reviewRevision&&box.isConnected)target.innerHTML=`<p class="muted">${esc(error.message)}</p>`;
    }
  }
  window.ChamTools={mountReviews};

  function setup(token) {
    state.setupToken=token;
    openShell('관리자 계정 등록','소유자 전용 설정이에요. 사용할 아이디와 비밀번호를 직접 정해 주세요.','setup');
    $('#workspaceBody').innerHTML=`<form id="setupForm" class="entry-form"><div class="entry-icon">🔐</div>${field('관리자 아이디','username','',{max:80,placeholder:'영문·숫자 3자 이상'})}<label class="field"><span>관리자 비밀번호 <b class="required">*</b></span><input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required><small class="field-help">12자 이상으로 설정해 주세요.</small></label><label class="field"><span>비밀번호 확인 <b class="required">*</b></span><input name="confirm" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><p class="form-error" role="alert" hidden></p><button type="submit" class="btn solid submit">관리자 계정 등록</button><p class="field-help">등록은 한 번만 가능해요. 등록 후에는 이 링크로 새 관리자를 만들 수 없어요.</p></form>`;
    const form=$('#setupForm');
    form.onsubmit=e=>{e.preventDefault();withBusy(form,async()=>{
      const data=Object.fromEntries(new FormData(form));
      if(data.password!==data.confirm) throw new Error('비밀번호 확인이 일치하지 않아요.');
      const result=await api('setup',{method:'POST',body:{username:data.username,password:data.password,setupToken:state.setupToken}});
      state.setupToken='';state.role=result.role;syncChrome();state.area='admin';state.adminReady=true;form.reset();toast('관리자 계정을 등록했어요.');await queueView();
    });};
  }
  workspace.addEventListener('input',e=>{
    if(e.target.dataset.caption){const s=state.shots.find(s=>s.key===e.target.dataset.caption);if(s)s.caption=e.target.value;}
  });
  workspace.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.closest('.preview-dialog'))return;
    if(state.busy)return;
    if(button.matches('.close-workspace'))return closeWorkspace();
    if(button.matches('.logout')){
      try{await api('logout',{method:'POST',body:{}});state.role=null;closeWorkspace();syncChrome();toast('로그아웃했어요.');}catch(error){toast(error.message);}return;
    }
    if(button.dataset.memberMode){await memberEntry(button.dataset.memberMode);return;}
    if(button.hasAttribute('data-admin-login')){await enter('admin');return;}
    if(button.dataset.devSave){await saveDevRequest(button);return;}
    if(button.dataset.inquirySave){await saveInquiry(button);return;}
    if(button.dataset.view){
      if(button.dataset.view==='bulk'){if(BULK_ENABLED)bulkView();return;}
      if(button.dataset.view==='settings')await passwordSettings();else if(button.dataset.view==='devqueue')await devQueueView();else if(button.dataset.view==='inquiries')await inquiryQueueView();else if(button.dataset.view==='inquiry')inquiryForm();else if(button.dataset.view==='devreq')devRequestForm();else if(button.dataset.view==='upload')uploadForm();else await queueView();return;
    }
    if(button.hasAttribute('data-preview'))return preview();
    if(button.dataset.filter){state.filter=button.dataset.filter;renderQueue();return;}
    if(button.dataset.review){const row=state.queue.find(r=>r.id===button.dataset.review);if(row)uploadForm(row);return;}
    if(button.dataset.shotRemove){const index=state.shots.findIndex(s=>s.key===button.dataset.shotRemove);if(index>=0){revokePreview(state.shots[index]);state.shots.splice(index,1);renderShotEditor();}return;}
    if(button.dataset.shotMove){const index=state.shots.findIndex(s=>s.key===button.dataset.shotMove),target=index+Number(button.dataset.direction);if(target>=0&&target<state.shots.length){[state.shots[index],state.shots[target]]=[state.shots[target],state.shots[index]];renderShotEditor();}}
  });
  $('#uploadButton').onclick=()=>enter('upload');$('#memberButton').onclick=()=>memberEntry();$('#adminMenuButton').onclick=()=>enter('admin');$('#devRequestButton').onclick=()=>devRequestForm();$('#inquiryButton').onclick=()=>inquiryForm();
  const authHash=new URLSearchParams(location.hash.slice(1));
  if(authHash.has('access_token')||authHash.has('error'))history.replaceState(null,'',location.pathname+location.search);
  if(new URLSearchParams(location.search).has('email-confirmed'))memberEntry();
  const setupToken=authHash.get('setup');
  if(setupToken){history.replaceState(null,'',location.pathname+location.search);setup(setupToken);}
  // Count once per page load, independently of catalogue rendering and login.
  api('visits',{method:'POST',body:{}}).then(data=>{
    $('#visitTotal').textContent=Number(data.total).toLocaleString('ko-KR');
    $('#visitToday').textContent=Number(data.today).toLocaleString('ko-KR');
  }).catch(()=>{const status=$('#visitStatus');status.hidden=false;status.textContent='방문 통계를 불러오지 못했어요.';});
  loadApps();
  refreshSession().catch(()=>{});
})();
