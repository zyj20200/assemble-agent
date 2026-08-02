/**
 * Skills 注入（DESIGN.md §6.5）
 *
 * 技能内容存 DB（skills 表），装配时注入系统提示词：
 * - 模板含 `{{skills}}` → 原位替换
 * - 无占位符 → 末尾追加 `## 可用技能` 章节
 * - 格式：`## 技能：{name}` + content（与设计文档一致）
 *
 * 演进：技能量大时切"索引 + read_skill 工具"渐进式披露（pi 原生机制，面向文件系统）。
 */

/** 技能定义（DB skills 表的运行时形态） */
export interface SkillDef {
  name: string;
  description?: string;
  content: string;
}

const SKILLS_PLACEHOLDER = '{{skills}}';

/** 拼接技能章节 */
export function formatSkillsSection(skills: SkillDef[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(
    (s) => `## 技能：${s.name}${s.description ? `（${s.description}）` : ''}\n\n${s.content}`,
  );
  return `## 可用技能\n\n${parts.join('\n\n')}`;
}

/** 把技能注入系统提示词（占位符替换 / 末尾追加） */
export function injectSkills(systemPrompt: string, skills: SkillDef[]): string {
  const section = formatSkillsSection(skills);
  if (!section) return systemPrompt;
  if (systemPrompt.includes(SKILLS_PLACEHOLDER)) {
    return systemPrompt.replace(SKILLS_PLACEHOLDER, section);
  }
  return `${systemPrompt}\n\n${section}`;
}
