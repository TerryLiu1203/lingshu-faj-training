/**
 * 灵枢智训 - 消费者陪练 Agent
 * 只负责“像客户一样回应”；状态、合规与最终评分由程序和评分 Agent 负责。
 */
'use strict';

const { chat, extractJSON } = require('./kimi');
const { buildContext } = require('./knowledge');

function buildConsumerSystemPrompt(persona, state, kbContext, availableHidden = []) {
  const hidden = (persona.hidden || []).map((h, i) => ({ id: `${persona.id}-H${String(i + 1).padStart(2, '0')}`, ...h }));
  const objections = (persona.objections || []).map((o, i) => ({ id: `${persona.id}-O${String(i + 1).padStart(2, '0')}`, text: o }));
  return `你是“灵枢智训”中的消费者陪练 Agent，正在与复方阿胶浆销售人员进行压力训练。

【唯一职责】始终以第一人称扮演消费者并自然回应。不得评分、教学、纠错、给标准话术、暴露画像或承认自己是 AI。

【消费者画像】
- 身份：${persona.identity}
- 显性需求：${persona.explicitNeed}
- 产品认知：${persona.awareness}
- 沟通风格：${persona.style}
- 已说出的开场白：${persona.opener}

【隐藏信息规则】
以下信息不可主动泄露。程序本轮允许释放的信息只有“本轮可释放信息”；每轮最多释放 1—2 条，不重复已释放信息。
全部隐藏项：
${hidden.map(h => `- ${h.id}：触发条件“${h.trigger}”；内容“${h.info}”`).join('\n')}
本轮可释放信息：${availableHidden.length ? availableHidden.map(h => `${h.id}：${h.info}`).join('；') : '无'}
已经释放：${(state.revealedInformationIds || []).join('、') || '无'}

【异议池】
${objections.map(o => `- ${o.id}：${o.text}`).join('\n')}
已经触发：${(state.triggeredObjectionIds || []).join('、') || '无'}
已经解决：${(state.resolvedObjectionIds || []).join('、') || '无'}
规则：每轮最多提出一个尚未解决的异议；销售员没有回应核心顾虑时可继续追问，但不要机械重复原句。

【反应规则】
${(persona.reactions || []).map(r => `- ${r}`).join('\n')}

【内部状态，仅用于控制语气】
- 轮次：${state.turnCount}/${state.maxTurns}
- 阶段：${state.stage}
- 情绪：${state.emotion}
- 信任度：${state.trust}/100
- 购买意愿：${state.intent}/100
- 异议强度：${state.objectionIntensity}/5

【知识边界】
你不是医生或产品专家。销售员说错普通知识时不要替系统纠错；遇到保证疗效、替代规范治疗或明显越界承诺时，应以真实客户口吻警觉、质疑或结束。
参考片段只用于保持反应一致，不得逐条背诵：
${kbContext || '无'}

【输出】严格输出一个 JSON 对象，不要 Markdown：
{
  "visible_reply": "消费者本轮可见回复",
  "behavior_tags": ["自然语言行为标签"],
  "newly_revealed_information_ids": ["仅可从本轮可释放信息中选择"],
  "triggered_objection_id": "本轮提出的异议ID或null",
  "resolved_objection_ids": ["判断已被销售员充分回应的异议ID"],
  "next_dialogue_stage": "inquiry|clarification|objection|closing",
  "emotion_type": "自然语言情绪",
  "risk_signals": [],
  "end_signal": false,
  "end_type": null,
  "handoff_reason": null
}

只有以下情况可建议结束：顾虑已经得到安全、完整回应且有明确下一步（positive）；信任崩塌或对方越过医疗合规红线（negative）。否则继续对话。`; 
}

async function runConsumerTurn(persona, state, history, options = {}) {
  if (options.endNegative) {
    return { reply: buildNegativeEnding(persona, state), structured: { end_signal: true, end_type: 'negative' } };
  }

  const lastSales = [...history].reverse().find(m => m.speaker === 'sales' || m.role === 'user')?.content || '';
  const kbContext = buildContext(`${persona.tag} ${lastSales}`, 4);
  const system = buildConsumerSystemPrompt(persona, state, kbContext, options.availableHidden || []);
  const messages = history.map(m => ({
    role: (m.speaker === 'sales' || m.role === 'user') ? 'user' : 'assistant',
    content: m.content
  }));

  const { content, usage } = await chat({ system, messages, json: true, temperature: 0.8, maxTokens: 4096 });
  const parsed = extractJSON(content) || {};
  const reply = String(parsed.visible_reply || parsed.reply || content || '').trim();
  if (!reply) throw new Error('消费者 Agent 未生成可见回复');

  return {
    reply,
    usage,
    structured: {
      behavior_tags: Array.isArray(parsed.behavior_tags) ? parsed.behavior_tags : [],
      newly_revealed_information_ids: Array.isArray(parsed.newly_revealed_information_ids) ? parsed.newly_revealed_information_ids : [],
      triggered_objection_id: parsed.triggered_objection_id || null,
      resolved_objection_ids: Array.isArray(parsed.resolved_objection_ids) ? parsed.resolved_objection_ids : [],
      next_dialogue_stage: ['inquiry','clarification','objection','closing'].includes(parsed.next_dialogue_stage) ? parsed.next_dialogue_stage : null,
      emotion_type: parsed.emotion_type || null,
      risk_signals: Array.isArray(parsed.risk_signals) ? parsed.risk_signals : [],
      end_signal: Boolean(parsed.end_signal),
      end_type: ['positive','neutral','negative'].includes(parsed.end_type) ? parsed.end_type : null,
      handoff_reason: parsed.handoff_reason || null
    }
  };
}

function buildNegativeEnding(persona, state) {
  const quote = state.redQuote ? `你刚才说“${String(state.redQuote).slice(0, 35)}”` : '';
  const map = {
    X01: '你这是什么态度？我不想再聊了。',
    A01: `${quote}，这个承诺太大了，我还是去问主治医生。`,
    A02: `${quote}，你凭什么这么肯定？我还是先问医生。`,
    A03: `${quote}？这涉及停治疗，我不能听你一句话就决定，先去问主治医生。`,
    A04: `${quote}？我还是不放心，先确认清楚再说。`,
    A05: `${quote}？停药的事我只听医生的，先不买了。`
  };
  return map[state.redLine] || persona.endNegative || '算了，我还是先去问医生吧。';
}

module.exports = { runConsumerTurn, buildConsumerSystemPrompt, buildNegativeEnding };
