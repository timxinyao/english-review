import { describe, expect, it } from 'vitest';
import { LibraryImportItem } from './import-export.js';
import { BackupExample } from './api/backup.js';
import { UpdateLearningItemRequest } from './api/library.js';
import { TodayTaskView } from './api/today.js';

const candidate = {
  type: 'word',
  target: 'gravity',
  meaning: '重力',
  source_example: 'Gravity pulls things down.',
};

describe('persisted source translation contracts', () => {
  it('retains imported translation rather than silently stripping it', () => {
    expect(
      LibraryImportItem.parse({ ...candidate, source_example_translation: '重力把物体向下拉。' }),
    ).toHaveProperty('source_example_translation', '重力把物体向下拉。');
    expect(LibraryImportItem.safeParse(candidate).success).toBe(true);
    expect(
      LibraryImportItem.safeParse({ ...candidate, source_example_translation: null }).success,
    ).toBe(true);
    expect(
      LibraryImportItem.safeParse({ ...candidate, source_example_translation: 123 }).success,
    ).toBe(false);
  });

  it('supports explicit translation edits and clearing while preserving omission', () => {
    expect(
      UpdateLearningItemRequest.parse({ sourceExampleTranslation: '重力把物体向下拉。' }),
    ).toEqual({ sourceExampleTranslation: '重力把物体向下拉。' });
    expect(UpdateLearningItemRequest.parse({ sourceExampleTranslation: null })).toEqual({
      sourceExampleTranslation: null,
    });
    expect(UpdateLearningItemRequest.parse({})).toEqual({});
  });

  it('preserves backup translations and reads old examples without them', () => {
    const example = { kind: 'source', text: 'Gravity pulls things down.' };
    expect(BackupExample.parse({ ...example, translation: '重力把物体向下拉。' })).toHaveProperty(
      'translation',
      '重力把物体向下拉。',
    );
    expect(BackupExample.safeParse(example).success).toBe(true);
  });

  it('retains Today translations while accepting legacy task DTOs', () => {
    const task = {
      taskId: 't',
      taskType: 'learn',
      dimension: 'understanding',
      origin: 'base',
      deferCount: 0,
      item: { id: 'i', type: 'word', target: 'gravity', meaning: '重力', ipa: null, notes: null },
      sourceExample: 'Gravity pulls things down.',
      supplementaryExamples: [],
      question: null,
    };
    expect(
      TodayTaskView.parse({ ...task, sourceExampleTranslation: '重力把物体向下拉。' }),
    ).toHaveProperty('sourceExampleTranslation', '重力把物体向下拉。');
    expect(TodayTaskView.safeParse(task).success).toBe(true);
  });
});
