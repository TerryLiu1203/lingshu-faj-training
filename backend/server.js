/** 灵枢智训 - 消费者陪练、停止控制、知识检索与评分闭环 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PERSONAS } = require('./personas');
const { loadKB } = require('./knowledge');
const { runConsumerTurn, buildNegativeEnding } = require('./consumer-agent');
const { evaluateConversation } = require('./evaluator-agent');
const { analyzeSalesMessage, matchHiddenInformation, applyDelta } = require('./rules');

const PORT = process.env.PORT || 3000;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');
const sessions = new Map();
const rateLimits = new Map();
const RATE_LIMIT_MAX = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE) || 10);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, now = Date.now()) {
  const ip = getClientIp(req);
  let entry = rateLimits.get(ip);
  if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  entry.count += 1;
  rateLimits.set(ip, entry);
  if (rateLimits.size > 5000) {
    for (const [key, value] of rateLimits) if (now >= value.resetAt) rateLimits.delete(key);
  }
  return {
    allowed: entry.count <= RATE_LIMIT_MAX,
    ip,
    limit: RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
    resetAt: entry.resetAt,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
  };
}

function findPersona(personaId) { return PERSONAS.find(p => p.id === personaId) || PERSONAS[0]; }
function id(prefix, n) { return `${prefix}${String(n).padStart(2, '0')}`; }

function createSession(personaId, maxTurns = 12) {
  const persona = findPersona(personaId);
  const session = {
    personaId: persona.id,
    turnCount: 0,
    maxTurns: Math.max(4, Math.min(20, Number(maxTurns) || 12)),
    stage: 'opening',
    emotion: persona.initialState.emotion,
    trust: persona.initialState.trust,
    intent: persona.initialState.intent,
    objectionIntensity: persona.initialState.objectionIntensity,
    history: [{ turnId: 'C00', speaker: 'consumer', role: 'assistant', content: persona.opener, kind: 'opener' }],
    stateSnapshots: [{ turn: 0, trust: persona.initialState.trust, intent: persona.initialState.intent, emotion: persona.initialState.emotion, stage: 'opening' }],
    revealedInformationIds: [],
    triggeredObjectionIds: [],
    resolvedObjectionIds: [],
    riskSignals: [],
    precheckFlags: [],
    behaviorLog: [],
    endSignal: false,
    endType: null,
    endReason: null,
    negativeReason: null,
    redLine: null,
    redQuote: null
  };
  return session;
}

function getSession(sessionId, personaId) {
  const key = sessionId || 'default';
  let session = sessions.get(key);
  if (!session || session.personaId !== findPersona(personaId).id) {
    session = createSession(personaId);
    sessions.set(key, session);
  }
  return session;
}

function summarizeState(s) {
  return {
    turn: s.turnCount, maxTurns: s.maxTurns, stage: s.stage, emotion: s.emotion,
    trust: s.trust, intent: s.intent, objectionIntensity: s.objectionIntensity,
    revealedInformationIds: s.revealedInformationIds,
    triggeredObjectionIds: s.triggeredObjectionIds,
    resolvedObjectionIds: s.resolvedObjectionIds
  };
}

function recordSnapshot(session) {
  session.stateSnapshots.push({
    turn: session.turnCount, trust: session.trust, intent: session.intent,
    emotion: session.emotion, stage: session.stage
  });
}

function setEnd(session, type, reason, negativeReason = null) {
  session.endSignal = true;
  session.endType = type;
  session.endReason = reason;
  session.negativeReason = negativeReason;
}

function fallbackConsumerReply(persona, session) {
  const unresolved = (persona.objections || []).map((text, i) => ({ id: `${persona.id}-O${String(i + 1).padStart(2, '0')}`, text }))
    .find(x => !session.resolvedObjectionIds.includes(x.id));
  return unresolved?.text || '我大概明白了，不过这种情况我还是想先问一下医生，再决定要不要用。';
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^[/\\]+/, '');
  const file = path.resolve(OUTPUT_DIR, relative);
  if (!file.startsWith(OUTPUT_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, '404 Not Found', 'text/plain; charset=utf-8');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
  if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, pathname);

  // 只限制会消耗模型额度的接口；画像读取和会话重置不调用模型。
  if (req.method === 'POST' && (pathname === '/api/chat' || pathname === '/api/evaluate')) {
    const rate = checkRateLimit(req);
    res.setHeader('X-RateLimit-Limit', String(rate.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.resetAt / 1000)));
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return send(res, 429, {
        error: `访问过于频繁：单个IP每分钟最多${rate.limit}次请求，请在${rate.retryAfter}秒后重试。`,
        retryAfter: rate.retryAfter
      });
    }
  }

  if (pathname === '/api/personas' && req.method === 'GET') {
    return send(res, 200, PERSONAS.map(p => ({ id:p.id, key:p.key, name:p.name, tag:p.tag, difficulty:p.difficulty, avatar:p.avatar, opener:p.opener })));
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const key = body.sessionId || 'default';
      const session = createSession(body.personaId, body.maxTurns);
      sessions.set(key, session);
      const persona = findPersona(session.personaId);
      return send(res, 200, { ok:true, opener:persona.opener, persona:{ id:persona.id, key:persona.key, name:persona.name }, state:summarizeState(session) });
    } catch (error) { return send(res, 400, { error:error.message }); }
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const message = String(body.message || '').trim();
      if (!message) return send(res, 400, { error:'message 不能为空' });
      const persona = findPersona(body.personaId);
      const session = getSession(body.sessionId, persona.id);
      if (session.endSignal) return send(res, 409, { error:'本轮对话已经结束，请先评分或重置。', endSignal:true, endType:session.endType });

      const analysis = analyzeSalesMessage(message, session.history, persona);
      if (analysis.manualEnd) {
        setEnd(session, 'neutral', '销售员主动结束训练');
        return send(res, 200, { reply:'', state:summarizeState(session), endSignal:true, endType:'neutral', endReason:session.endReason });
      }

      session.turnCount += 1;
      session.stage = session.turnCount === 1 ? 'inquiry' : session.stage;
      session.history.push({ turnId:id('S', session.turnCount), speaker:'sales', role:'user', content:message });
      session.behaviorLog.push({ turn:session.turnCount, tags:analysis.behaviorTags });
      session.precheckFlags.push(...analysis.flags.map(f => ({ ...f, turn:session.turnCount })));
      applyDelta(session, analysis.delta);

      const availableHidden = matchHiddenInformation(persona, message, session.revealedInformationIds);

      if (analysis.hardStop) {
        const flag = analysis.flags[0];
        session.redLine = flag.rule_id;
        session.redQuote = flag.sales_quote;
        session.trust = Math.min(session.trust, flag.rule_id === 'X01' ? 0 : 10);
        session.intent = Math.min(session.intent, flag.rule_id === 'X01' ? 0 : 5);
        setEnd(session, 'negative', `触发合规红线 ${flag.rule_id}`, 'compliance');
        const reply = buildNegativeEnding(persona, session);
        session.history.push({ turnId:id('C', session.turnCount), speaker:'consumer', role:'assistant', content:reply, kind:'ending' });
        recordSnapshot(session);
        return send(res, 200, { reply, state:summarizeState(session), endSignal:true, endType:'negative', endReason:session.endReason, redLine:flag });
      }

      let consumer;
      try {
        consumer = await runConsumerTurn(persona, session, session.history, { availableHidden });
      } catch (error) {
        console.warn('[Consumer] 模型回复失败，使用画像异议降级：', error.message);
        consumer = { reply:fallbackConsumerReply(persona, session), structured:{ risk_signals:[], resolved_objection_ids:[], end_signal:false }, fallbackReason:error.message };
      }
      const structured = consumer.structured || {};

      // 仅接受画像内、程序允许的隐藏信息 ID，防止模型越权泄露。
      const allowedHiddenIds = new Set(availableHidden.map(h => h.id));
      const modelRevealed = (structured.newly_revealed_information_ids || []).filter(x => allowedHiddenIds.has(x));
      modelRevealed.forEach(x => { if (!session.revealedInformationIds.includes(x)) session.revealedInformationIds.push(x); });

      const validObjectionIds = new Set((persona.objections || []).map((_, i) => `${persona.id}-O${String(i + 1).padStart(2, '0')}`));
      if (validObjectionIds.has(structured.triggered_objection_id) && !session.triggeredObjectionIds.includes(structured.triggered_objection_id)) session.triggeredObjectionIds.push(structured.triggered_objection_id);
      (structured.resolved_objection_ids || []).filter(x => validObjectionIds.has(x) && session.triggeredObjectionIds.includes(x)).forEach(x => {
        if (!session.resolvedObjectionIds.includes(x)) session.resolvedObjectionIds.push(x);
      });
      session.riskSignals.push(...(structured.risk_signals || []).map(x => ({ turn:session.turnCount, signal:x })));
      if (structured.next_dialogue_stage) session.stage = structured.next_dialogue_stage;
      if (structured.emotion_type) session.emotion = structured.emotion_type;

      session.history.push({ turnId:id('C', session.turnCount), speaker:'consumer', role:'assistant', content:consumer.reply });

      if (session.trust < 20) setEnd(session, 'negative', '客户信任度跌破停止阈值', 'trust');
      const unresolved = session.triggeredObjectionIds.filter(x => !session.resolvedObjectionIds.includes(x));
      const safeNextStep = analysis.behaviorTags.includes('safe_next_step') || analysis.behaviorTags.includes('professional_referral');
      if (!session.endSignal && structured.end_signal && structured.end_type === 'positive' && session.trust >= 55 && unresolved.length === 0 && safeNextStep) {
        setEnd(session, 'positive', structured.handoff_reason || '客户核心顾虑得到安全回应并形成下一步');
      }
      if (!session.endSignal && structured.end_signal && structured.end_type === 'negative') setEnd(session, 'negative', structured.handoff_reason || '客户主动终止', 'consumer');
      if (!session.endSignal && session.turnCount >= session.maxTurns) setEnd(session, 'neutral', `达到最大轮次 ${session.maxTurns}`);
      recordSnapshot(session);

      return send(res, 200, {
        reply:consumer.reply, state:summarizeState(session), endSignal:session.endSignal,
        endType:session.endType, endReason:session.endReason, fallbackReason:consumer.fallbackReason || null
      });
    } catch (error) { return send(res, 500, { error:error.message }); }
  }

  if (pathname === '/api/evaluate' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const key = body.sessionId || 'default';
      const persona = findPersona(body.personaId);
      const session = getSession(key, persona.id);
      if (!session.history.some(m => m.speaker === 'sales')) return send(res, 400, { error:'尚无销售员发言，无法评分' });
      if (!session.endSignal && body.manual) setEnd(session, 'neutral', '销售员主动结束训练');
      if (!session.endSignal) setEnd(session, 'neutral', '提交评分时对话尚未自动结束');
      const report = await evaluateConversation(persona, session);
      sessions.delete(key);
      return send(res, 200, { ...report, persona:{ key:persona.key, name:persona.name, tag:persona.tag, difficulty:persona.difficulty } });
    } catch (error) { return send(res, 500, { error:error.message }); }
  }

  return send(res, 404, { error:'Not Found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

function startServer() {
  loadKB();
  if (!process.env.KIMI_API_KEY) console.warn('⚠️ 未配置 KIMI_API_KEY：对话和评分将使用本地降级逻辑。');
  const server = http.createServer(handleRequest);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=== 灵枢智训后端已启动 ===`);
    console.log(`前端页面：http://localhost:${PORT}`);
    console.log(`画像列表：http://localhost:${PORT}/api/personas`);
    console.log(`Kimi 模型：${require('./kimi').KIMI_MODEL}`);
  });
  return server;
}

if (require.main === module) startServer();
module.exports = { createSession, getSession, handleRequest, summarizeState, startServer, sessions, checkRateLimit, rateLimits };
