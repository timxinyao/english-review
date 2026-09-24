import type { AiProvider, ProviderRequest } from './index.js';

/**
 * 确定性 mock provider：仅用于单元/集成测试与 ai:eval 的 Schema/不变式管线验证，
 * 不追求语言质量。输出直接由结构化变量构造，保证可复现。
 */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function understanding(req: ProviderRequest): string {
  const count = num(req.vars.count, 3);
  const target = str(req.vars.target, 'target');
  const meaning = str(req.vars.meaning, 'meaning');
  const context = str(req.vars.source_example, `Someone uses ${target} in daily life.`);
  const questions = Array.from({ length: count }, (_, i) => ({
    kind: i % 2 === 0 ? 'context_meaning' : 'direct_meaning',
    context: i % 2 === 0 ? context : `We often see ${target} in real contexts.`,
    question: `这里的 ${target} 最接近什么意思？`,
    options: [
      { id: 'o1', text: `${meaning}（干扰1）` },
      { id: 'o2', text: meaning },
      { id: 'o3', text: '完全无关的含义A' },
      { id: 'o4', text: '完全无关的含义B' },
    ],
    correct_option_id: 'o2',
    explanation: `${target} 在当前义项下表示「${meaning}」。`,
  }));
  return JSON.stringify({ questions });
}

function cloze(req: ProviderRequest): string {
  const count = num(req.vars.count, 3);
  const target = str(req.vars.target, 'target');
  const questions = Array.from({ length: count }, (_, i) => ({
    text_with_blank: `In everyday life, people often ____ in situation number ${i + 1}.`,
    answer: target,
    accepted_answers: [target],
    explanation: `此处应填 ${target}。`,
  }));
  return JSON.stringify({ questions });
}

function checkCloze(req: ProviderRequest): string {
  const answer = str(req.vars.answer, 'answer');
  const userAnswer = str(req.vars.user_answer, '');
  const accepted = norm(userAnswer) === norm(answer);
  return JSON.stringify({
    accepted,
    canonical_answer: answer,
    reason: 'mock 判定：归一化后与标准答案一致。',
  });
}

function productionPrompt(req: ProviderRequest): string {
  const target = str(req.vars.target, 'target');
  const meaning = str(req.vars.meaning, 'meaning');
  const reference = str(req.vars.source_example, `They use ${target} naturally.`);
  return JSON.stringify({
    zh_prompt: `请描述一个能自然使用（${meaning}）的日常场景。`,
    must_use: target,
    reference_answer: reference,
    acceptance_notes: '允许正常时态、人称与单复数变化。',
  });
}

function checkProduction(req: ProviderRequest): string {
  const target = str(req.vars.target, 'target');
  const userAnswer = str(req.vars.user_answer, '');
  const reference = str(req.vars.reference_answer, `They use ${target} correctly.`);
  const used = norm(userAnswer).includes(norm(target));
  const result = used ? 'pass' : 'fail';
  const segments = used
    ? [{ text: userAnswer, type: 'same' as const }]
    : [
        { text: userAnswer, type: 'delete' as const },
        { text: reference, type: 'insert' as const },
      ];
  return JSON.stringify({
    result,
    corrected_sentence: used ? userAnswer : reference,
    segments,
    explanation: used ? 'mock：目标使用正确。' : 'mock：未使用目标表达。',
    better_version: null,
    personal_example_candidate: {
      eligible: false,
      quality_score: 0.1,
      reason: 'mock 输出，不参与个人例句。',
    },
  });
}

function read(req: ProviderRequest): string {
  const focus = Array.isArray(req.vars.focus_items)
    ? (req.vars.focus_items as { id: string; target: string }[])
    : [];
  const filler =
    'English is a practical tool for daily life. People use it at work, at school, and while ' +
    'travelling. Short paragraphs like this one help learners meet familiar words again in a ' +
    'natural way. ';
  const wordsPerFiller = filler.trim().split(/\s+/).length;
  const repeats = Math.ceil(200 / wordsPerFiller);
  const focusSentences = focus
    .map((f) => `In this story, the phrase ${f.target} shows up naturally in a small moment.`)
    .join(' ');
  let body = filler.repeat(repeats) + ' ' + focusSentences;
  const words = body.trim().split(/\s+/);
  if (words.length > 380) body = words.slice(0, 380).join(' ');

  const coverage = focus.map((f) => ({ learning_item_id: f.id, surface_form: f.target }));
  const checks = focus.slice(0, 1).map((f) => ({
    learning_item_id: f.id,
    question: `文中 ${f.target} 的意思是什么？`,
    options: [
      { id: 'o1', text: '见释义' },
      { id: 'o2', text: '干扰' },
      { id: 'o3', text: '干扰' },
      { id: 'o4', text: '干扰' },
    ],
    correct_option_id: 'o1',
  }));
  if (checks.length === 0) {
    checks.push({
      learning_item_id: 'none',
      question: '文章主要讲了什么？',
      options: [
        { id: 'o1', text: '日常英语' },
        { id: 'o2', text: '历史' },
      ],
      correct_option_id: 'o1',
    });
    coverage.push({ learning_item_id: 'none', surface_form: 'daily' });
  }
  return JSON.stringify({ title: 'A Mock Story', type: 'story', body, coverage, checks });
}

function duplicate(req: ProviderRequest): string {
  const existing = (req.vars.existing_item ?? {}) as { target?: string; meaning?: string };
  const candidate = (req.vars.candidate_item ?? {}) as { target?: string; meaning?: string };
  const sameTarget = norm(str(existing.target)) === norm(str(candidate.target));
  const sameMeaning = norm(str(existing.meaning)) === norm(str(candidate.meaning));
  const decision = sameTarget && sameMeaning ? 'skip_exact_duplicate' : sameTarget ? 'merge' : 'new_item';
  return JSON.stringify({
    decision,
    confidence: 0.6,
    reason: 'mock 判定：仅比较 target/meaning 归一化结果。',
  });
}

export function createMockProvider(): AiProvider {
  return {
    name: 'mock',
    async complete(req: ProviderRequest): Promise<string> {
      switch (req.task) {
        case 'generateUnderstandingQuestions':
          return understanding(req);
        case 'generateClozeQuestions':
          return cloze(req);
        case 'checkCloze':
          return checkCloze(req);
        case 'generateProductionPrompt':
          return productionPrompt(req);
        case 'checkProduction':
          return checkProduction(req);
        case 'generateRead':
          return read(req);
        case 'judgeDuplicateMeaning':
          return duplicate(req);
      }
    },
  };
}
