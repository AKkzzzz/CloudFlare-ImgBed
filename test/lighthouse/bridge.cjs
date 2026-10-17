const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite'),{webcrypto}=require('node:crypto');
async function harness({issuerRedirect=false}={}){
 const store=new DatabaseSync(':memory:'),tickets=new Map();let uploads=0,block=null;const claims=[],fetchOptions=[],registered=[],hf={calls:[],info:null,failCommit:false};
 const db={prepare(sql){let values=[];return {bind(...v){values=v;return this},async run(){const r=store.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}}},async first(){return store.prepare(sql).get(...values)||null},async all(){return {results:store.prepare(sql).all(...values),meta:{size_after:4096}}}}}};
 const ctx=vm.createContext({Request,Response,FormData,File,URL,URLSearchParams,Uint8Array,Date,Number,JSON,String,Math,Error,atob,crypto:webcrypto,fetch:async(url,options)=>{fetchOptions.push({url,redirect:options.redirect});if(String(url).startsWith('https://huggingface.co/')){hf.calls.push(['complete',String(url),JSON.parse(options.body)]);return new Response('{}');}if(options.redirect==='error')throw new TypeError('Workers supports follow or manual redirects');if(issuerRedirect)return new Response(null,{status:307,headers:{Location:'https://other.invalid/verify'}});const {ticket:t,claim}=JSON.parse(options.body);if(claim)claims.push(t);return tickets.has(t)?Response.json(tickets.get(t)):Response.json({error:'bad'}, {status:403})}});
 const source=fs.readFileSync(path.join(__dirname,'../../functions/lighthouse/[[path]].js'),'utf8'),mod=new vm.SourceTextModule(source,{context:ctx});
 const modules={
  '../upload/index.js':{processFileUpload:async()=>{uploads++;if(block)await block;return Response.json([{src:'/file/test.png'}])}},
  '../utils/sysConfig.js':{fetchUploadConfig:async()=>({huggingface:{channels:[{name:'wanxiang',token:'t',repo:'owner/repo'}]}}),fetchSecurityConfig:async()=>({})},
  '../upload/uploadTools.js':{getUploadIp:()=> 'fixture',isBlockedUploadIp:async()=>false,endUpload:async()=>{}},
  '../utils/storage/huggingfaceAPI.js':{HuggingFaceAPI:class{async getLfsUploadInfo(size,file,oid){hf.calls.push(['info',file,oid,size]);return hf.info;}async commitLfsFile(file,oid,size){hf.calls.push(['commit',file,oid,size]);if(hf.failCommit)throw Error('oid mismatch');return {};}}},
  '../utils/databaseAdapter.js':{getDatabase:()=>({put:async(id,value,options)=>registered.push([id,options.metadata])})},
  '../utils/indexManager.js':{getIndexMeta:async()=>({totalCount:1,totalSizeMB:1})}
 };
 await mod.link(async name=>{const exports=modules[name],stub=new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v)},{context:ctx});return stub;});await mod.evaluate();
 const bytes=new Uint8Array(32);bytes.set([137,80,78,71]);const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
 let count=0;function ticket(extra={}){const t=String(++count).padStart(43,'a');tickets.set(t,{jti:count.toString(16).padStart(32,'0'),sub:'b'.repeat(64),mode:'original',bytes:bytes.length,sha256:hash,mime:'image/png',origin:'https://cg.chenyifei.xyz',day:Math.floor((Date.now()/1000+28800)/86400),limit:4,exp:Math.floor(Date.now()/1000)+300,...extra});return t;}
 async function upload(t,data=bytes){const f=new FormData();f.set('ticket',t);f.set('file',new File([data],'test.png',{type:'image/png'}));return mod.namespace.onRequest({request:new Request('https://wanxiangdengta.pages.dev/lighthouse/upload',{method:'POST',headers:{Origin:'https://cg.chenyifei.xyz'},body:f}),env:{img_d1:db}});}
 async function card(action,body,origin='https://cg.chenyifei.xyz'){return mod.namespace.onRequest({request:new Request('https://wanxiangdengta.pages.dev/lighthouse/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),env:{img_d1:db},waitUntil:()=>{}});}
 return {db,store,ticket,upload,card,mod,bytes,claims,fetchOptions,hf,registered,get uploads(){return uploads},setBlock:p=>block=p};
}
test('original cap is atomic; featured unlimited and same nonce is idempotent',async()=>{const h=await harness();try{for(let i=0;i<4;i++)assert.equal((await h.upload(h.ticket())).status,200);assert.equal((await h.upload(h.ticket())).status,429);for(let i=0;i<5;i++)assert.equal((await h.upload(h.ticket({limit:null}))).status,200);const t=h.ticket({limit:null});await h.upload(t);await h.upload(t);assert.equal(h.uploads,10);}finally{h.store.close()}});
test('concurrent replay only invokes upstream once',async()=>{const h=await harness();let release;try{h.setBlock(new Promise(r=>release=r));const t=h.ticket(),first=h.upload(t);while(!h.uploads)await new Promise(r=>setImmediate(r));const second=await h.upload(t);assert.equal(second.status,409);release();assert.equal((await first).status,200);assert.equal(h.uploads,1);}finally{release?.();h.store.close()}});
test('changed bytes, expired grant, wrong origin and forged token fail',async()=>{const h=await harness();try{const different=h.bytes.slice();different[20]=1;assert.equal((await h.upload(h.ticket(),different)).status,400);assert.equal((await h.upload(h.ticket({exp:1}))).status,403);assert.equal((await h.upload(h.ticket({origin:'https://other.test'}))).status,403);assert.equal((await h.upload('x'.repeat(43))).status,403);assert.equal(h.uploads,0);}finally{h.store.close()}});
test('preflight returns an empty 204 response',async()=>{const h=await harness();try{const r=await h.mod.namespace.onRequest({request:new Request('https://wanxiangdengta.pages.dev/lighthouse/upload',{method:'OPTIONS'}),env:{img_d1:h.db}});assert.equal(r.status,204);assert.equal(await r.text(),'');}finally{h.store.close()}});

test('invalid requests never claim daily reservations; valid upload claims once',async()=>{const h=await harness();try{const bad=h.bytes.slice();bad[20]=1;for(let i=0;i<4;i++)assert.equal((await h.upload(h.ticket(),bad)).status,400);assert.equal(h.claims.length,0);assert.equal((await h.upload(h.ticket())).status,200);assert.equal(h.claims.length,1);}finally{h.store.close()}});

test('real Workers redirect constraints are respected without following redirects',async()=>{const h=await harness();try{assert.equal((await h.upload(h.ticket())).status,200);assert.ok(h.fetchOptions.every(o=>o.redirect==='manual'));}finally{h.store.close()}const redirect=await harness({issuerRedirect:true});try{const r=await redirect.upload(redirect.ticket());assert.equal(r.status,403);assert.equal((await r.json()).code,'lighthouse-authorization-issuer-307');assert.equal(redirect.uploads,0);assert.equal(redirect.fetchOptions.length,1);}finally{redirect.store.close()}});

// Character-card attachments: the browser sends the bytes to Hugging Face storage directly; this function
// only hands out the upload address and commits the object, which Hugging Face checks against the SHA-256.
const PNG_SAMPLE=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13]).toString('base64');
const cardTicket=(h,extra={})=>h.ticket({mode:'card',mime:'image/png',bytes:12*1024*1024,sha256:'c'.repeat(64),limit:10,exp:Math.floor(Date.now()/1000)+1800,...extra});
test('a card goes straight to storage, is committed by hash and registered once',async()=>{const h=await harness();try{
 h.hf.info={needsLfs:true,alreadyExists:false,uploadAction:{href:'https://s3.example/put?sig=1',header:{}}};
 const t=cardTicket(h),start=await h.card('card-start',{ticket:t,sample:PNG_SAMPLE}),info=await start.json();
 assert.equal(start.status,200);assert.equal(info.route,'direct');assert.equal(info.href,'https://s3.example/put?sig=1');
 const done=await h.card('card-commit',{ticket:t}),out=await done.json();
 assert.equal(done.status,200,JSON.stringify(out));assert.match(out.url,/^https:\/\/wanxiangdengta\.pages\.dev\/file\/lighthouse\/cards\/b{64}\/\d+\/[0-9a-f]{32}\.png$/);
 assert.deepEqual(h.hf.calls.find(c=>c[0]==='commit').slice(2),['c'.repeat(64),12*1024*1024]);
 assert.equal(h.registered.length,1);assert.equal(h.registered[0][1].FileSizeBytes,12*1024*1024);assert.ok(h.claims.includes(t));
 assert.deepEqual(await (await h.card('card-commit',{ticket:t})).json(),out);
}finally{h.store.close()}});
test('multipart uploads are completed here with the stored target, never one supplied by the browser',async()=>{const h=await harness();try{
 h.hf.info={needsLfs:true,uploadAction:{href:'https://huggingface.co/api/complete_multipart?token=x',header:{chunk_size:'8388608','00001':'https://s3.example/1','00002':'https://s3.example/2'}}};
 const t=cardTicket(h),info=await (await h.card('card-start',{ticket:t,sample:PNG_SAMPLE})).json();
 assert.equal(info.href,'');assert.equal(info.header['00002'],'https://s3.example/2');
 assert.equal((await h.card('card-commit',{ticket:t,parts:[{partNumber:1,etag:'"a"'},{partNumber:2,etag:'"b"'}],target:'https://evil.example/'})).status,200);
 const complete=h.hf.calls.find(c=>c[0]==='complete');assert.equal(complete[1],'https://huggingface.co/api/complete_multipart?token=x');assert.equal(complete[2].oid,'c'.repeat(64));
}finally{h.store.close()}});
test('a file whose first bytes are not a card, a foreign origin or a used-up quota are refused',async()=>{const h=await harness();try{
 h.hf.info={needsLfs:true,uploadAction:{href:'https://s3.example/put',header:{}}};
 assert.equal((await h.card('card-start',{ticket:cardTicket(h),sample:Buffer.from('<html><body>hi</body></html>').toString('base64')})).status,400);
 assert.equal((await h.card('card-start',{ticket:cardTicket(h),sample:PNG_SAMPLE},'https://evil.example')).status,403);
 assert.equal((await h.card('card-start',{ticket:h.ticket(),sample:PNG_SAMPLE})).status,403,'image tickets cannot start card uploads');
 for(let i=0;i<10;i++)assert.equal((await h.card('card-start',{ticket:cardTicket(h),sample:PNG_SAMPLE})).status,200);
 assert.equal((await h.card('card-start',{ticket:cardTicket(h),sample:PNG_SAMPLE})).status,429);
}finally{h.store.close()}});
test('a commit Hugging Face rejects ends the upload and cannot be replayed',async()=>{const h=await harness();try{
 h.hf.info={needsLfs:true,uploadAction:{href:'https://s3.example/put',header:{}}};h.hf.failCommit=true;
 const t=cardTicket(h);await h.card('card-start',{ticket:t,sample:PNG_SAMPLE});
 assert.equal((await h.card('card-commit',{ticket:t})).status,502);assert.equal(h.registered.length,0);
 assert.equal((await h.card('card-commit',{ticket:t})).status,409);
}finally{h.store.close()}});
test('small text cards take the bounded upload route instead',async()=>{const h=await harness();try{
 h.hf.info={needsLfs:false};const json=new TextEncoder().encode('{"spec":"chara_card_v2","data":{"name":"x"}}');
 const sha=Buffer.from(await webcrypto.subtle.digest('SHA-256',json)).toString('hex'),t=cardTicket(h,{mime:'application/json',bytes:json.length,sha256:sha});
 assert.equal((await (await h.card('card-start',{ticket:t,sample:Buffer.from(json).toString('base64')})).json()).route,'small');
 assert.equal((await h.upload(t,json)).status,200);
}finally{h.store.close()}});
