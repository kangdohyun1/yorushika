const NATIVE = (() => { try{ return !!(window.YoruNative && YoruNative.isNative()); }catch(e){ return false; } })();
/* =================== 저장소 =================== */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem('yoru:'+k); return v==null ? d : JSON.parse(v); }catch(e){ return MEM[k] ?? d; } },
  set(k, v){ MEM[k]=v; try{ localStorage.setItem('yoru:'+k, JSON.stringify(v)); }catch(e){} }
};
const MEM = {};
const IDB = (() => {
  let dbp = null;
  function db(){
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      try{
        const r = indexedDB.open('yorushika-app', 2);
        r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('audio')) d.createObjectStore('audio'); if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta'); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }catch(e){ rej(e); }
    });
    return dbp;
  }
  const tx = (mode, fn, store='audio') => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  }));
  return {
    put:(k,v)=>tx('readwrite',s=>s.put(v,k)),
    get:(k)=>tx('readonly',s=>s.get(k)),
    del:(k)=>tx('readwrite',s=>s.delete(k)),
    keys:()=>tx('readonly',s=>s.getAllKeys()),
    clear:()=>tx('readwrite',s=>s.clear()),
    mput:(k,v)=>tx('readwrite',s=>s.put(v,k),'meta'),
    mget:(k)=>tx('readonly',s=>s.get(k),'meta')
  };
})();

/* =================== 데이터 인덱스 =================== */
const SONGS = {}; const ORDER = []; const ALB = {};
const BASE_SINGLES = ALBUMS.find(a=>a.id==='singles').tracks.length;
const getExtra = () => { const e = LS.get('extra', null) || {}; return { albums:e.albums||[], singles:e.singles||[], seen:e.seen||[], log:e.log||[], lastCheck:e.lastCheck||0, lastSrc:e.lastSrc||'', lastErr:e.lastErr||'' }; };
function applyExtras(){
  const ex = getExtra();
  for (let i=ALBUMS.length-1; i>=0; i--) if (ALBUMS[i].extra) ALBUMS.splice(i,1);
  const sg = ALBUMS.find(a=>a.id==='singles'); sg.tracks.length = BASE_SINGLES;
  ex.singles.forEach(t => sg.tracks.push([t[0], t[1], '', 'new', t[3]==='auto'?'auto':'']));
  if (ex.singles.length) sg.date = '2023 – ' + ex.singles[ex.singles.length-1][2].slice(0,4);
  const at = ALBUMS.findIndex(a=>a.id==='singles');
  ALBUMS.splice(at, 0, ...ex.albums.map(x => ({...x, extra:true})));
}
function buildIndex(){
  const KO = LS.get('krTitles', {}), KA = LS.get('krAlbums', {});
  Object.keys(SONGS).forEach(k=>delete SONGS[k]); ORDER.length = 0; Object.keys(ALB).forEach(k=>delete ALB[k]);
  ALBUMS.forEach(a => { if (KA[a.id]) a.kr = KA[a.id]; ALB[a.id] = a;
    a.tracks.forEach((t, i) => { const id = a.id + '-' + (i+1);
      const KAU = LS.get('krAutoIds', []);
      SONGS[id] = { id, jp:t[0], kr:KO[id] || t[1], inst:t[2]==='i', album:a.id, no:i+1, isNew:t[3]==='new', untr: !KO[id] && t[1]===t[0] && t[3]==='new', auto: KO[id] ? KAU.includes(id) : t[4]==='auto' };
      ORDER.push(id); }); });
  VER.clear(); ORDER.forEach(id => { const k = norm(baseTitle(SONGS[id].jp)); if (!k) return; if (!VER.has(k)) VER.set(k, []); VER.get(k).push(id); });
  ORDER.forEach(id => { const s = SONGS[id]; s.live = !!ALB[s.album].live; s.rr = /Re-Recording/.test(s.jp);
    const vs = VER.get(norm(baseTitle(s.jp))) || []; const o = vs.find(x => !ALB[SONGS[x].album].live && !/Re-Recording/.test(SONGS[x].jp));
    s.orig = o && o !== id ? o : null; });
}
const VER = new Map();
const versionsOf = id => (VER.get(norm(baseTitle(SONGS[id].jp))) || []).filter(x => x !== id);
const baseTitle = s => s.replace(/\s*\(Re-Recording\)/,'');
const noteOf = s => NOTES[s.jp] || NOTES[baseTitle(s.jp)] || '';

const state = {
  lyrics: LS.get('lyrics', {}),      // id -> {jp, kr}
  playlists: LS.get('playlists', []),// [{id,name,songs:[]}]
  favs: new Set(LS.get('favs', [])),
  recent: LS.get('recent', []),
  theme: LS.get('theme', 'auto'),
  lyrMode: LS.get('lyrMode', 'pair'),
  vol: LS.get('vol', .9),
  hasAudio: new Set(),
  queue: [], qi: -1, shuffle: LS.get('shuffle', false), repeat: LS.get('repeat', 'off'),
  npTab: 'lyr', mode: 'local', resumeT: 0
};
const saveFavs = () => LS.set('favs', [...state.favs]);
const savePl = () => LS.set('playlists', state.playlists);

/* =================== 유틸 =================== */
const $ = (s, r=document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = t => !isFinite(t) ? '0:00' : Math.floor(t/60)+':'+String(Math.floor(t%60)).padStart(2,'0');
const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/\(re-?recording\)|ヨルシカ|yorushika|official|music ?video|mv|audio|full/gi,'').replace(/[\s_\-–—・·、。.,!！?？「」『』()（）\[\]【】'"`~]/g,'');
let toastT; function toast(m){ const t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'), 2600); }
const uid = () => Math.random().toString(36).slice(2,9);

const I = { // 아이콘
  home:'<path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  disc:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  list:'<path d="M4 6h12M4 12h12M4 18h8M18 15v6m-3-3h6"/>',
  book:'<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v16M8 7h7"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play:'<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  prev:'<path d="M6 5v14M19 5 9 12l10 7z" fill="currentColor"/>',
  next:'<path d="M18 5v14M5 5l10 7-10 7z" fill="currentColor"/>',
  shuf:'<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  rep:'<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  heart:'<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3.5A5 5 0 0 1 21 11c-2 4.6-9 9-9 9z"/>',
  heartF:'<path d="M12 20s-7-4.4-9-9a5 5 0 0 1 9-3.5A5 5 0 0 1 21 11c-2 4.6-9 9-9 9z" fill="currentColor"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  more:'<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  up:'<path d="m6 15 6-6 6 6"/>',
  x:'<path d="M6 6l12 12M18 6 6 18"/>',
  vol:'<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  music:'<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  edit:'<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  trash:'<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  aminus:'<path d="M3 18 8 6l5 12M4.6 14h6.8M15 12h6"/>',
  aplus:'<path d="M3 18 8 6l5 12M4.6 14h6.8M15 12h6M18 9v6"/>',
  expand:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file:'<path d="M14 3H6v18h12V7zM14 3v4h4"/>'
};
const ic = (n, sw=1.7) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${I[n]}</svg>`;

applyExtras(); buildIndex();
/* =================== 앨범 아트 (오리지널 SVG) =================== */
/* ---- 공식 앨범 커버: Apple Music 공개 카탈로그(iTunes Lookup)의 이미지를 불러와 표시 ---- */
const coverMode = () => LS.get('coverMode', 'official');
let COV = LS.get('covers', {});
function coverOf(aid, px=300){
  if (coverMode() !== 'official') return '';
  const u = (COV.map || {})[aid]; if (!u) return '';
  return u.replace(/\/\d+x\d+(bb|cc)?\.(jpg|png|webp)$/i, `/${px}x${px}bb.jpg`);
}
const albKey = t => norm(String(t||'').replace(/\s*-\s*(Single|EP)$/i,''));
let coverBusy = false;
async function fetchCovers(manual){
  if (coverBusy) return; coverBusy = true;
  try{
    const d = await jsonp(`${IT}?id=${UPD_CFG.itunesId}&entity=album&limit=200&country=jp&lang=ja_jp`);
    const cols = (d.results||[]).filter(r => r.wrapperType==='collection' && r.artistId===UPD_CFG.itunesId && r.artworkUrl100)
      .sort((x,y) => (x.releaseDate||'').localeCompare(y.releaseDate||''));          // 같은 이름이면 처음 나온 판
    const by = {}; cols.forEach(c => { const k = albKey(c.collectionName); if (k && !by[k]) by[k] = c.artworkUrl100; });
    const map = {};
    ALBUMS.forEach(a => { if (a.live) return;
      if (a.id === 'singles'){ for (let i = a.tracks.length-1; i >= 0; i--){ const u = by[albKey(a.tracks[i][0])]; if (u){ map[a.id] = u; break; } } return; }
      const u = by[albKey(a.jp)]; if (u) map[a.id] = u; });
    const old = JSON.stringify(COV.map || {});
    COV = { map, at: Date.now(), n: Object.keys(map).length }; LS.set('covers', COV);
    if (manual) toast(Object.keys(map).length ? `공식 커버 ${Object.keys(map).length}장을 불러왔어요` : '커버를 찾지 못했어요');
    if (old !== JSON.stringify(map) || manual){ if (!$('#np').classList.contains('open')){ const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; } updateBar(); }
  }catch(e){ if (manual) toast(/claude|anthropic/.test(location.host) ? '미리보기 화면에서는 외부 연결이 막혀 있어요 — 설치한 앱에서 불러와져요' : '커버를 불러오지 못했어요 — 인터넷 연결을 확인해 주세요'); }
  coverBusy = false;
}
function maybeCovers(){ const c = COV; if (coverMode()==='official' && navigator.onLine !== false && (!c.at || Date.now() - c.at > 7*864e5)) fetchCovers(false); }
function art(aid, big){
  const cv = coverOf(aid, big ? 600 : 300);
  if (cv) return `<span class="awrap">${artSvg(aid)}<img class="ocov" src="${esc(cv)}" alt="" loading="lazy" decoding="async" onerror="this.remove()"></span>`;
  return artSvg(aid);
}
function artSvg(aid){
  const a = ALB[aid]; const c = a.hue, c2 = a.hue2; const t = a.jp;
  const vt = (x,y,size,fill,txt=t) => { const fs = Math.min(size, Math.floor((196-y)/(txt.length*1.1))); return `<text x="${x}" y="${y}" font-family="Shippori Mincho,serif" font-weight="800" font-size="${fs}" fill="${fill}" style="writing-mode:vertical-rl;letter-spacing:.1em">${esc(txt)}</text>`; };
  let g = '';
  switch(a.motif){
    case 'grass': g = `<defs><linearGradient id="g${aid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fd3ef"/><stop offset=".58" stop-color="#e9f5f6"/><stop offset=".6" stop-color="${c}"/><stop offset="1" stop-color="#2f6b4c"/></linearGradient></defs><rect width="200" height="200" fill="url(#g${aid})"/>
      <ellipse cx="60" cy="52" rx="38" ry="12" fill="#fff" opacity=".85"/><ellipse cx="140" cy="38" rx="28" ry="8" fill="#fff" opacity=".7"/>
      ${Array.from({length:46},(_,i)=>{const x=i*4.5+(i%3);const h=24+(i*37%30);return `<path d="M${x} 200 Q${x+3} ${200-h/2} ${x+(i%2?6:-4)} ${200-h-60}" stroke="${i%4?'#3d7d5a':'#6fae86'}" stroke-width="1.4" fill="none"/>`}).join('')}
      ${vt(172,18,15,'#1f3b2c')}`; break;
    case 'busstop': g = `<rect width="200" height="200" fill="${c}"/><rect y="120" width="200" height="80" fill="#2c5376"/>
      <circle cx="150" cy="60" r="26" fill="${c2}" opacity=".9"/><line x1="54" y1="58" x2="54" y2="150" stroke="#f4f1e6" stroke-width="3"/><rect x="38" y="46" width="32" height="20" rx="10" fill="#f4f1e6"/>
      <line x1="0" y1="150" x2="200" y2="150" stroke="#f4f1e6" stroke-width="1" opacity=".5"/>
      ${vt(178,14,12,'#f4f1e6')}`; break;
    case 'letters': g = `<rect width="200" height="200" fill="${c2}"/>
      ${[0,1,2,3].map(i=>`<g transform="rotate(${-8+i*5} 100 100) translate(${30+i*8} ${40+i*16})"><rect width="110" height="72" fill="#fbf9f3" stroke="#c9d3dc"/><path d="M0 0 55 40 110 0" fill="none" stroke="#c9d3dc"/></g>`).join('')}
      <text x="22" y="182" font-family="Shippori Mincho,serif" font-size="13" fill="${c}" letter-spacing="2">8/31 → 4/10</text>
      ${vt(180,16,12,c)}`; break;
    case 'lake': g = `<defs><linearGradient id="g${aid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3e7d2"/><stop offset="1" stop-color="#c9a77f"/></linearGradient></defs><rect width="200" height="200" fill="url(#g${aid})"/>
      <path d="M0 118 C40 108 80 112 120 104 S180 110 200 106 V200 H0z" fill="#7c94a0" opacity=".7"/>
      ${[0,1,2,3,4].map(i=>`<line x1="${20+i*12}" y1="${132+i*12}" x2="${120+i*14}" y2="${132+i*12}" stroke="#f3e7d2" stroke-width="1" opacity=".55"/>`).join('')}
      <path d="M70 104 l8 -40 l2 40z" fill="#5b4632"/><circle cx="150" cy="54" r="14" fill="#fff8e8"/>
      ${vt(182,16,15,'#4a3a2a')}`; break;
    case 'frame': g = `<rect width="200" height="200" fill="${c2}"/><rect x="34" y="34" width="132" height="132" fill="none" stroke="#1d1d1d" stroke-width="2"/>
      <rect x="48" y="48" width="104" height="104" fill="${c}"/><path d="M48 48 L152 152" stroke="${c2}" stroke-width="2"/>
      ${[0,1,2,3,4,5].map(i=>`<rect x="20" y="${180-i*0}" width="0" height="0"/>`).join('')}
      <text x="100" y="186" text-anchor="middle" font-family="Shippori Mincho,serif" font-size="10" letter-spacing="6" fill="#1d1d1d">PLAGIARISM</text>
      ${vt(184,40,13,'#1d1d1d')}`; break;
    case 'tape': g = `<rect width="200" height="200" fill="${c2}"/><rect x="30" y="58" width="140" height="88" rx="8" fill="${c}"/>
      <rect x="48" y="72" width="104" height="34" rx="4" fill="#f9f3e4"/><circle cx="72" cy="122" r="11" fill="#f9f3e4"/><circle cx="128" cy="122" r="11" fill="#f9f3e4"/>
      <circle cx="72" cy="122" r="4" fill="${c}"/><circle cx="128" cy="122" r="4" fill="${c}"/>
      <text x="100" y="95" text-anchor="middle" font-family="Shippori Mincho,serif" font-weight="800" font-size="16" fill="#5a4520">創作</text>
      <path d="M150 30 q10 10 0 20 q-10 10 0 20" stroke="#e7a9b4" stroke-width="5" fill="none" opacity=".8"/>`; break;
    case 'lantern': g = `<defs><radialGradient id="g${aid}" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="#ffe7b0"/><stop offset=".45" stop-color="${c}"/><stop offset="1" stop-color="#3a2614"/></radialGradient></defs><rect width="200" height="200" fill="url(#g${aid})"/>
      ${Array.from({length:12},(_,i)=>`<path d="M100 84 L${100+Math.cos(i/12*6.283)*160} ${84+Math.sin(i/12*6.283)*160}" stroke="#fff4d6" stroke-width="${i%2?.6:1.4}" opacity=".35"/>`).join('')}
      <rect x="86" y="66" width="28" height="38" rx="4" fill="#fff4d6" opacity=".9"/><circle cx="100" cy="85" r="7" fill="#f3b04e"/>
      ${vt(178,14,15,'#fff4d6')}`; break;
    case 'envelope': g = `<rect width="200" height="200" fill="${c2}"/><g transform="rotate(-6 100 100)"><rect x="30" y="52" width="140" height="94" fill="#fbf7ee" stroke="#b9b09c"/>
      <path d="M30 52 100 106 170 52" fill="none" stroke="#b9b09c"/><rect x="138" y="62" width="22" height="26" fill="none" stroke="${c}" stroke-dasharray="2 2"/>
      <circle cx="149" cy="75" r="6" fill="${c}"/></g><text x="22" y="180" font-family="Shippori Mincho,serif" font-size="12" fill="${c}" letter-spacing="3">二人称 ─ to you</text>`; break;
    case 'live': g = `<defs><radialGradient id="g${aid}" cx=".5" cy=".18" r=".9"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c2}"/></radialGradient></defs><rect width="200" height="200" fill="url(#g${aid})"/>
      ${[-1,0,1].map(k=>`<path d="M${100+k*46} 0 L${100+k*46-26} 150 L${100+k*46+26} 150 Z" fill="#fff" opacity="${k?'.07':'.13'}"/>`).join('')}
      <path d="M0 150 H200 V200 H0z" fill="#000" opacity=".35"/>${Array.from({length:14},(_,i)=>`<circle cx="${8+i*14.5}" cy="${172+(i%2)*6}" r="${4+(i%3)}" fill="#000" opacity=".45"/>`).join('')}
      <text x="18" y="30" font-family="Shippori Mincho,serif" font-size="11" letter-spacing="5" fill="#fff" opacity=".85">LIVE</text>
      <text x="18" y="142" font-family="Shippori Mincho,serif" font-size="8.5" letter-spacing="2" fill="#fff" opacity=".7">${esc(a.date)}</text>${vt(182,16,17,'#fff',a.tag||a.jp)}`; break;
    case 'paper': g = `<rect width="200" height="200" fill="${c2}"/><circle cx="92" cy="96" r="54" fill="${c}" opacity=".88"/><circle cx="92" cy="96" r="54" fill="none" stroke="${c}" stroke-width="1" transform="translate(10 8)" opacity=".5"/>
      <line x1="20" y1="176" x2="150" y2="176" stroke="${c}" stroke-width="1"/><text x="20" y="190" font-family="Shippori Mincho,serif" font-size="9" letter-spacing="1.5" fill="${c}">NEW · ${esc(a.date)}</text>${vt(182,16,16,'#1f2a36')}`; break;
    case 'moon': g = `<rect width="200" height="200" fill="#1c2546"/>
      ${Array.from({length:22},(_,i)=>`<circle cx="${(i*53)%200}" cy="${(i*37)%140}" r="${i%3?.7:1.2}" fill="#fff" opacity=".7"/>`).join('')}
      <circle cx="110" cy="80" r="34" fill="#f6efd5"/><circle cx="124" cy="70" r="30" fill="#1c2546"/>
      <path d="M0 160 Q50 140 100 158 T200 150 V200 H0z" fill="#2d3866"/>${vt(180,16,13,'#f6efd5','シングル')}`; break;
  }
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(a.kr)}">${g}</svg>`;
}

function accentFor(hex){ if (document.documentElement.dataset.mode!=='night') return hex; const n = parseInt(hex.slice(1),16); const m = c => Math.round(c + (255-c)*0.48); return '#'+[m(n>>16&255),m(n>>8&255),m(n&255)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function setAccent(hex){ document.documentElement.style.setProperty('--accent', accentFor(hex)); }
/* =================== 라우팅 =================== */
const routes = { home:vHome, albums:vAlbums, album:vAlbum, playlists:vPlaylists, playlist:vPlaylist, story:vStory, read:vRead, versions:vVersions, favs:vFavs, search:vSearch, settings:vSettings };
function go(h){ location.hash = h; }
function render(){
  const [r, p] = (location.hash.slice(2) || 'home').split('/');
  const fn = routes[r] || vHome;
  if (r!=='album') document.documentElement.style.setProperty('--accent', document.documentElement.dataset.mode==='night'?'#8fb4dc':'#3f6f9a');
  closeNP();
  const m = $('#main'); m.innerHTML = `<div class="view">${fn(p ? decodeURIComponent(p) : undefined)}</div>`; m.scrollTop = 0;
  document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('on', n.dataset.nav === (r==='album'||r==='versions'?'albums':r==='playlist'?'playlists':r==='read'?'story':r)));
  markPlaying();
  if (r==='search'){ const s=$('#q'); s && (s.focus(), s.setSelectionRange(s.value.length,s.value.length)); }
}
window.addEventListener('hashchange', render);

/* =================== 뷰 =================== */
function trackRow(id, i, ctx){
  const s = SONGS[id]; const fav = state.favs.has(id); const a = ALB[s.album];
  return `<div class="tr" data-id="${id}" data-ctx="${esc(ctx)}" data-i="${i}">
    <div class="n">${ctx.startsWith('pl:')||ctx==='favs'||ctx==='search' ? `<div class="art" style="width:34px;height:34px;border-radius:5px;overflow:hidden">${art(s.album)}</div>` : s.no}</div>
    <div><div class="k">${esc(s.kr)}${state.hasAudio.has(id)?'<span class="dot" title="음원 있음"></span>':(extOn() && streamable(id))?`<span class="dot yt" title="${esc(extName())}에서 재생"></span>`:ytOf(id)?'<span class="dot yt" title="YouTube 공식 영상으로 재생"></span>':''}${s.inst?' <span class="chip">연주곡</span>':''}${s.isNew?' <span class="chip new">NEW</span>':''}${s.untr?' <span class="chip">번역 전</span>':''}${s.auto?' <span class="chip">자동 번역</span>':''}</div>
      <div class="jj">${esc(s.jp)}${ctx.startsWith('pl:')||ctx==='favs'||ctx==='search' ? ' · '+esc(a.kr):''}</div></div>
    <div class="m">${ctx.startsWith('pl:') ? `<button class="ibtn" data-act="mvup" title="위로">${ic('up')}</button><button class="ibtn" data-act="mvdn" title="아래로">${ic('down')}</button><button class="ibtn" data-act="rm" title="빼기">${ic('x')}</button>` : ''}
      <button class="ibtn ${fav?'on':''}" data-act="fav" title="좋아요">${ic(fav?'heartF':'heart')}</button>
      <button class="ibtn" data-act="add" title="플레이리스트에 추가">${ic('plus')}</button></div>
  </div>`;
}
function ctxList(ctx){
  if (ctx.startsWith('alb:')) return ALB[ctx.slice(4)].tracks.map((_,i)=>ctx.slice(4)+'-'+(i+1));
  if (ctx.startsWith('pl:')) return (state.playlists.find(p=>p.id===ctx.slice(3))||{songs:[]}).songs;
  if (ctx==='favs') return ORDER.filter(id=>state.favs.has(id));
  if (ctx==='search') return searchIds($('#q')?.value||'');
  return [];
}

function vHome(){
  const day = Math.floor(Date.now()/864e5); const pick = ORDER.filter(id=>!SONGS[id].inst)[day*7919 % ORDER.filter(id=>!SONGS[id].inst).length]; const ps = SONGS[pick];
  const h = new Date().getHours(); const greet = h<5?'아직 잠들지 못한 밤이네요':h<11?'좋은 아침, 여름 냄새가 나요':h<17?'구름이 천천히 흘러가는 오후':h<20?'노을이 지는 시간':'밤에만 피는 노래들';
  const rec = state.recent.filter(id=>SONGS[id]).slice(0,6);
  return `<section class="hero card"><div class="line">YORUSHIKA · 夜しか</div>
      <div><h1>${greet}</h1><p>앨범 아홉 갈래, ${ORDER.length}곡. 편지와 여름과 달의 이야기를 한 곳에 모았습니다.</p>
      <div class="card today" data-go="song:${pick}"><div class="art">${art(ps.album)}</div><div><div class="tiny">오늘의 한 곡 · 今日の一曲</div><div class="kr" style="font-weight:700;font-size:17px">${esc(ps.kr)}</div><div class="jp muted" style="font-size:13px">${esc(ps.jp)} — ${esc(ALB[ps.album].kr)}</div></div></div></div>
      <div class="vt">ヨルシカ</div></section>
    ${rec.length?`<div class="sec-t"><h2>최근 들은 곡</h2><span>最近</span></div><div class="card tl">${rec.map((id,i)=>trackRow(id,i,'search-rec')).join('')}</div>`:''}
    <div class="sec-t"><h2>앨범</h2><span>ディスコグラフィ</span></div>${shelf()}
    <div class="sec-t"><h2>라이브</h2><span>ライブ</span></div>${shelf(ALBUMS.filter(a=>a.live))}
    <div class="sec-t"><h2>이야기 지도</h2><span>物語</span></div>
    <div class="arc-mini" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px">${STORY.arcs.map(a=>`<div class="card" style="padding:18px;cursor:pointer" data-go="#/read/${a.id}"><div class="tiny jp">${a.era}</div><div class="kr" style="font-weight:700;font-size:16px">${a.title}</div></div>`).join('')}</div>`;
}
function shelf(list){ list = list || ALBUMS.filter(a=>!a.live); return `<div class="shelf">${list.map(a=>`<div class="alb" data-go="#/album/${a.id}"><div class="art">${art(a.id)}${a.extra?'<span class="newb">NEW</span>':''}</div><div class="t">${esc(a.kr)}</div><div class="j">${esc(a.jp)}</div><div class="y">${a.date} · ${a.type}</div></div>`).join('')}</div>`; }
function vAlbums(){ const st = ALBUMS.filter(a=>!a.live), lv = ALBUMS.filter(a=>a.live);
  return `<h1 class="page">앨범</h1><p class="page-sub">アルバム · 스튜디오 ${st.length} · 라이브 ${lv.length}</p>${shelf(st)}
  <div class="sec-t"><h2>라이브</h2><span>ライブ映像作品</span></div>${shelf(lv)}
  <div class="sec-t"><h2>재녹음 · 다른 버전</h2><span>Re-Recording</span></div>${verCard()}`; }
function verCard(){ return `<div class="card ver-link" data-go="#/versions"><div><b class="kr">원곡과 재녹음, 라이브를 나란히</b><div class="tiny">재녹음 ${ORDER.filter(id=>SONGS[id].rr).length}곡 · 라이브 ${ALBUMS.filter(a=>a.live).length}편 · 버전이 여러 개인 곡 ${[...VER.values()].filter(v=>v.length>1).length}곡</div></div><span class="ibtn">${ic('next')}</span></div>`; }
function vVersions(){
  const rr = ORDER.filter(id => SONGS[id].rr);
  const pair = (o, v, label) => `<div class="card vpair"><div class="vp-h kr">${esc(SONGS[v].kr.replace(/\s*\(재녹음\)/,''))} <span class="jp tiny">${esc(baseTitle(SONGS[v].jp))}</span></div>
    <div class="vp-row">${[o, v].map((x,i)=>`<div class="vp-c" data-chip="${x}"><div class="art">${art(SONGS[x].album)}</div><div><div class="tiny">${i? label : '원곡'}</div><div class="kr" style="font-weight:700">${esc(ALB[SONGS[x].album].kr)}</div><div class="tiny">${ALB[SONGS[x].album].date}</div></div><span class="ibtn">${ic(playable(x)?'play':'music')}</span></div>`).join('<div class="vp-arrow">→</div>')}</div></div>`;
  const counts = [...VER.entries()].map(([k, ids]) => ({ ids, n: ids.filter(x => SONGS[x].live).length })).filter(x => x.n).sort((a,b) => b.n - a.n);
  const top = counts.slice(0, 12);
  return `<h1 class="page">재녹음 · 라이브 버전</h1><p class="page-sub">Re-Recording · Live</p>
  <div class="sec-t"><h2>재녹음</h2><span>Re-Recording</span></div>
  <div class="vgrid">${rr.map(v => SONGS[v].orig ? pair(SONGS[v].orig, v, '재녹음') : '').join('')}
    ${(()=>{ const g = ORDER.find(id=>SONGS[id].album==='gentou' && SONGS[id].jp==='靴の花火'), o = ORDER.find(id=>SONGS[id].album==='natsukusa' && SONGS[id].jp==='靴の花火'); return g && o ? pair(o, g, '「환등」 수록 버전') : ''; })()}</div>
  <p class="tiny">「폭탄마」는 「도작」에, 「히치콕」은 「2인칭」에 재녹음 버전이 실렸습니다. 「신발의 불꽃놀이」는 같은 제목으로 「환등」에 다시 수록됐어요.</p>
  <div class="sec-t"><h2>라이브 영상 작품</h2><span>ライブ</span></div>${shelf(ALBUMS.filter(a=>a.live))}
  <div class="sec-t"><h2>라이브에서 자주 부른 곡</h2><span>5편 기준</span></div>
  <div class="card tl">${top.map(({ids, n}) => { const s = SONGS[ids.find(x=>!SONGS[x].live) || ids[0]]; return `<div class="tr" data-id="${s.id}" data-ctx="search" data-i="0"><div class="n"><b class="jp" style="color:var(--accent);font-size:16px">${n}</b></div><div><div class="k">${esc(s.kr)}</div><div class="jj">${esc(s.jp)} · ${ids.filter(x=>SONGS[x].live).map(x=>esc(ALB[SONGS[x].album].tag)).join(' · ')}</div></div><div class="m"></div></div>`; }).join('')}</div>`;
}
function vAlbum(id){
  const a = ALB[id]; if(!a) return vAlbums();
  setAccent(a.hue);
  const ids = ctxList('alb:'+id); const n = ids.filter(x=>state.hasAudio.has(x)).length, ny = ids.filter(x=>!state.hasAudio.has(x) && ytOf(x)).length;
  return `<div class="ahead"><div class="art">${art(id,1)}</div><div><div class="type">${a.type.toUpperCase()} · ${a.date}</div><h1>${esc(a.kr)}${a.krAuto?' <span class="chip">자동 번역</span>':''} <button class="ibtn sm" data-act="renalb" data-alb="${id}" title="한국어 제목 고치기">${ic('edit')}</button></h1><div class="j">${esc(a.jp)}</div><p class="bl">${esc(a.blurb)}</p>
    <div class="acts"><button class="btn pri" data-play="alb:${id}">${ic('play')} 재생</button><button class="btn" data-play="alb:${id}" data-shuf="1">${ic('shuf')} 셔플</button><button class="btn" data-addall="alb:${id}">${ic('plus')} 전부 담기</button>${(()=>{const ar=STORY.arcs.find(x=>x.albums.includes(id));return ar&&DEEP[ar.id]?`<a class="btn" href="#/read/${ar.id}">${ic('book')} 이야기 읽기</a>`:''})()}<span class="tiny" style="align-self:center">${ids.length}곡 · 음원 ${n}${ny?` · YouTube ${ny}`:''}</span></div></div></div>
    <div class="card tl">${ids.map((x,i)=>trackRow(x,i,'alb:'+id)).join('')}</div>
    ${a.live ? `${YT_FULL[id] ? `<div class="card set" style="margin-top:14px"><b class="kr">공연 전체 영상이 공식 채널에 올라와 있어요</b><p class="tiny" style="margin:6px 0 10px">목록에서 YouTube 표시가 없는 곡은 곡 정보 → '공연 전체 영상에서 이 곡 찾기'로 시작·끝 지점을 한 번 맞춰 두면 그 구간만 재생돼요.</p><a class="btn" target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${YT_FULL[id]}">${ic('link')} 공연 전체 영상 (YouTube)</a></div>` : ''}
    <p class="tiny" style="margin-top:14px">${a.readings && a.readings.length ? `목록에서 뺀 낭독·연출 파트: ${a.readings.map(esc).join(' · ')}<br>` : ''}공식 영상 작품의 수록곡 기준입니다. 공식 라이브 영상이 있는 곡은 YouTube로 재생되고, 직접 소장한 영상에서 뽑은 음원 파일도 연결할 수 있어요(파일 이름에 'live'와 공연 이름이 있으면 자동 연결). 가사가 없으면 원곡 가사가 보여요.</p>` : ''}`;
}
function vFavs(){ const ids = ctxList('favs');
  return `<h1 class="page">좋아요</h1><p class="page-sub">お気に入り · ${ids.length}곡</p>${ids.length?`<div class="acts" style="margin-bottom:16px"><button class="btn pri" data-play="favs">${ic('play')} 재생</button></div><div class="card tl">${ids.map((x,i)=>trackRow(x,i,'favs')).join('')}</div>`:'<div class="empty card">♡ 를 눌러 좋아하는 곡을 모아 보세요.</div>'}`; }
function vPlaylists(){
  return `<h1 class="page">플레이리스트</h1><p class="page-sub">プレイリスト</p>
  <div class="pls"><div class="card pl" data-go="#/favs"><div class="cov" style="display:grid;place-items:center;grid-template-columns:1fr;background:linear-gradient(135deg,#f3c9d1,#c9d8f3)"><span style="color:#fff">${ic('heartF')}</span></div><div class="nm">좋아요</div><div class="tiny">${state.favs.size}곡</div></div>
  ${state.playlists.map(p=>`<div class="card pl" data-go="#/playlist/${p.id}"><div class="cov">${[...new Set(p.songs.map(s=>SONGS[s]?.album).filter(Boolean))].slice(0,4).concat(Array(4).fill(null)).slice(0,4).map(a=>`<div>${a?art(a):''}</div>`).join('')}</div><div class="nm">${esc(p.name)}</div><div class="tiny">${p.songs.length}곡</div></div>`).join('')}
  <button class="card pl newpl" data-act="newpl"><div>${ic('plus')}<br>새 플레이리스트</div></button></div>`;
}
function vPlaylist(id){
  const p = state.playlists.find(x=>x.id===id); if(!p) return vPlaylists();
  return `<div style="display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap;margin-bottom:20px"><div><div class="tiny">PLAYLIST</div><h1 class="page">${esc(p.name)}</h1><p class="page-sub" style="margin:0">${p.songs.length}곡</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap"><button class="btn pri" data-play="pl:${id}">${ic('play')} 재생</button><button class="btn" data-play="pl:${id}" data-shuf="1">${ic('shuf')}</button><button class="btn" data-act="renpl" data-pl="${id}">${ic('edit')} 이름</button><button class="btn" data-act="delpl" data-pl="${id}">${ic('trash')} 삭제</button></div></div>
  ${p.songs.length?`<div class="card tl">${p.songs.map((x,i)=>trackRow(x,i,'pl:'+id)).join('')}</div>`:'<div class="empty card">앨범이나 곡 옆의 ＋ 버튼으로 곡을 담아 보세요.</div>'}`;
}
function searchIds(q){ q = norm(q); if(!q) return []; return ORDER.filter(id=>{const s=SONGS[id]; return norm(s.jp).includes(q)||norm(s.kr).includes(q)||norm(ALB[s.album].kr).includes(q)||norm(ALB[s.album].jp).includes(q)||norm((state.lyrics[id]||{}).jp||'').includes(q)||norm((state.lyrics[id]||{}).kr||'').includes(q);}); }
function vSearch(q=''){
  const ids = searchIds(q);
  return `<h1 class="page">검색</h1><p class="page-sub">検索 · 제목(한/일), 앨범, 저장한 가사까지</p>
  <div class="search">${ic('search')}<input id="q" value="${esc(q)}" placeholder="예: 봄 도둑, 春泥棒, 엘마…"></div>
  <div id="sres">${q?(ids.length?`<div class="card tl">${ids.map((x,i)=>trackRow(x,i,'search')).join('')}</div>`:'<div class="empty">찾는 곡이 없어요.</div>'):''}</div>`;
}
function vStory(){
  const S = STORY;
  return `<h1 class="page">이야기와 세계관</h1><p class="page-sub">物語と世界観</p>
  <div class="card story-intro"><h2 class="kr" style="margin:0 0 12px">${S.intro.title}</h2>${S.intro.body.map(p=>`<p>${p}</p>`).join('')}</div>
  <div class="sec-t"><h2>이야기 지도</h2><span>年表</span></div>
  <div class="timeline">${S.arcs.map(a=>`<div class="arc" id="${a.id}"><div class="card"><div class="era">${a.era}</div><h3>${a.title}</h3><div class="bd">${a.body}</div>${a.note?`<div class="nt">✎ ${a.note}</div>`:''}
    <div class="als">${DEEP[a.id]?`<a class="btn pri" href="#/read/${a.id}">${ic('book')} 자세히 읽기</a>`:''}${a.albums.map(x=>`<div class="mini-alb" data-go="#/album/${x}"><div class="art">${art(x)}</div>${esc(ALB[x].kr)}</div>`).join('')}</div></div></div>`).join('')}</div>
  <div class="sec-t"><h2>인물</h2><span>登場人物</span></div>
  <div class="chars">${S.characters.map(c=>`<div class="card char"><div class="jp">${c.jp}</div><div class="nm">${c.name}</div><div class="rl">${c.role}</div><div class="ds">${c.desc}</div></div>`).join('')}</div>
  <div class="sec-t"><h2>모티프 사전</h2><span>モチーフ</span></div>
  <div class="motifs">${S.motifs.map(m=>`<div class="card motif"><div class="kj">${m[1].length>2?m[1].slice(0,2):m[1]}</div><div><b>${m[0]}</b> <span class="tiny jp">${m[1]}</span><p>${m[2]}</p></div></div>`).join('')}</div>
  <div class="sec-t"><h2>문학 레퍼런스</h2><span>引用と本歌</span></div><div class="legend" style="margin:-4px 0 12px">${Object.entries(TAGS).map(([k,v])=>`<span><i class="tag ${k}">${v[0]}</i>${v[1]}</span>`).join('')}</div>
  <div class="card"><table class="ref">${S.references.map(r=>`<tr><td>${r[0]}</td><td class="kr">${r[1]}</td><td class="kr muted">${r[2]}</td><td style="text-align:right">${r[3]?`<i class="tag ${r[3]}">${TAGS[r[3]][0]}</i>`:''}</td></tr>`).join('')}</table></div>
  <div class="sec-t"><h2>라이브 연표</h2><span>ライブ</span></div>
  <div class="card lives">${S.lives.map(l=>`<div class="live"><div class="yr">${l[0]}</div><div>${l[1]}${l[2]?` <span class="tiny">· ${l[2]}</span>`:''}</div></div>`).join('')}</div>
  <div style="margin-top:14px">${verCard()}</div>
  <p class="tiny" style="margin-top:24px">줄거리 요약은 공개된 정보를 바탕으로 직접 정리한 것이며, 해석이 갈리는 부분은 표시해 두었습니다.</p>`;
}
function vSettings(){
  const nAud = state.hasAudio.size, nLy = Object.values(state.lyrics).filter(l=>l.jp||l.kr).length;
  return `<h1 class="page">설정</h1><p class="page-sub">設定</p>
  <div class="card set"><h3>테마</h3><p>자동은 저녁 7시부터 아침 6시까지 밤 테마로 바뀝니다.</p>
    <div class="seg" id="themeSeg">${['auto','day','night'].map(t=>`<button data-theme-set="${t}" class="${state.theme===t?'on':''}">${{auto:'자동',day:'낮 · 昼',night:'밤 · 夜'}[t]}</button>`).join('')}</div></div>
  ${(()=>{ const c = COV; const m = coverMode(); return `<div class="card set"><h3>앨범 커버</h3><p>공식 커버는 Apple Music 공개 카탈로그의 앨범 이미지를 불러와 보여 줘요(인터넷이 필요하고, 한 번 본 이미지는 기기에 남아요). 라이브 영상 작품은 카탈로그에 없어서 앱 일러스트로 보여요.</p>
    <div class="seg">${[['official','공식 커버'],['art','앱 일러스트']].map(([k,l])=>`<button data-cover="${k}" class="${m===k?'on':''}">${l}</button>`).join('')}</div>
    <div class="upd-row" style="margin-top:12px"><button class="btn sm" data-act="covers">${ic('rep')} 커버 다시 불러오기</button><span class="tiny">${c.at ? `${c.n||0}장 · ${new Date(c.at).toLocaleDateString('ko-KR')}` : '아직 불러오지 않음'}</span></div></div>`; })()}
  ${(()=>{ const ex = getExtra(); const perm = ('Notification' in window) ? Notification.permission : 'unsupported'; const when = ex.lastCheck ? new Date(ex.lastCheck).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '아직 없음';
    return `<div class="card set"><h3>신곡 · 새 앨범 자동 추가</h3><p>앱을 열 때마다(6시간에 한 번) Apple Music과 MusicBrainz의 공개 정보를 확인해서, ${UPD_CFG.since.replace(/-/g,'.')} 이후 새로 나온 곡과 앨범을 목록에 넣습니다. 새 곡은 NEW 표시와 함께 들어오고, 한국어 제목은 자동 번역(MyMemory)으로 먼저 붙고 '자동 번역' 표시가 달려요. 마음에 안 들면 곡 정보에서 고치면 됩니다.</p>
      <div class="upd-row"><button class="btn pri" data-act="chkupd">${ic('rep')} 지금 확인</button>
      <button class="btn" data-act="mtall">번역 전 제목 자동 번역</button>
      ${(()=>{ const on = NATIVE ? (()=>{ try{ return YoruNative.notifyAllowed(); }catch(e){ return false; } })() : perm==='granted'; return `<button class="btn" data-act="alerts" ${on?'disabled':''}>${ic('clock')} ${on ? (NATIVE || LS.get('bgSync',false) ? '알림 켜짐 · 백그라운드 확인 중' : '알림 켜짐') : '새 발매 알림 받기'}</button>`; })()}</div>
      <div class="tiny" id="updSt" style="margin-top:10px">마지막 확인: ${when}${ex.lastSrc?` · ${ex.lastSrc}`:''}${ex.lastErr?` · ${ex.lastErr} (미리보기 화면에서는 외부 연결이 막혀 있어요. 설치한 앱에서 동작해요)`:''}</div>
      ${ex.log.length?`<div class="upd-log">${ex.log.map(l=>`<div><b class="mono">${l.d}</b> ${l.items.map(esc).join(' · ')}</div>`).join('')}</div>`:''}</div>`; })()}
  ${NATIVE ? `<div class="card set"><h3>앱 버전</h3><p>안드로이드 앱 v${esc(appVer())}${LS.get('apkLatest','') && LS.get('apkLatest','') !== 'v'+appVer() ? ` · <b>새 버전 ${esc(LS.get('apkLatest',''))}이 나왔어요</b>` : ''}. 새 버전은 아래 페이지에서 APK를 받아 그대로 설치하면 되고, 저장한 음원·가사·플레이리스트는 유지돼요.</p><a class="btn" href="${APK_PAGE}" target="_blank" rel="noopener">${ic('link')} 최신 APK 받기</a></div>` : `<div class="card set"><h3>안드로이드 앱</h3><p>앱을 밀어 꺼도 끊기지 않는 안드로이드 앱(APK) 버전이 있어요. 휴대폰에서 아래 페이지를 열어 최신 APK를 받으면 됩니다.</p><a class="btn" href="${APK_PAGE}" target="_blank" rel="noopener">${ic('link')} APK 받기</a></div>`}
  <div class="card set"><h3>잠금화면 · 백그라운드 · 버즈</h3><p>곡을 틀면 알림창과 잠금화면에 제목·앨범 아트·재생 버튼이 뜹니다. 홈 버튼을 누르거나 화면을 꺼도, 다른 앱을 써도 계속 재생돼요. 앱을 다시 열면 마지막에 듣던 곡과 위치가 그대로 이어집니다.</p>
    <table class="ref keys"><tr><td>버즈 한 번 탭</td><td class="kr">재생 / 일시정지</td></tr><tr><td>두 번 탭</td><td class="kr">다음 곡</td></tr><tr><td>세 번 탭</td><td class="kr">이전 곡 (3초 이후면 처음부터)</td></tr><tr><td>PC 키보드</td><td class="kr">Space 재생 · Shift+→/← 다음/이전 · 미디어 키</td></tr></table>
    <p class="tiny" style="margin:12px 0 0">${NATIVE ? '안드로이드 앱 버전이라 최근 앱 목록에서 밀어 꺼도 재생이 이어집니다. 멈춘 상태에서 버즈를 누르면 마지막 곡부터 다시 재생돼요. 오래 들을 땐 휴대폰 설정 → 애플리케이션 → 이 앱 → 배터리를 \'제한 없음\'으로 두면 더 안정적이에요.' : '최근 앱 목록에서 위로 밀어 앱을 완전히 종료하면 브라우저 기반 앱이라 재생도 멈춥니다. 안드로이드 앱(APK) 버전은 밀어 꺼도 계속 재생돼요.'}</p></div>
  ${(()=>{ const st = ORDER.filter(x=>!SONGS[x].live); const k = st.map(x=>ytOf(x)?.kind || ''); const c = t => k.filter(x=>x===t).length;
    return `<div class="card set"><h3>YouTube 공식 영상으로 듣기</h3><p>음원 파일이 없는 곡은 요루시카 공식 YouTube 채널의 영상으로 재생돼요. 재생 화면을 열면 앨범 아트 자리에 영상이 나오고, 닫으면 오른쪽 아래 작은 창에서 이어집니다. MV가 없는 수록곡은 레이블이 올린 공식 음원(Provided to YouTube)이나 공식 앨범 재생목록으로 채웠어요.</p>
    <div class="upd-row"><span class="chip">공식 영상·음원 ${c('mv')}곡</span><span class="chip">앨범 재생목록 ${c('list')}곡</span><span class="chip">직접 연결 ${c('user')}곡</span><span class="chip">연결 없음 ${c('')}곡</span><span class="chip">라이브 ${ORDER.filter(x=>SONGS[x].live && ytOf(x)).length}곡</span><button class="btn sm" data-act="ytside">작은 창 위치 바꾸기</button></div>
    <p class="tiny" style="margin:12px 0 0">· 화면을 끄거나 앱을 나가면 멈춰요. YouTube 정책상 백그라운드 재생이 안 되고, 잠금화면·버즈 조작도 음원 파일로 들을 때만 돼요.<br>· 영상이 없는 곡은 곡 정보 → 'YouTube 링크 직접 연결'에 주소를 붙여 넣으면 돼요. 공연 전체 영상이 있는 라이브는 '공연 전체 영상에서 이 곡 찾기'로 구간을 맞출 수 있어요.<br>· claude.ai 미리보기 화면에서는 YouTube가 막혀 있어요. 설치한 앱이나 웹 주소에서 열면 동작합니다.</p></div>`; })()}
  ${(()=>{ if (!NATIVE) return `<div class="card set"><h3>스트리밍 앱 연동</h3><p>Spotify·YouTube Music으로 재생하고, 그 앱에서 듣는 곡의 가사·이야기를 이 앱에서 따라 보여 주는 기능이에요. 다른 앱의 재생 정보를 읽어야 해서 안드로이드 앱(APK)에서만 쓸 수 있어요.</p></div>`;
    let apps = []; try{ apps = JSON.parse(YoruNative.extApps()); }catch(e){}
    const acc = !!extInfo.access, pref = LS.get('srcPref','yt'), fol = LS.get('extFollow', true), cur0 = extPkg();
    return `<div class="card set" id="extCard"><h3>스트리밍 앱 연동</h3><p>음원 파일이 없는 곡을 Spotify·YouTube Music 같은 앱으로 재생하고, 그 앱에서 듣는 요루시카 곡의 가사와 이야기를 여기서 따라 보여 줘요. 소리는 그 앱이 내기 때문에 화면을 꺼도, 앱을 나가도 계속 재생되고 잠금화면·버즈 조작도 그 앱 그대로 돼요.</p>
    <div class="upd-row">${acc ? '<span class="chip">알림 접근 허용됨 ✓</span>' : `<button class="btn pri" data-act="extperm">${ic('clock')} 알림 접근 권한 켜기</button>`}
      ${apps.length ? apps.map(a=>`<button class="btn sm ${a.pkg===cur0?'pri':''}" data-act="extapp" data-pkg="${esc(a.pkg)}">${esc(a.label)}${a.pkg===cur0?' ✓':''}</button>`).join('') : '<span class="tiny">Spotify나 YouTube Music이 설치돼 있지 않아요</span>'}
      ${apps.some(a=>a.pkg===cur0) ? `<button class="btn sm" data-act="extopen">${ic('link')} ${esc(extName())} 열기</button>` : ''}</div>
    <div class="tiny" style="margin:14px 0 6px">음원 파일이 없는 곡은</div>
    <div class="seg">${[['ext','연동 앱으로 재생'],['yt','YouTube 공식 영상으로']].map(([k,l])=>`<button data-srcpref="${k}" class="${pref===k?'on':''}">${l}</button>`).join('')}</div>
    <div class="upd-row" style="margin-top:12px"><button class="btn sm" data-act="extfollow">${fol?'✓ ':''}연동 앱에서 듣는 요루시카 곡 따라가기 ${fol?'켬':'끔'}</button></div>
    ${acc && extInfo.title ? `<div class="tiny" style="margin-top:10px">지금 ${esc(extInfo.app||'')}: ${esc(extInfo.title)}${extInfo.artist?' · '+esc(extInfo.artist):''}${extMatch(extInfo.title, extInfo.artist, extInfo.album)?' — 이 앱의 곡과 연결됨 ✓':''}</div>` : ''}
    <p class="tiny" style="margin:12px 0 0">· 알림 접근 권한은 '지금 재생 중인 곡'을 읽고 재생 명령을 보내는 데만 써요. 알림 내용은 읽거나 저장하지 않아요.<br>· Spotify 무료는 곡을 골라 듣는 시간이 하루 단위로 제한되고 광고가 나와요. YouTube Music은 Premium이어야 백그라운드 재생이 돼요.<br>· 라이브 영상 작품과 幻燈 화집 전용곡은 스트리밍 음원이 없어 YouTube 공식 영상으로 재생해요.<br>· 연동 앱이 꺼져 있으면 첫 곡은 그 앱이 열리면서 시작될 수 있어요. 그다음부터는 이 앱에서 누르는 대로 바로 바뀌어요.</p></div>`; })()}
  <div class="card set"><h3>음원 가져오기</h3><p>갖고 있는 음원 파일(mp3, m4a, flac 등)을 고르면 파일 이름으로 곡을 자동 연결합니다. 파일은 이 기기 안에만 저장됩니다. 연결 안 된 파일은 곡 화면의 '음원 연결'로 직접 지정할 수 있어요.</p>
    <label class="btn pri">${ic('music')} 파일 고르기<input type="file" id="audIn" accept="audio/*" multiple hidden></label> <span class="tiny">현재 ${nAud}곡 연결됨</span><div class="prog" id="audProg" style="display:none"><i></i></div><div id="audRes" class="tiny" style="margin-top:8px">${lastImport}</div></div>
  <div class="card set"><h3>가사</h3><p>가사는 곡 화면 → '가사 편집'에서 일본어 원문과 한국어 번역을 붙여 넣어 저장합니다. 줄 단위로 짝지어 보여 줍니다. 현재 ${nLy}곡 저장됨.</p>
    <a class="btn" href="https://yorushika.com/" target="_blank" rel="noopener">${ic('link')} 요루시카 공식 사이트</a></div>
  <div class="card set"><h3>백업 · 복원</h3><p>가사, 플레이리스트, 좋아요를 JSON 파일 하나로 내보내고, 다른 기기(PC ↔ 폰)에서 불러올 수 있습니다. 음원은 포함되지 않습니다.</p>
    <button class="btn" data-act="export">${ic('down')} 내보내기</button> <label class="btn">${ic('file')} 불러오기<input type="file" id="impIn" accept="application/json,.json" hidden></label></div>
  <div class="card set"><h3>초기화</h3><p>이 기기에 저장된 음원을 모두 지웁니다. 되돌릴 수 없어요.</p><button class="btn" data-act="clearaud">${ic('trash')} 음원 모두 지우기</button></div>
  <p class="tiny">요루시카 팬이 개인적으로 쓰기 위해 만든 비공식 앱입니다. 곡·앨범·이야기의 권리는 요루시카와 각 권리자에게 있습니다.</p>`;
}

function sidOf(a, jp){ const al = ALB[a]; const i = al.tracks.findIndex(t => t[0]===jp); return a+'-'+(i+1); }
let readOrder = 'album';
function relSvg(rel){
  const N = Object.fromEntries(rel.nodes.map(n=>[n.id,n])); let g = '';
  rel.edges.forEach(([f,t,l,c]) => {
    const A = N[f], B = N[t]; const mx = (A.x+B.x)/2, my = (A.y+B.y)/2; const dx = B.x-A.x, dy = B.y-A.y, L = Math.hypot(dx,dy);
    const cx = mx - dy/L*c*2, cy = my + dx/L*c*2; const lx = (A.x+2*cx+B.x)/4, ly = (A.y+2*cy+B.y)/4;
    g += `<path d="M${A.x} ${A.y} Q${cx} ${cy} ${B.x} ${B.y}" fill="none" stroke="var(--ink3)" stroke-width="1.4" ${l?'marker-end="url(#ar)"':'stroke-dasharray="3 4"'}/>`;
    if (l){ const w = l.length*12.5+18; g += `<rect x="${lx-w/2}" y="${ly-12}" width="${w}" height="24" rx="12" fill="var(--paper)" stroke="var(--line)"/><text x="${lx}" y="${ly+4.5}" text-anchor="middle" font-size="12.5" fill="var(--ink2)" font-family="Gowun Batang,serif">${esc(l)}</text>`; }
  });
  rel.nodes.forEach(n => { g += `<circle cx="${n.x}" cy="${n.y}" r="26" fill="var(--paper)" stroke="var(--accent)" stroke-width="2"/><text x="${n.x}" y="${n.y+6}" text-anchor="middle" font-size="17" font-weight="800" fill="var(--accent)" font-family="Shippori Mincho,serif">${esc(n.l[0])}</text>
    <text x="${n.x}" y="${n.y+46}" text-anchor="middle" font-size="15" font-weight="700" fill="var(--ink)" font-family="Gowun Batang,serif">${esc(n.l)}</text><text x="${n.x}" y="${n.y+63}" text-anchor="middle" font-size="11.5" fill="var(--ink3)" font-family="Gowun Batang,serif">${esc(n.s)}</text>`; });
  const list = rel.edges.filter(e=>e[4]).map(([f,t,,,d])=>`<li><b>${esc(N[f].l)}${N[t]?' → '+esc(N[t].l):''}</b> ${esc(d)}</li>`).join('');
  return `<svg viewBox="0 0 360 290" class="rel" role="img" aria-label="인물 관계도"><defs><marker id="ar" viewBox="0 0 10 10" refX="36" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="var(--ink3)"/></marker></defs>${g}</svg><ul class="rel-l">${list}</ul>`;
}
function songChip(a, jp){ const id = sidOf(a, jp), s = SONGS[id]; return `<button class="schip" data-chip="${id}">${ic(playable(id)?'play':'music')}<span class="kr">${esc(s.kr)}</span><span class="jp">${esc(s.jp)}</span></button>`; }
function vRead(id){
  const arc = STORY.arcs.find(a=>a.id===id), D = DEEP[id]; if (!arc || !D) return vStory();
  const k = STORY.arcs.indexOf(arc), pv = STORY.arcs[k-1], nx = STORY.arcs[k+1];
  setAccent(ALB[arc.albums[arc.albums.length-1]].hue);
  const num = '一二三四五六七八九十';
  const order = D.order ? `<div class="card side-card"><div class="side-t">순서 바꿔 보기</div><div class="seg" style="margin-bottom:12px">${[['album',D.order.album],['life',D.order.life]].map(o=>`<button data-ro="${o[0]}" class="${readOrder===o[0]?'on':''}">${o[1]}</button>`).join('')}</div>
    <ol class="olist">${(readOrder==='life' ? D.order.lifeIds : ALB[arc.albums[0]].tracks.map(t=>[arc.albums[0],t[0]])).map(([a,j])=>{ const s = SONGS[sidOf(a,j)]; const hit = D.order.lifeIds.some(x=>x[1]===j); return `<li class="${hit?'hit':''}" data-chip="${s.id}"><span class="kr">${esc(s.kr)}</span> <span class="jp tiny">${esc(s.jp)}</span></li>`; }).join('')}</ol>
    <p class="tiny" style="margin:10px 0 0">${D.order.note}</p></div>` : '';
  return `<a class="back" href="#/story">← 이야기 지도</a>
  <header class="rhead"><div class="era jp">${arc.era}</div><h1 class="page">${arc.title}</h1><p class="lead kr">${D.lead}</p>
    <div class="als">${arc.albums.map(x=>`<div class="mini-alb" data-go="#/album/${x}"><div class="art">${art(x)}</div>${esc(ALB[x].kr)}</div>`).join('')}</div>
    <div class="legend">${Object.entries(TAGS).map(([k,v])=>`<span><i class="tag ${k}">${v[0]}</i>${v[1]}</span>`).join('')}</div></header>
  <div class="rgrid"><div class="scenes">${D.scenes.map((sc,i)=>`<article class="scene card" id="sc-${id}-${i}"><div class="sn jp"><small>第</small>${num[i]||i+1}</div><div class="sb"><div class="st"><h3 class="kr">${esc(sc.t)}</h3><i class="tag ${sc.tag}">${TAGS[sc.tag][0]}</i></div><p class="kr">${sc.x}</p>${sc.songs.length?`<div class="chips">${sc.songs.map(([a,j])=>songChip(a,j)).join('')}</div>`:''}</div></article>`).join('')}</div>
    <aside class="raside">${D.rel?`<div class="card side-card"><div class="side-t">인물 관계</div>${relSvg(D.rel)}</div>`:''}${order}
      <div class="card side-card"><div class="side-t">손에 쥘 수 있는 이야기</div>${D.props.map(p=>`<div class="prop"><b class="kr">${esc(p[0])}</b><span class="kr">${esc(p[1])}</span></div>`).join('')}</div></aside></div>
  <nav class="rnav">${pv?`<a class="card" href="#/read/${pv.id}"><span class="tiny">← 이전 이야기</span><b class="kr">${pv.title}</b></a>`:'<span></span>'}${nx?`<a class="card" href="#/read/${nx.id}" style="text-align:right"><span class="tiny">다음 이야기 →</span><b class="kr">${nx.title}</b></a>`:''}</nav>
  <p class="tiny" style="margin-top:20px">줄거리는 공개된 설명·인터뷰·평론을 바탕으로 직접 요약했고, 가사나 소설 원문은 옮기지 않았습니다.</p>`;
}

/* =================== 지금 재생 =================== */
let npSong = null;
state.lyrSize = LS.get('lyrSize', 1); state.imm = false;
function lyrOf(id){
  let L = state.lyrics[id] || {}; let borrowed = null;
  const o = SONGS[id]?.orig; if (o && !L.jp && !L.kr){ const OL = state.lyrics[o]; if (OL && (OL.jp || OL.kr)){ L = { jp:OL.jp, kr:OL.kr, times:L.times, offset:L.offset }; borrowed = o; } }
  const jp = (L.jp||'').replace(/\r/g,'').split('\n'), kr = (L.kr||'').replace(/\r/g,'').split('\n');
  const n = Math.max(L.jp ? jp.length : 0, L.kr ? kr.length : 0);
  return { L, jp, kr, n, times: L.times || [], off: L.offset || 0, borrowed };
}
const hasSync = id => (state.lyrics[id]?.times || []).some(t => t != null);
const nextNB = (jp, i) => { for (let j=Math.max(0,i); j<jp.length; j++) if ((jp[j]||'').trim()) return j; return -1; };
const prevNB = (jp, i) => { for (let j=Math.min(i, jp.length-1); j>=0; j--) if ((jp[j]||'').trim()) return j; return -1; };
const fmt2 = t => t==null ? '—' : String(Math.floor(t/60)).padStart(2,'0')+':'+(t%60).toFixed(2).padStart(5,'0');
function scenesOf(id){
  const s = SONGS[id], out = [];
  for (const k in DEEP) DEEP[k].scenes.forEach((sc, i) => { if (sc.songs.some(([a,j]) => a===s.album && j===s.jp)) out.push({arc:k, i, t:sc.t}); });
  return out;
}

function openNP(id){ npSong = id || cur(); if(!npSong) return; renderNP(); $('#np').classList.add('open'); posYT(); }
function closeNP(){ $('#np').classList.remove('open'); posYT(); }
function renderNP(){
  const s = SONGS[npSong]; if(!s) return; const a = ALB[s.album]; const isCur = cur()===npSong;
  const np = $('#np'); np.classList.toggle('imm', state.imm); np.style.setProperty('--ls', state.lyrSize);
  np.style.setProperty('--accent', accentFor(a.hue)); if (state.imm) np.scrollTop = 0;
  const tabs = [['lyr','가사'],['sync','싱크'],['info','정보'],['edit','가사 편집']];
  np.innerHTML = `<div class="bg">${art(s.album)}</div>${state.imm?'':`<button class="ibtn close-np" data-act="closenp" title="닫기">${ic('down',2)}</button>`}
  <div class="lft"><div class="bigart">${art(s.album,1)}</div>
    <div class="ttl"><div class="k">${esc(s.kr)}</div><div class="j">${esc(s.jp)}</div><div class="a" data-go="#/album/${a.id}">${esc(a.kr)} · ${esc(a.jp)}</div></div>
    ${isCur?`<div class="ctr"><div class="seek"><span id="npCur">0:00</span><input type="range" id="npSeek" min="0" max="1000" value="0"><span id="npDur">0:00</span></div>
      <div class="b"><button class="ibtn" data-act="shuf" style="${state.shuffle?'color:var(--accent)':''}">${ic('shuf')}</button><button class="ibtn" data-act="prev">${ic('prev')}</button><button class="play" data-act="toggle" id="npPlay">${ic(audio.paused?'play':'pause')}</button><button class="ibtn" data-act="next">${ic('next')}</button><button class="ibtn" data-act="rep" style="${state.repeat!=='off'?'color:var(--accent)':''}" title="반복: ${state.repeat}">${ic('rep')}${state.repeat==='one'?'<sup style="font-size:9px">1</sup>':''}</button></div></div>`
      :`<button class="btn pri" data-playone="${s.id}">${ic('play')} 이 곡 재생</button>`}
    <div style="display:flex;gap:6px"><button class="ibtn ${state.favs.has(s.id)?'on':''}" data-act="fav" data-id="${s.id}">${ic(state.favs.has(s.id)?'heartF':'heart')}</button><button class="ibtn" data-act="add" data-id="${s.id}">${ic('plus')}</button></div>
  </div>
  <div class="rgt2"><div class="np-top">
    ${state.imm?`<button class="ibtn" data-act="imm" title="몰입 해제">${ic('down',2)}</button>${isCur?`<button class="play sm" data-act="toggle" id="npPlay2">${ic(audio.paused?'play':'pause')}</button>`:''}<div class="imm-t"><b class="kr">${esc(s.kr)}</b> <span class="jp tiny">${esc(s.jp)}</span></div>`
      :`<div class="seg">${tabs.map(t=>`<button data-np="${t[0]}" class="${state.npTab===t[0]?'on':''}">${t[1]}${t[0]==='sync'&&hasSync(s.id)?' ●':''}</button>`).join('')}</div>`}
    ${state.npTab==='lyr'||state.imm?`<div class="np-tools"><div class="seg">${[['pair','함께'],['side','나란히'],['jp','日'],['kr','한'],['focus','집중']].map(t=>`<button data-lm="${t[0]}" class="${state.lyrMode===t[0]?'on':''}">${t[1]}</button>`).join('')}</div>
      <button class="ibtn" data-act="lsz" data-d="-0.1" title="글자 작게">${ic('aminus')}</button><button class="ibtn" data-act="lsz" data-d="0.1" title="글자 크게">${ic('aplus')}</button>
      ${state.imm?'':`<button class="ibtn" data-act="imm" title="몰입 모드">${ic('expand')}</button>`}</div>`:''}
  </div>
    <div class="np-body">${npBody(s)}</div></div>`;
  syncTime(); lastLi = -2; startTick(true);
  if ($('#focus') && npSong!==cur()) applyHL(-1);
  posYT();
}
/* 라이브 곡 구간 맞추기: 공연 전체 영상에서 이 곡이 시작·끝나는 지점을 저장 */
function segBox(s){
  if (!s.live) return '';
  const y = ytOf(s.id), full = YT_FULL[s.album], playing = cur()===s.id && audio.eng===ytEng && ytEng.cur && ytEng.cur.v;
  if (playing && (full || (y && y.kind !== 'mv'))) return `<div class="segbox"><div class="tiny">구간 맞추기 · 영상 속 위치 <b id="ytRaw" class="mono">${fmtR(ytEng.raw)}</b>${ytEng.off||ytEng.end?` · 지금 구간 ${fmtR(ytEng.off)}–${ytEng.end?fmtR(ytEng.end):'끝'}`:''}</div>
    <div class="upd-row"><button class="btn sm" data-act="segnudge" data-d="-10">−10초</button><button class="btn sm" data-act="segnudge" data-d="-2">−2초</button><button class="btn sm" data-act="segnudge" data-d="2">+2초</button><button class="btn sm" data-act="segnudge" data-d="10">+10초</button>
    <button class="btn sm pri" data-act="segS" data-id="${s.id}">지금을 시작으로</button><button class="btn sm" data-act="segE" data-id="${s.id}">지금을 끝으로</button>${ytSeg[s.id]?`<button class="btn sm" data-act="segX" data-id="${s.id}">맞춘 구간 지우기</button>`:''}</div></div>`;
  if (full && (!y || y.est || y.kind==='pair2')) return `<div style="margin-top:8px"><button class="btn sm" data-act="segfind" data-id="${s.id}">${ic('play')} 공연 전체 영상에서 이 곡 찾기</button></div>`;
  return '';
}
function npBody(s){
  const {L, jp, kr, n, times, off} = lyrOf(s.id);
  const tab = state.imm ? 'lyr' : state.npTab;
  if (tab==='edit') return `<div class="ed"><div><label>日本語 원문</label><textarea class="jpta" id="edJp" placeholder="일본어 가사를 붙여 넣으세요">${esc(L.jp||'')}</textarea></div><div><label>한국어 번역</label><textarea class="krta" id="edKr" placeholder="한국어 번역을 붙여 넣으세요 (줄 수를 원문과 맞추면 짝지어 보여요)">${esc(L.kr||'')}</textarea></div></div>
    <div style="display:flex;gap:10px;margin-top:14px;align-items:center;flex-wrap:wrap"><button class="btn pri" data-act="savely" data-id="${s.id}">저장</button><button class="btn" data-act="lrc" data-id="${s.id}">${ic('clock')} LRC 붙여넣기</button><span class="tiny" id="lnCount"></span></div>
    <p class="tiny" style="margin-top:14px">LRC는 <code>[01:23.45]가사</code> 형식의 시간 붙은 가사입니다. 붙여 넣으면 일본어 원문과 싱크 시간이 한 번에 들어갑니다.</p>`;
  if (tab==='info'){
    const a = ALB[s.album]; const q = encodeURIComponent('ヨルシカ '+baseTitle(s.jp)); const sc = scenesOf(s.id);
    return `<div class="info"><dl><dt>한국어</dt><dd class="kr">${esc(s.kr)} <button class="btn sm" data-act="rensong" data-id="${s.id}">${ic('edit')} 고치기</button> <button class="btn sm" data-act="mtone" data-id="${s.id}">자동 번역</button></dd><dt>일본어</dt><dd class="jp">${esc(s.jp)}</dd><dt>앨범</dt><dd>${esc(a.kr)} <span class="jp muted">${esc(a.jp)}</span></dd><dt>트랙</dt><dd>${s.no} / ${a.tracks.length}${s.inst?' · 연주곡':''}</dd><dt>발매</dt><dd>${a.date}</dd><dt>음원</dt><dd>${state.hasAudio.has(s.id)?'연결됨 ✓':'없음'}</dd>${NATIVE ? `<dt>연동 앱</dt><dd>${streamable(s.id) ? (extOn() ? `${esc(extName())}에서 재생 ✓` : '꺼짐 — 설정 → 스트리밍 앱 연동') : '스트리밍 음원 없음'}${cur()===s.id && audio.eng===extEng && extInfo.title ? `<div class="tiny">지금 ${esc(EXT_APPS[extInfo.pkg]||'')}: ${esc(extInfo.title)}${extInfo.artist?' · '+esc(extInfo.artist):''}</div>` : ''}</dd>` : ''}<dt>YouTube</dt><dd>${ytLabel(ytOf(s.id))}${segBox(s)}${!ytOf(s.id) && !s.live && YT_NOTE[s.album] ? `<div class="tiny">${YT_NOTE[s.album]}</div>` : ''}${cur()===s.id && audio.eng===ytEng ? `<div class="tiny" id="ytNow">${esc(ytEng.title)}</div>` : ''}</dd><dt>가사 싱크</dt><dd>${hasSync(s.id)?`있음 ✓ (${times.filter(t=>t!=null).length}줄)`:'없음'}</dd></dl>
      ${noteOf(s)?`<div class="note">${esc(noteOf(s))}</div>`:''}
      ${(()=>{ const vs = versionsOf(s.id); return vs.length ? `<div class="scn"><div class="tiny" style="margin-bottom:8px">이 곡의 다른 버전</div>${vs.map(x=>`<button class="scn-l" data-chip="${x}"><span class="jp">${SONGS[x].live?'LIVE':SONGS[x].rr?'再':'原'}</span>${esc(ALB[SONGS[x].album].kr)} · ${ALB[SONGS[x].album].date}${state.hasAudio.has(x)?' ▶':''}</button>`).join('')}</div>` : ''; })()}
      ${sc.length?`<div class="scn"><div class="tiny" style="margin-bottom:8px">이 곡이 나오는 이야기</div>${sc.map(x=>`<button class="scn-l" data-go="#/read/${x.arc}#sc-${x.arc}-${x.i}"><span class="jp">${'一二三四五六七八九十'[x.i]||x.i+1}</span>${esc(STORY.arcs.find(a=>a.id===x.arc).title)} · ${esc(x.t)} →</button>`).join('')}</div>`:''}
      <div class="links"><label class="btn">${ic('music')} 음원 연결<input type="file" accept="audio/*" data-link="${s.id}" hidden></label>${state.hasAudio.has(s.id)?`<button class="btn" data-act="unlink" data-id="${s.id}">${ic('trash')} 연결 해제</button>`:''}
        ${(()=>{ const y = ytOf(s.id); return y ? `<a class="btn" target="_blank" rel="noopener" href="${y.v ? 'https://www.youtube.com/watch?v='+y.v : 'https://www.youtube.com/watch?list='+y.list+'&index='+(y.index+1)}">${ic('link')} 공식 영상 열기</a>` : `<a class="btn" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${q}">${ic('link')} YouTube 검색</a>`; })()}
        <button class="btn" data-act="ytlink" data-id="${s.id}">${ic('edit')} YouTube 링크 직접 연결</button>${ytUser[s.id]?`<button class="btn" data-act="ytunlink" data-id="${s.id}">${ic('x')} 직접 연결 해제</button>`:''}<a class="btn" target="_blank" rel="noopener" href="https://open.spotify.com/search/${q}">${ic('link')} Spotify</a></div></div>`;
  }
  if (tab==='sync') return syncBody(s);
  /* 가사 */
  if (s.inst) return `<div class="lyr-empty"><div class="big">〜</div>가사가 없는 연주곡이에요.<br>소리에 귀를 기울여 보세요.</div>`;
  if (!L.jp && !L.kr) return `<div class="lyr-empty"><div class="big">詞</div>${s.orig?`원곡 「${esc(ALB[SONGS[s.orig].album].kr)}」에도 아직 가사가 없어요.<br>원곡에 가사를 넣으면 이 버전에도 함께 보여요.<br><br>`:''}아직 저장된 가사가 없어요.<br>'가사 편집'에 일본어 원문과 한국어 번역을 붙여 넣으면<br>여기서 두 언어를 함께 볼 수 있어요.<br><br><button class="btn" data-np="edit">${ic('edit')} 가사 편집하기</button></div>`;
  const synced = hasSync(s.id); const mode = state.lyrMode; const live = synced && cur()===s.id;
  const bor = lyrOf(s.id).borrowed; const borNote = bor ? `<div class="sync-bar" style="background:none;border:1px dashed var(--line)">${ic('book')} 원곡 「${esc(ALB[SONGS[bor].album].kr)}」의 가사를 보여 주고 있어요${s.live?' · 라이브 편곡과 다를 수 있어요':''}</div>` : '';
  const bar = synced ? `<div class="sync-bar"><span class="live-dot ${live?'on':''}"></span><span class="sb-t">${live?'재생에 맞춰 넘어가요 · 줄을 누르면 그 위치로':'싱크 가사 · 이 곡을 재생하면 따라 넘어가요'}</span><span class="tiny" style="white-space:nowrap">보정</span><button class="ibtn sm" data-act="off" data-d="-0.1">−</button><b id="offv" class="tiny" style="min-width:42px;text-align:center">${(off>0?'+':'')+off.toFixed(1)}s</b><button class="ibtn sm" data-act="off" data-d="0.1">+</button></div>`
    : `<div class="sync-bar">${ic('clock')} 싱크가 없어요<button class="btn sm" data-np="sync" style="margin-left:auto">싱크 만들기</button></div>`;
  if (mode==='focus'){
    if (!synced) return bar + `<div class="lyr-empty">집중 모드는 싱크 가사가 있을 때 앞뒤 줄을 크게 보여 줘요.<br>'싱크' 탭에서 탭 몇 번이면 만들 수 있어요.</div>`;
    return borNote + bar + `<div class="focus" id="focus"><div class="fp"></div><div class="fc"></div><div class="fn"></div><div class="fn2"></div></div>`;
  }
  let h = '';
  for (let i=0;i<n;i++){
    const a = (jp[i]||'').trim(), b = (kr[i]||'').trim(); const d = `data-li="${i}"`;
    if (!a && !b){ h += mode==='side' ? '<div class="gap"></div><div class="gap"></div>' : '<div class="gap"></div>'; continue; }
    if (mode==='jp'){ if(a) h += `<div class="ln"><div class="ljp" ${d}>${esc(a)}</div></div>`; continue; }
    if (mode==='kr'){ if(b) h += `<div class="ln"><div class="lkr" ${d}>${esc(b)}</div></div>`; continue; }
    h += `<div class="ln"><div class="ljp" ${d}>${esc(a)||'&nbsp;'}</div><div class="lkr" ${d}>${esc(b)||'&nbsp;'}</div></div>`;
  }
  return borNote + bar + `<div class="lyr ${mode==='side'?'side':''} ${mode==='kr'?'only-kr':''} ${synced?'synced':''}">${h}<div style="height:30vh"></div></div>`;
}

/* ---- 가사 싱크: 하이라이트 ---- */
let lastLi = -2, userScrollT = 0, rafOn = false;
function curLineIdx(id){ const {times, off} = lyrOf(id); const t = audio.currentTime + off; let k = -1; for (let i=0;i<times.length;i++) if (times[i]!=null && times[i] <= t) k = i; return k; }
function applyHL(k){
  const {jp, kr} = lyrOf(npSong);
  const box = $('.lyr.synced');
  if (box){
    box.querySelectorAll('.cur,.near,.past').forEach(e => e.classList.remove('cur','near','past'));
    box.querySelectorAll('[data-li]').forEach(e => { if (+e.dataset.li < k) e.classList.add('past'); });
    box.querySelectorAll(`[data-li="${k}"]`).forEach(e => e.classList.add('cur'));
    const nx = nextNB(jp, k+1); if (nx>=0) box.querySelectorAll(`[data-li="${nx}"]`).forEach(e => e.classList.add('near'));
    const el = box.querySelector(`[data-li="${k}"]`) || (k<0 ? null : null);
    if (el && Date.now() > userScrollT){ const body = el.closest('.np-body'); const r = el.getBoundingClientRect(), br = body.getBoundingClientRect();
      if (body.scrollHeight > body.clientHeight + 4) body.scrollTo({top: body.scrollTop + (r.top - br.top) - body.clientHeight*0.36, behavior:'smooth'});
      else el.scrollIntoView({block:'center', behavior:'smooth'}); }
  }
  const f = $('#focus');
  if (f){
    const line = i => i<0 ? '' : `<div class="ljp">${esc(jp[i]||'')}</div><div class="lkr">${esc(kr[i]||'')}</div>`;
    const p = k>=0 ? prevNB(jp, k-1) : -1, n1 = nextNB(jp, k+1), n2 = n1>=0 ? nextNB(jp, n1+1) : -1;
    f.querySelector('.fp').innerHTML = line(p);
    const fc = f.querySelector('.fc'); fc.innerHTML = k>=0 && (jp[k]||'').trim() ? line(k) : '<div class="ljp" style="opacity:.5">♪</div>';
    fc.classList.remove('swap'); void fc.offsetWidth; fc.classList.add('swap');
    f.querySelector('.fn').innerHTML = line(n1); f.querySelector('.fn2').innerHTML = line(n2);
  }
}
function lyrTick(){
  rafOn = false;
  if (!$('#np').classList.contains('open')) return;
  const tab = state.imm ? 'lyr' : state.npTab;
  if (npSong===cur() && tab==='lyr' && hasSync(npSong)){ const k = curLineIdx(npSong); if (k!==lastLi){ lastLi = k; applyHL(k); } }
  if (tab==='sync'){ const e = $('#syT'); if (e) e.textContent = fmt2(audio.currentTime); }
  if (!audio.paused){ rafOn = true; requestAnimationFrame(lyrTick); }
}
function startTick(force){ if (force) rafOn = false; if (!rafOn){ rafOn = true; requestAnimationFrame(lyrTick); } }
['wheel','touchmove'].forEach(ev => document.addEventListener(ev, e => { if (e.target.closest && e.target.closest('.np-body')) userScrollT = Date.now() + 3500; }, {passive:true}));

/* ---- 가사 싱크: 기록 ---- */
let rec = null; // {id, idx, times, on}
function ensureRec(id){
  const {jp, times} = lyrOf(id);
  if (!rec || rec.id!==id){ const t = jp.map((_, i) => times[i] ?? null); rec = {id, idx: nextNB(jp, 0), times: t, on:false}; }
  return rec;
}
function syncBody(s){
  const {L, jp, kr} = lyrOf(s.id);
  if (s.inst) return `<div class="lyr-empty"><div class="big">〜</div>연주곡은 싱크가 필요 없어요.</div>`;
  if (!(L.jp||'').trim()) return `<div class="lyr-empty"><div class="big">時</div>먼저 '가사 편집'에서 일본어 원문을 넣어 주세요.<br>LRC 파일이 있다면 거기서 한 번에 넣을 수도 있어요.<br><br><button class="btn" data-np="edit">${ic('edit')} 가사 편집</button></div>`;
  if (!state.hasAudio.has(s.id)) return `<div class="lyr-empty"><div class="big">♪</div>싱크를 기록하려면 이 곡의 음원이 필요해요.<br><br><button class="btn" data-np="info">${ic('music')} 음원 연결하기</button></div>`;
  if (cur()!==s.id) return `<div class="lyr-empty"><div class="big">♪</div>이 곡을 재생하면 싱크를 기록할 수 있어요.<br><br><button class="btn pri" data-playone="${s.id}">${ic('play')} 이 곡 재생</button></div>`;
  const r = ensureRec(s.id); const total = jp.filter(x=>x.trim()).length, done = r.times.filter((t,i)=>t!=null && (jp[i]||'').trim()).length;
  const i = r.idx, nx = i>=0 ? nextNB(jp, i+1) : -1;
  return `<div class="sync">
    <div class="sync-head"><span class="live-dot ${r.on?'on rec':''}"></span><b>${r.on?'기록 중':'준비'}</b><span class="tiny">${done}/${total}줄</span><span id="syT" class="mono" style="margin-left:auto">${fmt2(audio.currentTime)}</span></div>
    <div class="sync-card">${i>=0?`<div class="tiny">이번 줄 · 시작하는 순간에 탭</div><div class="ljp">${esc(jp[i])}</div><div class="lkr">${esc(kr[i]||'')}</div>${nx>=0?`<div class="sync-next"><span class="tiny">다음</span> ${esc(jp[nx])}</div>`:''}`:`<div class="ljp">모든 줄을 기록했어요 ✓</div><div class="lkr">저장하거나, 아래 목록에서 다시 찍을 줄을 고르세요.</div>`}</div>
    <button class="tapbtn" data-act="tap" ${i<0?'disabled':''}><span style="letter-spacing:.3em">탭</span> <span class="tiny" style="color:inherit;opacity:.6;letter-spacing:0">Space</span></button>
    <div class="sync-acts"><button class="btn" data-act="recstart">${ic('rep')} 처음부터</button><button class="btn" data-act="undo">↶ 한 줄 취소</button><button class="btn pri" data-act="recsave">저장</button><button class="btn" data-act="lrcout">${ic('clock')} LRC 복사</button><button class="btn" data-act="recclear">${ic('trash')} 시간 지우기</button></div>
    <p class="tiny">노래가 그 줄을 부르기 시작할 때 탭하세요. 반응 속도만큼 0.12초 앞당겨 저장됩니다. 목록의 줄을 누르면 거기서부터 다시 기록해요.</p>
    <div class="sync-list">${jp.map((l,k)=> l.trim() ? `<button class="sl ${k===i?'on':''}" data-from="${k}"><span class="mono">${fmt2(r.times[k])}</span><span class="jp">${esc(l)}</span></button>` : '').join('')}</div>
  </div>`;
}
function reSync(){ const b = $('.np-body'); if (!b) return; b.innerHTML = syncBody(SONGS[npSong]); const on = b.querySelector('.sl.on'), list = b.querySelector('.sync-list'); if (on && list) list.scrollTop = on.offsetTop - list.offsetTop - list.clientHeight/2 + on.clientHeight/2; }
function tap(){
  if (!rec || rec.id!==cur() || rec.idx<0) return; const {jp} = lyrOf(rec.id);
  rec.on = true; rec.times[rec.idx] = Math.max(0, +(audio.currentTime - 0.12).toFixed(2));
  rec.idx = nextNB(jp, rec.idx+1);
  if (rec.idx<0){ rec.on = false; saveRec(); toast('모든 줄 기록 완료 — 저장했어요'); }
  reSync();
}
function undoTap(){
  if (!rec) return; const {jp} = lyrOf(rec.id);
  const from = rec.idx<0 ? jp.length-1 : rec.idx-1; let p = from; while (p>=0 && (rec.times[p]==null || !(jp[p]||'').trim())) p--;
  if (p<0) return; rec.times[p] = null; rec.idx = p; rec.on = true;
  let q = p-1; while (q>=0 && rec.times[q]==null) q--; audio.currentTime = Math.max(0, (q>=0 ? rec.times[q] : 0) - 0.5); audio.play().catch(()=>{});
  reSync();
}
function saveRec(){ const L = state.lyrics[rec.id] || {}; state.lyrics[rec.id] = {...L, times: rec.times.slice()}; LS.set('lyrics', state.lyrics); }
function toLRC(id){ const {jp, times} = lyrOf(id); return jp.map((l,i)=> times[i]!=null ? `[${fmt2(times[i])}]${l}` : (l.trim()? l : '')).join('\n'); }
function parseLRC(txt){
  const out = [];
  txt.replace(/\r/g,'').split('\n').forEach(line => {
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)]; if (!tags.length) return;
    const text = line.replace(/\[[^\]]*\]/g,'').trim();
    tags.forEach(m => out.push({t: +m[1]*60 + parseFloat(m[2].replace(':','.')), text}));
  });
  return out.sort((a,b)=>a.t-b.t);
}
function lrcModal(id){
  modal(`<h3>LRC 붙여넣기</h3><p class="tiny">[mm:ss.xx]가사 형식. 일본어 원문과 줄별 시간이 함께 저장됩니다. 한국어 번역은 그대로 둡니다.</p><textarea class="field" id="lrcIn" style="min-height:220px;font-family:var(--jp);font-size:13px" placeholder="[00:21.30]…"></textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn" data-x="c">취소</button><button class="btn pri" data-x="o">적용</button></div>`);
  $('#modal').onclick = e => {
    if (e.target.id==='modal' || e.target.dataset.x==='c') return closeModal();
    if (e.target.dataset.x==='o'){
      const out = parseLRC($('#lrcIn').value); if (!out.length) return toast('시간 태그를 찾지 못했어요');
      const L = state.lyrics[id] || {}; state.lyrics[id] = {...L, jp: out.map(x=>x.text).join('\n'), times: out.map(x=> x.text ? +x.t.toFixed(2) : null)};
      LS.set('lyrics', state.lyrics); rec = null; closeModal(); toast(`${out.filter(x=>x.text).length}줄 적용 — 싱크 시간도 저장했어요`); renderNP();
    }
  };
}
function copyModal(title, text){
  modal(`<h3>${title}</h3><textarea class="field" id="cpT" style="min-height:220px;font-size:12px" readonly>${esc(text)}</textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn" data-x="c">닫기</button><button class="btn pri" data-x="cp">복사</button></div>`);
  $('#modal').onclick = ev => { if (ev.target.id==='modal'||ev.target.dataset.x==='c') return closeModal(); if (ev.target.dataset.x==='cp'){ const ta=$('#cpT'); ta.select(); (navigator.clipboard?navigator.clipboard.writeText(ta.value):Promise.reject()).then(()=>toast('복사했어요')).catch(()=>{ try{document.execCommand('copy'); toast('복사했어요');}catch(e){ toast('직접 선택해서 복사해 주세요'); } }); } };
}

/* =================== 플레이어 =================== */
/* 안드로이드 앱: 재생은 네이티브 플레이어(Media3)가 맡고, 여기서는 상태만 비춘다 */
class NativeAudio extends EventTarget {
  constructor(){ super(); this._t = 0; this._at = performance.now(); this._d = NaN; this._p = true; this.src = ''; this.preload = 'none'; this._vol = 1; }
  get currentTime(){ const t = this._p ? this._t : this._t + (performance.now() - this._at)/1000; return isFinite(this._d) ? Math.min(t, this._d) : t; }
  set currentTime(v){ v = Math.max(0, +v || 0); this._t = v; this._at = performance.now(); try{ YoruNative.seek(Math.round(v*1000)); }catch(e){} this.dispatchEvent(new Event('seeked')); }
  get duration(){ return this._d; } get paused(){ return this._p; }
  get volume(){ return this._vol; } set volume(v){ this._vol = v; }
  play(){ try{ YoruNative.play(); }catch(e){} return Promise.resolve(); }
  pause(){ try{ YoruNative.pause(); }catch(e){} }
}
/* YouTube 공식 영상 엔진 — IFrame Player API를 <audio>처럼 쓰도록 감싼다 */
class YTEngine extends EventTarget {
  constructor(){ super(); this.p = null; this.ready = null; this._p = true; this._vol = 1; this.cur = null; this.title = ''; this.vid = ''; this._timer = 0; this._armed = false; this._done = false; this._dur = NaN; this._lt = 0; this._la = 0; this.lastErr = 0; }
  load(){
    if (this.ready) return this.ready;
    this.ready = new Promise((res, rej) => {
      if (window.YT && YT.Player) return res();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try{ prev && prev(); }catch(e){} res(); };
      const sc = document.createElement('script'); sc.src = 'https://www.youtube.com/iframe_api'; sc.async = true;
      sc.onerror = () => rej(new Error('load')); document.head.appendChild(sc);
      setTimeout(() => rej(new Error('timeout')), 15000);
    }).then(() => new Promise((res, rej) => {
      const box = $('#ytw'); box.innerHTML = '<div id="ytFrame"></div>';
      const pv = { playsinline:1, rel:0, fs:0, iv_load_policy:3, disablekb:1 }; if (/^https?:/.test(location.origin)) pv.origin = location.origin;
      this.p = new YT.Player('ytFrame', { width:'100%', height:'100%', playerVars:pv,
        events:{ onReady: () => { try{ this.p.setVolume(Math.round(this._vol*100)); }catch(e){} res(); }, onStateChange: e => this._state(e.data), onError: e => this._error(e.data) } });
      setTimeout(() => rej(new Error('ready')), 15000);
    })).catch(err => { this.ready = null; this.p = null; throw err; });
    return this.ready;
  }
  async open(src, start=0, autoplay=true){
    this.cur = src; this._done = false; this._armed = false; this.title = ''; this.vid = src.v || ''; this._dur = NaN; this._lt = 0; this.lastErr = 0;
    this.off = src.list ? 0 : (src.s || 0); this.end = src.list ? 0 : (src.e || 0);
    if (this._p !== !autoplay){ this._p = !autoplay; }
    await this.load();
    if (this.cur !== src) return;
    const s = Math.max(0, Math.floor(this.off + (start || 0)));
    if (src.list){ const o = { list:src.list, listType:'playlist', index:src.index, startSeconds:s }; autoplay ? this.p.loadPlaylist(o) : this.p.cuePlaylist(o); }
    else { const o = { videoId:src.v, startSeconds:s }; if (this.end > s) o.endSeconds = this.end; autoplay ? this.p.loadVideoById(o) : this.p.cueVideoById(o); }
    this._tick();
  }
  _meta(){ try{ const d = this.p.getVideoData(); if (d && (d.title !== this.title || d.video_id !== this.vid)){ this.title = d.title || ''; this.vid = d.video_id || this.vid; this.dispatchEvent(new Event('meta')); } }catch(e){} }
  _state(st){
    if (!this.cur) return;
    if (st === 1){
      if (this.cur.list && !this._armed){ try{ if (this.p.getPlaylistIndex() === this.cur.index) this._armed = true; }catch(e){} }
      this._meta(); const d = this.duration; if (isFinite(d) && d !== this._dur){ this._dur = d; this.dispatchEvent(new Event('loadedmetadata')); }
      if (this._p){ this._p = false; this.dispatchEvent(new Event('play')); }
      this._tick();
    } else if (st === 2 || st === 5){ this._meta(); if (!this._p){ this._p = true; this.dispatchEvent(new Event('pause')); } this._tick(); }
    else if (st === 0) this._finish();
  }
  _finish(){ if (this._done) return; this._done = true; this._p = true; clearTimeout(this._timer); this.dispatchEvent(new Event('ended')); }
  _tick(){
    clearTimeout(this._timer); if (!this.p || !this.cur) return;
    if (this.cur.list && this._armed && !this._done){ try{ const i = this.p.getPlaylistIndex(); if (i >= 0 && i !== this.cur.index){ this.p.pauseVideo(); this._finish(); return; } }catch(e){} }
    if (this.end && !this._done && !this._p && this.raw >= this.end - 0.25){ try{ this.p.pauseVideo(); }catch(e){} this._finish(); return; }
    this.dispatchEvent(new Event('timeupdate'));
    if (!this._p) this._timer = setTimeout(() => this._tick(), 250);
  }
  _error(code){ this.lastErr = code; this._p = true; clearTimeout(this._timer); this.dispatchEvent(new Event('error')); }
  /* raw = 영상 속 실제 위치, currentTime/duration = 곡 구간 기준(공연 전체 영상에서 한 곡만 잘라 들을 때) */
  get raw(){ if (!this.p || !this.cur) return 0; let t = 0; try{ t = this.p.getCurrentTime() || 0; }catch(e){}
    const now = performance.now(); if (t !== this._lt){ this._lt = t; this._la = now; }
    return this._p ? t : t + Math.min(0.5, (now - this._la)/1000); }
  seekRaw(t){ t = Math.max(0, +t || 0); try{ this.p && this.p.seekTo(t, true); }catch(e){} this._lt = t; this._la = performance.now(); this.dispatchEvent(new Event('seeked')); setTimeout(() => this._tick(), 80); }
  get currentTime(){ const t = this.raw - (this.off || 0); return this.end ? Math.min(Math.max(0, t), this.end - this.off) : Math.max(0, t); }
  set currentTime(v){ this.seekRaw((this.off || 0) + Math.max(0, +v || 0)); }
  get duration(){ try{ const d = this.p && this.cur && this.p.getDuration(); if (!(d > 0)) return NaN; return (this.end && this.end <= d ? this.end : d) - (this.off || 0); }catch(e){ return NaN; } }
  get paused(){ return this._p; }
  get volume(){ return this._vol; } set volume(v){ this._vol = v; try{ this.p && this.p.setVolume(Math.round(v*100)); }catch(e){} }
  play(){ try{ this.p && this.p.playVideo(); }catch(e){} return Promise.resolve(); }
  pause(){ try{ this.p && this.p.pauseVideo(); }catch(e){} }
  stop(){ try{ this.p && this.p.stopVideo(); }catch(e){} clearTimeout(this._timer); const was = !this._p; this._p = true; this.cur = null; this.title = ''; if (was) this.dispatchEvent(new Event('pause')); }
  url(){ const c = this.cur; if (!c) return 'https://www.youtube.com/@nbuna'; if (this.vid) return 'https://www.youtube.com/watch?v=' + this.vid + (c.list ? '&list=' + c.list : '') + (this.off ? '&t=' + Math.floor(this.off) : ''); return 'https://www.youtube.com/watch?list=' + c.list + '&index=' + (c.index + 1); }
}
/* 스트리밍 앱 연동 엔진 — 소리는 Spotify·YouTube Music 등이 내고, 여기서는 그 앱의 재생 상태를 비춘다(안드로이드 앱 전용) */
class ExtEngine extends EventTarget {
  constructor(){ super(); this._t = 0; this._at = performance.now(); this._d = NaN; this._p = true; }
  get currentTime(){ const t = this._p ? this._t : this._t + (performance.now() - this._at)/1000; return isFinite(this._d) ? Math.min(t, this._d) : t; }
  set currentTime(v){ v = Math.max(0, +v || 0); this._t = v; this._at = performance.now(); try{ YoruNative.extControl('seek', Math.round(v*1000)); }catch(e){} this.dispatchEvent(new Event('seeked')); }
  get duration(){ return this._d; } get paused(){ return this._p; }
  get volume(){ return 1; } set volume(v){}
  play(){ this._p = false; this._at = performance.now(); try{ YoruNative.extControl('play', 0); }catch(e){} this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause(){ if (!this._p){ this._t = this.currentTime; this._p = true; this.dispatchEvent(new Event('pause')); } try{ YoruNative.extControl('pause', 0); }catch(e){} }
}
/* 실제로 소리를 내는 엔진(로컬 음원 / YouTube / 연동 앱)을 하나로 묶어 앱 나머지는 audio 하나만 보게 한다 */
class PlayerProxy extends EventTarget {
  constructor(engines){ super(); this.eng = engines[0];
    ['play','pause','ended','timeupdate','seeked','loadedmetadata','error','meta'].forEach(ev => engines.forEach(e => e.addEventListener(ev, () => { if (this.eng === e) this.dispatchEvent(new Event(ev)); }))); }
  use(e){ if (this.eng === e) return; const old = this.eng; this.eng = e; this.at = Date.now(); if (old === ytEng) old.stop(); else { if (old === extEng){ try{ YoruNative.extStopQueue(); }catch(_){} } try{ if (!old.paused) old.pause(); }catch(_){} } }
  get currentTime(){ return this.eng.currentTime; } set currentTime(v){ this.eng.currentTime = v; }
  get duration(){ return this.eng.duration; } get paused(){ return this.eng.paused; }
  get volume(){ return this.eng.volume; } set volume(v){ localEng.volume = v; ytEng.volume = v; }
  play(){ return this.eng.play(); } pause(){ return this.eng.pause(); }
}
const localEng = NATIVE ? new NativeAudio() : new Audio(); localEng.preload = 'metadata';
const ytEng = new YTEngine(), extEng = new ExtEngine();
const audio = new PlayerProxy([localEng, ytEng, extEng]); audio.volume = state.vol;
/* ---- 스트리밍 앱 연동 설정·판정 ---- */
const EXT_APPS = { 'com.spotify.music':'Spotify', 'com.google.android.apps.youtube.music':'YouTube Music', 'com.google.android.youtube':'YouTube', 'com.apple.android.music':'Apple Music' };
let extInfo = { access:false };
const extPkg = () => LS.get('extApp', 'com.spotify.music');
const extName = () => EXT_APPS[extPkg()] || '연동 앱';
const extOn = () => NATIVE && LS.get('srcPref', 'yt') === 'ext' && !!extInfo.access;
/* 스트리밍에 있는 곡: 라이브 영상 작품과 幻燈 화집 전용곡은 제외 */
const streamable = id => { const s = SONGS[id]; if (!s || s.live) return false; if (s.album === 'gentou') return YT_LIST.gentou.order.includes(s.jp); return true; };
const extQuery = id => { const s = SONGS[id]; return baseTitle(s.jp) + (s.rr ? ' Re-Recording' : '') + ' ヨルシカ'; };
/* 연동 앱이 알려 준 제목·가수·앨범으로 우리 곡 찾기 */
function extMatch(t, ar, al){
  if (!t || !/ヨルシカ|yorushika|요루시카|n-buna|suis/i.test((ar||'') + ' ' + (al||'') + ' ' + t)) return null;
  const k = norm(t); if (!k) return null; const ka = norm(al || ''); const rrT = /re-?record/i.test(t);
  let best = null, bs = 0;
  for (const id of ORDER){ const s = SONGS[id]; const j = norm(s.jp); if (!j) continue;
    if (!(k === j || k.startsWith(j) || (j.length >= 2 && k.includes(j)))) continue;
    const sc = j.length*10 + (k === j ? 5 : 0) + (s.live ? 0 : 4) + (ka && norm(ALB[s.album].jp) && ka.includes(norm(ALB[s.album].jp)) ? 30 : 0) + (s.rr === rrT ? 6 : 0);
    if (sc > bs){ bs = sc; best = id; } }
  return best;
}
let ytUser = LS.get('ytLinks', {}), ytSeg = LS.get('ytSeg', {}), ytTemp = null;
/* 라이브 곡: 직접 맞춘 구간 > 공식 라이브 영상(단독·구간·이어진 영상) */
function liveSrc(s){
  const g = ytSeg[s.id]; if (g && g.v) return { v:g.v, s:g.s || 0, e:g.e || 0, kind:'user-seg' };
  const L = YT_LIVE[s.album] || {}, m = L[s.jp];
  if (m){ const [v, st=0, e=0, pair='', est=''] = Array.isArray(m) ? m : [m]; return { v, s:st, e, pair, est: est==='est', kind: st || e ? 'seg' : 'live' }; }
  for (const k in L){ const x = L[k]; if (Array.isArray(x) && x[3] === s.jp) return { v:x[0], s:x[1] || 0, e:0, kind:'pair2', after:k }; }
  return null;
}
function ytOf(id){
  const s = SONGS[id]; if (!s) return null;
  if (ytTemp && ytTemp.id === id) return ytTemp.src;
  if (ytUser[id]) return { v:ytUser[id], kind:'user' };
  if (s.live) return liveSrc(s);
  const v = YT_MV[s.jp] || (!s.rr && YT_MV[baseTitle(s.jp)]);
  if (v) return { v, kind:'mv' };
  const L = YT_LIST[s.album]; if (L){ const i = L.order ? L.order.indexOf(s.jp) : s.no - 1; if (i >= 0) return { list:L.list, index:i, kind:'list' }; }
  return null;
}
const playable = id => state.hasAudio.has(id) || (extOn() && streamable(id)) || !!ytOf(id);
const ytLabel = y => !y ? '없음' : ({ user:'직접 연결한 영상 ✓', mv:'공식 영상·음원 ✓', live:'공식 라이브 영상 ✓', 'user-seg':'직접 맞춘 공연 영상 구간 ✓', find:'공연 영상에서 구간 찾는 중',
  seg: y.est ? '공식 공연 영상 · 구간 추정(맞추기 가능)' : '공식 공연 영상 구간 ✓', pair2:`공식 라이브 영상 ✓ · 「${y.after}」부터 이어서 나와요` })[y.kind] || `공식 앨범 재생목록 ${y.index+1}번째 ✓`;
const fmtR = t => { t = Math.max(0, Math.floor(t || 0)); const h = Math.floor(t/3600), m = Math.floor(t%3600/60), x = t%60; return (h ? h+':'+String(m).padStart(2,'0') : m) + ':' + String(x).padStart(2,'0'); };
function parseYT(u){ u = String(u||'').trim(); const m = u.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/) || u.match(/^([\w-]{11})$/); return m ? m[1] : ''; }
/* 영상 창 위치: 재생 화면이 열려 있으면 앨범 아트 자리, 아니면 오른쪽 아래 작은 창(최소 200×200) */
function positionYT(){
  const box = $('#ytBox'); if (!box) return;
  const on = audio.eng === ytEng && !!ytEng.cur; box.classList.toggle('on', on); if (!on) return;
  const npOpen = $('#np').classList.contains('open');
  const ba = npOpen && npSong === cur() && !state.imm ? $('#np .bigart') : null; const r = ba && ba.getBoundingClientRect();
  if (r && r.width >= 150 && r.top > -r.height*0.4 && r.bottom < innerHeight + r.height*0.4 && r.top < innerHeight - 80){
    box.classList.add('art'); box.classList.remove('mini','left');
    Object.assign(box.style, { left:r.left+'px', top:r.top+'px', width:Math.max(200, r.width)+'px', height:Math.max(200, r.height)+'px' });
  } else { box.classList.remove('art'); box.classList.add('mini'); box.classList.toggle('left', !!LS.get('ytLeft', false)); box.removeAttribute('style'); }
  $('#ytT').textContent = ytEng.title || (SONGS[cur()] ? SONGS[cur()].jp : 'YouTube'); $('#ytOut').href = ytEng.url();
}
let ytRaf = 0; const posYT = () => { if (ytRaf) return; ytRaf = requestAnimationFrame(() => { ytRaf = 0; positionYT(); }); };
addEventListener('resize', posYT); document.addEventListener('scroll', () => { if (audio.eng === ytEng) posYT(); }, { capture:true, passive:true });
let ytFails = 0;
audio.addEventListener('meta', () => { ytFails = 0; positionYT(); const e = $('#ytNow'); if (e) e.textContent = ytEng.title; });
audio.addEventListener('error', () => {
  if (audio.eng !== ytEng) return; const id = cur(), s = SONGS[id]; const c = ytEng.lastErr; ytFails++;
  toast(`「${s ? s.kr : ''}」 ${c===101||c===150 ? '영상은 앱 안 재생이 막혀 있어요' : c===100 ? '영상을 찾을 수 없어요' : '영상을 재생하지 못했어요'} — ↗ 버튼으로 YouTube에서 열 수 있어요`);
  updateBar();
  if (ytFails < 3 && state.qi < state.queue.length - 1) setTimeout(() => { if (cur() === id && audio.eng === ytEng && ytEng.lastErr) next(true); }, 2600);
});
window.yoruBg = () => { if (audio.eng === ytEng && !audio.paused) audio.pause(); saveSession(); };
let curURL = null;
const cur = () => state.queue[state.qi];
async function loadAndPlay(startAt=0, autoplay=true){
  const id = cur(); if (!id) return;
  if (state.mode === 'ext'){
    if (!NATIVE) { state.mode = 'yt'; return loadAndPlay(startAt, autoplay); }
    audio.use(extEng); loadedId = id; if (autoplay) extReqAt = Date.now();
    const items = state.queue.map(x => ({ id:x, q:extQuery(x), key:norm(SONGS[x].jp), title:baseTitle(SONGS[x].jp) }));
    let r = 'error'; try{ r = YoruNative.extSetQueue(JSON.stringify(items), state.qi, state.repeat, extPkg(), !!autoplay); }catch(e){}
    if (autoplay){ extEng._t = 0; extEng._at = performance.now(); extEng._d = NaN; extEng._p = false; extEng.dispatchEvent(new Event('play'));
      state.recent = [id, ...state.recent.filter(x=>x!==id)].slice(0,30); LS.set('recent', state.recent);
      const S = SONGS[id];
      toast({ session:`「${S.kr}」 — ${extName()}에서 재생해요`, intent:`${extName()}을(를) 열어 재생해요 — 돌아오면 가사가 따라가요`, search:`${extName()} 검색 화면을 열었어요 — 「${S.jp}」를 눌러 주세요`,
        noapp:`${extName()}이(가) 설치돼 있지 않아요 — 설정에서 연동 앱을 바꿔 주세요`, noaccess:'알림 접근 권한이 꺼져 있어요 — 설정 → 스트리밍 앱 연동', error:'연동 앱에 재생을 요청하지 못했어요' }[r] || `${extName()}에서 재생해요`); }
    updateBar(); saveSession(); if (autoplay && $('#np').classList.contains('open')) { npSong = id; renderNP(); }
    return r === 'session' || r === 'intent' || r === 'ok';
  }
  if (state.mode === 'yt'){
    if (ytTemp && ytTemp.id !== id) ytTemp = null;
    const src = ytOf(id);
    if (!src){ if (autoplay) toast(`「${SONGS[id].kr}」은 연결된 YouTube 영상이 없어요 — 곡 정보에서 직접 연결할 수 있어요`); updateBar(); return false; }
    if (!startAt && state.resumeT){ startAt = state.resumeT; } state.resumeT = 0;
    audio.use(ytEng); loadedId = id; ytEng.cur = src; positionYT();
    if (autoplay){ state.recent = [id, ...state.recent.filter(x=>x!==id)].slice(0,30); LS.set('recent', state.recent); }
    updateBar(); mediaSession(); saveSession(); if (autoplay && $('#np').classList.contains('open')) { npSong = id; renderNP(); }
    try{ await ytEng.open(src, startAt, autoplay); }
    catch(e){ if (cur() === id){ ytEng.stop(); loadedId = null; positionYT(); updateBar(); toast(/claude|anthropic/.test(location.host) ? 'YouTube는 이 미리보기 화면에서 막혀 있어요 — 설치한 앱이나 GitHub Pages 주소에서 열어 주세요' : 'YouTube를 불러오지 못했어요 — 인터넷 연결을 확인해 주세요'); } return false; }
    positionYT(); return true;
  }
  audio.use(localEng);
  if (NATIVE){
    if (!state.hasAudio.has(id)){ if (autoplay) toast(`「${SONGS[id].kr}」 음원이 없어요 — 설정에서 가져오기`); updateBar(); return false; }
    const items = state.queue.map(x => { const s = SONGS[x], a = ALB[s.album]; return { id:x, title:s.kr, artist:'ヨルシカ · ' + s.jp, album:a.kr + ' · ' + a.jp, art: a.extra ? '' : a.id, artUrl: coverOf(a.id, 600) }; });
    try{ YoruNative.setQueue(JSON.stringify(items), state.qi, Math.round(startAt*1000), !!autoplay); YoruNative.setRepeat(state.repeat); }catch(e){ toast('플레이어를 시작하지 못했어요'); return false; }
    loadedId = id; localEng._t = startAt; localEng._at = performance.now(); localEng._p = !autoplay; nativeLastId = id;
    if (autoplay){ state.recent = [id, ...state.recent.filter(x=>x!==id)].slice(0,30); LS.set('recent', state.recent); }
    updateBar(); saveSession(); if (autoplay && $('#np').classList.contains('open')) { npSong = id; renderNP(); }
    return true;
  }
  let blob = null; try{ blob = await IDB.get(id); }catch(e){}
  if (!blob){ if (autoplay) toast(`「${SONGS[id].kr}」 음원이 없어요 — 설정에서 가져오기`); updateBar(); return false; }
  if (curURL) URL.revokeObjectURL(curURL); curURL = URL.createObjectURL(blob);
  localEng.src = curURL; loadedId = id;
  if (startAt > 0){ await new Promise(r => { localEng.addEventListener('loadedmetadata', r, {once:true}); setTimeout(r, 1500); }); try{ audio.currentTime = startAt; }catch(e){} }
  if (autoplay){ try{ await audio.play(); }catch(e){}
    state.recent = [id, ...state.recent.filter(x=>x!==id)].slice(0,30); LS.set('recent', state.recent); }
  updateBar(); mediaSession(); saveSession(); if (autoplay && $('#np').classList.contains('open')) { npSong = id; renderNP(); }
  return true;
}
let loadedId = null, lastSave = 0;
function saveSession(){ lastSave = Date.now(); LS.set('session', { q:state.queue, qi:state.qi, t: audio.currentTime || 0, mode:state.mode }); }
async function restoreSession(){
  const ss = LS.get('session', null);
  if (NATIVE){ try{ const st = JSON.parse(YoruNative.getState()); if (st.count > 0 && (st.playing || !ss || ss.mode !== 'yt')){ state.mode = 'local'; state.queue = JSON.parse(YoruNative.getQueue()).filter(id => SONGS[id]); state.qi = Math.max(0, state.queue.indexOf(st.id)); loadedId = cur(); nativeLastId = loadedId; nativePoll(); return; } }catch(e){} }
  if (!ss || !ss.q || !ss.q.length) return;
  if (ss.mode === 'ext' && NATIVE){ const keep = ss.q[ss.qi]; state.queue = ss.q.filter(id => SONGS[id] && streamable(id)); if (!state.queue.length) return;
    state.mode = 'ext'; audio.use(extEng); state.qi = Math.max(0, state.queue.indexOf(keep)); loadedId = null; return; }
  if (ss.mode === 'yt'){ const keep = ss.q[ss.qi]; state.queue = ss.q.filter(id => SONGS[id] && ytOf(id)); if (!state.queue.length) return;
    state.mode = 'yt'; audio.use(ytEng); state.qi = Math.max(0, state.queue.indexOf(keep)); state.resumeT = state.queue.indexOf(keep) >= 0 ? (ss.t || 0) : 0; loadedId = null; return; }
  state.queue = ss.q.filter(id => SONGS[id] && state.hasAudio.has(id)); if (!state.queue.length) return;
  const keep = ss.q[ss.qi]; state.qi = Math.max(0, state.queue.indexOf(keep)); if (state.queue.indexOf(keep) < 0) state.qi = 0;
  await loadAndPlay(state.queue.indexOf(keep) >= 0 ? (ss.t||0) : 0, false);
}
let nativeLastId = null;
function nativePoll(){
  let st; try{ st = JSON.parse(YoruNative.getState()); }catch(e){ return; }
  const A = localEng, wasPaused = A._p;
  A._t = (st.pos||0)/1000; A._at = performance.now(); A._d = st.dur > 0 ? st.dur/1000 : NaN; A._p = !st.playing;
  if (audio.eng !== localEng){ if (st.playing && Date.now() - (audio.at||0) > 2500){ state.mode = 'local'; audio.use(localEng); positionYT(); try{ state.queue = JSON.parse(YoruNative.getQueue()).filter(x=>SONGS[x]); }catch(e){} nativeLastId = null; } else return; }
  if (st.count > 0 && st.id && st.id !== nativeLastId){
    nativeLastId = st.id; const qi = state.queue.indexOf(st.id);
    if (qi >= 0) state.qi = qi; else { try{ state.queue = JSON.parse(YoruNative.getQueue()).filter(x=>SONGS[x]); state.qi = Math.max(0, state.queue.indexOf(st.id)); }catch(e){} }
    loadedId = cur(); if (cur()){ state.recent = [cur(), ...state.recent.filter(x=>x!==cur())].slice(0,30); LS.set('recent', state.recent); }
    updateBar(); saveSession(); if ($('#np').classList.contains('open')){ npSong = cur(); renderNP(); }
  }
  A.dispatchEvent(new Event('timeupdate'));
  if (wasPaused !== A._p) A.dispatchEvent(new Event(A._p ? 'pause' : 'play'));
}
if (NATIVE) setInterval(nativePoll, 250);
/* 연동 앱 상태 읽기: 지금 곡·위치를 비추고, 요루시카 곡을 듣고 있으면 따라간다 */
let extReqAt = 0, extForeign = false;
function extPoll(){
  let st; try{ st = JSON.parse(YoruNative.extState()); }catch(e){ return; }
  const had = !!extInfo.access; extInfo = st || { access:false };
  if (had !== !!extInfo.access && /^#\/settings/.test(location.hash) && !$('#np').classList.contains('open')){ const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; }
  if (!st || !st.title) return;
  const id = extMatch(st.title, st.artist, st.album), E = extEng;
  if (audio.eng === extEng){
    if (Date.now() - extReqAt < 5000 && id !== cur()) return;      // 요청한 곡으로 바뀌기 전
    const wasP = E._p; extForeign = !id;
    if (!id) return;                                                 // 요루시카가 아닌 곡: 표시는 그대로 둔다
    E._t = (st.pos||0)/1000; E._at = performance.now(); E._d = st.dur > 0 ? st.dur/1000 : NaN; E._p = !st.playing;
    if (id !== cur()){ const qi = state.queue.indexOf(id); if (qi >= 0) state.qi = qi; else { state.queue = [id]; state.qi = 0; }
      const was = loadedId; loadedId = id; state.recent = [id, ...state.recent.filter(x=>x!==id)].slice(0,30); LS.set('recent', state.recent);
      updateBar(); saveSession(); if ($('#np').classList.contains('open') && npSong === was){ npSong = id; renderNP(); } lastLi = -2; }
    E.dispatchEvent(new Event('timeupdate'));
    if (wasP !== E._p){ E.dispatchEvent(new Event(E._p ? 'pause' : 'play')); updateBar(); }
  } else if (LS.get('extFollow', true) && id && st.playing && audio.paused){
    state.mode = 'ext'; audio.use(extEng); state.queue = [id]; state.qi = 0; loadedId = id;
    E._t = (st.pos||0)/1000; E._at = performance.now(); E._d = st.dur > 0 ? st.dur/1000 : NaN; E._p = false;
    updateBar(); saveSession(); if ($('#np').classList.contains('open')){ npSong = id; renderNP(); }
  }
}
if (NATIVE) setInterval(extPoll, 700);
const engReady = () => audio.eng === ytEng ? !!ytEng.cur : audio.eng === extEng ? true : (NATIVE || !!localEng.src);
function resume(){ if (cur() && loadedId===cur() && engReady()) return audio.play().catch(()=>{}); if (cur()) return loadAndPlay(); toggle(); }
/* 재생 방식은 대기열 단위로 정한다 — 누른 곡에 음원 파일이 있으면 로컬, 없으면 YouTube 공식 영상 */
function playQueue(ids, start=0, shuf=false){
  const f0 = ids[start] ?? ids[0];
  const mode = state.hasAudio.has(f0) ? 'local' : (extOn() && streamable(f0)) ? 'ext' : ytOf(f0) ? 'yt' : ids.some(x=>state.hasAudio.has(x)) ? 'local' : extOn() && ids.some(streamable) ? 'ext' : 'yt';
  const ok = mode === 'local' ? (x => state.hasAudio.has(x)) : mode === 'ext' ? streamable : (x => !!ytOf(x));
  let q = ids.filter(ok);
  if (!q.length){ toast('재생할 음원도, 연결된 YouTube 영상도 없어요. 곡 정보에서 영상을 직접 연결할 수 있어요.'); return; }
  let first = ok(f0) ? f0 : q[0];
  if (shuf){ q = q.sort(()=>Math.random()-.5); first = q[0]; }
  if (mode === 'yt') ytFails = 0;
  state.mode = mode; state.queue = q; state.qi = q.indexOf(first); state.shuffle = shuf; LS.set('shuffle', shuf); loadAndPlay();
}
function playOne(id, ctxIds){
  if (!playable(id)){ openNP(id); toast('음원도 YouTube 영상도 없어 곡 정보를 열었어요.'); return; }
  const ids = ctxIds && ctxIds.length ? ctxIds : [id];
  playQueue(ids, ids.indexOf(id), false);
}
function next(auto){
  if (!state.queue.length) return;
  if (NATIVE && loadedId && state.mode==='local'){ try{ YoruNative.next(); }catch(e){} return; }
  if (auto && state.repeat==='one'){ if (state.mode==='yt') return loadAndPlay(); audio.currentTime=0; audio.play(); return; }
  /* 두 곡이 이어진 라이브 영상(예: 歩く / 心に穴が空いた)을 끝까지 들었으면 뒷곡은 건너뛴다 */
  const ps = auto && state.mode==='yt' && ytEng.cur && ytEng.cur.pair; const nx = state.queue[state.qi+1];
  if (ps && nx && SONGS[nx].jp === ps && SONGS[nx].album === SONGS[cur()]?.album && state.qi < state.queue.length-2) state.qi++;
  if (state.qi < state.queue.length-1) state.qi++;
  else if (state.repeat==='all' || !auto) state.qi = 0;
  else { updateBar(); return; }
  loadAndPlay();
}
function prev(){ if (NATIVE && loadedId && state.mode==='local'){ try{ YoruNative.prev(); }catch(e){} return; } if (audio.currentTime>3){ audio.currentTime=0; return; } if (state.qi>0) state.qi--; loadAndPlay(); }
function toggle(){ if (cur() && loadedId!==cur()) return loadAndPlay(); if(!cur()) { const f = ORDER.find(id=>state.hasAudio.has(id)) || ORDER.find(id=>ytOf(id)); if(f) playQueue(ORDER.filter(x=>!SONGS[x].live), ORDER.filter(x=>!SONGS[x].live).indexOf(f)); else toast('먼저 설정에서 음원을 가져와 주세요.'); return; } audio.paused ? audio.play() : audio.pause(); }
audio.addEventListener('ended', ()=>next(true));
audio.addEventListener('play', ()=>{ updateBar(); startTick(true); }); audio.addEventListener('seeked', ()=>{ lastLi=-2; startTick(true); }); audio.addEventListener('pause', updateBar);
audio.addEventListener('timeupdate', syncTime); audio.addEventListener('loadedmetadata', syncTime);
function syncTime(){
  const p = audio.duration ? audio.currentTime/audio.duration : 0;
  [['#seek','#tCur','#tDur'],['#npSeek','#npCur','#npDur']].forEach(([s,c,d])=>{ const e=$(s); if(!e) return; if(!e._drag){ e.value = p*1000; } e.style.setProperty('--p', (e.value/10)+'%'); $(c).textContent = fmt(audio.currentTime); $(d).textContent = fmt(audio.duration); });
  const m = $('#mprog i'); if (m) m.style.width = (p*100)+'%';
  const rw = $('#ytRaw'); if (rw) rw.textContent = fmtR(ytEng.raw);
  if ('mediaSession' in navigator && audio.duration && navigator.mediaSession.setPositionState){ try{ navigator.mediaSession.setPositionState({duration:audio.duration,position:audio.currentTime,playbackRate:1}); }catch(e){} }
}
function updateBar(){
  const id = cur(); const s = SONGS[id];
  $('#pNow').innerHTML = s ? `<div class="art">${art(s.album)}</div><div class="tx"><div class="k">${esc(s.kr)}</div><div class="j">${audio.eng===ytEng?'<b class="ytm">YouTube</b> ':audio.eng===extEng?`<b class="ytm">${esc(EXT_APPS[extInfo.pkg]||extName())}</b> `:''}${esc(s.jp)} · ${esc(ALB[s.album].kr)}</div></div>`
    : `<div class="art" style="display:grid;place-items:center;background:var(--line)">${ic('music')}</div><div class="tx"><div class="k">재생 중인 곡 없음</div><div class="j">ヨルシカ</div></div>`;
  $('#pPlay').innerHTML = ic(audio.paused?'play':'pause'); const np = $('#npPlay'); if (np) np.innerHTML = ic(audio.paused?'play':'pause'); const np2 = $('#npPlay2'); if (np2) np2.innerHTML = ic(audio.paused?'play':'pause');
  $('#pShuf').innerHTML = ic('shuf'); $('#pShuf').style.color = state.shuffle?'var(--accent)':''; $('#pRep').style.color = state.repeat!=='off'?'var(--accent)':''; $('#pRep').innerHTML = ic('rep')+(state.repeat==='one'?'<sup style="font-size:9px">1</sup>':'');
  if (s) document.title = `${s.kr} — ヨルシカ`;
  markPlaying();
}
function markPlaying(){ document.querySelectorAll('.tr').forEach(r=>{ const on = r.dataset.id===cur(); r.classList.toggle('playing', on); const n=r.querySelector('.n'); if(on && !r.dataset.ctx.startsWith('pl:') && !['favs','search','search-rec'].includes(r.dataset.ctx)){ n.innerHTML = `<span class="eq ${audio.paused?'paused':''}"><i></i><i></i><i></i></span>`; r.classList.toggle('paused', audio.paused);} }); }
function artURL(aid){ return coverOf(aid, 512) || (ALB[aid]?.extra ? 'icon-512.png' : `art/${aid}.png`); }
function mediaSession(){
  if (!('mediaSession' in navigator)) return; const s = SONGS[cur()]; if(!s) return; const a = ALB[s.album];
  try{ navigator.mediaSession.metadata = new MediaMetadata({ title: s.kr, artist: `ヨルシカ · ${s.jp}`, album: `${a.kr} · ${a.jp}`,
    artwork: [96,192,512].map(n => ({ src: artURL(a.id), sizes: `${n}x${n}`, type: 'image/png' })) }); }catch(e){}
}
function setupMediaKeys(){
  if (!('mediaSession' in navigator)) return; const ms = navigator.mediaSession;
  const h = (k, f) => { try{ ms.setActionHandler(k, f); }catch(e){} };
  h('play', () => resume());
  h('pause', () => audio.pause());
  h('stop', () => { audio.pause(); saveSession(); });
  h('previoustrack', () => prev());
  h('nexttrack', () => next());
  h('seekto', e => { if (e.fastSeek && 'fastSeek' in audio) audio.fastSeek(e.seekTime); else audio.currentTime = e.seekTime; });
  h('seekbackward', e => { audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10)); });
  h('seekforward', e => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (e.seekOffset || 10)); });
}
audio.addEventListener('play', () => { try{ navigator.mediaSession.playbackState = 'playing'; }catch(e){} });
audio.addEventListener('pause', () => { try{ navigator.mediaSession.playbackState = 'paused'; }catch(e){} saveSession(); });
audio.addEventListener('timeupdate', () => { if (Date.now() - lastSave > 4000) saveSession(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState==='hidden') saveSession(); else maybeCheck(); });

/* =================== 음원 가져오기 =================== */
async function refreshAudio(){ if (NATIVE){ try{ state.hasAudio = new Set(JSON.parse(YoruNative.listFiles()).filter(x=>SONGS[x])); }catch(e){ state.hasAudio = new Set(); } return; } try{ const k = await IDB.keys(); state.hasAudio = new Set(k.filter(x=>SONGS[x])); }catch(e){ state.hasAudio = new Set(); } }
const LIVE_HINT = /live|ライブ|라이브|\blv\b/i;
const LIVE_KEYS = [['live-gekkou',/月光|gekkou|moonlight|월광/i],['live-zense24',/2024|2025/],['live-tsuki',/月と猫|猫|neko|cat|고양이/i],['live-tousaku',/盗作|tousaku|plagiar|도작|2026/i],['live-zense21',/前世|zense|전생|2021/i]];
function matchFile(name){
  const raw = name.replace(/\.[^.]+$/,'');
  const isLive = LIVE_HINT.test(raw);
  let pool = ORDER.filter(id => !ALB[SONGS[id].album].live), cleaned = raw;
  if (isLive){
    const hit = LIVE_KEYS.find(([, re]) => re.test(raw));
    pool = ORDER.filter(id => hit ? SONGS[id].album===hit[0] : ALB[SONGS[id].album].live).reverse();
    cleaned = raw.replace(/[\(\[（【「][^\)\]）】」]*(live|ライブ|라이브)[^\)\]）】」]*[\)\]）】」]/gi,'').replace(LIVE_HINT,'');
    if (hit) cleaned = cleaned.replace(hit[1],'');
  }
  const n = norm(cleaned.replace(/^\s*\d{1,2}[\s.\-_)]+/,'')); if (!n) return null;
  const rr = /re-?recording/i.test(name);
  let best = null, bl = 0;
  for (const id of pool){ const s = SONGS[id]; const t = norm(s.jp); if (!t) continue;
    const exact = n===t; const inc = n.includes(t);
    if (exact || inc){ const score = t.length + (exact?100:0) + ((/Re-Recording/.test(s.jp))===rr?50:0); if (score>bl){ bl=score; best=id; } } }
  return best;
}
let lastImport = '';
async function storeAudio(id, file){
  if (!NATIVE) return IDB.put(id, file);
  const CH = 384*1024; if (!YoruNative.fileBegin(id)) throw new Error('begin');
  for (let o = 0; o < file.size; o += CH){
    const buf = new Uint8Array(await file.slice(o, o+CH).arrayBuffer()); let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i+0x8000));
    if (!YoruNative.fileChunk(id, btoa(bin))) throw new Error('write');
  }
  if (!YoruNative.fileEnd(id)) throw new Error('end');
}
async function importAudio(files){
  const pr = $('#audProg'), bar = pr?.querySelector('i'); if (pr) pr.style.display='block';
  let ok=0, miss=[]; let i=0;
  for (const f of files){ i++; const id = matchFile(f.name);
    if (id){ try{ await storeAudio(id, f); ok++; }catch(e){ miss.push(f.name); } } else miss.push(f.name);
    if (bar) bar.style.width = (i/files.length*100)+'%'; }
  await refreshAudio();
  lastImport = `${ok}곡 연결 완료.${miss.length?`<br>자동 연결 못 한 파일 ${miss.length}개: ${miss.slice(0,8).map(esc).join(', ')}${miss.length>8?' …':''}<br>곡 화면 → 정보 → '음원 연결'로 직접 지정할 수 있어요.`:''}`;
  toast(`${ok}곡 연결 완료`);
}

/* =================== 신곡 자동 추가 =================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function jsonp(url, timeout=12000){
  return new Promise((res, rej) => {
    const cb = '__yoru' + Math.random().toString(36).slice(2); const s = document.createElement('script');
    const done = () => { clearTimeout(t); try{ delete window[cb]; }catch(e){ window[cb] = undefined; } s.remove(); };
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, timeout);
    window[cb] = d => { done(); res(d); }; s.onerror = () => { done(); rej(new Error('blocked')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb; document.head.appendChild(s);
  });
}
const IT = 'https://itunes.apple.com/lookup';
async function fromItunes(){
  const d = await jsonp(`${IT}?id=${UPD_CFG.itunesId}&entity=album&limit=200&country=jp&lang=ja_jp`);
  return (d.results||[]).filter(r => r.wrapperType==='collection' && r.artistId===UPD_CFG.itunesId).map(c => ({
    src:'it', key:'it'+c.collectionId, id:c.collectionId, title:c.collectionName.replace(/\s*-\s*(Single|EP)$/i,'').trim(),
    type: /-\s*Single$/i.test(c.collectionName) ? 'single' : /-\s*EP$/i.test(c.collectionName) ? 'ep' : 'album', date:(c.releaseDate||'').slice(0,10) }));
}
async function itunesTracks(r){
  const d = await jsonp(`${IT}?id=${r.id}&entity=song&limit=200&country=jp&lang=ja_jp`);
  return (d.results||[]).filter(x => x.wrapperType==='track').sort((a,b) => (a.discNumber-b.discNumber) || (a.trackNumber-b.trackNumber)).map(x => x.trackName);
}
const MB = 'https://musicbrainz.org/ws/2/';
async function mbGet(p){ const r = await fetch(MB + p + (p.includes('?')?'&':'?') + 'fmt=json', {headers:{Accept:'application/json'}}); if (!r.ok) throw new Error('mb ' + r.status); return r.json(); }
async function mbArtist(){
  let id = LS.get('mbid', ''); if (id) return id;
  const d = await mbGet('artist?query=' + encodeURIComponent('artist:ヨルシカ') + '&limit=5');
  const a = (d.artists||[]).find(x => x.name==='ヨルシカ') || (d.artists||[])[0]; if (!a) throw new Error('no artist');
  LS.set('mbid', a.id); IDB.mput('mbid', a.id).catch(()=>{}); return a.id;
}
async function fromMB(){
  const id = await mbArtist(); await sleep(1100);
  const d = await mbGet(`release-group?artist=${id}&type=album|ep|single&limit=100`);
  return (d['release-groups']||[]).filter(g => !(g['secondary-types']||[]).length).map(g => ({ src:'mb', key:'mb'+g.id, id:g.id, title:g.title, type:(g['primary-type']||'album').toLowerCase(), date:g['first-release-date']||'' }));
}
async function mbTracks(r){
  await sleep(1100); const d = await mbGet(`release?release-group=${r.id}&inc=recordings&limit=10`);
  const rel = (d.releases||[]).filter(x => (x.media||[]).length).sort((a,b) => (a.date||'9').localeCompare(b.date||'9'))[0];
  return rel ? rel.media.flatMap(m => (m.tracks||[]).map(t => t.title)) : [];
}
const PAL = [['#4f7f9e','#dde9f1'],['#9a6b4f','#f1e6dc'],['#5d8a6a','#dfeee3'],['#7a5c96','#ebe3f3'],['#a2553f','#f3e1da'],['#3e6e72','#d9eceb'],['#8a7a3c','#f1ecd6']];
const typeKr = t => ({single:'싱글', ep:'EP', album:'앨범'}[t] || '앨범');
let checking = false;
async function checkUpdates(manual){
  if (checking) return; checking = true; const st = $('#updSt'); if (st) st.textContent = '확인하는 중…';
  const ex = getExtra(); let rels = null, src = '';
  try{ rels = await fromItunes(); src = 'Apple Music'; }catch(e){ try{ rels = await fromMB(); src = 'MusicBrainz'; }catch(e2){ rels = null; } }
  ex.lastCheck = Date.now();
  if (!rels){ ex.lastErr = '연결할 수 없음'; LS.set('extra', ex); checking = false; if (manual) toast('지금은 확인할 수 없어요. 설치한 앱에서 인터넷이 연결돼 있을 때 다시 해 주세요.'); if ($('#updSt')) render(); return; }
  ex.lastErr = ''; ex.lastSrc = src;
  const known = new Set(ORDER.map(id => norm(SONGS[id].jp))); const krOf = new Map(ORDER.map(id => [norm(SONGS[id].jp), SONGS[id].kr])); const knownAlb = new Set(ALBUMS.map(a => norm(a.jp)));
  const seen = new Set(ex.seen); const today = new Date().toISOString().slice(0,10);
  const cand = rels.filter(r => r.date && r.date > UPD_CFG.since && !seen.has(r.key)).sort((a,b) => a.date.localeCompare(b.date));
  const added = []; let maxDate = '';
  for (const r of cand){
    let tracks = []; try{ tracks = r.src==='it' ? await itunesTracks(r) : await mbTracks(r); }catch(e){ continue; }
    seen.add(r.key); if (r.date > maxDate) maxDate = r.date;
    if (!tracks.length) continue;
    const soon = r.date > today ? ' (발매 예정)' : '';
    if (r.type==='single' && tracks.length <= 3){
      tracks.forEach(t => { const n = norm(t); if (n && !known.has(n)){ ex.singles.push([t, t, r.date]); known.add(n); added.push(`싱글 「${t}」${soon}`); } });
    } else if (!knownAlb.has(norm(r.title))){
      const h = [...r.key].reduce((s,c) => (s*31 + c.charCodeAt(0)) >>> 0, 7); const [c1, c2] = PAL[h % PAL.length];
      const tn = new Set(tracks.map(norm)); ex.singles = ex.singles.filter(s => !tn.has(norm(s[0])));
      ex.albums.push({ id:'x' + h.toString(36), jp:r.title, kr:r.title, type:typeKr(r.type), date:r.date.replace(/-/g,'.'), hue:c1, hue2:c2, motif:'paper',
        blurb:`${src}에서 자동으로 들어온 새 ${typeKr(r.type)}${soon}. 제목 옆 연필 버튼으로 한국어 제목을 붙일 수 있어요.`, tracks: tracks.map(t => { const k = krOf.get(norm(t)); return k ? [t, k, '', ''] : [t, t, '', 'new']; }) });
      knownAlb.add(norm(r.title)); tracks.forEach(t => known.add(norm(t))); added.push(`${typeKr(r.type)} 「${r.title}」 ${tracks.length}곡${soon}`);
    }
  }
  ex.seen = [...seen];
  if (added.length) ex.log = [{ d: today, items: added }, ...ex.log].slice(0, 30);
  LS.set('extra', ex); if (maxDate) IDB.mput('since', maxDate).catch(()=>{}); if (NATIVE){ try{ YoruNative.setReleaseState(maxDate || UPD_CFG.since, JSON.stringify(ex.seen)); }catch(e){} }
  checking = false;
  if (added.length){ applyExtras(); buildIndex(); await refreshAudio(); render(); notifyNew(added); autoTranslate(false); }
  else { if (manual) toast(`새 발매가 없어요 · ${src} 기준`); if (location.hash.startsWith('#/settings')) render(); }
}
async function notifyNew(items){
  const body = items.slice(0,3).join('\n') + (items.length > 3 ? `\n외 ${items.length-3}건` : '');
  toast('요루시카 새 발매가 들어왔어요');
  if (NATIVE){ try{ YoruNative.pushNote('요루시카 새 발매', body); }catch(e){} return; }
  try{ if ('Notification' in window && Notification.permission==='granted'){
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) reg.showNotification('요루시카 새 발매', { body, icon:'icon-192.png', badge:'icon-192.png', tag:'yoru-new' }); else new Notification('요루시카 새 발매', { body, icon:'icon-192.png' }); } }catch(e){}
}
function maybeCheck(){ const ex = getExtra(); if (navigator.onLine !== false && Date.now() - ex.lastCheck > 6*3600e3) checkUpdates(false); }
async function enableAlerts(){
  if (NATIVE){ try{ YoruNative.requestNotify(); }catch(e){} LS.set('bgSync', true); toast('알림 권한을 허용하면, 앱을 닫아 둬도 하루 두 번 새 발매를 확인해 알려 드려요'); setTimeout(render, 800); return; }
  if (!('Notification' in window)){ toast('이 브라우저는 알림을 지원하지 않아요'); return; }
  const p = await Notification.requestPermission();
  if (p !== 'granted'){ toast('알림이 꺼져 있어요. 휴대폰 설정에서 이 앱의 알림을 허용해 주세요.'); render(); return; }
  let bg = false;
  try{ const reg = await navigator.serviceWorker.ready; if (reg.periodicSync){ const q = await navigator.permissions.query({name:'periodic-background-sync'}).catch(()=>({state:'granted'})); if (q.state==='granted'){ await reg.periodicSync.register('yoru-new', { minInterval: 12*3600e3 }); bg = true; } } }catch(e){}
  LS.set('bgSync', bg); toast(bg ? '알림을 켰어요 · 앱을 닫아 둬도 하루 두 번쯤 확인해요' : '알림을 켰어요 · 앱을 열 때마다 확인해요'); render();
}

const appVer = () => { try{ return YoruNative.appVersion() || ''; }catch(e){ return ''; } };
const APK_PAGE = 'https://github.com/kangdohyun1/yorushika/releases/latest';
async function checkApk(){
  if (!NATIVE || Date.now() - LS.get('apkCheck', 0) < 12*3600e3) return;
  try{ const r = await fetch('https://api.github.com/repos/kangdohyun1/yorushika/releases/latest', {headers:{Accept:'application/vnd.github+json'}}); if (!r.ok) return;
    const d = await r.json(); LS.set('apkCheck', Date.now()); LS.set('apkLatest', d.tag_name || '');
    if (d.tag_name && d.tag_name !== 'v' + appVer()) toast(`새 앱 버전 ${d.tag_name}이 나왔어요 · 설정에서 받기`); }catch(e){}
}
/* =================== 제목 자동 번역 =================== */
async function mt(text){
  const rr = /\s*\((Re-?Recording)\)\s*$/i; const tail = rr.test(text) ? ' (재녹음)' : ''; const q = text.replace(rr, '').trim();
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=ja|ko&q=' + encodeURIComponent(q)); if (!r.ok) throw new Error('mt ' + r.status);
  const d = await r.json(); let t = String(d?.responseData?.translatedText || '').trim();
  if (+d.responseStatus !== 200 || !t || /MYMEMORY|QUERY LENGTH|INVALID|LIMIT/i.test(t)) throw new Error('mt fail');
  t = t.replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/^["'「]|["'」]$/g,'');
  return t + tail;
}
async function autoTranslate(manual){
  const ex = getExtra(); let n = 0, fail = 0;
  const jobs = [];
  ex.albums.forEach(al => { if (al.kr===al.jp && !al.krUser) jobs.push(async () => { al.kr = await mt(al.jp); al.krAuto = true; });
    al.tracks.forEach(t => { if (t[3]==='new' && t[1]===t[0]) jobs.push(async () => { t[1] = await mt(t[0]); t[4] = 'auto'; }); }); });
  ex.singles.forEach(t => { if (t[1]===t[0]) jobs.push(async () => { t[1] = await mt(t[0]); t[3] = 'auto'; }); });
  const KO = LS.get('krTitles', {});
  for (const j of jobs){ try{ await j(); n++; }catch(e){ fail++; } await sleep(350); }
  if (n){ LS.set('extra', ex); applyExtras(); buildIndex(); render(); }
  if (manual) toast(n ? `${n}개 제목을 자동 번역했어요${fail?` · ${fail}개 실패`:''}` : (jobs.length ? '지금은 번역할 수 없어요. 인터넷 연결을 확인해 주세요.' : '번역할 제목이 없어요'));
  return n;
}
async function translateOne(id){
  const s = SONGS[id]; try{ const t = await mt(s.jp); const K = LS.get('krTitles',{}); K[id] = t; LS.set('krTitles', K); const A = new Set(LS.get('krAutoIds',[])); A.add(id); LS.set('krAutoIds',[...A]); buildIndex(); renderNP(); toast(`「${t}」(으)로 바꿨어요 · 마음에 안 들면 고치기`); }
  catch(e){ toast('지금은 번역할 수 없어요. 인터넷 연결을 확인해 주세요.'); }
}

/* =================== 모달 =================== */
function modal(html){ $('#modal .box').innerHTML = html; $('#modal').classList.add('open'); }
function closeModal(){ $('#modal').classList.remove('open'); }
function addToPl(ids){
  modal(`<h3>플레이리스트에 담기</h3>${state.playlists.map(p=>`<button class="opt" data-pick="${p.id}"><span class="ibtn">${ic('list')}</span>${esc(p.name)} <span class="tiny" style="margin-left:auto">${p.songs.length}곡</span></button>`).join('')}
    <div style="display:flex;gap:8px;margin-top:12px"><input class="field" id="npl" placeholder="새 플레이리스트 이름"><button class="btn pri" data-pick="__new">만들기</button></div>`);
  $('#modal').onclick = e => {
    if (e.target.id==='modal') return closeModal();
    const b = e.target.closest('[data-pick]'); if (!b) return;
    let p;
    if (b.dataset.pick==='__new'){ const nm = $('#npl').value.trim() || '새 플레이리스트'; p = {id:uid(), name:nm, songs:[]}; state.playlists.push(p); }
    else p = state.playlists.find(x=>x.id===b.dataset.pick);
    const before = p.songs.length; ids.forEach(id=>{ if(!p.songs.includes(id)) p.songs.push(id); });
    savePl(); closeModal(); toast(`「${p.name}」에 ${p.songs.length-before}곡 담았어요`);
    if (location.hash.startsWith('#/playlist')) render();
  };
}
function promptName(title, val, cb){
  modal(`<h3>${title}</h3><input class="field" id="pn" value="${esc(val)}"><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn" data-x="c">취소</button><button class="btn pri" data-x="o">확인</button></div>`);
  setTimeout(()=>$('#pn')?.focus(),50);
  $('#modal').onclick = e => { if (e.target.id==='modal'||e.target.dataset.x==='c') return closeModal(); if (e.target.dataset.x==='o'){ const v=$('#pn').value.trim(); closeModal(); v && cb(v); } };
}
function confirmBox(msg, cb){
  modal(`<h3>${msg}</h3><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button class="btn" data-x="c">취소</button><button class="btn pri" data-x="o">확인</button></div>`);
  $('#modal').onclick = e => { if (e.target.id==='modal'||e.target.dataset.x==='c') return closeModal(); if (e.target.dataset.x==='o'){ closeModal(); cb(); } };
}

/* =================== 이벤트 =================== */
document.addEventListener('click', e => {
  const t = e.target;
  const g = t.closest('[data-go]');
  const act = t.closest('[data-act]');
  if (act){
    const a = act.dataset.act; const row = act.closest('.tr'); const id = act.dataset.id || row?.dataset.id;
    e.stopPropagation();
    if (a==='fav'){ state.favs.has(id)?state.favs.delete(id):state.favs.add(id); saveFavs(); act.classList.toggle('on'); act.innerHTML = ic(state.favs.has(id)?'heartF':'heart'); if(location.hash==='#/favs') render(); return; }
    if (a==='add') return addToPl([id]);
    if (a==='newpl') return promptName('새 플레이리스트', '', v=>{ const p={id:uid(),name:v,songs:[]}; state.playlists.push(p); savePl(); go('#/playlist/'+p.id); });
    if (a==='renpl'){ const p = state.playlists.find(x=>x.id===act.dataset.pl); return promptName('이름 바꾸기', p.name, v=>{ p.name=v; savePl(); render(); }); }
    if (a==='delpl') return confirmBox('이 플레이리스트를 삭제할까요?', ()=>{ state.playlists = state.playlists.filter(x=>x.id!==act.dataset.pl); savePl(); go('#/playlists'); });
    if (['mvup','mvdn','rm'].includes(a)){ const p = state.playlists.find(x=>x.id===row.dataset.ctx.slice(3)); const i=+row.dataset.i;
      if (a==='rm') p.songs.splice(i,1); else { const j = a==='mvup'?i-1:i+1; if (j<0||j>=p.songs.length) return; [p.songs[i],p.songs[j]]=[p.songs[j],p.songs[i]]; }
      savePl(); render(); return; }
    if (a==='toggle') return toggle();
    if (a==='next') return next();
    if (a==='prev') return prev();
    if (a==='shuf'){ state.shuffle=!state.shuffle; LS.set('shuffle',state.shuffle); if(state.shuffle && state.queue.length){ const c=cur(); const rest=state.queue.filter(x=>x!==c).sort(()=>Math.random()-.5); state.queue=[c,...rest]; state.qi=0; } if (NATIVE && loadedId && state.mode==='local') loadAndPlay(audio.currentTime, !audio.paused); if (state.mode==='ext' && loadedId) loadAndPlay(0, false); updateBar(); if($('#np').classList.contains('open')) renderNP(); return; }
    if (a==='rep'){ state.repeat = {off:'all',all:'one',one:'off'}[state.repeat]; LS.set('repeat',state.repeat); if (NATIVE){ try{ YoruNative.setRepeat(state.repeat); YoruNative.extSetRepeat(state.repeat); }catch(e){} } toast({off:'반복 끔',all:'전체 반복',one:'한 곡 반복'}[state.repeat]); updateBar(); if($('#np').classList.contains('open')) renderNP(); return; }
    if (a==='closenp') return closeNP();
    if (a==='ytnp') return openNP();
    if (a==='covers') return fetchCovers(true);
    if (a==='extperm'){ try{ YoruNative.extOpenAccess(); }catch(e){} toast('목록에서 「요루시카 서재」를 켜고 돌아와 주세요'); return; }
    if (a==='extapp'){ LS.set('extApp', act.dataset.pkg); if (state.mode==='ext'){ try{ YoruNative.extStopQueue(); }catch(e){} } toast(`${extName()}(으)로 연동해요`); const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; return; }
    if (a==='extopen'){ try{ YoruNative.extOpenApp(extPkg()); }catch(e){} return; }
    if (a==='extfollow'){ LS.set('extFollow', !LS.get('extFollow', true)); const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; return; }
    if (a==='ytside'){ LS.set('ytLeft', !LS.get('ytLeft', false)); return positionYT(); }
    if (a==='ytlink') return promptName('YouTube 링크 붙여넣기', ytUser[id] ? 'https://youtu.be/'+ytUser[id] : '', v=>{ const vid = parseYT(v); if (!vid) return toast('영상 주소를 알아보지 못했어요 — youtube.com/watch?v=… 또는 youtu.be/… 형식이에요');
      ytUser[id] = vid; LS.set('ytLinks', ytUser); toast('이 곡에 영상을 연결했어요'); if (cur()===id && state.mode==='yt') loadAndPlay(0, !audio.paused); renderNP(); });
    if (a==='segfind'){ const s0 = SONGS[id], y0 = ytOf(id); const at = y0 && y0.v === YT_FULL[s0.album] ? y0.s : 0;
      ytTemp = { id, src:{ v:YT_FULL[s0.album], s:0, e:0, kind:'find' } }; state.mode = 'yt'; state.queue = [id]; state.qi = 0; ytFails = 0;
      loadAndPlay(at, true).then(() => { npSong = id; state.npTab = 'info'; renderNP(); }); toast('곡이 시작하는 곳을 찾아 \'지금을 시작으로\'를 눌러 주세요'); return; }
    if (a==='segnudge'){ if (audio.eng===ytEng) ytEng.seekRaw(ytEng.raw + +act.dataset.d); return; }
    if (a==='segS' || a==='segE'){ if (audio.eng!==ytEng || !ytEng.cur || !ytEng.cur.v) return; const raw = Math.round(ytEng.raw*10)/10;
      const g = ytSeg[id] && ytSeg[id].v === ytEng.cur.v ? ytSeg[id] : { v:ytEng.cur.v, s:ytEng.off || 0, e:ytEng.end || 0 };
      if (a==='segS'){ g.s = raw; if (g.e && g.e <= raw + 5) g.e = 0; } else { if (raw <= (g.s||0) + 5) return toast('끝 지점은 시작보다 뒤여야 해요'); g.e = raw; }
      ytSeg[id] = g; LS.set('ytSeg', ytSeg); ytTemp = null;
      if (a==='segS'){ toast('시작 지점을 저장했어요 — 여기서부터 다시 재생해요'); loadAndPlay(0, true); }
      else { ytEng.end = raw; ytEng.cur = { ...ytEng.cur, e:raw, pair:'' }; toast('끝 지점을 저장했어요'); renderNP(); }
      return; }
    if (a==='segX'){ delete ytSeg[id]; LS.set('ytSeg', ytSeg); toast('맞춘 구간을 지웠어요'); renderNP(); return; }
    if (a==='ytunlink'){ delete ytUser[id]; LS.set('ytLinks', ytUser); toast('직접 연결을 해제했어요'); renderNP(); return; }
    if (a==='chkupd') return checkUpdates(true);
    if (a==='alerts') return enableAlerts();
    if (a==='rensong'){ const s = SONGS[id]; return promptName('한국어 제목 고치기', s.kr, v=>{ const K = LS.get('krTitles',{}); K[id] = v; LS.set('krTitles', K); LS.set('krAutoIds', LS.get('krAutoIds',[]).filter(x=>x!==id)); buildIndex(); renderNP(); toast('제목을 바꿨어요'); }); }
    if (a==='mtone') return translateOne(id);
    if (a==='mtall') return autoTranslate(true);
    if (a==='renalb'){ const al = ALB[act.dataset.alb]; return promptName('앨범 한국어 제목', al.kr, v=>{ const K = LS.get('krAlbums',{}); K[al.id] = v; LS.set('krAlbums', K); if (al.extra){ const ex = getExtra(); const x = ex.albums.find(y=>y.id===al.id); if (x){ x.kr = v; x.krAuto = false; x.krUser = true; LS.set('extra', ex); applyExtras(); } } buildIndex(); render(); }); }
    if (a==='tap') return tap();
    if (a==='undo') return undoTap();
    if (a==='recstart'){ const {jp} = lyrOf(npSong); ensureRec(npSong); rec.times = jp.map(()=>null); rec.idx = nextNB(jp,0); rec.on = true; audio.currentTime = 0; audio.play().catch(()=>{}); reSync(); return; }
    if (a==='recsave'){ if (rec){ saveRec(); toast('싱크를 저장했어요'); state.npTab='lyr'; renderNP(); } return; }
    if (a==='recclear') return confirmBox('이 곡의 싱크 시간을 모두 지울까요?', ()=>{ const L = state.lyrics[npSong]||{}; delete L.times; delete L.offset; state.lyrics[npSong]=L; LS.set('lyrics',state.lyrics); rec=null; renderNP(); toast('싱크를 지웠어요'); });
    if (a==='lrcout'){ if (rec) saveRec(); return copyModal('LRC 복사', toLRC(npSong)); }
    if (a==='lrc') return lrcModal(id);
    if (a==='off'){ const L = state.lyrics[npSong]; if(!L) return; L.offset = Math.round(((L.offset||0) + +act.dataset.d)*10)/10; LS.set('lyrics', state.lyrics); const o=$('#offv'); if(o) o.textContent=(L.offset>0?'+':'')+L.offset.toFixed(1)+'s'; lastLi=-2; startTick(true); return; }
    if (a==='lsz'){ state.lyrSize = Math.min(1.6, Math.max(.8, Math.round((state.lyrSize + +act.dataset.d)*10)/10)); LS.set('lyrSize', state.lyrSize); $('#np').style.setProperty('--ls', state.lyrSize); return; }
    if (a==='imm'){ state.imm = !state.imm; renderNP(); return; }
    if (a==='opennp') return openNP();
    if (a==='savely'){ const old = state.lyrics[id] || {}; const jpv = $('#edJp').value; const changed = hasSync(id) && (old.jp||'').split('\n').length !== jpv.split('\n').length;
      state.lyrics[id] = { ...old, jp:jpv, kr:$('#edKr').value }; LS.set('lyrics', state.lyrics); rec = null; toast(changed?'저장했어요 — 원문 줄 수가 바뀌어 싱크를 확인해 주세요':'가사를 저장했어요'); state.npTab='lyr'; renderNP(); return; }
    if (a==='unlink'){ (NATIVE ? Promise.resolve(YoruNative.deleteFile(id)) : IDB.del(id)).then(refreshAudio).then(()=>{ toast('연결을 해제했어요'); renderNP(); }); return; }
    if (a==='export'){ const blob = new Blob([JSON.stringify({app:'yorushika',v:1,lyrics:state.lyrics,playlists:state.playlists,favs:[...state.favs]},null,1)],{type:'application/json'}); const u=URL.createObjectURL(blob); const l=document.createElement('a'); l.href=u; l.download='yorushika-backup.json'; try{ l.click(); }catch(e){} setTimeout(()=>URL.revokeObjectURL(u),2000);
      modal(`<h3>백업 내보내기</h3><p class="tiny">파일이 내려받아지지 않으면 아래 내용을 복사해 .json 파일로 저장하세요.</p><textarea class="field" id="bk" style="min-height:180px;font-size:12px" readonly>${esc(JSON.stringify({app:'yorushika',v:1,lyrics:state.lyrics,playlists:state.playlists,favs:[...state.favs]}))}</textarea><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px"><button class="btn" data-x="c">닫기</button><button class="btn pri" data-x="cp">복사</button></div>`);
      $('#modal').onclick = ev => { if (ev.target.id==='modal'||ev.target.dataset.x==='c') return closeModal(); if (ev.target.dataset.x==='cp'){ const ta=$('#bk'); ta.select(); (navigator.clipboard?navigator.clipboard.writeText(ta.value):Promise.reject()).then(()=>toast('복사했어요')).catch(()=>{ try{document.execCommand('copy'); toast('복사했어요');}catch(e){ toast('직접 선택해서 복사해 주세요'); } }); } };
      return; }
    if (a==='clearaud') return confirmBox('이 기기에 저장된 음원을 모두 지울까요? 되돌릴 수 없어요.', ()=>{ audio.pause(); state.queue=[]; state.qi=-1; (NATIVE ? Promise.resolve(YoruNative.clearFiles()) : IDB.clear()).then(refreshAudio).then(()=>{ updateBar(); render(); toast('음원을 모두 지웠어요'); }); });
    if (a==='theme'){ setTheme(document.documentElement.dataset.mode==='night'?'day':'night'); return; }
  }
  const tp = t.closest('[data-theme-set]'); if (tp){ setTheme(tp.dataset.themeSet); render(); return; }
  const cvb = t.closest('[data-cover]'); if (cvb){ LS.set('coverMode', cvb.dataset.cover); if (cvb.dataset.cover==='official') maybeCovers(); const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; updateBar(); return; }
  const sp = t.closest('[data-srcpref]'); if (sp){ LS.set('srcPref', sp.dataset.srcpref); if (sp.dataset.srcpref==='ext' && NATIVE && !extInfo.access){ try{ YoruNative.extOpenAccess(); }catch(e){} toast('알림 접근 권한을 켜면 연동이 시작돼요'); } const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; return; }
  const np = t.closest('[data-np]'); if (np){ state.npTab = np.dataset.np; renderNP(); if (innerWidth<=820) $('.rgt2')?.scrollIntoView({block:'start'}); return; }
  const lm = t.closest('[data-lm]'); if (lm){ state.lyrMode = lm.dataset.lm; LS.set('lyrMode', state.lyrMode); renderNP(); return; }
  const ch = t.closest('[data-chip]'); if (ch){ const id = ch.dataset.chip; if (playable(id)) playOne(id); else openNP(id); return; }
  const ro = t.closest('[data-ro]'); if (ro){ readOrder = ro.dataset.ro; const y = $('#main').scrollTop; render(); $('#main').scrollTop = y; return; }
  const fr = t.closest('[data-from]'); if (fr && rec){ const i = +fr.dataset.from; rec.idx = i; rec.on = true; let q = i-1; while (q>=0 && rec.times[q]==null) q--; audio.currentTime = Math.max(0, (q>=0?rec.times[q]:0) - 0.5); audio.play().catch(()=>{}); reSync(); return; }
  const li = t.closest('.lyr.synced [data-li]'); if (li && npSong===cur()){ const {times, off} = lyrOf(npSong); const tm = times[+li.dataset.li]; if (tm!=null){ audio.currentTime = Math.max(0, tm - off + 0.01); userScrollT = 0; lastLi = -2; startTick(true); } return; }
  const pl = t.closest('[data-play]'); if (pl){ playQueue(ctxList(pl.dataset.play), 0, !!pl.dataset.shuf); return; }
  const aa = t.closest('[data-addall]'); if (aa){ addToPl(ctxList(aa.dataset.addall)); return; }
  const po = t.closest('[data-playone]'); if (po){ playOne(po.dataset.playone); return; }
  if (g){ const v = g.dataset.go; if (v.startsWith('song:')) { openNP(v.slice(5)); return; } closeNP();
    const parts = v.split('#'); if (parts.length>2){ go('#'+parts[1]); setTimeout(()=>{ const el = document.getElementById(parts[2]); if (el){ el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('flash'); setTimeout(()=>el.classList.remove('flash'),1800); } },120); return; }
    go(v); return; }
  const row = t.closest('.tr');
  if (row){ const id = row.dataset.id; const ctx = row.dataset.ctx; const ids = ctx==='search-rec' ? state.recent.filter(x=>SONGS[x]) : ctxList(ctx);
    if (playable(id)) { playOne(id, ids); } else openNP(id); return; }
  if (t.closest('#pNow')) return openNP();
});
document.addEventListener('input', e => {
  if (e.target.id==='q'){ const q=e.target.value; history.replaceState(null,'','#/search/'+encodeURIComponent(q)); const ids=searchIds(q); $('#sres').innerHTML = q?(ids.length?`<div class="card tl">${ids.map((x,i)=>trackRow(x,i,'search')).join('')}</div>`:'<div class="empty">찾는 곡이 없어요.</div>'):''; markPlaying(); }
  if (e.target.id==='seek' || e.target.id==='npSeek'){ e.target._drag = true; e.target.style.setProperty('--p',(e.target.value/10)+'%'); }
  if (e.target.id==='vol'){ audio.volume = +e.target.value; state.vol = audio.volume; LS.set('vol', state.vol); e.target.style.setProperty('--p', (audio.volume*100)+'%'); }
  if (e.target.id==='edJp' || e.target.id==='edKr'){ const a=$('#edJp').value.split('\n').length, b=$('#edKr').value.split('\n').length; $('#lnCount').textContent = `원문 ${a}줄 · 번역 ${b}줄${a===b?' ✓ 줄 수 일치':' — 줄 수를 맞추면 정확히 짝지어져요'}`; }
});
document.addEventListener('change', async e => {
  if (e.target.id==='seek' || e.target.id==='npSeek'){ if (audio.duration) audio.currentTime = e.target.value/1000*audio.duration; e.target._drag=false; }
  if (e.target.id==='audIn' && e.target.files.length){ await importAudio([...e.target.files]); render(); }
  if (e.target.dataset.link && e.target.files[0]){ try{ await storeAudio(e.target.dataset.link, e.target.files[0]); }catch(err){ toast('음원을 저장하지 못했어요'); return; } await refreshAudio(); toast('음원을 연결했어요'); renderNP(); }
  if (e.target.id==='impIn' && e.target.files[0]){
    try{ const d = JSON.parse(await e.target.files[0].text()); if (d.app!=='yorushika') throw 0;
      Object.assign(state.lyrics, d.lyrics||{}); LS.set('lyrics', state.lyrics);
      (d.playlists||[]).forEach(p=>{ const ex = state.playlists.find(x=>x.id===p.id); ex ? Object.assign(ex,p) : state.playlists.push(p); }); savePl();
      (d.favs||[]).forEach(f=>state.favs.add(f)); saveFavs(); toast('백업을 불러왔어요'); render();
    }catch(err){ toast('백업 파일을 읽지 못했어요'); }
  }
});
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if ($('#np').classList.contains('open') && !state.imm && state.npTab==='sync' && rec && rec.id===cur()){
    if (e.code==='Space'){ e.preventDefault(); return tap(); }
    if (e.code==='Backspace'){ e.preventDefault(); return undoTap(); } }
  if (e.code==='Space'){ e.preventDefault(); toggle(); }
  if (e.key==='ArrowRight' && e.shiftKey) next(); if (e.key==='ArrowLeft' && e.shiftKey) prev();
  if (e.key==='Escape'){ closeModal(); closeNP(); }
});

/* =================== 테마 · 하늘 =================== */
let booted = false;
function setTheme(t){ state.theme = t; LS.set('theme', t); applyTheme(); }
function applyTheme(){
  const h = new Date().getHours(); const night = state.theme==='night' || (state.theme==='auto' && (h>=19 || h<6));
  const prev = document.documentElement.dataset.mode; document.documentElement.dataset.mode = night ? 'night' : 'day';
  if (booted && prev !== document.documentElement.dataset.mode){ const y = $('#main').scrollTop; const wasOpen = $('#np').classList.contains('open'); render(); $('#main').scrollTop = y; if (wasOpen){ renderNP(); $('#np').classList.add('open'); } }
  $('#themeBtn').innerHTML = ic(night?'moon':'sun');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', night?'#0f1724':'#f7f4ec');
}
function buildSky(){
  const sky = $('#sky'); let h = '<div id="moon"></div>';
  for (let i=0;i<6;i++){ const w = 160+Math.random()*260; h += `<div class="cloud" style="top:${5+Math.random()*45}%;width:${w}px;height:${w*.32}px;animation-duration:${90+Math.random()*120}s;animation-delay:-${Math.random()*200}s"></div>`; }
  for (let i=0;i<70;i++) h += `<div class="star" style="left:${Math.random()*100}%;top:${Math.random()*70}%;animation-delay:${Math.random()*4}s"></div>`;
  for (let i=0;i<9;i++) h += `<div class="petal" style="left:${Math.random()*110}%;animation-duration:${14+Math.random()*14}s;animation-delay:-${Math.random()*28}s"></div>`;
  sky.innerHTML = h;
}

window.yoruBack = () => {
  if ($('#modal').classList.contains('open')){ closeModal(); return true; }
  if ($('#np').classList.contains('open')){ if (state.imm){ state.imm = false; renderNP(); return true; } closeNP(); return true; }
  const h = location.hash; if (h && h!=='#/home' && h!=='#/' && h!==''){ history.back(); return true; }
  return false;
};
/* =================== 시작 =================== */
(async function init(){
  buildSky(); applyTheme(); setInterval(applyTheme, 60000); $('#np').addEventListener('transitionend', posYT);
  const v = $('#vol'); v.value = state.vol; v.style.setProperty('--p',(state.vol*100)+'%');
  await refreshAudio(); setupMediaKeys(); await restoreSession(); updateBar(); render(); booted = true;
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol==='https:' && !/claude|anthropic/.test(location.host)){ try{ navigator.serviceWorker.register('sw.js'); }catch(e){} }
  setTimeout(maybeCheck, 2500); setTimeout(checkApk, 5000); setTimeout(maybeCovers, 1200);
  try{ navigator.storage && navigator.storage.persist && navigator.storage.persist(); }catch(e){}
})();
