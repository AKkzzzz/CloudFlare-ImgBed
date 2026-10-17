import { processFileUpload } from '../upload/index.js';
import { fetchUploadConfig,fetchSecurityConfig } from '../utils/sysConfig.js';
import { getUploadIp,isBlockedUploadIp } from '../upload/uploadTools.js';
import { getIndexMeta } from '../utils/indexManager.js';
const ISSUER='https://cg.chenyifei.xyz/lighthouse/api/forum/media-verify';
const BASE='https://wanxiangdengta.pages.dev';
const MAX=10*1024*1024;
const json=(out,status=200,origin='*')=>new Response(status===204?null:JSON.stringify(out),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'}});
async function grant(ticket,claim=false,readonly=false){
 if(typeof ticket!=='string'||!/^[-\w]{40,60}$/.test(ticket))throw Error('上传票据无效');
 const r=await fetch(ISSUER,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 Lighthouse/1.0'},body:JSON.stringify({ticket,claim,purpose:readonly?'status':'upload'}),redirect:'error'});
 if(!r.ok)throw Object.assign(Error('票据核对未通过'),{reason:'issuer-'+r.status});
 const g=await r.json();
 if(!/^[a-f0-9]{32}$/.test(g.jti)||!/^[a-f0-9]{64}$/.test(g.sub))throw Object.assign(Error('票据格式无效'),{reason:'grant-format'});
 if(!readonly&&g.exp<Date.now()/1000)throw Object.assign(Error('票据已过期'),{reason:'expired'});
 if(!readonly&&g.day!==Math.floor((Date.now()/1000+28800)/86400))throw Object.assign(Error('票据日期不一致'),{reason:'day'});
 return g;
}
async function database(env){
 if(!env.img_d1?.prepare)throw Error('图床需要绑定D1数据库');
 await env.img_d1.prepare("CREATE TABLE IF NOT EXISTS lighthouse_uploads(jti TEXT PRIMARY KEY,sub TEXT NOT NULL,day INTEGER NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,result TEXT NOT NULL DEFAULT '')").run();
 await env.img_d1.prepare('CREATE INDEX IF NOT EXISTS lighthouse_upload_owner ON lighthouse_uploads(sub,day,mode,state)').run();return env.img_d1;
}
function picture(bytes,mime){
 const match={
  'image/png':()=>bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71,
  'image/jpeg':()=>bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
  'image/gif':()=>String.fromCharCode(...bytes.slice(0,6)).match(/^GIF8[79]a$/),
  'image/webp':()=>String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP',
  'image/avif':()=>String.fromCharCode(...bytes.slice(4,16)).includes('ftypavif')
 };return bytes.length>16&&!!match[mime]?.();
}
async function boundedForm(request){
 const reader=request.body?.getReader();if(!reader)throw Error('请选择图片');let size=0;const parts=[];
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX+128*1024){await reader.cancel();throw Error('图片最多10MB');}parts.push(value);}}finally{reader.releaseLock();}
 const all=new Uint8Array(size);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.byteLength;}
 return new Response(all,{headers:{'Content-Type':request.headers.get('Content-Type')||''}}).formData();
}
export async function onRequest(context){
 const {request,env}=context,action=new URL(request.url).pathname.split('/').pop(),origin=request.headers.get('Origin')||'*';
 if(request.method==='OPTIONS')return json({},204,origin);
 if(request.method==='GET'&&action==='health')return json({version:'lighthouse-media-v1',d1:!!env.img_d1?.prepare});
 if(request.method==='GET'&&action==='connectivity'){
  let issuerStatus=null,issuerJson=false,d1Ready=false,issuerMessage=null,issuerDate=null,strictGrantFailure=null;
  try{const r=await fetch(ISSUER,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 Lighthouse/1.0'},body:JSON.stringify({ticket:'0'.repeat(43)})});issuerStatus=r.status;issuerJson=(r.headers.get('Content-Type')||'').includes('application/json');issuerDate=r.headers.get('Date');if(issuerJson){const out=await r.json();if(typeof out.error==='string')issuerMessage=out.error.slice(0,100);}}catch{}
  try{const db=await database(env);await db.prepare('SELECT 1 FROM lighthouse_uploads LIMIT 1').first();d1Ready=true;}catch{}
  try{await grant('0'.repeat(43));}catch(error){strictGrantFailure={name:error.name,message:String(error.message).slice(0,180),reason:error.reason||null};}
  return json({issuerStatus,issuerJson,d1Ready,issuerMessage,issuerDate,strictGrantFailure,workerTime:Math.floor(Date.now()/1000)},issuerJson&&d1Ready?200:503);
 }
 if(request.method!=='POST')return json({error:'Method not allowed'},405,origin);
 let db,g,stage='request';
 try{
  if(action==='upload'){
   const form=await boundedForm(request);stage='authorization';g=await grant(form.get('ticket'));
   if(origin!==g.origin||!['original','compressed'].includes(g.mode))return json({error:'上传来源无效'},403,origin);
   const file=form.get('file');if(!file||typeof file.arrayBuffer!=='function'||file.size!==g.bytes||file.size>(g.mode==='original'?MAX:200*1024))return json({error:'图片大小与票据不一致'},400,origin);
   const bytes=new Uint8Array(await file.arrayBuffer()),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(hash!==g.sha256||!picture(bytes,g.mime))return json({error:'图片内容或校验值无效'},400,origin);
   if(await isBlockedUploadIp(env,getUploadIp(request)))return json({error:'此账号来源暂不可上传'},403,origin);
   stage='database';db=await database(env);
   const saved=await db.prepare('SELECT state,result FROM lighthouse_uploads WHERE jti=?').bind(g.jti).first();
   if(saved)return saved.state==='done'?json(JSON.parse(saved.result),200,origin):json({error:'图片已处理或正在处理，请查询上传结果'},409,origin);
   const cap=g.mode==='original'?g.limit:null;
   if(cap!==null&&(!Number.isInteger(cap)||cap<0))return json({error:'额度无效'},403,origin);
   const inserted=await db.prepare("INSERT OR IGNORE INTO lighthouse_uploads(jti,sub,day,mode,state,created) SELECT ?,?,?,?,'pending',? WHERE ? IS NULL OR (SELECT COUNT(*) FROM lighthouse_uploads WHERE sub=? AND day=? AND mode='original' AND state!='failed')<?").bind(g.jti,g.sub,g.day,g.mode,Math.floor(Date.now()/1000),cap,g.sub,g.day,cap).run();
   if(!inserted.meta.changes)return json({error:'今天原图额度已用完或此图片正在上传'},429,origin);
   try{
    await grant(form.get('ticket'),true);
    const url=new URL('/upload',request.url);url.search=new URLSearchParams({uploadChannel:'huggingface',channelName:'wanxiang',autoRetry:'false',serverCompress:'false',returnFormat:'full',uploadFolder:'lighthouse/'+g.sub+'/'+g.day}).toString();
    const input=new FormData(),extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'}[g.mime];input.set('file',new File([bytes],g.jti+'.'+extension,{type:g.mime}));
    const response=await processFileUpload({...context,url,securityConfig:await fetchSecurityConfig(env),uploadConfig:await fetchUploadConfig(env,context)},input);
    if(!response.ok)throw Error('图床上传失败');const result=await response.json(),address=new URL(result?.[0]?.src||result?.[0]?.publicUrl||'',BASE);
    if(!address.pathname.startsWith('/file/')||!['https://42ddc630.wanxiangdengta.pages.dev',BASE].includes(address.origin))throw Error('图床返回地址无效');
    const out={state:'done',url:BASE+address.pathname,bytes:bytes.length,sha256:hash};await db.prepare("UPDATE lighthouse_uploads SET state='done',result=? WHERE jti=?").bind(JSON.stringify(out),g.jti).run();return json(out,200,origin);
   }catch(error){await db.prepare("UPDATE lighthouse_uploads SET state='failed' WHERE jti=?").bind(g.jti).run();return json({error:'图床暂时无法完成上传，请稍后再试'},502,origin);}
  }
  const payload=await request.json();stage='authorization';g=await grant(payload.ticket,false,action==='status');stage='database';db=await database(env);
  if(action==='status'&&g.mode!=='stats'){
   const row=await db.prepare('SELECT state,result FROM lighthouse_uploads WHERE jti=?').bind(g.jti).first();return json(row?.state==='done'?JSON.parse(row.result):{state:row?.state||'pending'},200,origin);
  }
  if(action==='stats'&&g.mode==='stats'){
   const index=await getIndexMeta(context),meta=await db.prepare('SELECT 1').all();
   return json({indexed:index?.success===true,files:index?.totalCount??null,sizeMB:index?.totalSizeMB??null,updated:index?.lastUpdated??null,d1Bytes:meta.meta?.size_after??null,d1SingleLimit:500*1024*1024,d1AccountFree:5*1024*1024*1024,hfPublicLimit:null,channel:'Hugging Face · wanxiang'},200,origin);
  }
  return json({error:'Unknown operation'},400,origin);
 }catch(error){const messages={authorization:'图床未能向灯塔核对上传授权，请稍后重试或改存灯塔服务器',database:'图床数据库暂不可用，请稍后重试或改存灯塔服务器',request:'上传请求未能解析，请重新选择图片'};return json({error:messages[stage]||'图床暂不可用，请改存灯塔服务器',code:'lighthouse-'+stage+(error.reason?'-'+error.reason:'')},stage==='authorization'?403:503,origin);}
}
