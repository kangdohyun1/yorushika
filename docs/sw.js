const C='yoru-v7';
const ART=['natsukusa','makeinu','dakara','elma','tousaku','sousaku','gentou','nininshou','singles','live-zense21','live-gekkou','live-tsuki','live-zense24','live-tousaku'].map(a=>'art/'+a+'.png');
const CORE=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png',...ART];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const u=e.request.url;if(e.request.method!=='GET'||/itunes\.apple\.com|musicbrainz\.org|youtube\.com|ytimg\.com|googlevideo\.com/.test(u))return;
  if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).then(r=>{const cl=r.clone();caches.open(C).then(c=>c.put('index.html',cl));return r}).catch(()=>caches.match('index.html')));return}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{if((res.ok||(res.type==='opaque'&&/mzstatic\.com/.test(u)))&&(u.startsWith(self.location.origin)||/fonts\.(googleapis|gstatic)|mzstatic\.com/.test(u))){const cl=res.clone();caches.open(C).then(c=>c.put(e.request,cl))}return res})))});
/* ---- 새 발매 백그라운드 확인 (Chrome Android 설치 앱) ---- */
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('yorushika-app',2);r.onupgradeneeded=()=>{const d=r.result;if(!d.objectStoreNames.contains('audio'))d.createObjectStore('audio');if(!d.objectStoreNames.contains('meta'))d.createObjectStore('meta')};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function mget(k){const d=await idb();return new Promise(r=>{const q=d.transaction('meta').objectStore('meta').get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>r(undefined)})}
async function mput(k,v){const d=await idb();return new Promise(r=>{const t=d.transaction('meta','readwrite');t.objectStore('meta').put(v,k);t.oncomplete=r;t.onerror=r})}
async function bgCheck(){
  const MB='https://musicbrainz.org/ws/2/';let id=await mget('mbid');
  if(!id){const d=await(await fetch(MB+'artist?query='+encodeURIComponent('artist:ヨルシカ')+'&limit=5&fmt=json')).json();const a=(d.artists||[]).find(x=>x.name==='ヨルシカ')||(d.artists||[])[0];if(!a)return;id=a.id;await mput('mbid',id);await new Promise(r=>setTimeout(r,1100))}
  const since=(await mget('since'))||'2026-11-25';const told=new Set((await mget('told'))||[]);
  const d=await(await fetch(MB+'release-group?artist='+id+'&type=album|ep|single&limit=100&fmt=json')).json();
  const fresh=(d['release-groups']||[]).filter(g=>!(g['secondary-types']||[]).length&&(g['first-release-date']||'')>since&&!told.has(g.id));
  if(!fresh.length)return;fresh.forEach(g=>told.add(g.id));await mput('told',[...told]);
  await self.registration.showNotification('요루시카 새 발매',{body:fresh.map(g=>'「'+g.title+'」').join(', ')+' — 앱을 열면 목록에 들어와요',icon:'icon-192.png',badge:'icon-192.png',tag:'yoru-new'});
}
self.addEventListener('periodicsync',e=>{if(e.tag==='yoru-new')e.waitUntil(bgCheck().catch(()=>{}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{const c=cs[0];if(c){return c.focus()}return clients.openWindow('./#/home')}))});
