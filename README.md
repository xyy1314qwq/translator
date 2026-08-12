这是一个课堂实时翻译网页，使用 Deepgram 做英文语音识别，再通过 Cloudflare Worker 调用 DeepSeek 翻译。

## 这版改了什么

- 修复页面中文乱码和默认术语库乱码。
- Deepgram 断句参数调慢，减少半句话就翻译的问题。
- 翻译请求新增最近上下文、课程领域、翻译风格和术语库。
- 新增设置面板，可以改 Worker 地址、翻译风格和课程领域。
- 附带 `cloudflare-worker-deepseek.js`，可作为 DeepSeek Worker 的新版模板。

## Worker 请求格式

前端会向 Worker 发送两类请求：

1) 获取翻译凭证

`POST /token`：前端请求短期签名 token（每分钟更新）。
返回格式：

```json
{
  "token": "base64url.payload.signature",
  "expiresAt": 1720000000000
}
```

2) 翻译文本

`POST /translate`：前端通过 `X-Translation-Token` 请求头携带上一步 token。

```json
{
  "text": "当前要翻译的英文（≤1200字）",
  "context": [{"en": "上一句英文", "zh": "上一句中文"}],
  "glossary": "academic integrity=学术诚信",
  "mode": "lecture",
  "courseHint": "传媒研究"
}
```

## Worker 环境变量

部署 `cloudflare-worker-deepseek.js` 时至少需要配置：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_MODEL`（可选，默认 `deepseek-chat`）
- `TRANSLATION_TOKEN_SECRET`（签名 token 用，建议随机高熵字符串）
- `ALLOWED_ORIGINS`（可选，不填写则默认允许 `https://xyy1314qwq.github.io` 与本地开发端口）

## 注意

- `/translate` 会严格校验签名 token、过期时间、来源域和来源 IP（在同一 IP/Origin 下同一 token 可用）。
- 术语库长度上限为 2000 字符，输入文本上限为 1200 字符。
- Worker 返回的是纯中文翻译文本，前端会逐条展示并支持重试。
- 已新增提示词注入防护：课程提示、术语库和上下文文本会在 Worker 层做指令化关键词过滤与长度/结构校验，不允许异常内容作为指令注入模型。
