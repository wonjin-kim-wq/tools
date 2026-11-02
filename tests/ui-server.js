// Isolated browser fixture. This file is excluded from Vercel deployments.
const {randomUUID}=require('node:crypto');
const {hashPassword}=require('../lib/tools-core');
const credential=hashPassword('local-admin-test-only');
const admin={id:1,username:'local-admin',salt:credential.salt,password_hash:credential.hash};
const rows=[],uploads=[];
Object.assign(process.env,{SUPABASE_URL:'https://ui-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',SESSION_SECRET:'fixture-session-secret-only',UPLOAD_PASSWORD:'local-upload-test-only',PORT:'8742'});
global.fetch=async(input,options={})=>{
  const url=new URL(input),body=options.body&&!Buffer.isBuffer(options.body)?JSON.parse(options.body):{};
  let data;
  if(url.pathname==='/rest/v1/tools_admins'){
    if(options.method==='PATCH')Object.assign(admin,body);
    data=[admin];
  }
  else if(url.pathname==='/rest/v1/rpc/tools_check_rate')data=true;
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
