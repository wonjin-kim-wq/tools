/* Upload requests and review workspace. Credentials and database writes stay on the server. */
(() => {
  const esc = escapeHtml;
  const state = { role: null, area: 'member', member: null, configured: false, adminReady: false, queue: [], filter: 'pending', shots: [], edit: null, busy: false, setupToken: '' };
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
  let lastFocus, viewRevision=0, sessionFlight=null, sessionCheckedAt=0, sessionEpoch=0, memberNext;
  function invalidateSession(){sessionEpoch++;sessionCheckedAt=0;sessionFlight=null;}

  async function api(action, { method = 'GET', body } = {}) {
    const response = await fetch(`/api/tools?action=${action}`, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data;
    try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    if (!response.ok) {
      if (response.status === 401) invalidateSession();
      throw new Error(data.error || '요청을 처리하지 못했어요.');
    }
    if(['login','logout','setup','member-login','member-signup','member-logout','member-link','member-password'].includes(action))invalidateSession();
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
      appsLoadFailed = false;
      appsLoading = false; renderCatalog(); layout(); banner.hidden = true;
    } catch {
      // 예시 앱은 보여 주지 않는다. 빈 목록과 다시 불러오기 안내만 보인다.
      apps.splice(0, apps.length);
      appsLoadFailed = true;
      appsLoading = false; renderCatalog(); layout();
      banner.textContent = '최신 목록을 불러오지 못했어요. 연결을 확인한 뒤 새로고침해 주세요.';
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
      ${adminView && ['queue','review','devqueue','inquiries'].includes(active) ? `<nav class="workspace-nav" aria-label="관리자 메뉴"><button type="button" data-view="queue" class="${['queue','review'].includes(active)?'active':''}">요청 검토 · 앱 관리</button><button type="button" data-view="devqueue" class="${active==='devqueue'?'active':''}">앱 개발 요청</button><button type="button" data-view="inquiries" class="${active==='inquiries'?'active':''}">기타 문의</button><span class="role-chip">관리자</span><button type="button" class="logout">로그아웃</button></nav>`:''}
      <div class="workspace-content"><div id="workspaceBody"></div></div>`;
    return revision;
  }
  function closeWorkspace() {
    if (state.busy) return;
    workspace.close(); document.body.style.overflow = ''; lastFocus?.focus();
  }
  workspace.addEventListener('cancel', e => { if (state.busy) e.preventDefault(); });
  workspace.addEventListener('close', () => { if(workspace.open)return; viewRevision++; document.body.style.overflow = ''; workspace.replaceChildren(); state.shots.forEach(revokePreview); state.shots = []; state.bulk?.cards.forEach(c=>c.shots.forEach(revokePreview)); state.bulk = null; });
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
    const button=$('#memberButton'), signedIn=Boolean(state.member);
    button.classList.toggle('profile-button',signedIn);
    $('#memberButtonLabel').hidden=signedIn;
    $('#memberProfileIcon').toggleAttribute('hidden',!signedIn);
    if(signedIn){
      button.setAttribute('aria-label','내 프로필 열기');
      button.title='내 프로필';
    }else{
      button.removeAttribute('aria-label');
      button.removeAttribute('title');
    }
  }
  function loadingShell(title,active='loading'){
    const revision=openShell(title,'잠시만 기다려 주세요.',active);
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">접속 상태를 확인하고 있어요…</p><p class="form-error" role="alert" hidden></p>';
    return revision;
  }
  async function enterAdmin() {
    state.area='admin';
    const revision=loadingShell('관리자','login');
    try {
      await refreshSession();
      if(revision!==viewRevision||!workspace.open)return;
      if(state.role!=='admin')return adminLogin();
      await queueView();
    } catch(error){if(revision===viewRevision)errorIn($('#workspaceBody'),error);}
  }
  function adminLogin() {
    openShell('관리자 로그인','승인과 수정은 관리자 계정으로 진행해요.','login');
    $('#workspaceBody').innerHTML = `<form id="loginForm" class="entry-form">
      <div class="entry-icon">🔑</div>
      <label class="field"><span>관리자 아이디</span><input name="username" autocomplete="username" maxlength="80" required></label>
      <label class="field"><span>관리자 비밀번호</span><input name="password" type="password" autocomplete="current-password" required maxlength="256"></label>
      <p class="form-error" role="alert" hidden></p><button class="btn solid submit" type="submit">관리자 로그인</button>
      ${!state.adminReady?'<p class="field-help">관리자 계정은 아직 등록되지 않았어요. 소유자 전용 등록 링크에서 마지막 설정을 마쳐 주세요.</p>':''}
      <p class="field-help">등록된 관리자만 요청을 승인하거나 수정할 수 있어요.</p></form>`;
    const form = $('#loginForm');
    form.addEventListener('submit', e => { e.preventDefault(); withBusy(form,async()=>{
      const body = Object.fromEntries(new FormData(form)); body.kind = 'admin';
      const data = await api('login',{method:'POST',body}); state.role=data.role; syncChrome(); form.reset();
      await queueView();
    }); });
    form.querySelector('input')?.focus();
  }
  // 관리자 로그인은 회원 로그인 창(로그인 상태면 내 계정 창) 아래에서 들어간다
  const adminEntry='<div class="admin-entry"><span>참코딩 운영자이신가요?</span><button type="button" class="btn line" data-admin-login>관리자로 로그인</button></div>';
  const memberTitles={login:'회원 로그인',signup:'회원가입',reset:'비밀번호 찾기',resend:'인증 메일 다시 받기',newpass:'새 비밀번호 설정'};
  const memberLinks='<p class="member-links"><button type="button" class="text-link" data-member-mode="reset">비밀번호 찾기</button><span aria-hidden="true">·</span><button type="button" class="text-link" data-member-mode="resend">인증 메일 다시 받기</button></p>';
  const passwordFields=(label='비밀번호')=>`<label class="field"><span>${label} *</span><input type="password" name="password" minlength="8" maxlength="256" autocomplete="new-password" required></label><label class="field"><span>${label} 확인 *</span><input type="password" name="confirm" minlength="8" maxlength="256" autocomplete="new-password" required></label>`;
  async function memberEntry(mode='login', next=null, notice=null) {
    memberNext=next;
    if(!memberTitles[mode])mode='login';
    const revision=loadingShell(memberTitles[mode],'member');
    try {await refreshSession();} catch(error){if(revision===viewRevision)errorIn($('#workspaceBody'),error);return;}
    if(revision!==viewRevision||!workspace.open)return;
    const note=notice?`<p class="form-notice${notice.error?' error':''}" role="${notice.error?'alert':'status'}">${esc(notice.text)}</p>`:'';
    if(mode==='newpass'){
      if(!state.member)return memberEntry('reset',next,{error:true,text:'로그인이 만료됐어요. 비밀번호 찾기를 다시 하거나 로그인해 주세요.'});
      openShell(memberTitles.newpass,'앞으로 로그인할 때 쓸 비밀번호를 정해 주세요.','member');
      $('#workspaceBody').innerHTML=`<form id="memberForm" class="entry-form">${note}${passwordFields('새 비밀번호')}<p class="field-help">8자 이상, 다른 사이트와 다른 비밀번호를 권장해요.</p><p class="form-error" role="alert" hidden></p><button type="submit" class="btn solid submit">비밀번호 바꾸기</button></form>`;
      $('#memberForm').onsubmit=e=>{e.preventDefault();const form=e.target;withBusy(form,async()=>{
        const data=Object.fromEntries(new FormData(form));
        if(data.password!==data.confirm)throw new Error('새 비밀번호 확인이 일치하지 않아요.');
        await api('member-password',{method:'POST',body:data});form.reset();
        await memberEntry('login',next,{text:'비밀번호를 바꿨어요. 다음 로그인부터 새 비밀번호를 사용해 주세요.'});
      });};
      return;
    }
    if(state.member){
      if(next==='queue')return queueView();
      if(next)return next==='bulk'?uploadRequests('direct','bulk'):uploadRequests(next);
      openShell('내 계정','참코딩 회원 정보와 콘텐츠 이용 권한을 확인해요.','member');
      $('#workspaceBody').innerHTML=`<div class="entry-form">${note}<div class="entry-icon">👤</div><h3>${esc(state.member.name)}님</h3><p class="field-help">${esc(state.member.email)}</p><p class="membership-state">${state.member.contentAccess?'회원 전용 콘텐츠 이용 권한이 있어요.':'콘텐츠 이용 권한 확인이 필요해요.'}</p><p class="field-help">회원 전용 콘텐츠는 준비되는 대로 추가돼요.</p><div class="member-actions"><button type="button" class="btn line" data-member-mode="newpass">비밀번호 바꾸기</button><button type="button" class="btn line" id="memberLogout">회원 로그아웃</button></div></div>${adminEntry}`;
      $('#memberLogout').onclick=async()=>{try{await api('member-logout',{method:'POST',body:{}});state.member=null;await refreshSession();closeWorkspace();toast('로그아웃했어요.');}catch(error){toast(error.message);}};
      return;
    }
    if(mode==='reset'||mode==='resend'){
      const reset=mode==='reset';
      openShell(memberTitles[mode],reset?'가입한 이메일로 비밀번호를 다시 정하는 링크를 보내요.':'가입할 때 받은 인증 메일이 없거나 링크가 만료됐을 때 새 메일을 받아요.','member');
      $('#workspaceBody').innerHTML=`<form id="memberForm" class="entry-form">${note}${field('이메일','email','',{type:'email',max:254})}<p class="field-help">메일이 보이지 않으면 스팸함도 확인해 주세요.</p><p class="form-error" role="alert" hidden></p><button type="submit" class="btn solid submit">${reset?'재설정 링크 받기':'인증 메일 다시 받기'}</button><p class="member-links"><button type="button" class="text-link" data-member-mode="login">로그인으로 돌아가기</button><span aria-hidden="true">·</span><button type="button" class="text-link" data-member-mode="${reset?'resend':'reset'}">${reset?'인증 메일 다시 받기':'비밀번호 찾기'}</button></p></form>`;
      $('#memberForm').onsubmit=e=>{e.preventDefault();const form=e.target;withBusy(form,async()=>{
        const data=Object.fromEntries(new FormData(form));
        await api(reset?'member-recover':'member-resend',{method:'POST',body:data});form.reset();
        $('#workspaceBody').innerHTML=`<div class="success-state"><span>✉️</span><h3>메일함을 확인해 주세요</h3><p>${reset?'가입한 이메일이라면 비밀번호를 다시 정하는 링크를 보냈어요.<br>링크를 누르면 새 비밀번호를 정할 수 있어요.':'아직 인증하지 않은 가입 이메일이라면 새 인증 메일을 보냈어요.<br>이미 인증했다면 바로 로그인해 주세요.'}</p><button class="btn solid" data-member-mode="login">로그인으로 이동</button></div>`;
      });};
      return;
    }
    const signup=mode==='signup';
    openShell(signup?'회원가입':'회원 로그인',next?'업로드 요청을 하려면 이메일을 인증한 참코딩 회원으로 로그인해 주세요.':'참코딩 회원으로 로그인하고 회원 전용 콘텐츠를 이용하세요.','member');
    $('#workspaceBody').innerHTML=`<form id="memberForm" class="entry-form"><div class="tabs"><button type="button" data-member-mode="login" class="${!signup?'on':''}">로그인</button><button type="button" data-member-mode="signup" class="${signup?'on':''}">회원가입</button></div>${note}${signup?field('이름','name','',{max:60}):''}${field('이메일','email','',{type:'email',max:254})}${signup?passwordFields()+'<p class="field-help">가입 후 받은 인증 메일의 링크를 눌러 이메일을 확인해 주세요.</p>':'<label class="field"><span>비밀번호 *</span><input type="password" name="password" minlength="8" maxlength="256" autocomplete="current-password" required></label>'}<p class="form-error" role="alert" hidden></p><button type="submit" class="btn solid submit">${signup?'회원가입':'로그인'}</button>${memberLinks}</form>${signup?'':adminEntry}`;
    $('#memberForm').onsubmit=e=>{e.preventDefault();const form=e.target;withBusy(form,async()=>{
      const data=Object.fromEntries(new FormData(form));
      if(signup&&data.password!==data.confirm)throw new Error('비밀번호 확인이 일치하지 않아요.');
      const result=await api(signup?'member-signup':'member-login',{method:'POST',body:data});form.reset();
      if(signup&&result.needsConfirmation){$('#workspaceBody').innerHTML='<div class="success-state"><span>✉️</span><h3>이메일을 확인해 주세요</h3><p>인증 메일의 링크를 누르면 바로 로그인돼요.<br>메일이 보이지 않으면 스팸함을 확인하거나 인증 메일을 다시 받아 주세요.</p><button class="btn solid" data-member-mode="login">로그인으로 이동</button><button class="btn line" data-member-mode="resend">인증 메일 다시 받기</button></div>';}
      else{await refreshSession();await memberEntry('login',next);}
    });};
  }
  // 인증·비밀번호 재설정 메일 링크로 돌아왔을 때: 토큰은 서버의 HttpOnly 쿠키로 옮기고, 실패 사유를 안내한다.
  async function memberFromMail(tokens,error,recovery,description=''){
    if(error){
      // 오류 주소에는 인증 메일인지 비밀번호 재설정 메일인지가 없으므로 두 경우를 함께 안내한다.
      const expired=/expired/i.test(error+' '+description);
      return memberEntry('resend',null,{error:true,text:(expired?'메일 링크가 만료됐거나 이미 사용됐어요. ':'메일 링크를 확인하지 못했어요. ')+'가입 인증이라면 아래에서 새 인증 메일을 받고, 비밀번호를 찾던 중이라면 ‘비밀번호 찾기’에서 새 링크를 받아 주세요. 이미 인증했다면 로그인해 주세요.'});
    }
    if(tokens){
      loadingShell(recovery?'비밀번호 찾기':'이메일 인증','member');
      try{await api('member-link',{method:'POST',body:tokens});}
      catch(e){return memberEntry('login',null,{error:true,text:e.message});}
      if(recovery)return memberEntry('newpass',null,{text:'본인 확인을 마쳤어요. 새 비밀번호를 정해 주세요.'});
      return memberEntry('login',null,{text:'이메일 인증을 마쳤어요. 참코딩 회원으로 로그인됐어요.'});
    }
    return memberEntry('login',null,{text:recovery?'메일 링크를 확인했어요. 새 비밀번호로 로그인해 주세요.':'이메일 인증을 마쳤어요. 가입한 이메일과 비밀번호로 로그인해 주세요.'});
  }
  const mcpUrl='https://www.chamssaem.kr/mcp';
  const claudeCommand=token=>`claude mcp add --transport http --scope user chamcoding ${mcpUrl} --header "Authorization: Bearer ${token}"`;
  const codexConfig=token=>`[mcp_servers.chamcoding]
url = "${mcpUrl}"
http_headers = { "Authorization" = "Bearer ${token}" }`;
  const mcpPrompt=token=>`참코딩 MCP를 내 개인 에이전트에 연결해 줘.

Claude Code를 쓰고 있으면 사용자 범위에 추가해 줘.
${claudeCommand(token)}

Codex를 쓰고 있으면 개인 ~/.codex/config.toml의 chamcoding 항목을 추가하거나 갱신해 줘.
${codexConfig(token)}

토큰은 내 개인 MCP 설정에만 저장해 줘. 답변, 프로젝트 파일, Git, 셸 기록에 남기지 마.
새 세션이 필요하면 알려 주고, 연결 후 list_options를 호출해 등록 규칙을 확인해 줘.
내가 앱 등록을 요청하면 공개 주소와 실제 화면을 확인하고 앱 소개를 작성해 줘. 스크린샷 파일에서 base64를 로컬로 읽어 upload_screenshot의 data_base64에 넣고, 이미지 원문은 채팅에 출력하지 마. 도구로 파일 내용을 직접 전달하기 어렵다면 로컬 스크립트에서 파일을 읽어 ${mcpUrl}에 JSON-RPC tools/call POST를 보내 줘. Authorization에는 개인 설정의 Bearer 토큰을 쓰고, 로그에는 남기지 마.
register_app의 dry_run으로 검증한 내용과 본인 제작 확인 질문을 보여 줘. 내가 직접 “네”라고 답하면 같은 정보와 confirmation_id, confirm_own_work: true로 접수해 줘.`;

  const requestIcons={
    agent:'<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 7V3m-3 9h.01M15 12h.01M9 16h6"/>',
    prompt:'<path d="M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3zM8 8h8M8 12h5"/>',
    direct:'<path d="M12 15V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>'
  };
  const requestIcon=name=>`<svg class="request-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${requestIcons[name]}</svg>`;
  const requestExample='이 앱을 참코딩에 등록해 줘: (내 웹앱 주소)';
  async function copyRequestText(value){
    try{await navigator.clipboard.writeText(value);return true;}catch{}
    const field=document.createElement('textarea'),focused=document.activeElement;
    field.className='request-copy-buffer';
    field.value=value;field.readOnly=true;workspace.append(field);
    field.select();
    try{return document.execCommand('copy');}catch{return false;}
    finally{field.remove();if(focused?.isConnected)focused.focus({preventScroll:true});}
  }
  const requestTabs = [['agent','에이전트 요청'],['prompt','프롬프트 요청'],['direct','직접 업로드']];
  function selectRequestTab(id, focus=false) {
    for(const [key] of requestTabs){
      const button=$('#request-tab-'+key), selected=key===id;
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex=selected?0:-1;
      $('#request-panel-'+key).hidden=!selected;
      if(selected&&focus)button.focus();
    }
  }
  function selectDirectMode(mode) {
    workspace.querySelectorAll('[data-direct-mode]').forEach(button=>{
      button.setAttribute('aria-pressed',String(button.dataset.directMode===mode));
    });
    $('#singleRequest').hidden=mode!=='single';
    $('#bulkRequest').hidden=mode!=='bulk';
  }
  const requestLogin = tab => `<button type="button" class="btn solid" data-request-login="${tab}">${requestIcon('arrow')} 로그인하고 시작</button>`;
  async function uploadRequests(initial='agent', mode='single') {
    state.area='member';
    state.shots.forEach(revokePreview);state.shots=[];
    state.bulk?.cards.forEach(c=>c.shots.forEach(revokePreview));state.bulk=null;
    const revision=openShell('업로드 요청','만든 웹앱을 참코딩에 소개해 주세요. 요청한 앱은 관리자 승인 후 공개돼요.','requests');
    $('#workspaceBody').innerHTML=`<section class="upload-requests">
      <div class="request-tabs" role="tablist" aria-label="업로드 요청 방법">
        ${requestTabs.map(([key,label])=>`<button type="button" id="request-tab-${key}" role="tab" data-request-tab="${key}" aria-controls="request-panel-${key}" aria-selected="false" tabindex="-1">${requestIcon(key)}<span>${label}</span></button>`).join('')}
      </div>
      <section id="request-panel-agent" role="tabpanel" aria-labelledby="request-tab-agent" tabindex="0" hidden>
        <section class="mcp-setup" aria-label="MCP로 업로드 요청하기">
          <header class="request-intro"><span class="mcp-tag">MCP 연결</span><h3>AI에게 앱 등록 맡기기</h3><p>Claude Code나 Codex가 앱 소개와 스크린샷을 준비해요.</p></header>
          <ol class="mcp-steps" aria-label="에이전트 요청 3단계">
          <li class="mcp-card mcp-connect" aria-labelledby="mcpTokenTitle">
            <p class="mcp-kicker">처음 한 번만</p>
            <h4 id="mcpTokenTitle"><span class="mcp-step-number"><span class="sr-only">단계 </span>1</span>토큰 준비하기</h4>
            <p>로그인한 뒤 토큰을 발급하세요. 이미 발급했다면 저장한 토큰을 붙여 넣으세요.</p>
            <section id="mcpControls" aria-label="연결 준비"><p role="status">로그인 상태를 확인하고 있어요…</p></section>
          </li>
          <li class="mcp-card mcp-connect" aria-labelledby="mcpConnectTitle">
            <p class="mcp-kicker">토큰을 준비했다면</p>
            <h4 id="mcpConnectTitle"><span class="mcp-step-number"><span class="sr-only">단계 </span>2</span>에이전트 연결하기</h4>
            <p>설정 프롬프트를 복사해 Claude Code나 Codex 채팅에 붙여 넣으세요.</p>
            <button type="button" class="btn line mcp-copy-locked" data-mcp-copy="prompt" aria-disabled="true" aria-describedby="mcpFeedback">${requestIcon('copy')} 설정 프롬프트 복사</button>
            <p class="mcp-feedback" id="mcpFeedback" role="status"></p>
            <label class="field mcp-fallback" hidden><span>설정 프롬프트 직접 복사</span><textarea readonly rows="4" autocomplete="off" spellcheck="false"></textarea></label>
          </li>
          <li class="mcp-card mcp-request" aria-labelledby="mcpRequestTitle">
            <p class="mcp-kicker">연결했다면</p>
            <h4 id="mcpRequestTitle"><span class="mcp-step-number"><span class="sr-only">단계 </span>3</span>앱 등록 요청하기</h4>
            <p>에이전트에게 앱 주소와 함께 등록을 부탁하세요.</p>
            <div class="mcp-example"><code>${requestExample}</code><button type="button" class="btn line" data-mcp-copy="example">${requestIcon('copy')} 예시 복사</button></div>
            <p>준비된 내용을 확인하고 직접 만든 앱이라면 동의해 주세요. 동의하면 관리자에게 접수돼요.</p>
            <p class="mcp-example-status" role="status"></p>
          </li>
          </ol>
          <details class="mcp-details"><summary>직접 연결하기</summary>
            <section class="mcp-details-body" aria-label="직접 연결 설정">
              <div class="tabs mcp-clients" role="group" aria-label="연결할 AI 선택">
                <button type="button" data-mcp-client="claude" aria-pressed="true" class="on">Claude Code</button>
                <button type="button" data-mcp-client="codex" aria-pressed="false">Codex</button>
                <button type="button" data-mcp-client="app" aria-pressed="false">Claude 앱</button>
              </div>
              <p class="mcp-client-help"></p>
              <pre tabindex="0"><code id="mcpCommand"></code></pre>
              <button type="button" class="btn line" data-mcp-copy="command">${requestIcon('copy')} 연결 설정 복사</button>
              <p class="mcp-manual-status" role="status"></p>
            </section>
          </details>
        </section>
      </section>
      <section id="request-panel-prompt" role="tabpanel" aria-labelledby="request-tab-prompt" tabindex="0" hidden>
        <header class="request-intro"><h3>AI로 소개와 스크린샷 준비하기</h3><p>프롬프트로 업로드에 필요한 자료를 만든 뒤, 직접 업로드 탭에서 내용을 확인하고 요청을 보내세요.</p></header>
        ${prepBox()}${bulkPromptBox()}
      </section>
      <section id="request-panel-direct" role="tabpanel" aria-labelledby="request-tab-direct" tabindex="0" hidden>
        <section id="directControls" aria-label="업로드 양식"><p class="loading-state" role="status">로그인 상태를 확인하고 있어요…</p></section>
      </section>
      <footer class="request-footer" id="requestFooter"></footer>
      <section id="mcpTokenList" class="mcp-card mcp-token-record" aria-labelledby="mcpRecordTitle" hidden>
        <h3 id="mcpRecordTitle" tabindex="-1">MCP 연결 기록 <span id="mcpTokenCount"></span></h3>
        <div class="mcp-example"><code>${mcpUrl}</code><button type="button" class="btn line" data-mcp-copy="url">${requestIcon('copy')} 주소 복사</button></div>
        <ul id="mcpTokens"></ul>
        <section id="mcpIssued" class="mcp-token-entry" aria-label="발급된 토큰 원문" hidden>
          <label class="field"><span>발급된 토큰</span><input type="text" id="mcpIssuedToken" readonly autocomplete="off" spellcheck="false"></label>
          <button type="button" class="btn line" data-mcp-copy="token">${requestIcon('copy')} 토큰 복사</button>
          <p class="field-help">토큰 전체 값은 발급한 창에서만 확인할 수 있어요.</p>
        </section>
        <p class="mcp-record-status" role="status"></p>
      </section>
    </section>`;
    workspace.scrollTop=0;
    selectRequestTab(initial);
    const heading=$('#workspaceTitle');heading.tabIndex=-1;heading.focus({preventScroll:true});
    const mcp=bindMcpSetup($('#request-panel-agent'));
    const direct=$('#directControls');
    try {
      await refreshSession();
      if(revision!==viewRevision||!workspace.open)return;
      if(!state.member){
        $('#mcpControls').innerHTML=requestLogin('agent');
        direct.innerHTML=`<section class="request-intro"><h3>웹앱 정보를 직접 입력하기</h3><p>회원으로 로그인하면 소개와 스크린샷을 등록해 승인 요청을 보낼 수 있어요.</p>${requestLogin(mode==='bulk'?'bulk':'direct')}</section>`;
        return;
      }
      $('#requestFooter').innerHTML=`<button type="button" data-view="queue" class="btn line">${requestIcon('arrow')} 내 요청 보기</button>`;
      direct.innerHTML=`<header class="request-intro"><h3>웹앱 정보를 직접 입력하기</h3><p>설명과 스크린샷을 확인한 뒤 요청을 보내세요.</p></header>
        <div class="direct-modes" role="group" aria-label="올릴 앱 개수"><button type="button" class="btn line" data-direct-mode="single">앱 한 개</button><button type="button" class="btn line" data-direct-mode="bulk">여러 앱 일괄 업로드</button></div>
        <section id="singleRequest"></section><section id="bulkRequest" hidden></section>`;
      uploadForm(null,$('#singleRequest'));
      bulkView($('#bulkRequest'));
      selectDirectMode(mode);
      await mcp.loadTokens();
    } catch(error){
      if(revision!==viewRevision||!workspace.open)return;
      for(const el of [$('#mcpControls'),direct])el.innerHTML=`<p class="form-error" role="alert">${esc(error.message)}</p><button type="button" class="btn line" data-view="requests">다시 시도</button>`;
    }
  }
  function bindMcpSetup(root) {
    const dialogContent=root.closest('.upload-requests');
    const controls=root.querySelector('#mcpControls'), list=dialogContent.querySelector('#mcpTokenList');
    const issuedToken=list.querySelector('#mcpIssuedToken'), recordStatus=list.querySelector('.mcp-record-status');
    const feedback=root.querySelector('.mcp-feedback'), manualStatus=root.querySelector('.mcp-manual-status');
    const fallback=root.querySelector('.mcp-fallback'), fallbackText=fallback.querySelector('textarea');
    let tokens=[], issued, issueButton, tokenInput;
    const promptButton=root.querySelector('[data-mcp-copy="prompt"]');
    const clearFallback=()=>{fallback.hidden=true;fallbackText.value='';};
    const setupToken=()=>issued?.token||tokenInput?.value.trim()||'';
    const validSetupToken=token=>/^chm_live_[A-Za-z0-9_-]{43}$/.test(token);
    const updatePromptState=()=>{
      const ready=tokens.length>0&&validSetupToken(setupToken());
      promptButton.classList.toggle('solid',ready);
      promptButton.classList.toggle('line',!ready);
      promptButton.classList.toggle('mcp-copy-locked',!ready);
      promptButton.setAttribute('aria-disabled',String(!ready));
    };
    const renderTokens=()=>{
      list.querySelector('#mcpTokenCount').textContent=`${tokens.length}개`;
      list.querySelector('#mcpTokens').innerHTML=tokens.length?tokens.map(token=>
        `<li><div><strong>${esc(token.name)}</strong> <code>${esc(token.prefix)}…</code><p class="field-help">발급 ${date(token.created_at)} · 마지막 사용 ${token.last_used_at?date(token.last_used_at):'없음'}</p></div><button type="button" class="btn line" data-mcp-revoke="${esc(token.id)}" aria-label="${esc(token.name)} 토큰 폐기">폐기</button></li>`
      ).join(''):'<li>사용 중인 토큰이 없어요.</li>';
      issueButton.hidden=tokens.length>0;
      issueButton.disabled=tokens.length>0;
      issuedToken.value=issued?.token||'';
      list.querySelector('#mcpIssued').hidden=!issued;
      tokenInput.closest('label').hidden=Boolean(issued)||tokens.length===0;
      updatePromptState();
      const capacity=root.querySelector('#mcpCapacity');
      capacity.hidden=Boolean(issued)||tokens.length===0;
      capacity.textContent=tokens.length>1
        ? '기존 토큰이 여러 개 있어요. 사용할 토큰을 붙여 넣고, 사용하지 않는 토큰은 아래에서 폐기할 수 있어요.'
        : '발급된 토큰이 있어요. 저장한 토큰을 붙여 넣으세요. 토큰 값을 잃어버렸다면 아래에서 폐기하고 다시 만들 수 있어요.';
    };
    const setClient=client=>{
      root.querySelectorAll('[data-mcp-client]').forEach(button=>{
        const active=button.dataset.mcpClient===client;
        button.classList.toggle('on',active);button.setAttribute('aria-pressed',String(active));
      });
      const placeholder='<발급받은 토큰>';
      const clients={
        claude:['토큰 자리만 바꿔 터미널에서 실행한 뒤 Claude Code를 다시 여세요.',claudeCommand(placeholder)],
        codex:['토큰 자리만 바꿔 개인 config.toml에 넣은 뒤 Codex를 다시 여세요.',codexConfig(placeholder)],
        app:['Claude의 설정 → 커넥터 → 사용자 지정 커넥터에 이 주소를 추가하면 공개 앱을 찾아볼 수 있어요.',mcpUrl]
      };
      root.querySelector('.mcp-client-help').textContent=clients[client][0];
      root.querySelector('#mcpCommand').textContent=clients[client][1];
      manualStatus.textContent='';
    };
    setClient('claude');
    async function loadTokens(){
      controls.innerHTML='<p role="status">연결을 준비하고 있어요…</p>';
      try { ({tokens}=await api('mcp-tokens')); }
      catch(error){
        controls.innerHTML=`<p class="form-error" role="alert">${esc(error.message)}</p><button type="button" class="btn line" data-mcp-retry>다시 시도</button>`;
        return;
      }
      if(!controls.isConnected)return;
      controls.innerHTML=`<section class="mcp-token-entry" aria-label="연결 단계">
        <button type="button" class="btn solid" data-mcp-issue>토큰 발급</button>
        <p class="mcp-capacity" id="mcpCapacity" hidden></p>
        <label class="field"><span>토큰 붙여 넣기</span><input type="password" id="mcpTokenInput" placeholder="chm_live_…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="mcpFeedback"></label>
      </section>`;
      issueButton=controls.querySelector('[data-mcp-issue]');
      tokenInput=controls.querySelector('#mcpTokenInput');
      tokenInput.addEventListener('input',()=>{
        tokenInput.removeAttribute('aria-invalid');
        updatePromptState();
        clearFallback();
        feedback.textContent='';
      });
      renderTokens();list.hidden=false;
    }
    async function issueToken(){
      if(tokens.length)return;
      state.busy=true;
      issueButton.disabled=true;
      issueButton.textContent='토큰 만드는 중…';
      feedback.textContent='';
      try {
        issued=await api('mcp-token',{method:'POST',body:{name:'참코딩 MCP'}});
        tokens.unshift(issued.record);
        feedback.textContent='토큰을 발급했어요. 설정 프롬프트를 복사해 에이전트에 붙여 넣으세요.';
      } catch(error) {
        feedback.textContent=error.message;
      } finally {
        state.busy=false;
        issueButton.textContent='토큰 발급';
        renderTokens();
        const next=issued?promptButton:issueButton;
        if(!next.disabled)next.focus();
      }
    }
    async function copySetup(){
      if(!tokens.length){
        feedback.textContent='1단계에서 로그인하고 토큰을 준비해 주세요.';
        return;
      }
      const token=setupToken();
      if(!validSetupToken(token)){
        tokenInput.setAttribute('aria-invalid','true');
        feedback.textContent='chm_live_로 시작하는 토큰 값 전체를 붙여 넣으세요.';
        tokenInput.focus();
        return;
      }
      const value=mcpPrompt(token);
      state.busy=true;
      promptButton.disabled=true;
      try {
        if(await copyRequestText(value)){
          clearFallback();
          feedback.textContent='복사했어요. 내 에이전트 채팅에 붙여 넣으세요.';
        }else{
          fallback.hidden=false;
          fallbackText.value=value;
          fallbackText.focus();
          fallbackText.select();
          feedback.textContent='자동으로 복사하지 못했어요. 아래에 선택된 내용을 복사해 주세요.';
        }
      } finally {
        state.busy=false;
        promptButton.disabled=false;
        if(fallback.hidden&&document.activeElement===document.body)promptButton.focus({preventScroll:true});
      }
    }
    dialogContent.addEventListener('click',async event=>{
      const button=event.target.closest('button');
      if(!button||state.busy)return;
      if(button.hasAttribute('data-mcp-retry'))return loadTokens();
      if(button.hasAttribute('data-mcp-issue'))return issueToken();
      if(button.dataset.mcpClient)return setClient(button.dataset.mcpClient);
      const id=button.dataset.mcpRevoke;
      if(id){
        if(!window.confirm('이 토큰을 폐기할까요?'))return;
        state.busy=true;button.disabled=true;
        try {
          await api('mcp-token',{method:'PATCH',body:{id}});
          tokens=tokens.filter(token=>token.id!==id);
          if(issued?.record.id===id)issued=null;
          tokenInput.value='';
          tokenInput.removeAttribute('aria-invalid');
          clearFallback();
          feedback.textContent='';
          renderTokens();
          recordStatus.textContent='연결 토큰을 폐기했어요.';
          list.querySelector('#mcpRecordTitle').focus({preventScroll:true});
          toast('연결 토큰을 폐기했어요.');
        } catch(error) {toast(error.message);}
        finally {state.busy=false;button.disabled=false;}
        return;
      }
      const copy=button.dataset.mcpCopy;
      if(copy==='prompt')return copySetup();
      if(copy==='example'){
        const copied=await copyRequestText(requestExample);
        root.querySelector('.mcp-example-status').textContent=copied?'복사했어요. 괄호 안을 내 웹앱 주소로 바꿔 주세요.':'예시 문장을 선택해서 복사해 주세요.';
      }
      if(copy==='token'&&issued){
        if(await copyRequestText(issued.token)){
          recordStatus.textContent='토큰을 복사했어요.';
        }else{
          recordStatus.textContent='선택된 토큰 값을 직접 복사해 주세요.';
          issuedToken.focus();
          issuedToken.select();
        }
      }
      if(copy==='url'){
        recordStatus.textContent=await copyRequestText(mcpUrl)?'연결 주소를 복사했어요.':'연결 주소를 선택해 복사해 주세요.';
      }
      if(copy==='command'){
        const value=root.querySelector('#mcpCommand').textContent;
        manualStatus.textContent=await copyRequestText(value)?'복사했어요.':'복사하지 못했어요. 브라우저의 클립보드 권한을 확인해 주세요.';
      }
    });
    return {loadTokens};
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
  /* ===== 내 AI에게 업로드 준비 맡기기 =====
     업로더가 Claude Code·Codex·ChatGPT Work 같은 AI에 붙여 넣어 스크린샷과 폼 내용을 준비하게 하는 프롬프트(한 개용·일괄용).
     폼 규칙(카테고리·교과·학년 형식·글자 수·사진 수)이 바뀌면 promptRules 문구도 함께 고친다. */
  const BULK_MAX_CARDS=12, BULK_MAX_IMAGES=36;   // 서버의 시간당 제한(요청 12회·이미지 36장)에 맞춘다
  const promptSafety = `   - 로그인·결제·이메일 전송·제출·삭제 같은 버튼은 누르지 마.
   - 실제 개인정보는 입력하지 마. 입력해야만 다음 화면이 열리면 teacher@example.com, 학생1 같은 예시 값만 써.`;
  const promptRules = () => `- 앱 이름: 60자 이내
- 제작자 이름: 화면에서 확실히 알 수 없으면 '직접 입력'이라고 남겨
- 웹앱 주소: 앱 주소(https://로 시작)
- 체험하기 주소: 체험용 주소가 따로 있을 때만
- 소개 영상 주소: 사이트에 유튜브·비메오 링크가 실제로 있을 때만
- 카테고리(하나): ${CATS.filter(c=>c.k!=='all').map(c=>c.name).join(' / ')}
- 적용 학년: '초등학교 4-6학년'처럼 학교급 + 시작-끝 학년(초등학교 1~6, 중학교·고등학교 1~3). 3학년만이면 '초등학교 3-3학년'. 추정했다면 그렇다고 적어
- 교과(1개 이상, 여러 개 가능, 이 목록에서만): ${SUBJECTS.join(', ')}
- 대표 색상: #RRGGBB(앱의 대표 색)
- 한 줄 소개: 어떤 수업에서 무엇을 하는 앱인지 한 문장, 160자 이내(70자 안팎 권장)
- 상세 설명: 앱의 목적 → 사용 방법(화면의 버튼·단계) → 수업 활용 팁 순서, 해요체, 6000자 이내. 화면에서 확인하지 못한 기능은 지어내지 마
- 새로운 소식 · 변경 사항: 한 줄에 하나, 최대 12줄(알 수 없으면 비워 둬)
- 스크린샷 설명: 사진마다 한 문장, 250자 이내
- 연락 이메일과 '공개 권한·개인정보 확인' 체크는 내가 직접 할 테니 비워 둬`;
  const promptChat = what => `[Codex·Claude Code가 아닌 일반 채팅인 경우]
바탕화면에 폴더를 만들 수 없으면, 이 채팅 안에서 쓸 수 있는 기능(웹 브라우징, 코드 실행, 인앱 브라우저 등)으로 위 작업을 똑같이 진행해 줘.
- 찍은 스크린샷은 파일 이름(01-대표썸네일.png 등)을 붙여 이 채팅에 이미지 파일로 바로 보내 줘. 여러 장이면 zip으로 묶어 내려받을 수 있게 해도 좋아.
- '${what}'도 파일로 만들어 채팅에 보내 주고, 같은 내용을 칸별로 채팅에도 적어 줘. 나는 채팅에서 바로 저장해서 업로드 폼에 쓸 거야.
- 이 채팅에서 사이트를 열거나 캡처할 수 없으면 먼저 그렇다고 말해 줘. 그때는 내가 직접 찍을 스크린샷 목록(어떤 화면, 몇 장)을 알려 주고, 사이트 내용을 볼 수 없으면 지어내지 말고 나에게 앱 설명을 물어봐.`;
  const prepPrompt = () => `너는 내 웹앱을 '참코딩'(https://www.chamssaem.kr/) 웹앱 목록에 올리기 위한 업로드 준비를 돕는 조수야.

[내 웹앱 주소]
웹앱 주소: (여기에 내 웹앱 주소를 붙여 넣으세요)

[해야 할 일]
1. 위 주소를 브라우저로 열고, 첫 화면과 주요 메뉴·기능을 직접 눌러 보며 어떤 앱인지 파악해 줘.
${promptSafety}
2. 스크린샷을 최대 6장 찍어 줘(대표 썸네일 포함).
   - 01번 대표 썸네일: 창을 정사각형(예: 900×900)으로 맞추고 첫 화면을 찍어. 목록 카드에 정사각형으로 보여.
   - 02~06번: 1280×800 정도 창에서 메인 화면과 핵심 기능이 실제로 동작하는 화면을 골라 찍어. 시작 설정 화면보다 버튼을 눌러 결과·진행 상황이 보이는 화면이 좋아.
   - PNG 또는 JPG, 장당 15MB 이하. 학생 이름·얼굴 같은 개인정보가 보이면 그 화면은 빼.
3. 바탕화면에 '참코딩 업로드 준비' 폴더를 만들고 그 안에 앱 이름 폴더를 만들어 줘. 사진은 01-대표썸네일.png, 02-메인화면.png처럼 순서와 내용이 보이는 이름으로 저장해.
4. 같은 폴더에 '업로드 내용.md'를 만들고, 아래 업로드 폼 칸을 순서대로 채워 줘. 폼에 바로 복사해 붙일 수 있게 칸마다 내용을 따로 적어.

[업로드 폼 칸과 규칙]
${promptRules()}

[마지막에 알려 줄 것]
- 만든 폴더 위치와 파일 목록
- 내가 직접 확인하거나 고쳐야 할 칸(추정한 학년, 제작자 이름 등)

${promptChat('업로드 내용.md')}`;
  const bulkPrompt = () => `너는 내 웹앱 여러 개를 '참코딩'(https://www.chamssaem.kr/) 웹앱 목록에 한 번에 올리기 위한 일괄 업로드 준비를 돕는 조수야.

[내 웹앱 주소 목록] 한 줄에 하나씩, 최대 ${BULK_MAX_CARDS}개
1. (여기에 웹앱 주소를 붙여 넣으세요)
2. (두 번째 웹앱 주소)
3. (필요한 만큼 줄을 늘려 주세요)

[해야 할 일]
1. 목록의 주소를 순서대로 하나씩 브라우저로 열고, 첫 화면과 주요 메뉴·기능을 직접 눌러 보며 어떤 앱인지 파악해 줘.
${promptSafety}
2. 앱마다 스크린샷을 찍어 줘.
   - 01번 대표 썸네일: 창을 정사각형(예: 900×900)으로 맞추고 첫 화면을 찍어. 목록 카드에 정사각형으로 보여.
   - 02번부터: 1280×800 정도 창에서 메인 화면과 핵심 기능이 실제로 동작하는 화면(버튼을 눌러 결과·진행 상황이 보이는 화면)을 골라 찍어.
   - 앱당 최대 6장, 모든 앱을 합쳐 ${BULK_MAX_IMAGES}장 이하. 앱이 7개 이상이면 앱당 3~4장으로 줄여 합계를 맞춰.
   - PNG 또는 JPG, 장당 15MB 이하. 학생 이름·얼굴 같은 개인정보가 보이면 그 화면은 빼.
3. 바탕화면에 '참코딩 업로드 준비/일괄 업로드' 폴더를 만들고, 앱마다 '01-앱 이름', '02-앱 이름'처럼 목록 순서가 보이는 폴더를 만들어 사진을 저장해. 사진 이름은 01-대표썸네일.png, 02-메인화면.png처럼 순서와 내용이 보이게 지어.
4. '일괄 업로드' 폴더에 '일괄 업로드 내용.md'를 만들어 줘. 앱마다 '## 앱 1 — 앱 이름' 제목 아래에 업로드 카드 칸을 순서대로 채우고, 사진 파일 이름과 사진별 설명도 적어 줘. 나는 참코딩 일괄 업로드 화면에서 '웹앱 카드 추가'로 카드를 앱 수만큼 만들고 같은 번호 카드에 칸마다 복사해 붙일 거야.

[업로드 카드 칸과 규칙] 앱마다 아래 칸을 채워 줘
${promptRules()}

[마지막에 알려 줄 것]
- 만든 폴더 위치와 앱별 파일 목록, 전체 사진 수
- 열지 못했거나 로그인이 필요해 제대로 보지 못한 앱
- 내가 직접 확인하거나 고쳐야 할 칸(추정한 학년, 제작자 이름 등)

${promptChat('일괄 업로드 내용.md')}`;
  const promptBox = ({id,title,steps,prompt,folder}) => `<section class="ai-prep" aria-labelledby="${id}Title"><div class="ai-prep-head"><b id="${id}Title">${title}</b></div>
      <ol class="ai-prep-steps">${steps}<li><b>Claude Code, Codex, ChatGPT Work(에이전트)</b>처럼 컴퓨터·브라우저를 다룰 수 있는 AI에 붙여 넣으면, 바탕화면 <b>'${folder}'</b> 폴더에 스크린샷과 정리된 내용이 만들어져요.</li></ol>
      <p class="ai-prep-note">일반 AI 채팅(ChatGPT·Claude·Gemini 채팅창)은 바탕화면에 폴더를 만들 수 없어요. 대신 <b>채팅 안에서 캡처본과 정리된 내용을 파일로 보내 주니</b>, 채팅에서 바로 저장해 쓰세요. 채팅에서 사이트를 열지 못하면 <b>Claude Code나 ChatGPT Work</b>를 쓰거나 스크린샷을 직접 찍어 주세요.</p>
      <textarea id="${id}" class="ai-prep-prompt" rows="8" readonly aria-label="${esc(title)} 프롬프트">${esc(prompt)}</textarea>
      <div class="ai-prep-actions"><button type="button" class="btn solid" data-copy-prompt="${id}">${requestIcon('copy')} 프롬프트 복사</button><button type="button" class="btn line" data-request-target="direct" data-target-mode="${id==='bulkPrepPrompt'?'bulk':'single'}">직접 업로드로 이동 ${requestIcon('arrow')}</button><span class="ai-prep-copied" role="status" aria-live="polite"></span></div></section>`;
  const prepBox = () => promptBox({id:'aiPrepPrompt',title:'웹앱 한 개 준비하기',folder:'참코딩 업로드 준비',prompt:prepPrompt(),
    steps:'<li><b>프롬프트 복사</b>를 누르고, 프롬프트의 <b>웹앱 주소:</b> 뒤에 내 앱 주소를 넣어 주세요.</li>'});
  const bulkPromptBox = () => promptBox({id:'bulkPrepPrompt',title:'웹앱 여러 개 준비하기',folder:'참코딩 업로드 준비/일괄 업로드',prompt:bulkPrompt(),
    steps:'<li><b>프롬프트 복사</b>를 누르고, <b>내 웹앱 주소 목록</b>에 올릴 앱 주소를 한 줄에 하나씩 넣어 주세요(최대 '+BULK_MAX_CARDS+'개).</li><li>AI가 만든 \'일괄 업로드 내용.md\'의 앱 순서대로 직접 업로드 탭에서 <b>웹앱 카드 추가</b>를 눌러 카드를 만들고 칸마다 붙여 넣어 주세요.</li>'});
  async function copyPrepPrompt(button) {
    const area=$('#'+button.dataset.copyPrompt),done=button.parentElement.querySelector('.ai-prep-copied');if(!area)return;
    try{await navigator.clipboard.writeText(area.value);}
    catch{area.focus();area.select();document.execCommand('copy');}
    done.textContent='복사했어요. AI에 붙여 넣고 웹앱 주소를 채워 주세요.';toast('프롬프트를 복사했어요.');
  }

  /* ===== 일괄 업로드 =====
     카드 하나가 웹앱 하나. 아래 '웹앱 카드 추가'로 업로더가 개수를 정한다(최대 12개, 사진 합계 36장).
     보낼 때는 카드마다 일반 업로드와 같은 API(upload → submit)를 차례로 부르고, 보낸 카드는 잠가 다시 보내지 않는다. */
  const bulkCardOf = el => state.bulk?.cards.find(c=>c.key===el.dataset.card);
  function bulkCardHtml(card, author='') {
    return `<article class="bulk-card" data-card="${card.key}">
      <header class="bulk-card-head"><span class="bulk-no"></span><b class="bulk-name">새 웹앱</b><span class="bulk-state" role="status"></span><button type="button" class="bulk-remove" data-card-remove="${card.key}">카드 삭제</button></header>
      <div class="form-grid">${field('앱 이름','name','',{max:60,placeholder:'예: 우리 반 모둠 뽑기'})}${field('제작자 이름','author_name',author,{max:60,placeholder:'이름 또는 연구회 이름'})}</div>
      ${field('웹앱 주소','web_url','',{type:'url',max:2000,placeholder:'https://my-app.vercel.app'})}
      <div class="form-grid">${field('체험하기 주소','demo_url','',{required:false,type:'url',max:2000,placeholder:'https://…'})}${field('소개 영상 주소','video_url','',{required:false,type:'url',max:2000,placeholder:'https://youtu.be/…'})}</div>
      <div class="form-grid"><label class="field"><span>카테고리 <b class="required">*</b></span><select name="cat" required>${CATS.filter(c=>c.k!=='all').map(c=>`<option value="${c.k}">${c.icon} ${c.name}</option>`).join('')}</select></label>${gradeField('')}</div>
      <fieldset class="field subject-pick"><legend>교과 <b class="required">*</b> <small>여러 개 고를 수 있어요</small></legend><div class="subject-list">${SUBJECTS.map(v=>`<label><input type="checkbox" name="subjects" value="${esc(v)}"><span>${esc(v)}</span></label>`).join('')}</div></fieldset>
      ${field('대표 색상','color','#ffd23f',{type:'color',max:7})}
      ${field('한 줄 소개','short','',{max:160,placeholder:'어떤 수업에서 어떻게 쓰는 앱인지 짧게 알려 주세요.'})}
      <label class="field"><span>상세 설명 <b class="required">*</b></span><textarea name="description" rows="5" maxlength="6000" required placeholder="앱의 목적, 사용 방법, 준비물과 수업 활용 팁을 적어 주세요."></textarea></label>
      <label class="field"><span>새로운 소식 · 변경 사항</span><textarea name="notes" rows="2" maxlength="3000" placeholder="한 줄에 한 가지씩, 최대 12개"></textarea></label>
      <div class="bulk-shots" data-shots="${card.key}"></div>
      <label class="file-drop"><span>＋ 사진 추가</span><small>첫 사진이 대표 썸네일(정사각형 카드)이에요 · 앱당 최대 6장 · PNG·JPG·WebP</small><input type="file" accept="image/png,image/jpeg,image/webp" multiple data-card-files="${card.key}"></label>
    </article>`;
  }
  function bulkView(root) {
    state.bulk?.cards.forEach(c=>c.shots.forEach(revokePreview));
    state.bulk={cards:[{key:crypto.randomUUID(),shots:[]}]};
    root.innerHTML=`<form id="bulkForm" class="app-form bulk-form">
      <div class="form-intro"><span>01</span><div><h3>웹앱 카드</h3><p>카드 하나가 웹앱 하나예요. 아래 <b>웹앱 카드 추가</b>로 올릴 개수만큼 카드를 만들어 주세요.</p></div></div>
      <div id="bulkCards" class="bulk-cards">${bulkCardHtml(state.bulk.cards[0])}</div>
      <div class="bulk-add-row"><button type="button" class="btn line bulk-add" data-card-add>＋ 웹앱 카드 추가</button><small id="bulkCount" class="field-help"></small></div>
      <div class="form-intro"><span>02</span><div><h3>연락과 검토</h3><p>연락 이메일은 모든 카드에 함께 쓰이고 관리자에게만 보여요.</p></div></div>
      ${field('연락 이메일','contact_email','',{type:'email',required:false,max:254,placeholder:'teacher@school.kr'})}
      <p class="field-help">카드마다 한 건씩 승인 대기로 등록돼요. 한 번에 웹앱 ${BULK_MAX_CARDS}개, 사진 합계 ${BULK_MAX_IMAGES}장까지 보낼 수 있어요.</p>
      <label class="consent"><input name="consent" type="checkbox" required> 모든 앱과 스크린샷을 공개할 권한이 있으며, 학생의 개인정보가 포함되지 않았음을 확인했어요.</label>
      <p class="form-error" role="alert" hidden></p><p class="upload-progress" role="status" aria-live="polite"></p>
      <footer class="form-actions"><button type="submit" class="btn solid">일괄 업로드 요청 보내기</button></footer></form>`;
    const form=$('#bulkForm');
    form.addEventListener('input',e=>{
      const cap=e.target.closest('[data-bulk-caption]');
      if(cap){const [ck,sk]=cap.dataset.bulkCaption.split(':');const shot=state.bulk.cards.find(c=>c.key===ck)?.shots.find(s=>s.key===sk);if(shot)shot.caption=cap.value;}
      if(e.target.name==='name'){const card=e.target.closest('.bulk-card');card.querySelector('.bulk-name').textContent=e.target.value.trim()||'새 웹앱';}
    });
    form.addEventListener('change',e=>{const input=e.target.closest('[data-card-files]');if(input){addBulkFiles(input.dataset.cardFiles,input.files);input.value='';}});
    form.addEventListener('submit',e=>{e.preventDefault();withBusy(form,()=>sendBulk(form));});
    renumberBulk();
  }
  function renumberBulk() {
    const cards=[...workspace.querySelectorAll('.bulk-card')];
    cards.forEach((el,i)=>{el.querySelector('.bulk-no').textContent=`앱 ${i+1}`;el.querySelector('.bulk-remove').hidden=cards.length<2||el.classList.contains('done');});
    const images=state.bulk.cards.filter(c=>!c.done).reduce((n,c)=>n+c.shots.length,0);
    const count=$('#bulkCount');if(count)count.textContent=`카드 ${cards.length}개 · 사진 ${images}장 (최대 ${BULK_MAX_CARDS}개 · ${BULK_MAX_IMAGES}장)`;
    const add=workspace.querySelector('[data-card-add]');if(add)add.disabled=cards.length>=BULK_MAX_CARDS;
  }
  function addBulkCard() {
    const cards=$('#bulkCards');if(!cards||state.bulk.cards.length>=BULK_MAX_CARDS)return;
    const card={key:crypto.randomUUID(),shots:[]};state.bulk.cards.push(card);
    // 제작자 이름은 대부분 같아서 마지막 카드의 값을 이어 쓴다
    const last=[...cards.querySelectorAll('.bulk-card')].pop()?.querySelector('[name="author_name"]')?.value||'';
    cards.insertAdjacentHTML('beforeend',bulkCardHtml(card,last));
    renumberBulk();
    const el=cards.lastElementChild;el.scrollIntoView({block:'start',behavior:'smooth'});el.querySelector('[name="name"]').focus({preventScroll:true});
  }
  function removeBulkCard(key) {
    const i=state.bulk.cards.findIndex(c=>c.key===key);if(i<0||state.bulk.cards.length<2)return;
    state.bulk.cards[i].shots.forEach(revokePreview);state.bulk.cards.splice(i,1);
    workspace.querySelector(`.bulk-card[data-card="${key}"]`)?.remove();renumberBulk();
  }
  function renderBulkShots(card) {
    const box=workspace.querySelector(`[data-shots="${card.key}"]`);if(!box)return;
    box.innerHTML=card.shots.map((s,i)=>`<article class="shot-edit bulk-shot"><img src="${esc(s.preview||'')}" alt="${i===0?'대표 썸네일':`스크린샷 ${i+1}`} 미리보기"><div><label class="field"><span>${i===0?'대표 썸네일 설명':`스크린샷 ${i+1} 설명`} <b class="required">*</b></span><textarea data-bulk-caption="${card.key}:${s.key}" rows="2" maxlength="250" required placeholder="예: 학생 이름을 입력하고 모둠 수를 선택하는 시작 화면">${esc(s.caption||'')}</textarea></label><div class="shot-controls"><button type="button" data-bulk-shot="${card.key}:${s.key}" data-direction="-1" ${i===0?'disabled':''} aria-label="앞으로">↑</button><button type="button" data-bulk-shot="${card.key}:${s.key}" data-direction="1" ${i===card.shots.length-1?'disabled':''} aria-label="뒤로">↓</button><button type="button" data-bulk-shot-remove="${card.key}:${s.key}">삭제</button></div></div></article>`).join('');
    renumberBulk();
  }
  function addBulkFiles(key,files) {
    const card=state.bulk?.cards.find(c=>c.key===key),form=$('#bulkForm');if(!card)return;
    if(card.shots.length+files.length>6)return errorIn(form,new Error('사진은 앱마다 최대 6장까지 넣을 수 있어요.'));
    for(const file of files){
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024){errorIn(form,new Error('15MB 이하의 PNG, JPG, WebP 이미지를 선택해 주세요.'));continue;}
      card.shots.push({file,preview:URL.createObjectURL(file),key:crypto.randomUUID(),caption:card.shots.length?'':'대표 썸네일'});
    }
    renderBulkShots(card);
  }
  function bulkShotAction(button) {
    const [ck,sk]=(button.dataset.bulkShot||button.dataset.bulkShotRemove).split(':');
    const card=state.bulk?.cards.find(c=>c.key===ck);if(!card)return;
    const i=card.shots.findIndex(s=>s.key===sk);if(i<0)return;
    if(button.dataset.bulkShotRemove){revokePreview(card.shots[i]);card.shots.splice(i,1);}
    else{const t=i+Number(button.dataset.direction);if(t<0||t>=card.shots.length)return;[card.shots[i],card.shots[t]]=[card.shots[t],card.shots[i]];}
    renderBulkShots(card);
  }
  async function sendBulk(form) {
    const els=[...form.querySelectorAll('.bulk-card')],todo=els.filter(el=>!bulkCardOf(el).done);
    if(!todo.length)return;
    const label=el=>`${el.querySelector('.bulk-no').textContent}(${el.querySelector('[name="name"]').value.trim()||'이름 없음'})`;
    for(const el of todo){
      const card=bulkCardOf(el);
      if(!card.shots.length)throw new Error(`${label(el)}: 사진을 1장 이상 넣어 주세요. 첫 사진이 대표 썸네일이에요.`);
      if(card.shots.some(s=>!s.caption?.trim()))throw new Error(`${label(el)}: 모든 사진에 설명을 적어 주세요.`);
      if(!el.querySelectorAll('input[name="subjects"]:checked').length)throw new Error(`${label(el)}: 교과를 하나 이상 골라 주세요.`);
    }
    if(todo.reduce((n,el)=>n+bulkCardOf(el).shots.length,0)>BULK_MAX_IMAGES)throw new Error(`사진은 한 번에 ${BULK_MAX_IMAGES}장까지 보낼 수 있어요. 카드를 나눠 보내 주세요.`);
    form.querySelector('.form-error').hidden=true;
    const progress=form.querySelector('.upload-progress'),contact=form.querySelector('[name="contact_email"]').value;
    for(const [n,el] of todo.entries()){
      const card=bulkCardOf(el),state_=el.querySelector('.bulk-state'),val=name=>el.querySelector(`[name="${name}"]`).value;
      try{
        for(let i=0;i<card.shots.length;i++){
          const shot=card.shots[i];if(shot.path)continue;
          progress.textContent=state_.textContent=`${n+1}/${todo.length}번째 앱 · 사진 저장 중 ${i+1}/${card.shots.length}`;
          shot.path=(await api('upload',{method:'POST',body:{data:await imageData(shot.file)}})).path;
        }
        progress.textContent=state_.textContent=`${n+1}/${todo.length}번째 앱 · 요청 저장 중`;
        const result=await api('submit',{method:'POST',body:{name:val('name'),author_name:val('author_name'),web_url:val('web_url'),demo_url:val('demo_url'),video_url:val('video_url'),cat:val('cat'),grade:val('grade'),
          subjects:[...el.querySelectorAll('input[name="subjects"]:checked')].map(x=>x.value),color:val('color'),short:val('short'),description:val('description'),
          notes:val('notes').split('\n').map(s=>s.trim()).filter(Boolean),screenshots:card.shots.map(s=>({path:s.path,caption:s.caption})),contact_email:contact,consent:form.elements.consent.checked}});
        card.done=true;el.classList.add('done');el.querySelectorAll('input,select,textarea,button').forEach(x=>x.disabled=true);
        state_.textContent=`✓ 보냄 · #${result.id.slice(0,8).toUpperCase()}`;
      }catch(error){
        el.classList.add('failed');state_.textContent='확인 필요';el.scrollIntoView({block:'start'});
        throw new Error(`${label(el)}: ${error.message} 앞 카드들은 이미 보냈으니, 이 카드부터 고쳐서 다시 보내 주세요.`);
      }
      el.classList.remove('failed');renumberBulk();
    }
    const sent=state.bulk.cards.filter(c=>c.done).length;
    state.bulk.cards.forEach(c=>c.shots.forEach(revokePreview));state.bulk=null;
    openShell('일괄 업로드 요청을 보냈어요','관리자가 내용을 확인하면 공개 목록에 올라가요.','queue');
    $('#workspaceBody').innerHTML=`<div class="success-state"><span>✓</span><h3>웹앱 ${sent}개가 승인 대기 중이에요</h3><p>내 요청에서 처리 상태와 검토 메모를 확인할 수 있어요.</p><button type="button" data-view="queue" class="btn solid">내 요청 보기</button><button type="button" data-view="requests" data-target-mode="bulk" class="btn line">새 일괄 업로드</button></div>`;
  }
  function uploadForm(row, root) {
    state.shots.forEach(revokePreview);
    state.edit = row;
    const value = row ? {...row,cat:row.category,notes:row.notes.join('\n')} : loadDraft();
    state.shots = (row?.screenshots || []).map(s=>({...s,key:crypto.randomUUID()}));
    if(row){
      openShell('요청 검토 · 내용 수정','내용을 확인하고 상태를 선택해 저장해 주세요.','review');
      root=$('#workspaceBody');
    }
    root.innerHTML = `<form id="appForm" class="app-form">${row?.source==='mcp'?`<p class="mcp-review"><b>MCP · ${esc(row.mcp_member_name||'회원')}</b>${row.own_work_confirmed_at?` · 본인 제작 확인 ${esc(new Date(row.own_work_confirmed_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}`:''}</p>`:''}
      <div class="form-intro"><span>01</span><div><h3>기본 정보</h3><p>웹앱 카드와 상세 화면에 표시될 내용이에요.</p></div></div>
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
    if(row)$('#workspaceTitle').scrollIntoView({block:'start'});
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
    if(form.elements.consent)result.consent=form.elements.consent.checked;
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
      const result=await api(state.edit?'upload&scope=admin':'upload',{method:'POST',body:{data:await imageData(shot.file)}}); shot.path=result.path;
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
      $('#workspaceBody').innerHTML=`<div class="success-state"><span>✓</span><h3>승인 대기 중이에요</h3><p>요청 번호 ${esc(result.id.slice(0,8).toUpperCase())}</p><p>내 요청에서 처리 상태와 검토 메모를 확인할 수 있어요.</p><button type="button" data-view="queue" class="btn solid">내 요청 보기</button><button type="button" data-view="requests" class="btn line">다른 앱 요청하기</button></div>`;
    }
  }
  async function queueView() {
    const admin=state.area==='admin';
    if(!admin&&!state.member)return memberEntry('login','queue');
    const revision=openShell(admin?'요청 검토 · 앱 관리':'내 업로드 요청',admin?'요청을 열어 설명과 스크린샷을 수정하고 승인해 주세요.':'직접 또는 에이전트로 보낸 내 요청의 처리 상태와 검토 메모를 확인해요.','queue');
    $('#workspaceBody').innerHTML='<p class="loading-state" role="status">목록을 불러오고 있어요…</p>';
    try {
      const data=await api(admin?'queue&scope=admin':'queue');
      if(revision!==viewRevision||!workspace.open)return;
      state.queue=data.apps;
      renderQueue();
    } catch(error) {
      if(revision!==viewRevision||!workspace.open)return;
      $('#workspaceBody').innerHTML=`<div class="error-state" role="alert">${esc(error.message)}<button type="button" data-view="queue" class="btn line">다시 불러오기</button></div>`;
    }
  }
  function renderQueue() {
    const admin=state.role==='admin' && state.area==='admin', rows=state.queue.filter(r=>state.filter==='all'||r.status===state.filter);
    $('#workspaceBody').innerHTML=`<div class="queue-heading"><div class="status-filters" aria-label="상태별 요청 목록">${[['pending','승인 대기'],['changes_requested','수정 요청'],['approved','승인 완료'],['rejected','반려'],...(admin?[['archived','공개 중지']]:[]),['all','전체']].map(([key,label])=>`<button type="button" data-filter="${key}" aria-pressed="${state.filter===key}" class="${state.filter===key?'selected':''}">${label} <b>${state.queue.filter(r=>key==='all'||r.status===key).length}</b></button>`).join('')}</div><button type="button" data-view="queue" class="btn line">새로고침</button></div>
      <div class="queue-list">${rows.length?rows.map(r=>`<article class="request-row"><div class="request-main"><span class="status-badge status-${r.status}">${labels[r.status]}</span>${r.is_example?'<span class="example-label">예시 앱</span>':''}${admin&&r.source==='mcp'?`<span class="mcp-badge">MCP · ${esc(r.mcp_member_name||'회원')}</span>`:''}<h3>${esc(r.name)}</h3><p>${esc(r.category)} · ${esc(r.grade)} · ${date(r.created_at)}</p>${r.review_note?`<p class="review-note"><b>검토 메모</b> ${esc(r.review_note)}</p>`:''}</div>${admin?`<button type="button" class="btn solid" data-review="${r.id}">검토 · 수정</button>`:`<span class="request-number">#${r.id.slice(0,8).toUpperCase()}</span>`}</article>`).join(''):`<div class="empty-state"><span>📭</span><h3>${state.filter==='pending'?'승인 대기 중인 요청이 없어요':'이 상태의 요청이 없어요'}</h3><p>새 요청을 보내면 이곳에서 확인할 수 있어요.</p>${admin?'':'<button type="button" data-view="requests" class="btn line">업로드 요청하기</button>'}</div>`}</div>${admin?'':'<footer class="request-footer"><button type="button" data-view="requests" class="btn line">업로드 요청으로 돌아가기</button></footer>'}`;
  }
  function preview() {
    const form=$('#appForm'), data=values(form);
    const preview=document.createElement('dialog'); preview.className='preview-dialog';
    preview.innerHTML=`<button type="button" class="x" aria-label="미리보기 닫기">✕</button><div class="preview-inner"><span class="eyebrow">공개 전 미리보기</span><div class="preview-title"><span style="background:${esc(data.color)}">${state.shots[0]?`<img class="preview-thumb" src="${esc(state.shots[0].preview||state.shots[0].url||'')}" alt="대표 썸네일">`:'사진'}</span><div><h2>${esc(data.name||'앱 이름')}</h2><p>${esc(data.short||'한 줄 소개')}</p></div></div><p class="preview-meta">${esc((data.subjects||[]).join('·')||'교과')} · ${esc(data.cat)} · ${esc(data.grade||'대상 학년')} · 제작 ${esc(data.author_name||'제작자')}</p>${data.video_url?`<p class="preview-meta">소개 영상 · ${esc(data.video_url)}</p>`:''}<div class="preview-shots">${state.shots.map(s=>`<figure><img src="${esc(s.preview||s.url||'')}" alt="${esc(s.caption)}"><figcaption>${esc(s.caption||'스크린샷 설명')}</figcaption></figure>`).join('')}</div><p class="multiline">${esc(data.description||'상세 설명')}</p>${data.notes.length?`<h3>새로운 소식</h3><ul>${data.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>`:''}</div>`;
    workspace.append(preview); preview.showModal();
    preview.querySelector('button').onclick=()=>preview.close();preview.addEventListener('close',()=>preview.remove());
  }
  const devDraftKey='chamcoding-dev-request-draft';
  function devRequestForm() {
    state.area='member';
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
    if(button.dataset.memberMode){await memberEntry(button.dataset.memberMode,memberNext);return;}
    if(button.hasAttribute('data-admin-login')){await enterAdmin();return;}
    if(button.dataset.devSave){await saveDevRequest(button);return;}
    if(button.dataset.inquirySave){await saveInquiry(button);return;}
    if(button.dataset.requestLogin)return memberEntry('login',button.dataset.requestLogin);
    if(button.dataset.requestTab)return selectRequestTab(button.dataset.requestTab);
    if(button.dataset.requestTarget){
      selectRequestTab(button.dataset.requestTarget,true);
      if($('#singleRequest'))selectDirectMode(button.dataset.targetMode);
      const loginButton=$('#directControls [data-request-login]');
      if(loginButton)loginButton.dataset.requestLogin=button.dataset.targetMode==='bulk'?'bulk':'direct';
      $('#request-tab-'+button.dataset.requestTarget).scrollIntoView({block:'nearest'});
      return;
    }
    if(button.dataset.directMode)return selectDirectMode(button.dataset.directMode);
    if(button.dataset.view){
      switch(button.dataset.view){
        case 'requests':return uploadRequests(button.dataset.targetMode?'direct':'agent',button.dataset.targetMode);
        case 'devqueue':return devQueueView();
        case 'inquiries':return inquiryQueueView();
        case 'inquiry':return inquiryForm();
        case 'devreq':return devRequestForm();
        case 'queue':return queueView();
      }
    }
    if(button.dataset.copyPrompt)return copyPrepPrompt(button);
    if(button.hasAttribute('data-card-add'))return addBulkCard();
    if(button.dataset.cardRemove)return removeBulkCard(button.dataset.cardRemove);
    if(button.dataset.bulkShot||button.dataset.bulkShotRemove)return bulkShotAction(button);
    if(button.hasAttribute('data-preview'))return preview();
    if(button.dataset.filter){state.filter=button.dataset.filter;renderQueue();return;}
    if(button.dataset.review){const row=state.queue.find(r=>r.id===button.dataset.review);if(row)uploadForm(row);return;}
    if(button.dataset.shotRemove){const index=state.shots.findIndex(s=>s.key===button.dataset.shotRemove);if(index>=0){revokePreview(state.shots[index]);state.shots.splice(index,1);renderShotEditor();}return;}
    if(button.dataset.shotMove){const index=state.shots.findIndex(s=>s.key===button.dataset.shotMove),target=index+Number(button.dataset.direction);if(target>=0&&target<state.shots.length){[state.shots[index],state.shots[target]]=[state.shots[target],state.shots[index]];renderShotEditor();}}
  });
  workspace.addEventListener('keydown',e=>{
    const tab=e.target.closest('[data-request-tab]');
    if(!tab||state.busy||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();
    const current=requestTabs.findIndex(([key])=>key===tab.dataset.requestTab), count=requestTabs.length;
    const index=e.key==='Home'?0:e.key==='End'?count-1:(current+(e.key==='ArrowRight'?1:-1)+count)%count;
    selectRequestTab(requestTabs[index][0],true);
  });
  $('#uploadButton').onclick=()=>uploadRequests();$('#memberButton').onclick=()=>memberEntry();$('#adminMenuButton').onclick=()=>enterAdmin();$('#devRequestButton').onclick=()=>devRequestForm();$('#inquiryButton').onclick=()=>inquiryForm();
  const authHash=new URLSearchParams(location.hash.slice(1)),pageQuery=new URLSearchParams(location.search);
  const fromMail=pageQuery.has('email-confirmed');
  if(fromMail||authHash.has('access_token')||authHash.has('error')){
    const recovery=authHash.get('type')==='recovery';
    const tokens=authHash.has('access_token')?{access_token:authHash.get('access_token'),refresh_token:authHash.get('refresh_token')||'',expires_in:Number(authHash.get('expires_in'))||3600}:null;
    const error=authHash.get('error_code')||authHash.get('error'),description=authHash.get('error_description')||'';
    // 토큰과 표시용 주소 값을 바로 지워 새로고침·공유 때 다시 쓰이지 않게 한다.
    pageQuery.delete('email-confirmed');
    const rest=pageQuery.toString();
    history.replaceState(null,'',location.pathname+(rest?`?${rest}`:''));
    memberFromMail(tokens,error,recovery,description);
  }
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
