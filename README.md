# 课堂实时翻译

白蓝色课堂字幕页面：浏览器采集英文语音，经 Cloudflare Worker 中继送往 Deepgram，再通过 DeepSeek 生成中文译文。支持分人、术语库、上下文、字号和纯文本导出。

## 安全控制

所有请求共用一个 SQLite Durable Object `UsageGuard`。按 Cloudflare 提供的 `CF-Connecting-IP` 计数，同时执行全站预算；token 的随机 nonce 不参与限流身份。更换 token、并发请求或 Worker 重启不会清空已经使用的持久额度。共享校园或家庭网络的设备会共用同一 IP 配额。

`POST /token` 只签发短期的本应用 token，**不再返回 Deepgram 凭证**。语音统一通过 `/listen` 中继，不能从应用取得供应商凭证绕过用量限制。此前 `docs/superpowers/specs/2026-08-13-deepgram-websocket-fallback-design.md` 中的 direct-first 方案已由此方案替代。

中继在联系供应商前预留并发名额，正在握手的连接也计入并发。连接失败、关闭和错误均释放名额。连接使用非休眠 WebSocket，由同一个 Durable Object 持有两端；实例重启会关闭它的连接，而 SQLite 用量不会重置。会话截止由定时器和 Durable Object alarm 执行。

音频格式固定为 `nova-3 / English / linear16 / 16000 Hz / mono`，保留 `diarize` 开关；不接受更换模型、采样率、编码或重复参数。转发音频前按 PCM 字节扣减额度（每秒 32,000 字节），限制帧大小与发送速度，仅允许 `KeepAlive`、`Finalize`、`CloseStream` 控制消息。达到额度即关闭连接，不会继续向供应商发送超额音频。

这是一套公开服务的用量控制，并非登录认证。CORS 来源白名单不等于用户身份验证；若仅供本人使用，可另加 Cloudflare Access 等身份控制。供应商项目的费用硬上限仍可作为额外保护。

## 默认额度

日额度按 UTC 日期重置；分钟限制使用最近 60 秒窗口。识别会话可以正常跨越 token 的 60 秒握手有效期。

| 项目 | 每 IP | 全站 |
| --- | ---: | ---: |
| token 签发 / 60 秒 | 6 | 60 |
| token 签发 / 日 | 1,000 | 2,000 |
| 翻译请求 / 60 秒 | 60 | 180 |
| 翻译请求 / 日 | 3,000 | 6,000 |
| 识别连接发起 / 60 秒 | 4 | 12 |
| 识别连接发起 / 日 | 24 | 48 |
| 同时识别连接（含握手） | 2 | 4 |
| 每日识别音频 | 6 小时 | 12 小时 |

每次识别会话最长 3 小时，同时限制该会话音频总量。并发、会话时长、每日音频和翻译额度可通过 `wrangler.toml` 中对应变量调整。无效额度配置、缺失 Durable Object 绑定或存储失败时，接口拒绝请求，不会退回无计量路径。

单次翻译仍限制原文 1,200 字符、术语库 2,000 字符、最近 5 条上下文、课程提示 220 字符；最大输出 token 默认 220。关键词过滤只作为辅助输入约束，不保证模型绝对遵守翻译指令。

## 接口

`POST /token`，空 JSON 请求体，返回：

```json
{"token":"payload.signature","expiresAt":1720000000000,"speechMode":"relay"}
```

`POST /translate`，通过 `X-Translation-Token` 请求头携带 token：

```json
{
  "text":"Current English sentence.",
  "context":[{"en":"Previous sentence.","zh":"上一句。"}],
  "glossary":"academic integrity=学术诚信",
  "mode":"lecture",
  "courseHint":"传媒研究"
}
```

`GET /listen?diarize=true` 使用 WebSocket 升级，子协议为 `translator` 和本应用 token。默认不开分人。正常结果仍为 Deepgram 的识别事件。

超出 HTTP 配额返回 `429`，JSON 包含 `error`，以及 `Retry-After: 60`；若错误是每日额度耗尽，需要等待下一 UTC 日期。已打开的识别连接超额时以 `4008` 关闭并带可读原因。前端遇到 `429` 不进行连续自动重试。

## 本地检查

需要 Node.js 22.16 或更新版本。

```sh
npm ci
npm run check
npm test
npm run deploy:check
```

测试在本地真实 workerd/SQLite Durable Object/WebSocket 运行时执行，所有供应商访问都替换为本地测试 Worker；不需要真实密钥，不产生 Deepgram 或 DeepSeek 用量。测试覆盖换 token、并发、重启持久化、语音预算、异常握手清理、参数绕过、快速音频及正常转发。

页面可用静态 HTTP 服务预览。开发环境需要在 `ALLOWED_ORIGINS` 中加入实际页面来源，并同步页面 CSP 的允许服务地址；生产默认来源是 `https://xyy1314qwq.github.io`。

## 部署顺序

1. 先发布新版 `index.html`。它可使用旧 Worker 已有的 `/listen`，且忽略旧 `/token` 返回的额外 Deepgram 字段。
2. 确认现有 Worker Secrets 中配置了 `DEEPGRAM_API_KEY`、`DEEPSEEK_API_KEY`、`TRANSLATION_TOKEN_SECRET`。不要将秘密写进仓库。
3. 使用仓库中的完整 `wrangler.toml` 部署，创建 `USAGE_GUARD` 绑定及 `usage-guard-v1` 的 SQLite class migration：

   ```sh
   npx wrangler deploy
   ```

4. 核对线上绑定、变量和一次正常识别/翻译。不要只复制 Worker 文件而遗漏 `usage-budget.js` 与 Durable Object 配置。普通发布不要改动固定对象名 `shared-usage-v1`，否则会创建新的预算命名空间。

GitHub Pages 只更新前端，不会自动部署 Cloudflare Worker。源码和本地测试完成也不等于线上已修复。停止发放新 Deepgram token 不会主动撤销已经建立的旧直连；切换时应确认旧会话已结束，如需立即撤销则通过供应商的凭证/会话管理处理。

平台依据：[SQLite Durable Object 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Durable Object WebSocket](https://developers.cloudflare.com/durable-objects/examples/websocket-server/)、[类迁移](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)。
