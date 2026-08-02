import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_TEMPLATES, SKILLS, type SeedPrompt, type SeedSkill } from '../../scripts/templates-data.ts';

describe('专业模板库数据完整性', () => {
  it('提示词模板：8 个且 name 唯一、字段完整', () => {
    assert.equal(PROMPT_TEMPLATES.length, 8);
    const names = PROMPT_TEMPLATES.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'name 不得重复');
    for (const t of PROMPT_TEMPLATES as SeedPrompt[]) {
      assert.ok(t.name.trim(), 'name 必填');
      assert.ok(t.description.trim(), `description 必填（${t.name}）`);
      assert.ok(t.content.length > 100, `${t.name} 内容应专业完整（>100 字）`);
    }
  });

  it('技能：6 个且 name 唯一、字段完整', () => {
    assert.equal(SKILLS.length, 6);
    const names = SKILLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'name 不得重复');
    for (const t of SKILLS as SeedSkill[]) {
      assert.ok(t.name.trim(), 'name 必填');
      assert.ok(t.description.trim(), `description 必填（${t.name}）`);
      assert.ok(t.content.length > 100, `${t.name} 内容应专业完整（>100 字）`);
    }
  });

  it('提示词与技能 name 不交叉冲突', () => {
    const p = new Set(PROMPT_TEMPLATES.map((t) => t.name));
    for (const s of SKILLS) assert.ok(!p.has(s.name), `冲突：${s.name}`);
  });
});
