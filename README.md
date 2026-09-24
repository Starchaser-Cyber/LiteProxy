# ⚡ LiteProxy

轻量自用 Cloudflare 代理：**单文件 Worker** 实现 VLESS-WS-TLS 内核 + 内置「梦幻粉紫」管理面板，节点少而精，配置存 KV、保存即生效。

## 特性

- 🎀 **梦幻粉紫面板**：粉紫渐变 + 光斑漂移 + 毛玻璃卡片，☀️/🌙/💗 三主题循环切换（localStorage 记忆），`prefers-reduced-motion` 自动降级
- 📌 **节点少而精**：主节点 + 最多 8 个手动优选，面板内编辑保存立刻进订阅
- ⚡ **延迟测试**：面板一键并发测试所有优选节点，按快→慢排序显示
- 🌍 **ProxyIP 出站**：目标为 Cloudflare IP 时自动走 ProxyIP 反代，直连失败自动回退
- 📥 **自适应订阅**：Clash 系返回 YAML（含 🚀 节点选择 / ♻️ 自动选择 组），其他客户端返回 Base64
- 🥷 **伪装**：根路径与非授权路径一律返回 nginx 风格 404
- 🔧 **KV 即时配置**：面板改完不用重新部署，客户端刷新订阅即可

## 部署

### 方式一：Dashboard 粘贴（推荐新手）

1. Cloudflare 控制台 → **Workers 和 Pages** → 创建 Worker → 在线编辑器粘贴 `worker.js` 全部内容并部署
2. Worker → 设置 → **变量与机密**：添加 `u` = 你的 UUID（格式如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`，推荐 `cat /proc/sys/kernel/random/uuid` 生成）
3. 创建一个 **KV 命名空间**，在 Worker 设置中以变量名 **`C`** 绑定
4. （可选）设置 → 域名与路由 → 添加自定义域

部署后访问 `https://你的域名/你的UUID` 即可打开面板。

### 方式二：Wrangler

```bash
npm i -g wrangler
wrangler kv namespace create LITE
# 编辑 wrangler.toml：main = "worker.js"，compatibility_date >= 2026-01-20
# vars: u = "你的UUID"，kv_namespaces: binding = "C", id = <上一步输出>
wrangler deploy
```

## 面板功能

| 卡片 | 说明 |
|---|---|
| 📥 订阅链接 | 一键复制；客户端自动识别格式 |
| 🌍 出口 ProxyIP | 目标为 CF 站点时流量的反代出口，填对应地区地址可改变出口归属 |
| 📌 优选节点 | `ip:端口#名字` 每行一个，最多 8 个；保存即生效，可一键测延迟 |
| 🔑 信息 | UUID / 面板地址 / 内核说明 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `u` | （必填）UUID，同时是面板与订阅的访问路径 |
| `C` | （必填）KV 绑定名，存储面板配置 |

## 安全提示

- 面板与订阅路径含 UUID，等于访问密码，请勿外传
- 建议绑定自定义域名使用（`workers.dev` 域名在部分地区不可直连）
- 免费额度 10 万请求/天，个人自用绰绰有余

## 免责声明

本项目仅供学习与个人网络研究使用，请遵守所在地区法律法规；使用本项目产生的一切后果由使用者自行承担。
