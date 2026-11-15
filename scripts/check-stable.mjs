import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,relative,extname} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const tests=['calculations','storage','storage-extensions','json-merge','import-transaction','folders','recipe-view','recipe-card-model','profitability','packaging','drafts','photos','photo-print-selection','production-isolation','pages'].map(x=>'tests/'+x+'.test.js');
function run(args,env=process.env){
 return new Promise((ok,fail)=>{const child=spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'});child.once('error',fail);child.once('exit',code=>code===0?ok():fail(Error(args.join(' ')+' exited with '+code)));});
}
const server=createServer(async(req,res)=>{
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 let pathname;
 try{pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400);res.end();return;}
 const prefix='/kitchen-calculator/';
 if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
 const name=pathname.slice(prefix.length)||'index.html';
 const file=resolve(root,name);
 if(relative(root,file).startsWith('..')){res.writeHead(403);res.end();return;}
 try{
  const data=await readFile(file);
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(data);
 }catch{res.writeHead(404);res.end();}
});
try{
 await run(['--test',...tests]);
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
 const url='http://127.0.0.1:'+server.address().port+'/kitchen-calculator/';
 await run(['tests/persistence.browser.test.js'],{...process.env,KITCHEN_TEST_URL:url});
}catch(e){console.error(e.message);process.exitCode=1;}
finally{if(server.listening)await new Promise(done=>server.close(done));}