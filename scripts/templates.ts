/**
 * 专业模板播种：npm run templates
 *
 * - 对 PROMPT_TEMPLATES / SKILLS 按 name upsert（存在则升级内容，否则新增）
 * - 清理明确为 demo 的旧条目（测试/演示期间创建）
 * - 幂等：可重复执行
 */

import { eq } from 'drizzle-orm';
import { openDb, schema } from '../src/db/index.ts';
import { PROMPT_TEMPLATES, SKILLS } from './templates-data.ts';

const { db } = openDb();

let added = 0, updated = 0, removed = 0;

/** upsert：存在更新，不存在插入 */
function upsert<T extends { name: string; description: string; content: string }>(
  table: typeof schema.prompts | typeof schema.skills,
  items: T[],
  kind: string,
): void {
  for (const item of items) {
    const existing = db.select().from(table).where(eq(table.name, item.name)).get();
    if (existing) {
      db.update(table)
        .set({ content: item.content, description: item.description, ...('updatedAt' in table ? { updatedAt: new Date() } : {}) })
        .where(eq(table.id, existing.id))
        .run();
      updated++;
      console.log(`  ↻ 更新 ${kind}：${item.name}`);
    } else {
      db.insert(table).values({ name: item.name, description: item.description, content: item.content }).run();
      added++;
      console.log(`  ＋ 新增 ${kind}：${item.name}`);
    }
  }
}

console.log('== 提示词模板 ==');
upsert(schema.prompts, PROMPT_TEMPLATES, '提示词');
console.log('== 技能 ==');
upsert(schema.skills, SKILLS, '技能');

// 清理明确 demo 条目（不影响用户自建条目）
const DEMO_PROMPTS = ['客服基线'];
const DEMO_SKILLS = ['退款政策', '格式规范'];
for (const name of DEMO_PROMPTS) {
  const x = db.select().from(schema.prompts).where(eq(schema.prompts.name, name)).get();
  if (x) {
    db.delete(schema.prompts).where(eq(schema.prompts.id, x.id)).run();
    removed++;
    console.log(`  ✕ 清理 demo 提示词：${name}`);
  }
}
for (const name of DEMO_SKILLS) {
  const x = db.select().from(schema.skills).where(eq(schema.skills.name, name)).get();
  if (x) {
    db.delete(schema.skills).where(eq(schema.skills.id, x.id)).run();
    removed++;
    console.log(`  ✕ 清理 demo 技能：${name}`);
  }
}

console.log(`\n完成：新增 ${added} / 升级 ${updated} / 清理 demo ${removed}`);
console.log(`当前：提示词 ${db.select().from(schema.prompts).all().length} 个，技能 ${db.select().from(schema.skills).all().length} 个`);
