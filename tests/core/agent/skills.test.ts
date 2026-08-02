import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSkillsSection, injectSkills } from '../../../src/core/agent/skills.ts';

const skillA = { name: '客服话术', description: '客服场景话术规范', content: '语气友好，先致谢。' };
const skillB = { name: '退款政策', content: '7 天内可退。' };

describe('skills: 格式化与注入', () => {
  it('formatSkillsSection 按 `## 技能：{name}` 拼接', () => {
    const section = formatSkillsSection([skillA, skillB]);
    assert.ok(section.startsWith('## 可用技能'));
    assert.ok(section.includes('## 技能：客服话术（客服场景话术规范）'));
    assert.ok(section.includes('语气友好，先致谢。'));
    assert.ok(section.includes('## 技能：退款政策'));
    assert.ok(section.includes('7 天内可退。'));
  });

  it('空技能返回空串', () => {
    assert.equal(formatSkillsSection([]), '');
    assert.equal(injectSkills('提示词', []), '提示词');
  });

  it('模板含 {{skills}} 占位符 → 原位替换', () => {
    const prompt = '你是客服。\n{{skills}}\n注意保密。';
    const out = injectSkills(prompt, [skillA]);
    assert.ok(!out.includes('{{skills}}'), '占位符应被替换');
    assert.ok(out.includes('你是客服。'));
    assert.ok(out.includes('注意保密。'));
    assert.ok(out.indexOf('你是客服') < out.indexOf('## 可用技能'));
    assert.ok(out.indexOf('## 可用技能') < out.indexOf('注意保密'));
  });

  it('无占位符 → 末尾追加', () => {
    const prompt = '你是客服。';
    const out = injectSkills(prompt, [skillA]);
    assert.equal(out.startsWith('你是客服。'), true);
    assert.ok(out.endsWith('语气友好，先致谢。'));
    assert.ok(out.includes('## 可用技能'));
  });
});
