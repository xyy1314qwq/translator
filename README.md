这是一个课堂实时翻译网页，使用 Deepgram 做英文语音识别，再通过 Cloudflare Worker 调用 DeepSeek 翻译。

## 这版改了什么

- 修复页面中文乱码和默认术语库乱码。
- Deepgram 断句参数调慢，减少半句话就翻译的问题。
- 翻译请求新增最近上下文、课程领域、翻译风格和术语库。
- 新增设置面板，可以改 Worker 地址、翻译风格和课程领域。
- 附带 `cloudflare-worker-deepseek.js`，可作为 DeepSeek Worker 的新版模板。

## Worker 请求格式

前端现在会向 Worker 发送：

```json
{
  "text": "当前要翻译的英文",
  "context": [{"en": "上一句英文", "zh": "上一句中文"}],
  "glossary": "academic integrity=学术诚信",
  "mode": "lecture",
  "courseHint": "传媒研究"
}
```
