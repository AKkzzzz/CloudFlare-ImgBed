import { processFileUpload } from '../upload/index.js';
import { fetchUploadConfig,fetchSecurityConfig } from '../utils/sysConfig.js';
import { getUploadIp,isBlockedUploadIp,endUpload } from '../upload/uploadTools.js';
import { HuggingFaceAPI } from '../utils/storage/huggingfaceAPI.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { getIndexMeta } from '../utils/indexManager.js';
const ISSUER='https://cg.chenyifei.xyz/lighthouse/api/forum/media-verify';
const BASE='https://wanxiangdengta.pages.dev';
const MAX=10*1024*1024;
// Character cards (PNG / JSON / ZIP, kept as sent): bytes go browser → Hugging Face storage directly.
const CARD_EXT={'image/png':'png','application/json':'json','application/zip':'zip'};
const json=(out,status=200,origin='*')=>new Response(status===204?null:JSON.stringify(out),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Vary':'Origin'}});
async function grant(ticket,claim=false,readonly=false){
 if(typeof ticket!=='string'||!/^[-\w]{40,60}$/.test(ticket))throw Error('上传票据无效');
 const r=await fetch(ISSUER,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'Mozilla/5.0 Lighthouse/1.0'},body:JSON.stringify({ticket,claim,purpose:readonly?'status':'upload'}),redirect:'manual'});
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
function cardHeader(bytes,mime){
 if(mime==='image/png')return bytes.length>=8&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b);
 if(mime==='application/zip')return bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&((bytes[2]===3&&bytes[3]===4)||(bytes[2]===5&&bytes[3]===6));
 if(mime==='application/json'){let i=0;if(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)i=3;while([32,9,10,13].includes(bytes[i]))i++;return bytes[i]===123||bytes[i]===91;}
 return false;
}
async function cardChannel(env,context){
 const channels=(await fetchUploadConfig(env,context)).huggingface?.channels||[],channel=channels.find(c=>c.name==='wanxiang')||channels[0];
 if(!channel?.token||!channel?.repo)throw Error('图床没有可用的大文件渠道');
 return {channel,api:new HuggingFaceAPI(channel.token,channel.repo,channel.isPrivate||false)};
}
const cardId=g=>`lighthouse/cards/${g.sub}/${g.day}/${g.jti}.${CARD_EXT[g.mime]}`;
// Quota row for a card upload: at most g.limit live card uploads per member per day.
const claimQuota=(db,g)=>db.prepare("INSERT OR IGNORE INTO lighthouse_uploads(jti,sub,day,mode,state,created) SELECT ?,?,?,?,'pending',? WHERE ? IS NULL OR (SELECT COUNT(*) FROM lighthouse_uploads WHERE sub=? AND day=? AND mode=? AND state!='failed')<?").bind(g.jti,g.sub,g.day,g.mode,Math.floor(Date.now()/1000),g.mode==='compressed'?null:g.limit,g.sub,g.day,g.mode,g.mode==='compressed'?null:g.limit).run();
async function registerCard(context,channel,fullId,g){
 const {env,request,waitUntil}=context,metadata={FileName:fullId.split('/').pop(),FileType:g.mime,Channel:'HuggingFace',ChannelName:channel.name||'HuggingFace_env',FileSize:(g.bytes/1024/1024).toFixed(2),FileSizeBytes:g.bytes,
  UploadIP:getUploadIp(request)||'',UploadAddress:'',ListType:'None',HfFilePath:fullId,TimeStamp:Date.now(),Label:'None',Directory:fullId.split('/').slice(0,-1).join('/')+'/',Tags:['lighthouse-card']};
 await getDatabase(env).put(fullId,'',{metadata});waitUntil?.(endUpload({env,waitUntil,uploadConfig:await fetchUploadConfig(env,context),url:new URL(request.url)},fullId,metadata));
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
  // Probe the same transport as real uploads, without a valid user capability.
  let issuerReady=false,d1Ready=false;
  try{await grant('0'.repeat(43));}catch(error){issuerReady=error.reason==='issuer-403';}
  try{const db=await database(env);await db.prepare('SELECT 1 FROM lighthouse_uploads LIMIT 1').first();d1Ready=true;}catch{}
  return json({issuerReady,d1Ready},issuerReady&&d1Ready?200:503);
 }
 if(request.method!=='POST')return json({error:'Method not allowed'},405,origin);
 let db,g,stage='request';
 try{
  if(action==='upload'){
   const form=await boundedForm(request);stage='authorization';g=await grant(form.get('ticket'));
   if(origin!==g.origin||!['original','compressed','card'].includes(g.mode))return json({error:'上传来源无效'},403,origin);
   const file=form.get('file');if(!file||typeof file.arrayBuffer!=='function'||file.size!==g.bytes||file.size>(g.mode==='compressed'?200*1024:MAX))return json({error:'文件大小与票据不一致'},400,origin);
   const bytes=new Uint8Array(await file.arrayBuffer()),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(hash!==g.sha256||!(g.mode==='card'?cardHeader(bytes,g.mime):picture(bytes,g.mime)))return json({error:'文件内容或校验值无效'},400,origin);
   if(await isBlockedUploadIp(env,getUploadIp(request)))return json({error:'此账号来源暂不可上传'},403,origin);
   stage='database';db=await database(env);
   const saved=await db.prepare('SELECT state,result FROM lighthouse_uploads WHERE jti=?').bind(g.jti).first();
   if(saved)return saved.state==='done'?json(JSON.parse(saved.result),200,origin):json({error:'图片已处理或正在处理，请查询上传结果'},409,origin);
   const cap=g.mode==='compressed'?null:g.limit;
   if(cap!==null&&(!Number.isInteger(cap)||cap<0))return json({error:'额度无效'},403,origin);
   const inserted=await claimQuota(db,g);
   if(!inserted.meta.changes)return json({error:'今天原图额度已用完或此图片正在上传'},429,origin);
   try{
    await grant(form.get('ticket'),true);
    const url=new URL('/upload',request.url);url.search=new URLSearchParams({uploadChannel:'huggingface',channelName:'wanxiang',autoRetry:'false',serverCompress:'false',returnFormat:'full',uploadFolder:'lighthouse/'+g.sub+'/'+g.day}).toString();
    const input=new FormData(),extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','application/json':'json','application/zip':'zip'}[g.mime];input.set('file',new File([bytes],g.jti+'.'+extension,{type:g.mime}));
    const response=await processFileUpload({...context,url,securityConfig:await fetchSecurityConfig(env),uploadConfig:await fetchUploadConfig(env,context)},input);
    if(!response.ok)throw Error('图床上传失败');const result=await response.json(),address=new URL(result?.[0]?.src||result?.[0]?.publicUrl||'',BASE);
    if(!address.pathname.startsWith('/file/')||!['https://42ddc630.wanxiangdengta.pages.dev',BASE].includes(address.origin))throw Error('图床返回地址无效');
    const out={state:'done',url:BASE+address.pathname,bytes:bytes.length,sha256:hash};await db.prepare("UPDATE lighthouse_uploads SET state='done',result=? WHERE jti=?").bind(JSON.stringify(out),g.jti).run();return json(out,200,origin);
   }catch(error){await db.prepare("UPDATE lighthouse_uploads SET state='failed' WHERE jti=?").bind(g.jti).run();return json({error:'图床暂时无法完成上传，请稍后再试'},502,origin);}
  }
  const payload=await request.json();stage='authorization';g=await grant(payload.ticket,false,action==='status');stage='database';db=await database(env);
  if(action==='card-start'||action==='card-commit'){
   if(origin!==g.origin||g.mode!=='card'||!CARD_EXT[g.mime])return json({error:'上传来源无效'},403,origin);
   const fullId=cardId(g),saved=await db.prepare('SELECT state,result FROM lighthouse_uploads WHERE jti=?').bind(g.jti).first();
   if(saved?.state==='done')return json(JSON.parse(saved.result),200,origin);
   if(saved?.state==='failed')return json({error:'这次上传已结束，请重新选择文件'},409,origin);
   stage='storage';const {channel,api}=await cardChannel(env,context);
   if(action==='card-start'){
    let sample;try{sample=Uint8Array.from(atob(String(payload.sample||'')),c=>c.charCodeAt(0));}catch{sample=new Uint8Array();}
    if(sample.length<8||sample.length>512||!cardHeader(sample,g.mime))return json({error:'文件内容与类型不符，请选择真正的 PNG、JSON 或 ZIP 角色卡'},400,origin);
    if(await isBlockedUploadIp(env,getUploadIp(request)))return json({error:'此账号来源暂不可上传'},403,origin);
    if(!saved&&!(await claimQuota(db,g)).meta.changes)return json({error:'今天的角色卡附件额度已用完'},429,origin);
    const info=await api.getLfsUploadInfo(g.bytes,fullId,g.sha256,payload.sample);
    // Small text files are not stored as LFS objects: they go through the bounded 10MB upload route instead.
    if(!info.needsLfs){await db.prepare('DELETE FROM lighthouse_uploads WHERE jti=? AND state=\'pending\'').bind(g.jti).run();return json({route:'small'},200,origin);}
    const header=info.uploadAction?.header||null,multipart=!!header?.chunk_size;
    await db.prepare('UPDATE lighthouse_uploads SET result=? WHERE jti=?').bind(JSON.stringify({completion:multipart?info.uploadAction.href:''}),g.jti).run();
    return json({route:'direct',alreadyExists:!!info.alreadyExists,href:multipart?'':info.uploadAction?.href||'',header},200,origin);
   }
   if(!saved)return json({error:'请先开始上传'},409,origin);
   try{
    const start=JSON.parse(saved.result||'{}');
    if(start.completion){
     const target=new URL(start.completion),parts=payload.parts;
     if(target.protocol!=='https:'||target.hostname!=='huggingface.co'||target.pathname!=='/api/complete_multipart')throw Error('分片完成地址无效');
     if(!Array.isArray(parts)||!parts.length||parts.some(p=>!Number.isInteger(p?.partNumber)||p.partNumber<1||typeof p.etag!=='string'||!p.etag))throw Error('分片信息无效');
     const done=await fetch(target,{method:'POST',headers:{'Accept':'application/vnd.git-lfs+json','Content-Type':'application/vnd.git-lfs+json'},body:JSON.stringify({oid:g.sha256,parts:parts.map(p=>({partNumber:p.partNumber,etag:p.etag}))})});
     if(!done.ok)throw Error('分片合并失败');
    }
    await grant(payload.ticket,true);
    // Hugging Face checks that the stored object has exactly this SHA-256 and size before it accepts the commit.
    await api.commitLfsFile(fullId,g.sha256,g.bytes,'Lighthouse card '+g.jti);
    await registerCard(context,channel,fullId,g);
    const out={state:'done',url:BASE+'/file/'+fullId,bytes:g.bytes,sha256:g.sha256};
    await db.prepare("UPDATE lighthouse_uploads SET state='done',result=? WHERE jti=?").bind(JSON.stringify(out),g.jti).run();return json(out,200,origin);
   }catch(error){await db.prepare("UPDATE lighthouse_uploads SET state='failed' WHERE jti=?").bind(g.jti).run();return json({error:'角色卡没能存进图床：'+(error.message||'请稍后重试')},502,origin);}
  }
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
