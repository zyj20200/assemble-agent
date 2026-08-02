/**
 * 文档解析器（从 knowledge-control 移植）
 *
 * 支持格式：txt / md / pdf / docx / csv / xlsx / xls
 * - 文本类直读；PDF 用 pdf-parse；docx 用 mammoth；表格用 papaparse + xlsx
 * - GBK/GB2312 编码自动检测（jschardet + iconv-lite），中文场景必备
 * - CSV/Excel 支持两种模式：
 *   - 普通模式：自动识别 问题/答案/索引 列（不区分大小写）
 *   - QA 模板模式（isQaCsv）：忽略表头，按列位置解析，支持多路召回
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import Papa from 'papaparse';
import XLSX from 'xlsx';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- jschardet 无默认导出类型
import jschardet from 'jschardet';
import iconv from 'iconv-lite';

import type { ParsedRow } from './types.ts';

/** 读取文件内容，自动处理 GBK/GB2312 编码 */
const readFileContent = async (filePath: string): Promise<string> => {
  const buffer = await readFile(filePath);
  const detection = jschardet.detect(buffer);

  if (detection && (detection.encoding === 'GB2312' || detection.encoding === 'GBK')) {
    return iconv.decode(buffer, 'gbk');
  }
  return buffer.toString('utf-8');
};

/**
 * 表格数据归一化（普通文档模式）：
 * - 问题列：q / question / 问题 / 题目
 * - 答案列：a / answer / 回答 / 答案
 * - 索引列：indexes / index / 索引
 * - 未找到问题列 → 整行格式化为 `Key: Value` 文本作为内容
 */
export const normalizeDataset = (data: unknown[]): ParsedRow[] => {
  return data.map((item) => {
    const record = item as Record<string, unknown>;
    let q = '';
    let a = '';
    let indexes: string[] = [];

    Object.keys(record).forEach((key) => {
      const k = key.toLowerCase().trim();
      if (['q', 'question', '问题', '题目'].includes(k)) {
        q = String(record[key] ?? '');
      } else if (['a', 'answer', '回答', '答案'].includes(k)) {
        a = String(record[key] ?? '');
      } else if (['indexes', 'index', '索引'].includes(k)) {
        const val = record[key];
        if (typeof val === 'string') {
          indexes = [val];
        } else if (Array.isArray(val)) {
          indexes = val.map((v) => String(v));
        }
      }
    });

    // 无问题列 → 整行作为内容
    if (!q) {
      q = Object.entries(record)
        .filter(([_, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    }

    return { q, a, indexes };
  });
};

/**
 * 解析文件为纯文本（普通文档）或 QA 行（表格 QA 模式）。
 * 无扩展名时按 .txt 处理。
 */
export const parseFile = async (
  filePath: string,
  fileName?: string,
  isQaCsv = false,
): Promise<string | ParsedRow[]> => {
  let ext = path.extname(filePath).toLowerCase();

  // 临时文件可能丢失扩展名，用原始文件名兜底
  if (!ext && fileName) {
    ext = path.extname(fileName).toLowerCase();
  }

  // 仍无扩展名 → 默认按文本处理
  if (!ext) {
    ext = '.txt';
  }

  if (ext === '.csv') {
    const content = await readFileContent(filePath);
    return new Promise((resolve, reject) => {
      if (isQaCsv) {
        // QA 模板模式：无表头，按列位置解析（第 1 列问题，第 2 列答案，第 3 列起为索引）
        Papa.parse<string[]>(content, {
          header: false,
          skipEmptyLines: true,
          complete: (results) => {
            const rows = results.data
              .slice(1) // 跳过表头行
              .map((row) => ({
                q: row[0] || '',
                a: row[1] || '',
                indexes: row.slice(2).filter((i) => i && i.trim()),
              }))
              .filter((r) => r.q);
            resolve(rows);
          },
          error: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
        });
      } else {
        // 普通模式：CSV 按纯文本处理
        resolve(content);
      }
    });
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const worksheet = workbook.Sheets[sheetName]!;
    const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet);
    return normalizeDataset(jsonData);
  }

  if (ext === '.txt' || ext === '.md') {
    return readFileContent(filePath);
  }

  if (ext === '.pdf') {
    const dataBuffer = await readFile(filePath);
    const data = await pdf(dataBuffer);
    return data.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  throw new Error(`Unsupported file extension: ${ext}`);
};

/** 支持的文件扩展名集合（用于上传前校验） */
export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.csv', '.xlsx', '.xls'] as const;

export const isSupportedExtension = (fileName: string): boolean => {
  const ext = path.extname(fileName).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext) || ext === '';
};
