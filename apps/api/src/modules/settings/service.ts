import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type Settings, type UpdateSettingsRequest } from '@el/shared';
import { settings as settingsTable } from '../../db/schema.js';
import type { AppDatabase } from '../../db/client.js';
import { appError } from '../../lib/errors.js';

const ROW_ID = 1;

function nowIso(): string {
  return new Date().toISOString();
}

function toDto(row: {
  maxNewItemsPerDay: number;
  contentLevel: string;
  preferredTtsVoice: string | null;
  updatedAt: string;
}): Settings {
  return {
    maxNewItemsPerDay: row.maxNewItemsPerDay,
    contentLevel: row.contentLevel as Settings['contentLevel'],
    preferredTtsVoice: row.preferredTtsVoice,
    updatedAt: row.updatedAt,
  };
}

async function ensureRow(db: AppDatabase) {
  const existing = await db.select().from(settingsTable).where(eq(settingsTable.id, ROW_ID));
  if (existing.length === 0) {
    await db
      .insert(settingsTable)
      .values({ id: ROW_ID, ...DEFAULT_SETTINGS, updatedAt: nowIso() });
  }
}

export async function getSettings(db: AppDatabase): Promise<Settings> {
  await ensureRow(db);
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.id, ROW_ID));
  if (!row) throw appError('INTERNAL', '设置行读取失败');
  return toDto(row);
}

export async function updateSettings(
  db: AppDatabase,
  patch: UpdateSettingsRequest,
): Promise<Settings> {
  await ensureRow(db);
  await db
    .update(settingsTable)
    .set({ ...patch, updatedAt: nowIso() })
    .where(eq(settingsTable.id, ROW_ID));
  return getSettings(db);
}
