/**
 * 灵枢智训 - 确定性会话规则
 * 模型负责自然语言，规则层负责合规预检、行为标签和状态增量。
 */
'use strict';

const RULES = {
  A01: { level: 'A', name: '宣称抗癌、治癌或缩小肿瘤', risk: 40 },
  A02: { level: 'A', name: '保证疗效、绝对安全或固定见效', risk: 40 },
  A03: { level: 'A', name: '暗示替代、中断规范治疗', risk: 40 },
  A04: { level: 'A', name: '鼓励禁忌或不建议人群使用', risk: 40 },
  A05: { level: 'A', name: '建议停药或不咨询医生', risk: 40 },
  B01: { level: 'B', name: '无依据扩展适应场景或数据', risk: 20 },
  B02: { level: 'B', name: '特殊人群未提示专业咨询', risk: 20 },
  C01: { level: 'C', name: '泛化为日常保健品或饮料', risk: 5 },
  X01: { level: 'A', name: '侮辱、攻击或驱赶客户', risk: 40 }
};

const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const normalize = text => String(text || '').replace(/\s+/g, '').replace(/[，。！？、；：,.!?;:'"“”‘’]/g, '');

function hasSafeBoundary(text, riskyPattern) {
  const t = normalize(text);
  const m = t.match(riskyPattern);
  if (!m) return false;
  const before = t.slice(Math.max(0, m.index - 12), m.index);
  return /(不能|不可以|不可|不应|不要|绝不能|不得|无法|不建议|严禁|并非|不是)/.test(before);
}

function isShortAffirmation(text) {
  const t = normalize(text);
  return /^(是的|是|对|对的|可以|没错|当然|嗯|嗯嗯|确实|就是这样)(呀|啊|的)?$/.test(t);
}

function latestConsumerText(history) {
  return [...(history || [])].reverse().find(m => m.speaker === 'consumer' || m.role === 'assistant')?.content || '';
}

function addFlag(flags, ruleId, quote, matchedText, confidence = 'high') {
  const rule = RULES[ruleId];
  if (!rule || flags.some(f => f.rule_id === ruleId && f.matched_text === matchedText)) return;
  flags.push({
    rule_id: ruleId,
    level: rule.level,
    rule_name: rule.name,
    risk_points: rule.risk,
    confidence,
    matched_text: matchedText,
    sales_quote: quote
  });
}

function analyzeSalesMessage(message, history = [], persona = null) {
  const raw = String(message || '').trim();
  const t = normalize(raw);
  const previousConsumer = normalize(latestConsumerText(history));
  const flags = [];
  const tags = [];

  if (/^(结束|结束对话|结束训练|停止训练|提交评分|开始评分|就到这里|先这样)$/.test(t)) {
    return { manualEnd: true, flags, behaviorTags: ['manual_end'], delta: { trust: 0, intent: 0, objection: 0 } };
  }

  if (/(你妈的|废物|滚出去|滚|去死|去别家)/.test(t)) addFlag(flags, 'X01', raw, RegExp.$1 || raw);

  const substitute = /(替代(?:治疗|化疗|升白针|药物)|代替(?:治疗|化疗|升白针|药物)|不用(?:打升白针|化疗|治疗|吃药|看医生|去医院)|停(?:药|化疗)|别去医院|升白针不用打)/;
  if (substitute.test(t) && !hasSafeBoundary(t, substitute)) addFlag(flags, 'A03', raw, t.match(substitute)?.[0] || raw);

  const riskyQuestion = /(是不是|能不能|可以不可以|是否).{0,8}(不用打升白针|不用化疗|不用治疗|停药|替代治疗|代替治疗|不去医院)/;
  if (isShortAffirmation(t) && riskyQuestion.test(previousConsumer)) {
    addFlag(flags, 'A03', raw, `对客户危险诱导“${latestConsumerText(history)}”作肯定回应`, 'high');
  }

  const guarantee = /(绝对安全|绝对没问题|完全没问题|保证有效|肯定有效|一定有效|一定能治|包治|一定能升上去|百分之百|100%|固定.{0,4}(天|周|月).{0,3}(见效|恢复|改善)|放心吃|尽管喝|随便喝)/;
  if (guarantee.test(t) && !hasSafeBoundary(t, guarantee)) addFlag(flags, 'A02', raw, t.match(guarantee)?.[0] || raw);

  const antiCancer = /(治好肿瘤|根治肿瘤|治疗肿瘤|抗肿瘤|抗癌|缩小肿瘤|杀死癌细胞)/;
  if (antiCancer.test(t) && !hasSafeBoundary(t, antiCancer)) addFlag(flags, 'A01', raw, t.match(antiCancer)?.[0] || raw);

  if (/(不用咨询医生|不用问医生|没必要问医生|自行停药|把药停了|不要吃医生开的药)/.test(t) && !hasSafeBoundary(t, /(不用咨询医生|不用问医生|没必要问医生|自行停药|把药停了|不要吃医生开的药)/)) {
    addFlag(flags, 'A05', raw, t.match(/(不用咨询医生|不用问医生|没必要问医生|自行停药|把药停了|不要吃医生开的药)/)?.[0] || raw);
  }

  const coldScenario = persona?.id === 'FAJ-R01' || /(感冒|咳嗽痰多)/.test(previousConsumer);
  const healthyLongTerm = persona?.id === 'FAJ-R02' || /(身体没问题|健康).{0,6}(长期|每天)/.test(previousConsumer);
  if (coldScenario && /(可以喝|能喝|放心喝|多喝|继续喝)/.test(t) && !/(不建议|不宜|不能|先别|暂停)/.test(t)) {
    addFlag(flags, 'A04', raw, t.match(/(可以喝|能喝|放心喝|多喝|继续喝)/)?.[0] || raw);
  }
  if (healthyLongTerm && /(可以|没问题|能).{0,6}(长期|每天|一直).{0,4}(喝|服用)/.test(t) && !/(不建议|不宜|不能)/.test(t)) {
    addFlag(flags, 'A04', raw, t.match(/(可以|没问题|能).{0,6}(长期|每天|一直).{0,4}(喝|服用)/)?.[0] || raw);
  }

  if (/(理解|能理解|担心|焦虑|不容易|辛苦|体谅|着急)/.test(t)) tags.push('empathy');
  if (/(请问|能否|方便说|可以告诉我|目前|最近|多久|有没有|是否)/.test(t)) tags.push('inquiry');
  if (/(血常规|检查结果|化验单|复查|血红蛋白|白细胞|用药情况|正在吃|治疗方案)/.test(t)) tags.push('medical_information_inquiry');
  if (/(不能替代|不可以替代|不可替代|不能停|不要停|继续规范治疗)/.test(t)) tags.push('treatment_boundary');
  if (/(遵医嘱|主治医生|咨询医生|咨询医师|咨询药师|医生指导)/.test(t)) tags.push('professional_referral');
  if (/(不能保证|无法保证|因人而异|根据检查|结合具体情况)/.test(t)) tags.push('non_guarantee_boundary');
  if (/(下一步|可以先|建议先|带着.{0,6}(报告|用药)|确认后)/.test(t)) tags.push('safe_next_step');

  let trust = -2, intent = -1, objection = 1;
  if (tags.includes('empathy')) { trust += 5; intent += 2; objection -= 2; }
  if (tags.includes('inquiry')) { trust += 2; objection -= 1; }
  if (tags.includes('medical_information_inquiry')) { trust += 3; objection -= 1; }
  if (tags.includes('treatment_boundary')) { trust += 5; intent += 2; objection -= 2; }
  if (tags.includes('professional_referral')) { trust += 4; intent += 2; objection -= 1; }
  if (tags.includes('non_guarantee_boundary')) { trust += 2; objection -= 1; }
  if (tags.includes('safe_next_step')) { trust += 2; intent += 2; objection -= 1; }

  if (flags.length) {
    trust = flags.some(f => f.rule_id === 'X01') ? -100 : -30;
    intent = -40;
    objection = 5;
  }

  return {
    manualEnd: false,
    flags,
    behaviorTags: [...new Set(tags)],
    delta: { trust, intent, objection },
    hardStop: flags.some(f => f.level === 'A')
  };
}

function matchHiddenInformation(persona, message, alreadyRevealed = []) {
  const t = normalize(message);
  return (persona.hidden || []).map((item, index) => ({
    id: `${persona.id}-H${String(index + 1).padStart(2, '0')}`,
    trigger: item.trigger,
    info: item.info
  })).filter(item => !alreadyRevealed.includes(item.id) &&
    item.trigger.split(/[\/、，或]/).some(term => {
      const key = normalize(term).replace(/(是否|有没有|什么|情况|开放式追问|最|目前|具体)/g, '');
      return key.length >= 2 && (t.includes(key) || [...key].filter(c => t.includes(c)).length >= Math.min(3, key.length));
    })).slice(0, 2);
}

function applyDelta(state, delta) {
  state.trust = clamp(state.trust + (delta.trust || 0));
  state.intent = clamp(state.intent + (delta.intent || 0));
  state.objectionIntensity = Math.max(1, Math.min(5, Math.round(state.objectionIntensity + (delta.objection || 0))));
  if ((delta.trust || 0) >= 4) state.emotion = '逐渐缓和';
  if ((delta.trust || 0) <= -10) state.emotion = '警惕/不满';
}

module.exports = { RULES, analyzeSalesMessage, matchHiddenInformation, applyDelta, clamp, normalize };
