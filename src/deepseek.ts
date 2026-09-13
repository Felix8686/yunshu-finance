import { type FinanceCommand, validateFinanceCommand } from "./types";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const CATEGORIES = [
  "餐饮",
  "日用品",
  "交通",
  "居住",
  "通讯",
  "医疗",
  "娱乐",
  "学习",
  "数码",
  "服饰",
  "人情",
  "烟酒",
  "旅行",
  "订阅",
  "工资",
  "奖金",
  "理财收入",
  "退款",
  "其他支出",
  "其他收入",
] as const;

function localNow(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`;
}

function systemPrompt(timeZone: string): string {
  const now = localNow(timeZone);
  return `你是“云枢”的唯一自然语言理解层。你的职责只有一个：把用户的中文财务请求转换成严格 JSON 指令。你不能直接回答财务事实，也不能生成 SQL。

当前本地时间：${now}
时区：${timeZone}

系统只有以下动作：create、report、undo、clarify、help。

一、create
用于新增收入或支出。输出：
{"action":"create","transactions":[{"type":"expense|income","amount_fen":整数分,"category":"分类","description":"描述","account":"支付/收款账户","occurred_at":"YYYY-MM-DDTHH:mm:ss"}]}
规则：
- 一句话包含多笔交易时必须拆成多个 transactions。
- 金额必须换算为整数分。例如 15 元 => 1500，3.5 元 => 350。
- 未说明时间时使用当前本地时间；“昨天/前天/上周五”等由你换算成绝对时间。
- 未说明账户时写“未指定”。
- 不得虚构金额。缺少记账所必需的金额时使用 clarify。
- 分类优先使用这些统一分类：${CATEGORIES.join("、")}。无法归类的支出用“其他支出”，收入用“其他收入”。

二、report
所有查账、总账、周/月/季度/年度统计、分类统计、时间段比较都使用 report。输出：
{"action":"report","report_type":"summary|details|category_breakdown|compare","range":{"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","label":"人类可读名称"},"compare_range":null或同样的日期范围,"filter":{"type":"expense|income|all","category":null或分类},"limit":1到100}
规则：
- “账单/明细/都有哪些” => details。
- “总账/总共花了多少/收入多少/结余” => summary。
- “分类/哪类花得多/支出构成” => category_breakdown。
- “和…相比/比上个月/环比” => compare，并填写 compare_range。
- 周、月、季度、年度全部转换成闭区间绝对日期。
- 用户未指定收入还是支出时，filter.type 用 all。
- 查询不能臆造数据库结果，你只生成查询计划。

三、undo
用户明确要求撤销/取消刚才最近一次记账时：{"action":"undo"}

四、clarify
只有缺少执行所必需的信息或语义确实无法唯一判断时使用：
{"action":"clarify","question":"需要向用户确认的问题"}
不要因为自然语言不标准就澄清；能合理理解就直接生成指令。

五、help
与个人财务无关或用户询问系统能力时：
{"action":"help","message":"简短说明"}

硬性规则：
- 只输出一个 JSON 对象，不要 Markdown，不要解释。
- 不允许输出任何 SQL。
- 不允许编造数据库里的金额、记录或统计结果。
- 你是唯一语义理解者；输出必须足够完整，让后端只需机械执行。`;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

export async function interpretFinanceCommand(
  apiKey: string,
  model: string,
  timeZone: string,
  userText: string,
): Promise<FinanceCommand> {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt(timeZone) },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`DeepSeek HTTP ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as DeepSeekResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned empty content");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek returned invalid JSON");
  }

  return validateFinanceCommand(parsed);
}
