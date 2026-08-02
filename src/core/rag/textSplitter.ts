/**
 * 文本分块器（从 knowledge-control 移植，源自 FastGPT 的分块算法）
 *
 * 特性：
 * - Markdown 表格整块保留（strIsMdTable + markdownTableSplit）
 * - 自定义分隔符 `-----CUSTOM_SPLIT_SIGN-----` 强制分块
 * - 按 Markdown 标题深度递归切分（paragraphChunkDeep），标题随块保留
 * - 中文标点（。！？；，）优先断句，避免切断语义
 * - overlap 比例控制块间重叠；maxSize 兜底防止超长块
 * - 代码块内容不跨块截断（codeBlockMarker 保护）
 * - simpleText 清理：中文间去空格、统一换行、压缩空白
 *
 * 纯函数、零依赖，可独立测试。
 */

/** 自定义强制分块分隔符：出现在文档中时，直接按它切分 */
export const CUSTOM_SPLIT_SIGN = '-----CUSTOM_SPLIT_SIGN-----';

/** 默认单块硬上限（字符） */
const defaultMaxChunkSize = 8000;

/** 有效长度：去掉所有空白后的长度（对中文文本更合理） */
const getTextValidLength = (chunk: string) => chunk.replace(/\s+/g, '').length;

/**
 * 文本清理：
 * - 去除中文之间的空格
 * - 统一换行符，压缩连续空行
 * - 压缩连续空白为单空格，控制字符替换为空格
 */
const simpleText = (text = '') => {
  text = text.trim();
  // 中文之间去掉空白（保留换行）。
  // 注意：原版用 Java 风格字符类交集 [\s&&[^\n]]，JS 正则不支持，
  // 正确写法是 [^\S\n]（空白但排除换行）；且用前瞻避免 g 标志非重叠匹配
  // 导致只去掉部分空格，移植时已修复。
  text = text.replace(/([\u4e00-\u9fa5])[^\S\n]+(?=[\u4e00-\u9fa5])/g, '$1');
  text = text.replace(/\r\n|\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[^\S\n]{2,}/g, ' ');
  text = text.replace(/[\x00-\x08]/g, ' ');
  return text;
};

const getErrText = (err: unknown) =>
  err instanceof Error ? err.message : String(err ?? '');

export type SplitProps = {
  text: string;
  chunkSize: number;
  /** Markdown 标题切分深度（1-8，0 关闭）。默认 5 */
  paragraphChunkDeep?: number;
  /** 预留：段落最小长度阈值（当前算法未使用，保留兼容） */
  paragraphChunkMinSize?: number;
  /** 单块硬上限，默认 8000 */
  maxSize?: number;
  /** 重叠比例，默认 0.15 */
  overlapRatio?: number;
  /** 自定义分隔正则（字符串或正则数组），匹配处强制分块 */
  customReg?: string[];
};

export type TextSplitProps = Omit<SplitProps, 'text' | 'chunkSize'> & {
  chunkSize?: number;
};

export type SplitResponse = {
  chunks: string[];
  chars: number;
};

/** 判断是否为 Markdown 表格（表头 + 分隔行 + 数据行，均以 | 包裹） */
const strIsMdTable = (str: string) => {
  if (!str.includes('|')) return false;
  const lines = str.split('\n');
  if (lines.length < 2) return false;
  const headerLine = lines[0]!.trim();
  if (!headerLine.startsWith('|') || !headerLine.endsWith('|')) return false;
  const separatorLine = lines[1]!.trim();
  const separatorRegex = /^(\|[\s:]*-+[\s:]*)+\|$/;
  if (!separatorRegex.test(separatorLine)) return false;
  for (let i = 2; i < lines.length; i++) {
    const dataLine = lines[i]!.trim();
    if (dataLine && (!dataLine.startsWith('|') || !dataLine.endsWith('|'))) {
      return false;
    }
  }
  return true;
};

/** Markdown 表格分块：表头随每个分块保留，按行累积到 chunkSize */
const markdownTableSplit = (props: SplitProps): SplitResponse => {
  let { text = '', chunkSize, maxSize = defaultMaxChunkSize } = props;
  const splitText2Lines = text.split('\n').filter((line) => line.trim());
  if (splitText2Lines.length < 2) {
    return { chunks: [text], chars: text.length };
  }

  const header = splitText2Lines[0]!;
  const headerSize = header.split('|').length - 2;
  const mdSplitString = `| ${new Array(headerSize > 0 ? headerSize : 1)
    .fill(0)
    .map(() => '---')
    .join(' | ')} |`;

  const chunks: string[] = [];
  const defaultChunk = `${header}\n${mdSplitString}\n`;
  let chunk = defaultChunk;

  for (let i = 2; i < splitText2Lines.length; i++) {
    const chunkLength = getTextValidLength(chunk);
    const nextLineLength = getTextValidLength(splitText2Lines[i]!);

    if (chunkLength + nextLineLength > chunkSize) {
      if (chunkLength > maxSize) {
        const newChunks = commonSplit({
          ...props,
          text: chunk.replace(defaultChunk, '').trim(),
        }).chunks;
        chunks.push(...newChunks);
      } else {
        chunks.push(chunk);
      }
      chunk = defaultChunk;
    }
    chunk += `${splitText2Lines[i]}\n`;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  return {
    chunks,
    chars: chunks.reduce((sum, item) => sum + item.length, 0),
  };
};

/**
 * 通用递归分块：
 * 按优先级依次尝试 自定义分隔符 → Markdown 标题 → 代码块 → 表格 → 空行 → 换行 → 中文标点，
 * 每级切分后递归下钻，直到块长满足要求；支持块间重叠与标题透传。
 */
const commonSplit = (props: SplitProps): SplitResponse => {
  let {
    text = '',
    chunkSize,
    paragraphChunkDeep = 5,
    paragraphChunkMinSize = 100, // eslint-disable-line @typescript-eslint/no-unused-vars -- 保留兼容
    maxSize = defaultMaxChunkSize,
    overlapRatio = 0.15,
    customReg = [],
  } = props;

  const splitMarker = 'SPLIT_HERE_SPLIT_HERE';
  const codeBlockMarker = 'CODE_BLOCK_LINE_MARKER';
  const overlapLen = Math.round(chunkSize * overlapRatio);

  // 保护代码块：内部换行临时替换，避免被后续规则切碎
  text = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) =>
    match.replace(/\n/g, codeBlockMarker),
  );
  text = text.replace(/(\r?\n|\r){3,}/g, '\n\n\n');

  const customRegLen = customReg.length;
  const markdownIndex = paragraphChunkDeep - 1;
  const forbidOverlapIndex = customRegLen + markdownIndex + 4;

  const markdownHeaderRules = ((deep?: number) => {
    if (!deep || deep === 0) return [];
    const maxDeep = Math.min(deep, 8);
    const rules: { reg: RegExp; maxLen: number }[] = [];
    for (let i = 1; i <= maxDeep; i++) {
      const hashSymbols = '#'.repeat(i);
      rules.push({
        reg: new RegExp(`^(${hashSymbols}\\s[^\\n]+\\n)`, 'gm'),
        maxLen: chunkSize,
      });
    }
    return rules;
  })(paragraphChunkDeep);

  const stepReges: { reg: RegExp | string; maxLen: number }[] = [
    ...customReg.map((text) => ({
      reg: text.replace(/\\n/g, '\n'),
      maxLen: maxSize,
    })),
    ...markdownHeaderRules,
    { reg: /([\n](```[\s\S]*?```|~~~[\s\S]*?~~~))/g, maxLen: maxSize },
    {
      reg: /(\n\|(?:[^\n|]*\|)+\n\|(?:[:\-\s]*\|)+\n(?:\|(?:[^\n|]*\|)*\n)*)/g,
      maxLen: chunkSize,
    },
    { reg: /(\n{2,})/g, maxLen: chunkSize },
    { reg: /([\n])/g, maxLen: chunkSize },
    { reg: /([。]|([a-zA-Z])\.\s)/g, maxLen: chunkSize },
    { reg: /([！]|!\s)/g, maxLen: chunkSize },
    { reg: /([？]|\?\s)/g, maxLen: chunkSize },
    { reg: /([；]|;\s)/g, maxLen: chunkSize },
    { reg: /([，]|,\s)/g, maxLen: chunkSize },
  ];

  const checkIsCustomStep = (step: number) => step < customRegLen;
  const checkIsMarkdownSplit = (step: number) =>
    step >= customRegLen && step <= markdownIndex + customRegLen;
  const checkForbidOverlap = (step: number) => step <= forbidOverlapIndex;

  /** 按当前步骤的正则切分文本，返回带标题/上限的片段 */
  const getSplitTexts = ({ text, step }: { text: string; step: number }) => {
    if (step >= stepReges.length) {
      return [
        {
          text,
          title: '',
          chunkMaxSize: chunkSize,
        },
      ];
    }

    const isCustomStep = checkIsCustomStep(step);
    const isMarkdownSplit = checkIsMarkdownSplit(step);

    const { reg, maxLen } = stepReges[step]!;

    const replaceText = (() => {
      if (typeof reg === 'string') {
        let tmpText = text;
        reg.split('|').forEach((itemReg) => {
          tmpText = tmpText.replaceAll(
            itemReg,
            (() => {
              if (isCustomStep) return splitMarker;
              if (isMarkdownSplit) return `${splitMarker}$1`;
              return `$1${splitMarker}`;
            })(),
          );
        });
        return tmpText;
      }

      return text.replace(
        reg,
        (() => {
          if (isCustomStep) return splitMarker;
          if (isMarkdownSplit) return `${splitMarker}$1`;
          return `$1${splitMarker}`;
        })(),
      );
    })();

    const splitTexts = replaceText.split(splitMarker).filter((part) => part.trim());

    return splitTexts
      .map((text) => {
        const matchTitle = isMarkdownSplit ? text.match(reg)?.[0] || '' : '';
        const chunkMaxSize = (() => {
          if (isCustomStep) return maxLen;
          return text.match(reg) === null ? chunkSize : maxLen;
        })();

        return {
          text: isMarkdownSplit ? text.replace(matchTitle, '') : text,
          title: matchTitle,
          chunkMaxSize,
        };
      })
      .filter((item) => !!item.title || !!item.text?.trim());
  };

  /** 计算上一块尾部需要保留的重叠文本 */
  const getOneTextOverlapText = ({ text, step }: { text: string; step: number }): string => {
    const forbidOverlap = checkForbidOverlap(step);
    const maxOverlapLen = chunkSize * 0.4;
    if (forbidOverlap || overlapLen === 0 || step >= stepReges.length) return '';

    const splitTexts = getSplitTexts({ text, step });
    let overlayText = '';

    for (let i = splitTexts.length - 1; i >= 0; i--) {
      const currentText = splitTexts[i]!.text;
      const newText = currentText + overlayText;
      const newTextLen = getTextValidLength(newText);

      if (newTextLen > overlapLen) {
        if (newTextLen > maxOverlapLen) {
          const recursiveText = getOneTextOverlapText({ text: newText, step: step + 1 });
          return recursiveText || overlayText;
        }
        return newText;
      }

      overlayText = newText;
    }
    return overlayText;
  };

  /** 递归切分主函数 */
  const splitTextRecursively = ({
    text = '',
    step,
    lastText,
    parentTitle = '',
  }: {
    text: string;
    step: number;
    lastText: string;
    parentTitle: string;
  }): string[] => {
    const isMarkdownStep = checkIsMarkdownSplit(step);
    const isCustomStep = checkIsCustomStep(step);
    const forbidConcat = isCustomStep;

    // 已到最细粒度：直接按 chunkSize 硬切
    if (step >= stepReges.length) {
      const combinedText = lastText + text;
      const combinedLength = getTextValidLength(combinedText);

      if (combinedLength < maxSize) {
        return [combinedText];
      }

      const chunks: string[] = [];
      for (let i = 0; i < combinedText.length; i += chunkSize - overlapLen) {
        chunks.push(combinedText.slice(i, i + chunkSize));
      }
      return chunks;
    }

    const splitTexts = getSplitTexts({ text, step });
    const chunks: string[] = [];

    for (let i = 0; i < splitTexts.length; i++) {
      const item = splitTexts[i]!;
      const maxLen = item.chunkMaxSize;
      const lastTextLen = getTextValidLength(lastText);
      const currentText = item.text;
      const newText = lastText + currentText;
      const newTextLen = getTextValidLength(newText);

      // 表格整块超出 → 单独走表格分块
      if (strIsMdTable(currentText) && newTextLen > maxLen) {
        if (lastTextLen > 0) {
          chunks.push(lastText);
          lastText = '';
        }

        const { chunks: tableChunks } = markdownTableSplit({
          text: currentText,
          chunkSize: chunkSize * 1.2,
        });

        chunks.push(...tableChunks);
        continue;
      }

      // Markdown 标题级：携带标题递归下钻
      if (isMarkdownStep) {
        const innerChunks = splitTextRecursively({
          text: newText,
          step: step + 1,
          lastText: '',
          parentTitle: parentTitle + item.title,
        });

        if (innerChunks.length === 0) {
          chunks.push(`${parentTitle}${item.title}`);
          continue;
        }

        chunks.push(
          ...innerChunks.map((chunk) =>
            step === markdownIndex + customRegLen ? `${parentTitle}${item.title}${chunk}` : chunk,
          ),
        );

        continue;
      }

      // 超出当前上限 → 尝试递归细分或按重叠收尾
      if (newTextLen > maxLen) {
        const minChunkLen = maxLen * 0.8;
        const maxChunkLen = maxLen * 1.2;

        if (newTextLen < maxChunkLen) {
          chunks.push(newText);
          lastText = getOneTextOverlapText({ text: newText, step });
          continue;
        }
        if (lastTextLen > minChunkLen) {
          chunks.push(lastText);
          lastText = '';
          i--;
          continue;
        }

        const innerChunks = splitTextRecursively({
          text: currentText,
          step: step + 1,
          lastText,
          parentTitle: parentTitle + item.title,
        });
        const lastChunk = innerChunks[innerChunks.length - 1];

        if (!lastChunk) continue;

        if (getTextValidLength(lastChunk) < minChunkLen) {
          chunks.push(...innerChunks.slice(0, -1));
          lastText = lastChunk;
          continue;
        }

        chunks.push(...innerChunks);
        lastText = getOneTextOverlapText({
          text: lastChunk,
          step,
        });
        continue;
      }

      // 自定义分隔：禁止与后续文本拼接
      if (forbidConcat) {
        chunks.push(currentText);
        continue;
      }

      lastText = newText;
    }

    // 收尾：剩余 lastText 并入最后一块或单独成块
    if (lastText && chunks[chunks.length - 1] && !chunks[chunks.length - 1]!.endsWith(lastText)) {
      if (getTextValidLength(lastText) < chunkSize * 0.4) {
        chunks[chunks.length - 1] = chunks[chunks.length - 1]! + lastText;
      } else {
        chunks.push(lastText);
      }
    } else if (lastText && chunks.length === 0) {
      chunks.push(lastText);
    }

    return chunks;
  };

  try {
    const chunks = splitTextRecursively({
      text,
      step: 0,
      lastText: '',
      parentTitle: '',
    }).map((chunk) => chunk?.replaceAll(codeBlockMarker, '\n')?.trim() || '');

    const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);

    return {
      chunks,
      chars,
    };
  } catch (err) {
    throw new Error(getErrText(err));
  }
};

/**
 * 对外主入口：
 * 1. 按 CUSTOM_SPLIT_SIGN 强制分隔
 * 2. 每段：Markdown 表格走表格分块，否则走通用递归分块
 * 3. 结果统一 simpleText 清理
 */
export const splitText2Chunks = (props: SplitProps): SplitResponse => {
  let { text = '' } = props;
  const splitWithCustomSign = text.split(CUSTOM_SPLIT_SIGN);

  const splitResult = splitWithCustomSign.map((item) => {
    if (strIsMdTable(item)) {
      return markdownTableSplit({ ...props, text: item });
    }

    return commonSplit({ ...props, text: item });
  });

  return {
    chunks: splitResult
      .map((item) => item.chunks)
      .flat()
      .map((chunk) => simpleText(chunk)),
    chars: splitResult.reduce((sum, item) => sum + item.chars, 0),
  };
};
