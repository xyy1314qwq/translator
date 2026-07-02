const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.text) {
      return json({ error: "Missing text" }, 400);
    }

    try {
      const translation = await translateWithDeepSeek(body, env);
      return json({ translation });
    } catch (error) {
      return json({ error: error.message || "Translation failed" }, 500);
    }
  },
};

async function translateWithDeepSeek(body, env) {
  const glossary = String(body.glossary || "").trim();
  const courseHint = String(body.courseHint || "").trim();
  const mode = String(body.mode || "lecture");
  const context = Array.isArray(body.context) ? body.context.slice(-5) : [];
  const contextText = context
    .map((item, index) => `${index + 1}. EN: ${item.en || ""}\n   ZH: ${item.zh || ""}`)
    .join("\n");

  const style = {
    lecture: "翻译成自然、准确、适合课堂字幕阅读的简体中文。",
    literal: "尽量忠实直译，保留原文结构，但中文必须通顺。",
    notes: "翻译并整理成清楚的课堂复习笔记式中文。",
  }[mode] || "翻译成自然、准确、适合课堂字幕阅读的简体中文。";

  const messages = [
    {
      role: "system",
      content:
        "你是大学课堂实时同声传译助手。只输出中文译文，不要解释。优先保持含义准确，不逐词硬译。保留专有名词、人名、软件名和必要英文缩写。清理口语重复、停顿和填充词。不要添加原文没有的信息。术语表给出译法时必须优先使用。",
    },
    {
      role: "user",
      content: [
        `翻译风格：${style}`,
        courseHint ? `课程/领域：${courseHint}` : "",
        glossary ? `术语表：\n${glossary}` : "",
        contextText ? `最近上下文：\n${contextText}` : "",
        `当前英文：\n${body.text}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-chat",
      temperature: 0.2,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json;charset=utf-8" },
  });
}
