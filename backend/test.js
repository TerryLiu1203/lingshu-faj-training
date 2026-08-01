'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeSalesMessage } = require('./rules');
const { loadKB, search, getChunks } = require('./knowledge');
const { finalizeEvaluation } = require('./evaluator-agent');
const { checkRateLimit, rateLimits } = require('./server');

function testRules() {
  const history = [{ speaker:'consumer', content:'喝这个是不是就不用打升白针了？' }];
  const safe = analyzeSalesMessage('这个不能替代升白针，也不要停治疗，建议先问主治医生。', history, { id:'FAJ-C05' });
  assert.strictEqual(safe.hardStop, false, '安全边界表述不应误判为替代治疗');
  assert(safe.behaviorTags.includes('treatment_boundary'));

  const contextual = analyzeSalesMessage('是的', history, { id:'FAJ-C05' });
  assert(contextual.flags.some(f => f.rule_id === 'A03'), '对危险诱导的短肯定必须识别');

  const guarantee = analyzeSalesMessage('放心，保证有效，七天一定见效。', [], { id:'FAJ-C01' });
  assert(guarantee.flags.some(f => f.rule_id === 'A02'));

  const manual = analyzeSalesMessage('结束训练', [], null);
  assert.strictEqual(manual.manualEnd, true);
}

function testKnowledge() {
  loadKB();
  assert(getChunks().length >= 45, '应加载审核版编号知识条目');
  const cold = search('感冒咳嗽痰多可以服用吗', 5);
  assert(cold.some(x => /感冒|注意事项|慎用/.test(`${x.title}${x.content}`)), '感冒注意事项应能召回');
  const cancer = search('化疗升白针替代治疗保证有效', 6);
  assert(cancer.some(x => /化疗|白细胞|肿瘤|替代|保证/.test(`${x.title}${x.content}`)), '肿瘤治疗边界应能召回');
}

function testScoring() {
  const session = {
    precheckFlags:[{ rule_id:'A03', level:'A', risk_points:40, sales_quote:'不用打升白针' }],
    endType:'negative', negativeReason:'compliance', endReason:'红线',
    stateSnapshots:[{ turn:0, trust:45, intent:60, emotion:'焦虑' }], knowledgeEvidence:[]
  };
  const report = finalizeEvaluation({
    product_score:80, objection_score:75, compliance_risk:40, empathy_score:80,
    data_quality:'sufficient', findings:[], strengths:[], priority_actions:[]
  }, session);
  assert.strictEqual(report.complianceRisk, 40);
  assert(report.total <= 40, 'A类规则必须封顶40分');
  assert.strictEqual(report.scoreCap, 40);
}

function testFrontendSyntax() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'output', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x => x[1]);
  assert(scripts.length, '页面中应存在脚本');
  scripts.forEach(source => new Function(source)); // 仅编译，不执行 DOM 逻辑
}

function testRateLimit() {
  rateLimits.clear();
  const req = { headers:{ 'x-forwarded-for':'203.0.113.8, 10.0.0.1' }, socket:{ remoteAddress:'127.0.0.1' } };
  const start = 1_000_000;
  for (let i = 0; i < 10; i++) assert.strictEqual(checkRateLimit(req, start + i).allowed, true);
  const blocked = checkRateLimit(req, start + 10);
  assert.strictEqual(blocked.allowed, false, '同一IP第11次请求必须被限流');
  assert.strictEqual(blocked.limit, 10);
  assert.strictEqual(checkRateLimit(req, start + 60_001).allowed, true, '下一分钟应重置额度');
  rateLimits.clear();
}

testRules();
testKnowledge();
testScoring();
testFrontendSyntax();
testRateLimit();
console.log('✓ 规则、知识检索、评分封顶、前端语法和IP限流测试通过');
