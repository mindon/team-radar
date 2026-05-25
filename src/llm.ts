import { DIMENSION_KEYS, StructuredReview } from "./types.ts";
import { emptyProfile, parseModelJson, validateStructuredReview } from "./utils.ts";

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434/api/chat";
const DEFAULT_OLLAMA_MODEL = "gemma4";

type LlmProvider = "deepseek" | "ollama";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface OllamaResponse {
  message?: { content?: string };
}

interface RuntimeEnv {
  Deno?: { env?: { get(name: string): string | undefined } };
}

function envGet(name: string): string | undefined {
  return (globalThis as RuntimeEnv).Deno?.env?.get(name);
}

function getProvider(): LlmProvider {
  return envGet("LLM_PROVIDER") === "ollama" ? "ollama" : "deepseek";
}

function buildCleanerPrompt(rawText: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是资深职场文化研究员、组织行为分析师和隐私脱敏引擎。必须只输出一个合法 JSON 对象；不要输出 Markdown、代码块、解释文字或额外字段。",
    },
    {
      role: "user",
      content: `请分析一段主管/团队评价文本，完成“不可逆脱敏 + 六维管理风格量化”。

一、绝对安全红线
1. 删除或泛化所有可反查信息：真实姓名、花名、手机号、微信号、邮箱、精确时间、地点、楼层、项目名、客户名、工单号、组织暗号、特殊口头禅、特殊标点/排版习惯。
2. 不复述具体冲突细节，只保留可聚合的管理行为模式。
3. 将主观吐槽改写为中立、客观、第三方行业评估文风。
4. 如果原文包含违法、隐私、侮辱或不可验证指控，只抽象成“沟通方式”“责任归因”“边界感”“反馈质量”等管理模式。

二、六维评分规则（1-10，允许一位小数）
- transparency：决策透明度。信息同步是否及时、客观，责任归因是否清晰。
- autonomy：授权空间。是否信任成员自主推进；过度日报、细节审查、频繁打断应低分。
- psychological_safety：心理安全。是否允许试错；公开追责、羞辱、否定能力应低分。
- feedback_loop：反馈质量与频率。高频但只有否定、缺少建设性指导时不应高分。
- wlb_boundary：工作节奏与边界。非紧急深夜/周末响应、用在线时长绑定绩效应低分。
- growth_support：成长与资源支持。包括主动培养、资源争取、技术氛围和被动学习环境。

三、参考标注风格（仅学习尺度，不要照抄）
- “每日双报、代码细节强干预”通常对应 autonomy 低分和“微观管理”标签。
- “公开会议追责个体、否定员工能力”通常对应 psychological_safety 低分和“公开追责”标签。
- “非工作时间发布非紧急要求并影响绩效”通常对应 wlb_boundary 低分和“边界感缺失”标签。
- “团队技术专家密集但主管支持少”可体现为 growth_support 中等分和“技术氛围浓厚”标签。

四、输出要求
1. dimensions 的六个字段必须全部存在，值必须是 number，不要输出 reason 对象。
2. extracted_tags 输出 3-5 个中文短标签，优先使用管理风格标签，例如“微观管理”“边界感缺失”“公开追责”“反馈频繁”“技术氛围浓厚”。
3. safe_summary 输出 60-100 个中文字符，必须是脱敏后的总体摘要，不包含具体人名、时间、项目、组织暗号或可反查细节。
4. 只输出以下 JSON 结构，不要增加字段：
{
  "dimensions": {
    "transparency": number,
    "autonomy": number,
    "psychological_safety": number,
    "feedback_loop": number,
    "wlb_boundary": number,
    "growth_support": number
  },
  "extracted_tags": string[],
  "safe_summary": string
}

原始输入用 <review> 标签包裹。请仅分析标签内文本：
<review>
${rawText}
</review>`,
    },
  ];
}

export async function cleanAndStructureText(rawText: string): Promise<StructuredReview> {
  if (envGet("LLM_MOCK") === "1") return mockCleanAndStructureText(rawText);

  const provider = getProvider();
  const content = provider === "ollama"
    ? await cleanWithOllama(rawText)
    : await cleanWithDeepSeek(rawText);

  return validateStructuredReview(parseModelJson(content));
}

async function cleanWithDeepSeek(rawText: string): Promise<string> {
  const apiKey = envGet("DEEPSEEK_API_KEY") ?? "";
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

  const response = await fetch(DEEPSEEK_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      response_format: { type: "json_object" },
      messages: buildCleanerPrompt(rawText),
      temperature: 0.2,
      max_tokens: 800,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DeepSeek API error: ${response.status} ${detail.slice(0, 160)}`);
  }

  const result = await response.json() as DeepSeekResponse;
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty DeepSeek response");
  return content;
}

async function cleanWithOllama(rawText: string): Promise<string> {
  const endpoint = envGet("OLLAMA_ENDPOINT") ?? DEFAULT_OLLAMA_ENDPOINT;
  const model = envGet("OLLAMA_MODEL") ?? DEFAULT_OLLAMA_MODEL;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: buildCleanerPrompt(rawText),
      format: "json",
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: 800,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Ollama API error: ${response.status} ${detail.slice(0, 160)}`);
  }

  const result = await response.json() as OllamaResponse;
  const content = result.message?.content;
  if (!content) throw new Error("Empty Ollama response");
  return content;
}

export function mockCleanAndStructureText(rawText: string): StructuredReview {
  const text = rawText.toLocaleLowerCase("zh-CN");
  const dimensions = emptyProfile(6.5);

  const positiveHints = ["授权", "透明", "支持", "成长", "反馈", "尊重", "边界", "技术"];
  const negativeHints = ["微观", "高压", "画饼", "甩锅", "加班", "凌晨", "不透明", "pua"];
  const positive = positiveHints.filter((word) => text.includes(word)).length;
  const negative = negativeHints.filter((word) => text.includes(word)).length;
  const delta = Math.max(-2.5, Math.min(2.5, positive * 0.6 - negative * 0.7));

  for (const key of DIMENSION_KEYS) {
    dimensions[key] = Math.max(1, Math.min(10, Math.round((6.5 + delta) * 10) / 10));
  }
  if (text.includes("微观")) dimensions.autonomy = 3.2;
  if (text.includes("加班") || text.includes("凌晨")) dimensions.wlb_boundary = 3.4;
  if (text.includes("透明")) dimensions.transparency = Math.max(dimensions.transparency, 7.6);
  if (text.includes("成长") || text.includes("资源")) {
    dimensions.growth_support = Math.max(dimensions.growth_support, 7.5);
  }

  const tags = [
    text.includes("微观") ? "微观管理" : "目标管理",
    text.includes("加班") ? "高强度节奏" : "边界清晰",
    text.includes("透明") ? "决策透明" : "沟通待提升",
    text.includes("成长") ? "成长支持" : "结果导向",
  ];

  return validateStructuredReview({
    dimensions,
    extracted_tags: tags,
    safe_summary:
      "该团队管理风格已被脱敏概括为目标导向型，沟通、授权和工作边界表现存在差异，建议结合多样本趋势判断。",
  });
}
