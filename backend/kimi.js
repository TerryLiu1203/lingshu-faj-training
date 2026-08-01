/**
 * 灵枢智训 - Kimi API 客户端
 * OpenAI 兼容端点：https://api.moonshot.cn/v1
 * 模型：由 KIMI_MODEL 配置；代码提供兼容默认值
 */
'use strict';

const KIMI_BASE = process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_KEY = process.env.KIMI_API_KEY || '';

async function chat({ system, messages, json = false, temperature = 0.7, maxTokens = 1024 }) {
  if (!KIMI_KEY) {
    throw new Error('未配置 KIMI_API_KEY 环境变量');
  }

  const body = {
    model: KIMI_MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
    ],
    max_tokens: maxTokens
  };

  // kimi-k2.6/k2.7 等推理模型仅支持 temperature=1，统一用 1 以兼容
  if (KIMI_MODEL.includes('k2')) {
    body.temperature = 1;
  } else {
    body.temperature = temperature;
  }

  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const resp = await fetch(`${KIMI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KIMI_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Kimi API ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { content, usage: data.usage };
}

function extractJSON(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    // 尝试提取 ```json ... ``` 或首个 { } 块
    const m = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[1] || m[0]); } catch (e2) { /* fall through */ }
    }
    return null;
  }
}

module.exports = { chat, extractJSON, KIMI_MODEL, KIMI_BASE };
