/**
 * 灵枢智训 - 可追溯产品知识库
 * 优先读取经三份 PDF 整理、带知识编号和页码来源的评分专用知识库。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CURATED_FILE = path.join(__dirname, '..', 'knowledge', '复方阿胶浆产品知识库_评分Agent_2026.md');
const FALLBACK_FILES = [
  path.join(__dirname, '..', '提取文本', '复方阿胶浆常见问题解答_妇科_2026.txt'),
  path.join(__dirname, '..', '提取文本', '复方阿胶浆常见问题解答_肿瘤血液_2026.txt')
];

const STOP_WORDS = new Set(['的','了','是','吗','呢','啊','吧','在','与','和','或','及','可以','是否','什么','哪些','多少','如何','怎样','怎么','请问','复方阿胶浆','本品','我们','你们','一个','这个','患者','医生','服用','使用','适用','推荐','研究','临床','答','问','如果','对于','根据','通过','需要','建议']);
const TERMS = [
  '补气养血','气血两虚','头晕目眩','心悸失眠','食欲不振','白细胞减少','贫血','产后贫血',
  '妊娠期','哺乳期','孕早期','恶露','铁剂','月经','痛经','排卵','不孕','多囊卵巢',
  '卵巢早衰','更年期','高血压','糖尿病','高血脂','血糖','无糖装','有糖装','红参','党参',
  '熟地黄','山楂','阿胶','激素','化疗','肿瘤','癌因性疲乏','骨髓抑制','升白针','放化疗',
  '禁忌','感冒','咳嗽痰多','脾胃虚弱','茶','萝卜','藜芦','五灵脂','皂荚','安全性',
  '不良反应','疗程','长期服用','替代治疗','遵医嘱','咨询医师','说明书','用法用量','有效期'
];

let chunks = [];

function tokenize(text) {
  const clean = String(text || '').toLowerCase().replace(/[\s，。？、；："'（）()《》【】,.!?;:·\-—\d%]+/g, '');
  const tokens = [];
  TERMS.forEach(term => { if (clean.includes(term)) tokens.push(term); });
  for (let i = 0; i < clean.length - 1; i++) {
    const bi = clean.slice(i, i + 2);
    if (!STOP_WORDS.has(bi)) tokens.push(bi);
  }
  return [...new Set(tokens)];
}

function parseCuratedMarkdown(text) {
  const found = [];
  const pattern = /^##\s+(KB-[A-Z0-9-]+)｜(.+)$/gm;
  const matches = [...text.matchAll(pattern)];
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const body = text.slice(start, end).trim().replace(/\n---\s*$/g, '').trim();
    const source = body.match(/- \*\*来源：\*\*\s*([^\n]+)/)?.[1]?.trim() || '来源见知识库条目';
    const level = body.match(/- \*\*知识等级：\*\*\s*([^\n]+)/)?.[1]?.trim() || '';
    found.push({ id: match[1], title: match[2].trim(), content: body, source, level, kind: 'curated' });
  });
  return found;
}

function parseFallbackQA(text, source) {
  const cleanText = text.split(/\n+/).map(l => l.trim()).filter(Boolean).join('\n');
  const qPattern = /(?:[（(]\d+[)）]\s*)?[^？\n:]{4,80}[？?]/g;
  const matches = [...cleanText.matchAll(qPattern)];
  return matches.map((match, index) => {
    const question = match[0].replace(/^[（(]\d+[)）]\s*/, '').trim();
    const answerStart = match.index + match[0].length;
    // 必须切到“下一个问题的开始”，不能切到其结尾。
    const answerEnd = index + 1 < matches.length ? matches[index + 1].index : cleanText.length;
    const content = cleanText.slice(answerStart, answerEnd).replace(/^[（(]\d+[)）]\s*/, '').replace(/^答[:：]\s*/, '').trim();
    return { id: `RAW-${index + 1}`, title: question, content, source, level: 'RAW', kind: 'fallback' };
  }).filter(x => x.content);
}

function loadKB() {
  chunks = [];
  try {
    const text = fs.readFileSync(CURATED_FILE, 'utf8');
    chunks = parseCuratedMarkdown(text);
  } catch (error) {
    console.warn('[KB] 审核版知识库不可用，启用原始问答降级：', error.message);
    FALLBACK_FILES.forEach(file => {
      try { chunks.push(...parseFallbackQA(fs.readFileSync(file, 'utf8'), path.basename(file))); }
      catch (e) { console.error('[KB] 读取失败：', file, e.message); }
    });
  }
  chunks.forEach(chunk => { chunk.tokens = tokenize(`${chunk.id} ${chunk.title} ${chunk.content}`); });
  console.log(`[KB] 已加载 ${chunks.length} 个可追溯知识条目（${chunks[0]?.kind || 'none'}）`);
  return chunks;
}

function search(query, topK = 5) {
  if (!chunks.length) loadKB();
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const docCount = chunks.length || 1;
  return chunks.map((chunk, index) => {
    let score = 0;
    const matched = [];
    qTokens.forEach(token => {
      if (!chunk.tokens.includes(token)) return;
      const df = chunks.reduce((n, c) => n + (c.tokens.includes(token) ? 1 : 0), 0);
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const titleBoost = tokenize(chunk.title).includes(token) ? 2.2 : 1;
      score += idf * titleBoost;
      matched.push(token);
    });
    return { index, score, matched };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(x => {
      const c = chunks[x.index];
      return { id: c.id, title: c.title, content: c.content, answer: c.content, source: c.source, level: c.level, score: Math.round(x.score * 100) / 100, matched: x.matched };
    });
}

function formatHit(hit) {
  return `【${hit.id}｜${hit.title}】\n${hit.content}\n[来源：${hit.source}]`;
}

function buildContext(query, topK = 4) {
  return search(query, topK).map(formatHit).join('\n\n');
}

function buildEvaluationContext(transcript, topK = 12) {
  const salesMessages = (transcript || []).filter(m => m.speaker === 'sales' || m.role === 'user').map(m => m.content);
  const queries = salesMessages.length ? salesMessages : ['复方阿胶浆 功能主治 注意事项 合规边界'];
  const byId = new Map();
  queries.forEach(query => search(query, 4).forEach(hit => {
    const previous = byId.get(hit.id);
    if (!previous || hit.score > previous.score) byId.set(hit.id, hit);
  }));
  // 始终补充功能主治、注意事项和评分边界，避免短对话漏召回关键规则。
  ['功能主治', '感冒 注意事项 长期服用', '替代治疗 保证有效 合规'].forEach(query =>
    search(query, 3).forEach(hit => { if (!byId.has(hit.id)) byId.set(hit.id, hit); })
  );
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

function getChunks() { return chunks; }

module.exports = { loadKB, search, buildContext, buildEvaluationContext, parseCuratedMarkdown, getChunks };
