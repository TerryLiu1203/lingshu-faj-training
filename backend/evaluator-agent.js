/**
 * 灵枢智训 - 评分 Agent
 * 大模型负责证据化分析；权重、风险下限、封顶和结论由代码确定。
 */
'use strict';

const { chat, extractJSON } = require('./kimi');
const { buildEvaluationContext } = require('./knowledge');
const { clamp } = require('./rules');

const EVAL_SYSTEM = `你是“灵枢智训”复方阿胶浆销售训练评价 Agent。
你只评价销售员说过的话，不得把消费者话术当成销售员证据，不得使用资料之外的医学常识补全证据。

四维口径：
1. 产品知识准确率：核验产品事实、条件和边界。无事实主张时不要凭空扣成0分，但标注证据不足。
2. 异议应对完整性：70%看核心异议是否识别、回应、解释、形成安全下一步；30%看关键信息询问覆盖。
3. 合规风险指数：0代表未发现风险，100代表极高风险；分数越高越危险。必须引用销售员原话和规则ID。
4. 共情沟通能力：看情绪承接、倾听复述、语言清晰和非施压沟通。

合规规则：A类=宣称抗癌/保证疗效或绝对安全/替代中断治疗/鼓励禁忌与不建议人群/擅自停药，每项基础风险40；B类=无依据扩展、特殊人群缺专业咨询，每项20；C类=泛保健化等，每项5。重复可加重。程序还会用预检结果复核，不要忽略预检。

严格输出 JSON，不输出总分（总分由代码计算）：
{
  "product_score":0,
  "objection_score":0,
  "compliance_risk":0,
  "empathy_score":0,
  "data_quality":"sufficient|partial|insufficient",
  "strengths":[{"dimension":"维度","sales_quote":"销售员原话","reason":"原因"}],
  "findings":[{"dimension":"维度","severity":"high|medium|low","rule_id":"规则或知识ID","sales_quote":"销售员原话","basis":"依据","suggestion":"改进建议"}],
  "objection_coverage":[{"objection":"异议","status":"resolved|partial|missed","evidence":"销售员原话"}],
  "inquiry_coverage":{"asked":[],"missed":[]},
  "priority_actions":["最多3项可执行建议"],
  "memorization_points":[
    {"knowledge_id":"必须来自下方知识库证据的ID","point":"销售员需要记住的一条完整、可复述知识点"}
  ],
  "best_quotes":{"good":"销售员原话或空串","bad":"销售员原话或空串"},
  "summary":"简洁总结"
}

必背知识点规则：
- 只选择与本轮客户顾虑、销售错误或遗漏直接相关的3—6条；
- 每条必须绑定知识库证据中真实存在的 knowledge_id；
- point 必须写出完整知识内容和必要边界，不能只输出编号或标题；
- 不得补充知识库之外的医学结论。`;

function riskFloor(precheckFlags = []) {
  const seen = new Map();
  let risk = 0;
  precheckFlags.forEach(flag => {
    const key = `${flag.rule_id}:${flag.sales_quote}`;
    if (seen.has(key)) return;
    seen.set(key, true);
    risk += Number(flag.risk_points) || (flag.level === 'A' ? 40 : flag.level === 'B' ? 20 : 5);
  });
  const repeatedRules = precheckFlags.reduce((acc, f) => ((acc[f.rule_id] = (acc[f.rule_id] || 0) + 1), acc), {});
  Object.values(repeatedRules).forEach(n => { if (n > 1) risk += (n - 1) * 10; });
  return clamp(risk);
}

function finalizeEvaluation(raw, session) {
  const product = clamp(raw.product_score ?? raw.product ?? 50);
  const objection = clamp(raw.objection_score ?? raw.objection ?? 50);
  const empathy = clamp(raw.empathy_score ?? raw.empathy ?? 50);
  const complianceRisk = Math.max(clamp(raw.compliance_risk ?? raw.complianceRisk ?? 0), riskFloor(session.precheckFlags));
  let total = Math.round(product * 0.25 + objection * 0.25 + (100 - complianceRisk) * 0.30 + empathy * 0.20);

  const hasRuleA = (session.precheckFlags || []).some(f => f.level === 'A');
  let scoreCap = 100;
  if (hasRuleA || complianceRisk >= 80) scoreCap = 40;
  else if (complianceRisk >= 61) scoreCap = 60;
  if (session.endType === 'negative' && session.negativeReason === 'compliance') scoreCap = Math.min(scoreCap, 40);
  total = Math.min(total, scoreCap);

  const trainingResult = total >= 80 ? '通过' : total >= 60 ? '建议复训' : '必须复训';
  const dataQuality = ['sufficient','partial','insufficient'].includes(raw.data_quality) ? raw.data_quality : 'partial';
  const rawFindings = Array.isArray(raw.findings) ? raw.findings : [];
  const rawActions = Array.isArray(raw.priority_actions) ? raw.priority_actions : [];
  const humanReview = (total >= 75 && total <= 84) || dataQuality !== 'sufficient' || rawFindings.some(x => /冲突|证据不足|人工/.test(`${x.basis || ''}${x.suggestion || ''}`));
  const trend = (session.stateSnapshots || []).map(x => ({ turn: x.turn, trust: x.trust, intent: x.intent, emotion: x.emotion }));
  const nextTraining = complianceRisk >= 40
    ? '优先复训“治疗边界与绝对化承诺”场景'
    : objection < 70 ? '优先复训当前画像的核心异议闭环' : empathy < 70 ? '优先复训情绪承接与开放式提问' : '进入更高难度画像训练';

  const findings = [...rawFindings];
  const deterministicFindings = (session.precheckFlags || []).map(f => ({
    dimension: '合规风险', severity: 'high', rule_id: f.rule_id,
    sales_quote: f.sales_quote, basis: f.rule_name, suggestion: '撤回越界承诺，说明产品边界并建议按医嘱处理。'
  }));
  deterministicFindings.forEach(item => {
    if (!findings.some(x => x.rule_id === item.rule_id && x.sales_quote === item.sales_quote)) findings.unshift(item);
  });

  const issues = findings.slice(0, 6).map(x => `${x.rule_id ? `[${x.rule_id}] ` : ''}${x.basis || x.suggestion || '需要改进'}`);
  const suggestions = [...new Set([...rawActions, ...findings.map(x => x.suggestion).filter(Boolean)])].slice(0, 5);

  const evidence = Array.isArray(session.knowledgeEvidence) ? session.knowledgeEvidence : [];
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const requestedPoints = Array.isArray(raw.memorization_points) ? raw.memorization_points : [];
  let knowledgePoints = requestedPoints
    .map(item => {
      const knowledgeId = String(item.knowledge_id || item.knowledgeId || '').trim();
      const source = evidenceById.get(knowledgeId);
      const point = String(item.point || '').trim();
      if (!source || !point) return null;
      return { knowledgeId, title:source.title, point, source:source.source };
    })
    .filter(Boolean)
    .filter((item, index, list) => list.findIndex(x => x.knowledgeId === item.knowledgeId && x.point === item.point) === index)
    .slice(0, 6);

  // 模型评分不可用或未返回该字段时，仍给出可读的知识内容，而不是裸索引。
  if (!knowledgePoints.length) {
    knowledgePoints = evidence.slice(0, 5).map(item => ({
      knowledgeId:item.id,
      title:item.title,
      point:String(item.content || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      source:item.source
    }));
  }

  return {
    product, objection, complianceRisk, compliance: complianceRisk, empathy, total,
    scoreFormula: '产品知识×25% + 异议应对×25% + (100-合规风险)×30% + 共情沟通×20%',
    scoreCap, trainingResult, humanReview, dataQuality,
    endType: session.endType || 'neutral', endReason: session.endReason || null,
    summary: raw.summary || '已按完整对话、知识库证据和合规预检完成评价。',
    strengths: Array.isArray(raw.strengths) ? raw.strengths : [], findings,
    objectionCoverage: Array.isArray(raw.objection_coverage) ? raw.objection_coverage : [],
    inquiryCoverage: raw.inquiry_coverage || { asked: [], missed: [] },
    issues, suggestions, priorityActions: rawActions,
    trustTrend: trend, bestQuotes: raw.best_quotes || {}, nextTraining,
    precheckFlags: session.precheckFlags || [],
    knowledgePoints,
    evidenceIds: [...new Set(evidence.map(x => x.id))]
  };
}

function fallbackEvaluation(session) {
  const sales = (session.history || []).filter(m => m.speaker === 'sales').map(m => m.content);
  const joined = sales.join(' ');
  const inquiryCount = (joined.match(/请问|有没有|多久|目前|检查|血常规|用药|治疗方案/g) || []).length;
  const empathyCount = (joined.match(/理解|担心|焦虑|辛苦|不容易|着急/g) || []).length;
  const boundaryCount = (joined.match(/不能替代|遵医嘱|主治医生|咨询医生|咨询药师|不能保证|因人而异/g) || []).length;
  const flags = session.precheckFlags || [];
  return {
    product_score: clamp(55 + Math.min(25, boundaryCount * 5) - flags.filter(f => f.level !== 'C').length * 15),
    objection_score: clamp(40 + Math.min(40, inquiryCount * 6) + Math.min(15, boundaryCount * 5)),
    compliance_risk: riskFloor(flags),
    empathy_score: clamp(40 + Math.min(45, empathyCount * 12) + Math.min(10, inquiryCount * 2)),
    data_quality: sales.length >= 3 ? 'partial' : 'insufficient',
    strengths: [], findings: [], objection_coverage: [],
    inquiry_coverage: { asked: inquiryCount ? ['对话中存在主动询问'] : [], missed: inquiryCount ? [] : ['缺少对客户情况的主动询问'] },
    priority_actions: ['围绕客户核心异议完成“确认—解释—边界—下一步”闭环。'],
    memorization_points: [],
    best_quotes: { good: '', bad: flags[0]?.sales_quote || '' },
    summary: '评分模型不可用，已使用本地确定性规则生成保守评分；建议恢复模型后重新评价。'
  };
}

async function evaluateConversation(persona, session) {
  const evidence = buildEvaluationContext(session.history, 12);
  session.knowledgeEvidence = evidence;
  const transcript = (session.history || []).map(m => `[${m.turnId}] ${m.speaker === 'sales' ? '销售员' : `消费者(${persona.name})`}：${m.content}`).join('\n');
  const prompt = `【完整消费者画像】\n${JSON.stringify(persona, null, 2)}\n\n【会话状态】\n${JSON.stringify({
    revealedInformationIds: session.revealedInformationIds,
    triggeredObjectionIds: session.triggeredObjectionIds,
    resolvedObjectionIds: session.resolvedObjectionIds,
    endType: session.endType,
    endReason: session.endReason,
    stateSnapshots: session.stateSnapshots
  }, null, 2)}\n\n【程序合规预检】\n${JSON.stringify(session.precheckFlags || [], null, 2)}\n\n【知识库证据】\n${evidence.map(x => `【${x.id}｜${x.title}】\n${x.content}\n来源：${x.source}`).join('\n\n')}\n\n【完整对话】\n${transcript}`;

  let raw;
  try {
    const { content } = await chat({ system: EVAL_SYSTEM, messages: [{ role: 'user', content: prompt }], json: true, temperature: 0.3, maxTokens: 8192 });
    raw = extractJSON(content);
    if (!raw) throw new Error('评分 Agent JSON 解析失败');
  } catch (error) {
    console.warn('[Evaluator] 模型评分失败，使用本地规则降级：', error.message);
    raw = fallbackEvaluation(session);
    raw.fallback_reason = error.message;
  }
  const report = finalizeEvaluation(raw, session);
  if (raw.fallback_reason) report.fallbackReason = raw.fallback_reason;
  return report;
}

module.exports = { evaluateConversation, finalizeEvaluation, fallbackEvaluation, riskFloor };
