// ============================================================
// LiteProxy v1.0 — 自用轻量 CF 代理（VLESS-WS-TLS）+ 星铁粉紫面板
// 单文件 Worker · 配置存 KV 即时生效 · 节点少而精
// 界面主题：三月七小助手同款「星铁粉紫」三态切换
// ============================================================
import { connect } from 'cloudflare:sockets';

const VERSION = 'LiteProxy v1.0';
const FALLBACK = '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1><hr>nginx</center></body></html>';

// ---------- 默认配置（KV 无配置时兜底） ----------
const DEFAULT_CFG = {
  proxyip: 'proxyip.cmliussss.net:443',   // 出站反代：目标为 CF IP 时必走
  ips: [                                   // 优选节点 ip:端口#名称，最多 8 个
    '104.16.160.3:443#优选-1',
    '104.17.210.119:443#优选-2',
    '172.64.32.5:443#优选-3'
  ]
};

// ---------- CF IPv4 段判断 ----------
function ipToLong(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const s of p) {
    const v = parseInt(s, 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}
const CF_NETS = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22],
  ['103.31.4.0', 22], ['141.101.64.0', 18], ['108.162.192.0', 18],
  ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22],
  ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22]
].map(pair => {
  const base = ipToLong(pair[0]);
  const mask = pair[1] === 0 ? 0 : (0xFFFFFFFF << (32 - pair[1])) >>> 0;
  return [base & mask, mask];
});
function isCFIPv4(ip) {
  const n = ipToLong(ip);
  if (n === null) return false;
  return CF_NETS.some(net => (n & net[1]) === net[0]);
}

// ---------- KV 配置 ----------
async function loadCfg(env) {
  if (!env.C) return { ...DEFAULT_CFG };
  try {
    const raw = await env.C.get('cfg');
    if (raw) return { ...DEFAULT_CFG, ...JSON.parse(raw) };
  } catch (e) { /* 忽略读取异常，用默认 */ }
  return { ...DEFAULT_CFG };
}
async function saveCfg(env, patch) {
  const cfg = await loadCfg(env);
  if (typeof patch.proxyip === 'string') cfg.proxyip = patch.proxyip.trim().slice(0, 200);
  if (Array.isArray(patch.ips)) cfg.ips = patch.ips.map(s => String(s).trim()).filter(Boolean).slice(0, 8);
  await env.C.put('cfg', JSON.stringify(cfg));
  return cfg;
}

// ---------- VLESS 协议 ----------
function parseVLESSHeader(buf, uuidRaw) {
  if (buf.byteLength < 26) return null;
  if (buf[0] !== 0) return null;
  const idLen = buf[1];
  if (buf.byteLength < 2 + idLen + 4) return null;
  let uidHex = '';
  for (let i = 0; i < idLen; i++) uidHex += buf[2 + i].toString(16).padStart(2, '0');
  if (uidHex !== uuidRaw.replaceAll('-', '')) return null;
  let off = 2 + idLen;
  const cmd = buf[off]; off += 1;
  if (cmd !== 1) return { udpOnly: true };
  const port = (buf[off] << 8) | buf[off + 1]; off += 2;
  const atype = buf[off]; off += 1;
  let hostname = '';
  if (atype === 1) {
    hostname = buf[off] + '.' + buf[off + 1] + '.' + buf[off + 2] + '.' + buf[off + 3];
    off += 4;
  } else if (atype === 2) {
    const dl = buf[off]; off += 1;
    if (buf.byteLength < off + dl) return null;
    hostname = new TextDecoder().decode(buf.slice(off, off + dl));
    off += dl;
  } else if (atype === 3) {
    if (buf.byteLength < off + 16) return null;
    const seg = [];
    for (let i = 0; i < 8; i++) seg.push(((buf[off + i * 2] << 8) | buf[off + i * 2 + 1]).toString(16));
    hostname = seg.join(':');
    off += 16;
  } else return null;
  return { port, hostname, rest: buf.slice(off), udpOnly: false };
}

async function forwardTCP(ws, firstPacket, uuid, cfg, ctx) {
  const parsed = parseVLESSHeader(firstPacket, uuid);
  if (!parsed) { try { ws.close(1008, 'bad header'); } catch (e) {} return; }
  if (parsed.udpOnly) { try { ws.close(1008, 'udp not supported'); } catch (e) {} return; }
  const { port, hostname, rest } = parsed;

  let tcp = null;
  const openSock = async (addr) => {
    const s = connect(addr);
    await s.opened;
    return s;
  };
  try {
    const isIp4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    const directAllowed = !isIp4 || !isCFIPv4(hostname);
    if (directAllowed) {
      try { tcp = await openSock(hostname + ':' + port); } catch (e) { tcp = null; }
    }
    if (!tcp) {
      const px = (cfg.proxyip || '').trim();
      if (!px) throw new Error('proxyip empty');
      const pxHost = px.includes(':') ? px : px + ':443';
      tcp = await openSock(pxHost);
    }
  } catch (e) {
    try { ws.close(1011, 'connect failed'); } catch (e2) {}
    return;
  }

  ws.send(new Uint8Array([0, 0]));            // VLESS 响应头
  if (rest && rest.byteLength > 0) {
    const w = tcp.writable.getWriter();
    try { await w.write(rest); } finally { w.releaseLock(); }
  }

  const done = Promise.all([
    tcp.readable.pipeTo(new WritableStream({
      write(d) { if (ws.readyState === 1) ws.send(d); }
    }), { preventClose: true }).catch(() => {}),
    new ReadableStream({
      start(ctrl) {
        ws.addEventListener('message', ev => { try { ctrl.enqueue(ev.data); } catch (e) {} });
        ws.addEventListener('close', () => { try { ctrl.close(); } catch (e) {} });
        ws.addEventListener('error', () => { try { ctrl.close(); } catch (e) {} });
      }
    }).pipeTo(tcp.writable, { preventClose: true }).catch(() => {})
  ]).then(() => { try { ws.close(); } catch (e) {} }).catch(() => {});
  ctx.waitUntil(done);
}

// ---------- 节点与订阅 ----------
function buildNodes(uuid, host, cfg) {
  const list = [{ addr: host, port: 443, name: 'LiteProxy-主节点' }];
  (cfg.ips || []).forEach((item, idx) => {
    const i = item.lastIndexOf('#');
    if (i <= 0) return;
    const ap = item.slice(0, i).trim();
    const name = (item.slice(i + 1).trim() || ('优选-' + (idx + 1))).slice(0, 30);
    const [a, p] = ap.split(':');
    if (!a) return;
    list.push({ addr: a.trim(), port: parseInt(p || '443', 10) || 443, name });
  });
  return list.map(n => ({
    ...n,
    link: 'vless://' + uuid + '@' + n.addr + ':' + n.port +
      '?encryption=none&security=tls&sni=' + host + '&fp=chrome&type=ws&host=' + host +
      '&path=' + encodeURIComponent('/' + uuid + '?ed=2048') + '#' + encodeURIComponent(n.name)
  }));
}

function escYAML(s) { return '"' + String(s).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'; }

function buildClashYAML(uuid, host, cfg) {
  const nodes = buildNodes(uuid, host, cfg);
  const names = nodes.map(n => n.name);
  const L = [];
  L.push('port: 7890', 'socks-port: 7891', 'allow-lan: false', 'mode: rule', 'log-level: warning');
  L.push('dns:', '  enable: true', '  nameserver:', '    - 223.5.5.5', '    - 119.29.29.29');
  L.push('proxies:');
  for (const n of nodes) {
    L.push('  - name: ' + escYAML(n.name));
    L.push('    server: ' + n.addr);
    L.push('    port: ' + n.port);
    L.push('    type: vless');
    L.push('    uuid: ' + uuid);
    L.push('    tls: true');
    L.push('    udp: false');
    L.push('    servername: ' + host);
    L.push('    client-fingerprint: chrome');
    L.push('    network: ws');
    L.push('    ws-opts:');
    L.push('      path: ' + escYAML('/' + uuid + '?ed=2048'));
    L.push('      max-early-data: 2048');
    L.push('      early-data-header-name: Sec-WebSocket-Protocol');
    L.push('      headers:');
    L.push('        Host: ' + host);
  }
  L.push('proxy-groups:');
  L.push('  - name: ' + escYAML('🚀 节点选择'));
  L.push('    type: select');
  L.push('    proxies:');
  for (const nm of names) L.push('      - ' + escYAML(nm));
  L.push('      - ' + escYAML('♻️ 自动选择'));
  L.push('  - name: ' + escYAML('♻️ 自动选择'));
  L.push('    type: url-test');
  L.push('    url: ' + escYAML('http://www.gstatic.com/generate_204'));
  L.push('    interval: 1800');
  L.push('    tolerance: 60');
  L.push('    proxies:');
  for (const nm of names) L.push('      - ' + escYAML(nm));
  L.push('rules:');
  L.push('  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve');
  L.push('  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve');
  L.push('  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve');
  L.push('  - GEOIP,CN,DIRECT');
  L.push('  - MATCH,🚀 节点选择');
  return L.join('\n');
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function buildBase64Sub(uuid, host, cfg) {
  return b64(buildNodes(uuid, host, cfg).map(n => n.link).join('\n'));
}

// ---------- 延迟测试 ----------
async function pingNodes(cfg) {
  const out = [];
  const jobs = (cfg.ips || []).map(async item => {
    const i = item.lastIndexOf('#');
    const ap = (i > 0 ? item.slice(0, i) : item).trim();
    const name = i > 0 ? item.slice(i + 1).trim() : ap;
    const host = ap.split(':')[0];
    if (!host) return;
    const t0 = Date.now();
    try {
      const r = await fetch('https://' + host + '/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) });
      out.push({ name, addr: ap, ms: r.ok ? Date.now() - t0 : -1, ok: r.ok });
    } catch (e) {
      out.push({ name, addr: ap, ms: -1, ok: false });
    }
  });
  await Promise.all(jobs);
  out.sort((a, b) => (a.ms < 0 ? 9e9 : a.ms) - (b.ms < 0 ? 9e9 : b.ms));
  return out;
}

// ---------- 星铁粉紫面板 ----------
function panelHTML(uuid, host, cfg) {
  const subURL = 'https://' + host + '/' + uuid + '/sub';
  const apiBase = 'https://' + host + '/' + uuid;
  const ipsText = (cfg.ips || []).join(', ');
  const css = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--glow1:#ec4899;--glow2:#a855f7;--grad:linear-gradient(135deg,#ec4899,#a855f7);
  --bg:#0d0817;--bgfix:linear-gradient(160deg,#1a0b2e 0%,#2d1035 45%,#12081f 100%);
  --card:rgba(255,255,255,.055);--cardhover:rgba(255,255,255,.09);
  --border:rgba(255,255,255,.14);--txt:#f5eefb;--sub:#b9a8d0;--ink:#f5eefb;--panel:rgba(20,12,32,.55)}
:root[data-theme="dark"]{--bg:#070a12;--bgfix:linear-gradient(160deg,#0d1220 0%,#101426 50%,#0a0d18 100%);
  --glow1:#3b82f6;--glow2:#8b5cf6;--card:rgba(255,255,255,.04);--cardhover:rgba(255,255,255,.07);
  --txt:#e6e9f2;--sub:#8a93ad;--panel:rgba(13,17,30,.6)}
:root[data-theme="light"]{--bg:#f3effa;--bgfix:linear-gradient(160deg,#fdf2f8 0%,#f3e8ff 50%,#eff6ff 100%);
  --glow1:#f9a8d4;--glow2:#c4b5fd;--card:rgba(255,255,255,.62);--cardhover:rgba(255,255,255,.82);
  --border:rgba(167,139,250,.28);--txt:#2b2140;--sub:#7c6f96;--panel:rgba(255,255,255,.7)}
body{min-height:100vh;background:var(--bg);color:var(--txt);font-family:-apple-system,'PingFang SC',sans-serif;
  padding:18px 16px 40px;max-width:680px;margin:0 auto;position:relative;overflow-x:hidden}
.bgfix{position:fixed;inset:0;background:var(--bgfix);z-index:-3}
.glow{position:fixed;border-radius:50%;filter:blur(110px);opacity:.5;z-index:-2;pointer-events:none}
.glow.g1{width:380px;height:380px;background:var(--glow1);top:-120px;left:-100px;animation:drift1 26s ease-in-out infinite alternate}
.glow.g2{width:420px;height:420px;background:var(--glow2);bottom:-150px;right:-120px;animation:drift2 32s ease-in-out infinite alternate}
@keyframes drift1{to{transform:translate(120px,90px) scale(1.15)}}
@keyframes drift2{to{transform:translate(-140px,-70px) scale(1.1)}}
header{display:flex;align-items:center;gap:10px;margin-bottom:6px;animation:up .5s ease both}
h1{font-size:22px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:800}
.badge{font-size:10px;color:var(--sub);border:1px solid var(--border);border-radius:20px;padding:2px 9px}
#themeBtn{margin-left:auto;background:var(--card);border:1px solid var(--border);border-radius:24px;
  padding:7px 14px;font-size:15px;cursor:pointer;transition:.25s}
#themeBtn:active{transform:scale(.92)}
.headsub{color:var(--sub);font-size:12px;margin-bottom:20px;animation:up .5s .05s ease both}
.card{background:var(--card);backdrop-filter:blur(22px) saturate(1.5);-webkit-backdrop-filter:blur(22px) saturate(1.5);
  border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:15px;transition:.3s;animation:up .5s ease both}
.card:nth-of-type(1){animation-delay:.08s}.card:nth-of-type(2){animation-delay:.16s}
.card:nth-of-type(3){animation-delay:.24s}.card:nth-of-type(4){animation-delay:.32s}
.card:hover{background:var(--cardhover);transform:translateY(-2px)}
.card h2{font-size:13px;letter-spacing:.6px;margin-bottom:12px;color:var(--txt);opacity:.85;font-weight:700}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input,textarea{background:rgba(0,0,0,.22);border:1px solid var(--border);color:var(--ink);
  border-radius:10px;padding:10px 12px;font-size:14px;outline:none;transition:.2s;width:100%}
:root[data-theme="light"] input,:root[data-theme="light"] textarea{background:rgba(255,255,255,.7)}
input:focus,textarea:focus{border-color:var(--glow1);box-shadow:0 0 0 3px color-mix(in srgb,var(--glow1) 22%,transparent)}
textarea{min-height:76px;font-family:ui-monospace,monospace;font-size:13px;resize:vertical;line-height:1.6}
button{background:var(--grad);border:none;color:#fff;border-radius:10px;padding:10px 18px;font-size:13.5px;
  font-weight:600;cursor:pointer;transition:.2s;box-shadow:0 4px 16px color-mix(in srgb,var(--glow1) 30%,transparent)}
button:active{transform:scale(.95)}
button.ghost{background:transparent;border:1px solid var(--border);color:var(--txt);box-shadow:none}
.link{word-break:break-all;font-size:11.5px;color:var(--sub);background:rgba(0,0,0,.25);
  padding:9px 11px;border-radius:9px;font-family:ui-monospace,monospace;line-height:1.5;user-select:all}
:root[data-theme="light"] .link{background:rgba(255,255,255,.6);color:#5b4a7a}
.tip{font-size:11px;color:var(--sub);opacity:.85;line-height:1.7;margin-top:9px}
#pingbox{font-size:12.5px;line-height:2;margin-top:6px;display:none}
#pingbox .bar{height:5px;border-radius:3px;background:var(--grad);margin:2px 0 10px;transition:width .6s}
.okc{color:#34d399;font-weight:700}.badc{color:#f87171;font-weight:700}
.toast{position:fixed;top:18px;left:50%;transform:translate(-50%,-70px);background:var(--grad);color:#fff;
  padding:9px 24px;border-radius:22px;font-size:13px;font-weight:600;transition:.35s;z-index:99;box-shadow:0 8px 30px rgba(236,72,153,.4)}
.toast.show{transform:translate(-50%,0)}
@keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
  const body = `
<div class="bgfix"></div><div class="glow g1"></div><div class="glow g2"></div>
<header><h1>⚡ LiteProxy</h1><span class="badge">${VERSION}</span>
<button id="themeBtn" onclick="nextTheme()">💗</button></header>
<div class="headsub">自用轻量节点 · 配置存 KV，保存即生效 · 改完订阅刷新即可</div>

<div class="card"><h2>📥 订阅链接</h2>
<div class="link" id="sublink">${subURL}</div>
<div class="row" style="margin-top:11px"><button onclick="cpSub()">复制订阅</button>
<button class="ghost" onclick="cpSub()">导到 FlClash：配置 →＋→URL →粘贴</button></div>
<div class="tip">Clash 系客户端自动返回 YAML；v2rayNG 等返回 Base64。面板改完配置后，在客户端里下拉刷新订阅即可。</div></div>

<div class="card"><h2>🌍 出口 ProxyIP</h2>
<div class="row"><input id="px" value="${cfg.proxyip || ''}" placeholder="proxyip.cmliussss.net:443">
<button onclick="saveCfg({proxyip:val('px')})">保存</button></div>
<div class="tip">目标为 CF 站点时流量从这里出去：官方池 proxyip.cmliussss.net:443；想换出口归属就填对应地区的反代地址。留空则不反代。</div></div>

<div class="card"><h2>📌 优选节点</h2>
<textarea id="ips" spellcheck="false">${ipsText}</textarea>
<div class="row" style="margin-top:11px"><button onclick="saveIps()">保存节点</button>
<button class="ghost" onclick="doPing()">⚡ 测延迟</button></div>
<div id="pingbox"></div>
<div class="tip">每行一个，格式 <b>ip:端口#名字</b>，最多 8 个。保存后节点立刻进订阅；测延迟按快→慢排序。</div></div>

<div class="card"><h2>🔑 信息</h2>
<div class="tip">UUID：<b>${uuid}</b><br>面板：${host}/${uuid}<br>伪装：根路径与非授权路径一律返回 nginx 404<br>内核：VLESS-WS-TLS · 目标为 CF IP 自动走 ProxyIP · 直连失败自动回退</div></div>

<div class="toast" id="toast">已保存 ✓</div>
<script>
function val(id){return document.getElementById(id).value}
function toast(m){var t=document.getElementById('toast');t.textContent=m;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},1500)}
function cpSub(){navigator.clipboard.writeText(document.getElementById('sublink').textContent.trim()).then(function(){toast('订阅链接已复制 ✓')})}
function saveCfg(patch){fetch('${apiBase}/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)}).then(function(r){if(r.ok){toast('已保存 ✓ 订阅即时生效')}else{toast('保存失败')}}).catch(function(){toast('网络错误')})}
function saveIps(){var lines=val('ips').split(/\\n|,/).map(function(s){return s.trim()}).filter(Boolean);saveCfg({ips:lines})}
function doPing(){var box=document.getElementById('pingbox');box.style.display='block';box.innerHTML='测试中，请稍候…';
fetch('${apiBase}/api/ping').then(function(r){return r.json()}).then(function(d){
var mx=1;for(var i=0;i<d.length;i++){if(d[i].ms>mx)mx=d[i].ms}
box.innerHTML=d.map(function(x){
if(!x.ok)return '<span class="badc">●</span> '+x.name+' <span style="opacity:.5">'+x.addr+'</span> — 超时';
var w=Math.max(8,100-Math.round(x.ms/mx*82));
return '<div><span class="okc">●</span> '+x.name+' — '+x.ms+'ms <span style="opacity:.5">'+x.addr+'</span></div><div class="bar" style="width:'+w+'%"></div>'
}).join('')}).catch(function(){box.innerHTML='测试失败'})}
var themes=['light','dark','sakura'];var icons={light:'☀️',dark:'🌙',sakura:'💗'};
var cur=localStorage.getItem('lp_theme')||'sakura';apply(cur);
function apply(t){document.documentElement.setAttribute('data-theme',t);document.getElementById('themeBtn').textContent=icons[t]}
function nextTheme(){var i=themes.indexOf(cur);cur=themes[(i+1)%themes.length];apply(cur);localStorage.setItem('lp_theme',cur);toast('主题：'+(cur==='sakura'?'星铁粉紫':cur==='dark'?'深夜':'亮色'))}
</script>`;
  return '<!DOCTYPE html><html lang="zh" data-theme="sakura"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiteProxy 控制台</title><style>' + css + '</style></head><body>' + body + '</body></html>';
}

async function handleWS(request, uuid, env, ctx) {
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      let first = null;
      const proto = request.headers.get('sec-websocket-protocol');
      if (proto) {
        try {
          let b64s = proto.replaceAll('-', '+').replaceAll('_', '/');
          while (b64s.length % 4) b64s += '=';
          const bin = atob(b64s);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          first = arr;
        } catch (e) { first = null; }
      }
      if (first && first.byteLength > 0) {
        await forwardTCP(server, first, uuid, await loadCfg(env), ctx);
      } else {
        // 先返回 101，再异步等首包，避免与客户端互相等待死锁
        server.addEventListener('message', async (ev) => {
          try {
            const cfg2 = await loadCfg(env);
            const d = ev.data;
            const arr = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer || d);
            await forwardTCP(server, arr, uuid, cfg2, ctx);
          } catch (e) { try { server.close(1011); } catch (e2) {} }
        }, { once: true });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
}

// ---------- 主路由 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const uuid = (env.u || '').trim();
    const path = url.pathname;

    // WebSocket：VLESS 入口
    if (request.headers.get('Upgrade') === 'websocket') {
      if (!uuid) return new Response('not configured', { status: 500 });
      try {
        return await handleWS(request, uuid, env, ctx);
      } catch (err) {
        try { await env.C.put('last_err', new Date().toISOString() + ' | ' + String(err && err.stack || err)); } catch (e2) {}
        return new Response('ws error: ' + String(err && err.message || err), { status: 500 });
      }
    }

    // 面板 / 订阅 / API：必须带正确 UUID 前缀
    const okPrefix = uuid && (path === '/' + uuid || path.startsWith('/' + uuid + '/'));
    if (!okPrefix) {
      return new Response(FALLBACK, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const cfg = await loadCfg(env);
    const rest = path.slice(('/' + uuid).length) || '/';

    if (rest === '/' || rest === '') {
      return new Response(panelHTML(uuid, host, cfg), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    if (rest === '/sub') {
      const ua = request.headers.get('User-Agent') || '';
      if (/clash|mihomo|meta|stash/i.test(ua)) {
        return new Response(buildClashYAML(uuid, host, cfg), {
          headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
      return new Response(buildBase64Sub(uuid, host, cfg), {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    if (rest === '/api/err') {
      const e = await env.C.get('last_err');
      return new Response(e || 'no error', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (rest === '/api/save' && request.method === 'POST') {
      try {
        const patch = await request.json();
        const c = await saveCfg(env, patch);
        return Response.json({ ok: true, cfg: c });
      } catch (e) {
        return Response.json({ ok: false, err: String(e) }, { status: 400 });
      }
    }
    if (rest === '/api/ping') {
      return Response.json(await pingNodes(cfg));
    }
    return new Response(FALLBACK, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
};
