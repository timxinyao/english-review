import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { learningItems } from '../src/db/schema.js';
import { createGlmProvider } from '../src/ai/provider/glm.js';

const config = loadConfig({
  ...(process.env as Record<string, string | undefined>),
  AUTH_PASSWORD: process.env.AUTH_PASSWORD ?? 'placeholder',
});
const provider = createGlmProvider(config);
const db = createDatabase(config.databasePath);

const items = db.select().from(learningItems).all();
const words = items.filter((i) => i.type === 'word' && !i.ipa);
console.log(`共 ${words.length} 个 word 缺音标`);

const IpaMap = z.record(z.string());
const results: Record<string, string> = {};
const BATCH = 10;

for (let bi = 0; bi < words.length; bi += BATCH) {
  const batch = words.slice(bi, bi + BATCH);
  const wordList = batch.map((w, idx) => `${idx + 1}. ${w.target}`).join('\n');
  const prompt = `给以下英语单词标注 IPA 音标（美式）。只输出 JSON 对象，格式 {"单词": "/音标/", ...}，不要其他内容。\n\n${wordList}`;

  try {
    const raw = await provider.complete({
      task: 'generateUnderstandingQuestions',
      model: 'glm-5.3-flash',
      temperature: 0.1,
      thinking: 'off',
      prompt,
      vars: {},
    });
    const clean = raw
      .replace(/```json?\n?/g, '')
      .replace(/```/g, '')
      .trim();
    const parsed = IpaMap.safeParse(JSON.parse(clean));
    if (parsed.success) {
      Object.assign(results, parsed.data);
    }
    console.log(
      `批次 ${bi / BATCH + 1}/${Math.ceil(words.length / BATCH)}：${Object.keys(parsed.success ? parsed.data : {}).length} 条`,
    );
  } catch (err) {
    console.error(`批次 ${bi / BATCH + 1} 失败:`, (err as Error).message.slice(0, 80));
  }
  await new Promise((r) => setTimeout(r, 800));
}

let updated = 0;
for (const [target, ipa] of Object.entries(results)) {
  const r = db
    .update(learningItems)
    .set({ ipa, updatedAt: new Date().toISOString() })
    .where(eq(learningItems.target, target))
    .run();
  updated += r.changes;
}
console.log(`\n已更新 ${updated} 个词的音标`);
writeFileSync('/tmp/ipa-results.json', JSON.stringify(results, null, 2));
console.log('明细存 /tmp/ipa-results.json');
