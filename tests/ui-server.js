// Isolated browser fixture. This file is excluded from Vercel deployments.
const {randomUUID}=require('node:crypto');
const {hashPassword}=require('../lib/tools-core');
const credential=hashPassword('local-admin-test-only');
const admin={id:1,username:'local-admin',salt:credential.salt,password_hash:credential.hash};
const rows=[],uploads=[],devRequests=[],reviews=[];
// UI_FIXTURE_SEED=1 이면 예시 앱을 승인 상태로 넣어 둔다. 테스트 회원: member@local.test / local-member-test-only
const fixtureMember={id:'00000000-0000-4000-8000-000000000001',email:'member@local.test',email_confirmed_at:'2026-11-04T00:00:00Z',app_metadata:{chamcoding_member:true,chamcoding_content_access:true},user_metadata:{display_name:'테스트 회원'}};
if(process.env.UI_FIXTURE_SEED){
  require('../lib/examples.json').forEach((e,i)=>rows.push({id:randomUUID(),name:e.name,web_url:'https://example.com/',demo_url:'',video_url:i===0?'https://www.youtube.com/watch?v=dQw4w9WgXcQ':'',short:e.short,description:e.desc,category:e.cat,grade:e.grade,icon:e.icon,color:e.color,notes:e.notes,screenshots:[],author_name:i%3===0?'참쌤스쿨':'코딩 연구회',contact_email:'',status:'approved',review_note:'',uses:e.uses,is_example:true,featured:i<2,version:1,created_at:new Date(e.created).toISOString(),updated_at:new Date(e.updated).toISOString()}));
}
let visits=0;
Object.assign(process.env,{SUPABASE_URL:'https://ui-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-secret-only',UPLOAD_PASSWORD:'local-upload-test-only',PORT:'8742'});
global.fetch=async(input,options={})=>{
  const url=new URL(input),body=options.body&&!Buffer.isBuffer(options.body)?JSON.parse(options.body):{};
  let data;
  if(url.pathname==='/rest/v1/tools_admins'){
    if(options.method==='PATCH')Object.assign(admin,body);
    data=[admin];
  }
  else if(url.pathname==='/rest/v1/rpc/tools_visit_counts'){if(body.p_increment)visits++;data={total:visits,today:visits,day:'2026-11-03'};}
  else if(url.pathname==='/rest/v1/rpc/tools_check_rate')data=true;
  else if(url.pathname==='/auth/v1/token'){
    if(body.email!==fixtureMember.email||body.password!=='local-member-test-only')return new Response(JSON.stringify({error_code:'invalid_credentials'}),{status:400,headers:{'content-type':'application/json'}});
    data={access_token:'fixture-member-token',expires_in:3600,user:fixtureMember};
  }
  else if(url.pathname==='/auth/v1/user'){
    if(options.headers?.Authorization!=='Bearer fixture-member-token')return new Response('{}',{status:401,headers:{'content-type':'application/json'}});
    data=fixtureMember;
  }
  else if(url.pathname==='/rest/v1/tools_dev_requests'){
    if(options.method==='POST'){const row={...body,id:randomUUID(),status:'pending',admin_note:'',created_at:new Date().toISOString(),updated_at:new Date().toISOString()};devRequests.unshift(row);data=[row];}
    else if(options.method==='PATCH'){const row=devRequests.find(r=>r.id===url.searchParams.get('id')?.slice(3));if(row)Object.assign(row,body,{updated_at:new Date().toISOString()});data=row?[row]:[];}
    else data=devRequests;
  }
  else if(url.pathname==='/rest/v1/tools_reviews'){
    if(options.method==='POST'){
      const existing=reviews.find(r=>r.app_id===body.app_id&&r.member_id===body.member_id);
      if(existing)Object.assign(existing,body,{updated_at:new Date().toISOString()});
      else reviews.unshift({...body,id:randomUUID(),hidden:false,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});
      data=null;
    }else if(options.method==='PATCH'){const row=reviews.find(r=>r.id===url.searchParams.get('id')?.slice(3));if(row)Object.assign(row,body);data=row?[row]:[];}
    else data=reviews.filter(r=>r.app_id===url.searchParams.get('app_id')?.slice(3)&&!r.hidden);
  }
  else if(url.pathname==='/rest/v1/tools_uploads'){
    if(options.method==='POST'){uploads.push(body);data=null;}
    else data=uploads.filter(r=>r.path===url.searchParams.get('path')?.slice(3)&&r.session_id===url.searchParams.get('session_id')?.slice(3));
  }else if(url.pathname.startsWith('/storage/v1/object/sign/'))data=body.paths.map(path=>({path,signedURL:'http://127.0.0.1:8742/assets/chamssaem.png'}));
  else if(url.pathname.startsWith('/storage/v1/object/'))data={Key:'fixture-image'};
  else if(url.pathname==='/rest/v1/tools_apps'){
    if(options.method==='POST'){
      const row={...body,id:randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),version:1,uses:0,is_example:false,review_note:''};rows.push(row);data=[row];
    }else if(options.method==='PATCH'){
      const row=rows.find(r=>r.id===url.searchParams.get('id')?.slice(3)&&r.version===Number(url.searchParams.get('version')?.slice(3)));
      if(row){Object.assign(row,body,{version:row.version+1,updated_at:new Date().toISOString()});data=[row];}else data=[];
    }else{
      data=rows.filter(row=>(!url.searchParams.has('id')||row.id===url.searchParams.get('id').slice(3))&&(!url.searchParams.has('status')||row.status===url.searchParams.get('status').slice(3)));
      const select=url.searchParams.get('select');
      if(select&&select!=='*')data=data.map(row=>Object.fromEntries(select.split(',').map(k=>[k,row[k]])));
    }
  }else throw new Error('Unexpected fixture request');
  return new Response(data===null?null:JSON.stringify(data),{status:data===null?204:200,headers:{'content-type':'application/json'}});
};
require('../dev-server');
