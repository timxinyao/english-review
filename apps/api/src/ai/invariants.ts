import {
  reconstructFromSegments,
  type AiTask,
  type CheckProductionResult,
  type GenerateReadResult,
  type GenerateUnderstandingQuestionsResult,
} from '@el/shared';

/** 英文词计数（Read 篇幅约束） */
export function englishWordCount(text: string): number {
  return (text.match(/[A-Za-z0-9'-]+/g) ?? []).length;
}

/**
 * 机器可判定的语义不变式（AI_RULES §13.3 第一层）。
 * 返回违规列表；空数组 = 通过。Schema 之外的检查在此执行。
 */
export function checkAiOutput(
  task: AiTask,
  output: unknown,
  vars: Record<string, unknown>,
): string[] {
  const violations: string[] = [];

  switch (task) {
    case 'generateUnderstandingQuestions': {
      const out = output as GenerateUnderstandingQuestionsResult;
      const expected = Number(vars.count ?? out.questions.length);
      if (out.questions.length !== expected) {
        violations.push(`题目数量 ${out.questions.length} ≠ count=${expected}`);
      }
      out.questions.forEach((q, i) => {
        const ids = new Set(q.options.map((o) => o.id));
        if (ids.size !== q.options.length) violations.push(`第 ${i + 1} 题 option id 重复`);
        const texts = new Set(q.options.map((o) => o.text));
        if (texts.size !== q.options.length) violations.push(`第 ${i + 1} 题选项文本重复`);
        if (!ids.has(q.correct_option_id))
          violations.push(`第 ${i + 1} 题 correct_option_id 不存在`);
      });
      break;
    }
    case 'generateClozeQuestions': {
      const out = output as { questions: { text_with_blank: string }[] };
      const expected = Number(vars.count ?? out.questions.length);
      if (out.questions.length !== expected) {
        violations.push(`题目数量 ${out.questions.length} ≠ count=${expected}`);
      }
      break;
    }
    case 'generateProductionPrompt': {
      const out = output as { must_use: string; reference_answer: string };
      const target = String(vars.target ?? '');
      if (out.must_use !== target)
        violations.push(`must_use "${out.must_use}" ≠ target "${target}"`);
      const ref = out.reference_answer.toLowerCase();
      const targetLower = target.toLowerCase();
      // AI_RULES §9 允许正常词形变化（如 wear down → wore me down），
      // 因此判定为：完整 target 出现，或任一组成词（≥3 字符）出现
      const words = targetLower.split(/\s+/).filter((w) => w.length >= 3);
      const used =
        ref.includes(targetLower) || (words.length > 0 && words.some((w) => ref.includes(w)));
      if (!used) violations.push('reference_answer 未包含目标词');
      break;
    }
    case 'checkProduction': {
      const out = output as CheckProductionResult;
      const userAnswer = String(vars.user_answer ?? '');
      const { original, corrected } = reconstructFromSegments(out.segments);
      if (original !== userAnswer) {
        violations.push('segments 无法重建 user_answer');
      }
      if (corrected !== out.corrected_sentence) {
        violations.push('segments 无法重建 corrected_sentence');
      }
      break;
    }
    case 'generateRead': {
      const out = output as GenerateReadResult;
      const wc = englishWordCount(out.body);
      if (wc < 180 || wc > 400) violations.push(`正文词数 ${wc} 超出 180–400`);
      const focusIds = new Set(
        (Array.isArray(vars.focus_items) ? vars.focus_items : []).map(
          (f) => (f as { id: string }).id,
        ),
      );
      const covered = new Set(out.coverage.map((c) => c.learning_item_id));
      for (const id of focusIds) {
        if (!covered.has(id)) violations.push(`focus item ${id} 未出现在 coverage`);
      }
      out.checks.forEach((c, i) => {
        if (!c.options.some((o) => o.id === c.correct_option_id)) {
          violations.push(`第 ${i + 1} 道检查题 correct_option_id 不存在`);
        }
      });
      break;
    }
    case 'checkCloze':
    case 'judgeDuplicateMeaning':
      break;
  }

  return violations;
}
