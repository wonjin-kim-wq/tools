// Isolated browser fixture. This file is excluded from Vercel deployments.
const {randomUUID}=require('node:crypto');
const {hashPassword}=require('../lib/tools-core');
const credential=hashPassword('local-admin-test-only');
const admin={id:1,username:'local-admin',salt:credential.salt,password_hash:credential.hash};
const rows=[],uploads=[],devRequests=[],reviews=[],inquiries=[],useDaily=[],tokens=[];
// UI_FIXTURE_SEED=1 이면 예시 앱을 승인 상태로 넣어 둔다. 테스트 회원: member@local.test / local-member-test-only
let fixturePassword='local-member-test-only';
const fixtureMember={id:'00000000-0000-4000-8000-000000000001',email:'member@local.test',email_confirmed_at:'2026-11-04T00:00:00Z',app_metadata:{chamcoding_member:true,chamcoding_content_access:true},user_metadata:{display_name:'테스트 회원'}};
if(process.env.UI_FIXTURE_SEED){
  setTimeout(()=>{for(const r of rows)for(let d=0;d<60;d++){const n=Math.max(0,Math.round((r.uses/900)*(1+Math.sin(d*0.7+r.name.length))));if(n)useDaily.push({app_id:r.id,day:new Date(Date.now()+9*3600e3-d*86400e3).toISOString().slice(0,10),count:n});}},0);
  require('../lib/examples.json').forEach((e,i)=>rows.push({id:randomUUID(),name:e.name,web_url:'https://example.com/',demo_url:'',video_url:i===0?'https://www.youtube.com/watch?v=dQw4w9WgXcQ':'',short:e.short,description:e.desc,category:e.cat,grade:i===3?'중학교 1-3학년':i===6?'고등학교 2-3학년':e.grade,icon:e.icon,color:e.color,notes:e.notes,screenshots:[],author_name:i%3===0?'참쌤스쿨':'코딩 연구회',contact_email:'',status:'approved',review_note:'',subjects:[['수학'],['실과(정보)','수학'],['교과 무관'],['국어','실과(정보)'],['미술','실과(정보)','수학'],['실과(정보)'],['과학','실과(정보)'],['교과 무관'],['실과(정보)','사회'],['창의적 체험활동']][i]||[],uses:e.uses,is_example:!!process.env.UI_FIXTURE_EXAMPLES,featured:i<2,version:1,created_at:new Date(e.created).toISOString(),updated_at:new Date(e.updated).toISOString()}));
}
let visits=0;
Object.assign(process.env,{SUPABASE_URL:'https://ui-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-secret-only',PORT:'8742'});
global.fetch=async(input,options={})=>{
  const url=new URL(input),body=options.body&&!Buffer.isBuffer(options.body)?JSON.parse(options.body):{};
  let data;
  if(url.pathname==='/rest/v1/tools_admins'){
    if(options.method==='PATCH')Object.assign(admin,body);
    data=[admin];
  }
  else if(url.pathname==='/rest/v1/rpc/tools_visit_counts'){if(body.p_increment)visits++;data={total:visits,today:visits,day:'2026-11-03'};}
  else if(url.pathname==='/rest/v1/rpc/tools_check_rate')data=true;
  else if(url.pathname==='/rest/v1/rpc/tools_use_app'){const row=rows.find(r=>r.id===body.p_app);if(row){row.uses++;const day=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);const d=useDaily.find(x=>x.app_id===row.id&&x.day===day);if(d)d.count++;else useDaily.push({app_id:row.id,day,count:1});}data=null;}
  else if(url.pathname==='/rest/v1/tools_use_daily')data=useDaily;
  else if(url.pathname==='/rest/v1/rpc/tools_rank_snapshot'){
    // 시드 데이터에서는 순위 변동이 보이도록 '어제 순위'를 조금 섞어 둔다
    const ranked=rows.filter(r=>r.status==='approved').sort((a,b)=>b.uses-a.uses||a.created_at.localeCompare(b.created_at));
    data=Object.fromEntries(ranked.map((r,i)=>[r.id,{rank:i+1,prev:i===4?null:Math.max(1,i+1+[2,-1,0,1,0,-2,3,0,-1,1][i%10])}]));
  }
  else if(url.pathname==='/auth/v1/token'){
    // 비밀번호 로그인과 갱신 토큰(fixture-refresh) 모두 같은 회원 토큰을 준다.
    const refresh=url.searchParams.get('grant_type')==='refresh_token';
    if(refresh?body.refresh_token!=='fixture-refresh':(body.email!==fixtureMember.email||body.password!==fixturePassword))return new Response(JSON.stringify({error_code:refresh?'refresh_token_not_found':'invalid_credentials'}),{status:400,headers:{'content-type':'application/json'}});
    data={access_token:'fixture-member-token',refresh_token:'fixture-refresh',expires_in:3600,user:fixtureMember};
  }
  else if(url.pathname==='/auth/v1/user'){
    // fixture.mail.token은 인증·비밀번호 재설정 메일 링크가 주소 해시로 돌려준 토큰 역할이다.
    if(!['Bearer fixture-member-token','Bearer fixture.mail.token'].includes(options.headers?.Authorization))return new Response('{}',{status:401,headers:{'content-type':'application/json'}});
    if(options.method==='PUT'){if(body.password===fixturePassword)return new Response(JSON.stringify({error_code:'same_password'}),{status:422});fixturePassword=body.password;}
    data=fixtureMember;
  }
  else if(url.pathname==='/auth/v1/signup')data={id:randomUUID(),email:body.email,identities:[{id:'fixture'}],app_metadata:{provider:'email'},user_metadata:body.data};
  else if(['/auth/v1/resend','/auth/v1/recover'].includes(url.pathname))data={};
  else if(url.pathname==='/auth/v1/logout')return new Response(null,{status:204});
  else if(url.pathname.startsWith('/auth/v1/admin/users/')&&options.method==='PUT')data={id:url.pathname.split('/').pop(),app_metadata:body.app_metadata};
  else if(url.pathname===`/auth/v1/admin/users/${fixtureMember.id}`)data=fixtureMember;
  else if(url.pathname==='/rest/v1/rpc/tools_issue_api_token'){
    if(tokens.some(token=>token.member_id===body.p_member_id&&!token.revoked_at))data=null;
    else {
      const record={id:randomUUID(),name:body.p_name,prefix:body.p_prefix,created_at:new Date().toISOString(),last_used_at:null,revoked_at:null};
      tokens.push({...record,token_hash:body.p_token_hash,member_id:body.p_member_id});
      data=record;
    }
  }
  else if(url.pathname==='/rest/v1/tools_api_tokens'){
    const matches=(token,key)=>!url.searchParams.has(key)||token[key]===url.searchParams.get(key).slice(3);
    const active=tokens.filter(token=>!token.revoked_at&&['id','member_id','token_hash'].every(key=>matches(token,key)));
    if(options.method==='PATCH')active.forEach(token=>Object.assign(token,body));
    data=active.map(token=>Object.fromEntries(url.searchParams.get('select').split(',').map(key=>[key,token[key]])));
  }
  else if(url.pathname==='/rest/v1/tools_dev_requests'){
    if(options.method==='POST'){const row={...body,id:randomUUID(),status:'pending',admin_note:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};devRequests.unshift(row);data=[row];}
    else if(options.method==='PATCH'){const row=devRequests.find(r=>r.id===url.searchParams.get('id')?.slice(3));if(row)Object.assign(row,body,{updated_at:new Date().toISOString()});data=row?[row]:[];}
    else data=devRequests;
  }
  else if(url.pathname==='/rest/v1/tools_inquiries'){
    if(options.method==='POST'){const row={...body,id:randomUUID(),status:'pending',admin_note:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};inquiries.unshift(row);data=[row];}
    else if(options.method==='PATCH'){const row=inquiries.find(r=>r.id===url.searchParams.get('id')?.slice(3));if(row)Object.assign(row,body);data=row?[row]:[];}
    else data=inquiries;
  }
  else if(url.pathname==='/rest/v1/tools_reviews'){
    if(options.method==='POST'){
      const existing=body.member_id&&reviews.find(r=>r.app_id===body.app_id&&r.member_id===body.member_id);
      if(existing)Object.assign(existing,body,{updated_at:new Date().toISOString()});
      else reviews.unshift({...body,id:randomUUID(),hidden:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
      data=null;
    }else if(options.method==='PATCH'){const row=reviews.find(r=>r.id===url.searchParams.get('id')?.slice(3));if(row)Object.assign(row,body);data=row?[row]:[];}
    else data=reviews.filter(r=>(!url.searchParams.has('app_id')||r.app_id===url.searchParams.get('app_id').slice(3))&&!r.hidden&&(!url.searchParams.has('rating')||r.rating));
  }
  else if(url.pathname==='/rest/v1/tools_uploads'){
    if(options.method==='POST'){uploads.push(body);data=null;}
    else data=uploads.filter(r=>r.path===url.searchParams.get('path')?.slice(3)&&r.session_id===url.searchParams.get('session_id')?.slice(3));
  }else if(url.pathname.startsWith('/storage/v1/object/sign/'))data=body.paths.map(path=>({path,signedURL:'http://127.0.0.1:8742/assets/chamssaem.png'}));
  else if(url.pathname.startsWith('/storage/v1/object/'))data={Key:'fixture-image'};
  else if(url.pathname==='/rest/v1/tools_apps'){
    if(options.method==='POST'){
      const duplicate=body.member_id&&rows.some(row=>row.member_id===body.member_id&&row.web_url===body.web_url);
      if(duplicate&&url.searchParams.has('on_conflict'))data=[];
      else if(duplicate)return new Response('{}',{status:409});
      else {const row={...body,id:randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),version:1,uses:0,is_example:false,review_note:''};rows.push(row);data=[row];}
    }else if(options.method==='PATCH'){
      const row=rows.find(r=>r.id===url.searchParams.get('id')?.slice(3)&&r.version===Number(url.searchParams.get('version')?.slice(3)));
      if(row){Object.assign(row,body,{version:row.version+1,updated_at:new Date().toISOString()});data=[row];}else data=[];
    }else{
      data=rows.filter(row=>['id','status','member_id','web_url','source','is_example'].every(key=>!url.searchParams.has(key)||String(row[key])===url.searchParams.get(key).slice(3)));
      const select=url.searchParams.get('select');
      if(select&&select!=='*')data=data.map(row=>Object.fromEntries(select.split(',').map(k=>[k,row[k]])));
    }
  }else throw new Error('Unexpected fixture request');
  return new Response(data===null?null:JSON.stringify(data),{status:data===null?204:200,headers:{'content-type':'application/json'}});
};
require('../dev-server');
