import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

// A local, bounded wording check, not a factual verifier or a second model.
// Keep the actual draft unchanged: never silently remove a risk or rewrite code.
export const REVIEW_VERSION = 'owner-language-v1';
const scopes = ['frontend', 'data', 'operations', 'programming'];
const topicPatterns = {
  frontend: /前端|网页|HTML|CSS|frontend|front.end/i,
  data: /数据库|数据存储|SQL|database|data storage/i,
  operations: /运维|部署|服务器|operations|deployment|server/i,
  programming: /编程|开发|技术基础|技术背景|programming|technical background|software develop/i,
};
const terms = [
  ['API', 'programming', '两个服务之间传递数据的接口'],
  ['SDK', 'programming', '接入服务所用的开发工具包'],
  ['MCP', 'programming', '让 AI 使用外部工具的连接方式'],
  ['Agent', 'programming', '负责一项工作的 AI 助手'],
  ['schema', 'data', '数据应当包含哪些字段的约定'],
  ['JSON', 'data', '保存结构化数据的文件格式'],
  ['SQL', 'data', '查询和修改数据库内容的语言'],
  ['SQLite', 'data', '保存在本机文件中的数据库'],
  ['PostgreSQL', 'data', '管理和保存共享数据的数据库'],
  ['数据库', 'data', '长期保存并查找资料的地方'],
  ['幂等', 'programming', '重复操作也不会多做一次'],
  ['原子性', 'data', '一次操作要么全部完成，要么不改动'],
  ['异步', 'programming', '等待时仍能处理其他工作'],
  ['回调', 'programming', '工作完成后通知另一段程序'],
  ['并发', 'programming', '同时处理多项工作'],
  ['中间件', 'programming', '在处理过程中的一层连接程序'],
  ['序列化', 'data', '把数据转成可以保存或传送的格式'],
  ['回滚', 'operations', '退回之前可用的版本'],
  ['HTTPS', 'operations', '加密传输的网页连接'],
  ['OAuth', 'operations', '不交出密码也能授权连接账号的方式'],
  ['token', 'programming', '模型计算文字用量的单位或访问凭证，须按实际含义说明'],
  ['gateway', 'operations', '连接请求经过的中转入口'],
  ['CLI', 'operations', '通过输入命令操作的工具'],
  ['CI/CD', 'operations', '自动检查和发布更新的流程'],
  ['Docker', 'operations', '把程序及所需环境打包运行的工具'],
  ['Kubernetes', 'operations', '管理多台机器上程序运行的系统'],
  ['webhook', 'programming', '事件发生时自动发出的通知'],
  ['HTML', 'frontend', '网页内容的标记格式'],
  ['CSS', 'frontend', '控制网页外观的样式'],
  ['React', 'frontend', '搭建交互网页的工具'],
  ['DOM', 'frontend', '网页内容在浏览器中的结构'],
  ['SSR', 'frontend', '先在服务器生成页面再交给浏览器'],
  ['hydration', 'frontend', '让已显示的页面接上交互功能'],
  ['artifact', 'programming', '本次产出的文件或可体验成果'],
  ['candidate', 'programming', '尚待检查的版本'],
  ['SLA', 'operations', '服务响应和可用程度的约定'],
  ['RBAC', 'operations', '按职责分配访问权限'],
  ['PITR', 'data', '把数据恢复到指定时间的状态'],
];
const jargon = [
  ['赋能', '直接说明帮谁完成什么'],
  ['抓手', '说明具体采用什么办法'],
  ['底层逻辑', '直接解释原因'],
  ['颗粒度', '说明需要多细'],
  ['打通链路', '说明哪些步骤已经能够连起来完成'],
  ['闭环', '说明从开始到完成实际包含哪些步骤'],
  ['降维打击', '说明可验证的优势，不夸大'],
  ['范式', '说明具体做法'],
];
const checks = ['meaningFirst', 'necessaryDetailOnly', 'risksAndUnknownsPreserved'];
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const defaultPreference = () => ({
  level: 'plain', topics: [], revision: 'default', source: 'default',
  userQuote: null, sourceRef: null, authorizationGranted: false,
});
function string(value, name, limit = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${name} must be nonempty and at most ${limit} characters`);
  return value.trim();
}

export function communicationPreference(store, projectId) {
  const event = store.listOwnerEvents(projectId).filter(e =>
    e.kind === 'update' && e.payload.recordType === 'communication_preference').at(-1);
  if (!event) return defaultPreference();
  const { level, topics, userQuote, sourceRef } = event.payload;
  if (!['plain', 'limited_technical'].includes(level) || !Array.isArray(topics)
      || topics.some(t => !scopes.includes(t)) || (level === 'limited_technical' && !topics.length)) {
    throw new Error('Saved communication preference is invalid; do not infer technical fluency');
  }
  return { level, topics, userQuote, sourceRef, revision: event.id,
    source: 'assistant_attributed_user_statement', authorizationGranted: false };
}

export function setCommunicationPreference(args, { withStore }) {
  return withStore(args.workspacePath, store => {
    const project = store.getProject(args.projectId ?? 'main');
    if (!project || project.stateRevision !== args.expectedStateRevision) throw new Error('Stale project state; reread before changing communication preference');
    const userQuote = string(args.userQuote, 'actual user quote');
    const sourceRef = string(args.sourceRef, 'sourceRef', 500);
    if (!['plain', 'limited_technical'].includes(args.level)) throw new Error('Unsupported communication level');
    if (!Array.isArray(args.topics) || args.topics.length > 4 || new Set(args.topics).size !== args.topics.length
        || args.topics.some(t => !scopes.includes(t))) throw new Error('Unsupported or duplicate technical topics');
    if (args.level === 'plain' && args.topics.length) throw new Error('Plain language must clear technical topics');
    if (args.level === 'limited_technical') {
      // Reject obvious inferred/conditional/negated examples. This does NOT
      // authenticate the quoted conversation; disclose its attribution.
      const hypotheticalOrNegative = /如果|假如|假设|当用户|用户可以|比如|例如|不太懂|不懂|没(?:有)?[^。！？\n]{0,8}(?:基础|经验)|没有技术|don't|do not|if I|if the user|for example/i.test(userQuote);
      const reported = /[“”‘’「」『』"`]|(?:同事|别人|他说|她说|对方|用户说|told me|they said|he said|she said)/i.test(userQuote);
      const clauses = userQuote.match(/[^。！？?!\n，,；;]+[。！？?!\n，,；;]?/g) ?? [];
      const positive = clauses.map(c => c.trim()).filter(clause =>
        !/[？?]|(?:吗|么)[。！!，,；;]?$|不熟悉|不了解|不会|不太|不怎么|not familiar|but not/i.test(clause)
        && /^(?:我(?:自己)?(?:有(?:一[点些])?|具备)(?:一些|一定|基本的)?[^。！？\n]{0,12}(?:基础|经验|背景)|我(?:懂|了解|熟悉|会)(?!不)[^。！？\n]{1,30}|我是[^。！？\n]{0,16}(?:开发者|程序员|工程师)|I (?:know|understand|have experience|have (?:some |a )?technical background|am (?:a |an )?(?:developer|engineer)))/i.test(clause));
      if (hypotheticalOrNegative || reported || !args.topics.length
          || args.topics.some(t => !positive.some(clause => topicPatterns[t].test(clause)))) {
        throw new Error('Limited technical detail needs an explicit relevant user-background statement, not a question, example or inference');
      }
    }
    const id = store.recordOwnerEvent({ id: `communication-${randomUUID()}`, projectId: project.id, kind: 'update',
      payload: { recordType: 'communication_preference', level: args.level, topics: args.topics,
        userQuote, sourceRef, attribution: 'assistant_attributed', authorizationGranted: false } });
    return { message: args.level === 'plain' ? '已恢复通俗表达；不会改变项目范围或操作权限。' : '已记录你明确提到的技术基础；相关细节仍会简短解释，不改变操作权限。',
      data: { stateRevision: store.getProject(project.id).stateRevision, preference: communicationPreference(store, project.id), id } };
  });
}

function visibleText(draft) {
  // Destinations aren't prose. Preserve the clickable label, including labels
  // deliberately stuffed with jargon; fenced code is handled separately.
  return draft.replace(/!?\[([^\]]*)\]\((?:<[^>]*>|[^)\n]*)\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)]+/g, '')
    .replace(/:codex-annotation\{[^}]*\}/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (all, n) => {
      const point = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : all;
    })
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    }[entity]))
    .normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[*#`]/g, '').replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '');
}
function occurrences(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /^[A-Za-z]/.test(term)
    ? new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi')
    : new RegExp(escaped, 'g');
  return [...text.matchAll(pattern)];
}
function explained(text, match) {
  const before = text.slice(Math.max(0, match.index - 90), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 100);
  // Observable gloss shapes, not a claim that arbitrary definitions are correct.
  return /[（(][^（）()\n]{4,90}[）)]/.test(after.slice(0, 95))
    && /^[\s：:，,]*[（(]/.test(after)
    || /^[\s：:，,]*(?:也就是|意思是|指的是|即|which means|meaning)\s*[^。！？\n]{4,90}/i.test(after)
    || /[^。！？\n]{6,90}[（(]\s*$/.test(before) && /^[）)]/.test(after);
}

export function inspectReply(draft, { preference = defaultPreference(), kind = 'final', selfReview } = {}) {
  if (typeof draft !== 'string' || !draft.trim() || draft.length > 24000) throw new Error('Reply must contain 1–24000 characters');
  if (!['progress', 'question', 'final'].includes(kind)) throw new Error('Unsupported reply kind');
  if (!selfReview || typeof selfReview !== 'object' || Array.isArray(selfReview)
      || Object.keys(selfReview).some(k => !checks.includes(k))
      || checks.some(k => typeof selfReview[k] !== 'boolean')) throw new Error('Complete the three semantic self-review checks');
  const findings = [];
  const add = (code, message, term) => findings.push({ code, message, ...(term ? { term } : {}) });
  for (const key of checks) if (!selfReview[key]) add('self_review', {
    meaningFirst: '先讲清对用户的结果、使用或判断意味着什么。',
    necessaryDetailOnly: '删去不帮助用户理解或判断的细节。',
    risksAndUnknownsPreserved: '保留真实费用、权限、失败和未知情况，不用简化掩盖风险。',
  }[key]);
  const text = visibleText(draft);
  const opening = text.trim().split(/\n|[。！？]/)[0];
  for (const [term, suggestion] of jargon) if (text.includes(term)) add('jargon', suggestion, term);
  if (/```|~~~/.test(draft)) add('code_block', '把实现代码保存在成果文件中，回复用通俗说明和可打开的入口；技术基础不等于要求代码教程。');
  if (/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s]+|(?:^|\s)(?:npm|pnpm|npx|pip|git|curl)\s+(?:install|run|add|clone|push|pull|exec|test)/m.test(text)) {
    add('engineering_instructions', '不要让用户复制路径或执行工程命令；由负责人处理，成果用可点击的链接提供。');
  }
  let distinct = 0, total = 0;
  for (const [term, topic, explanation] of terms) {
    const found = occurrences(text, term);
    if (!found.length) continue;
    distinct++; total += found.length;
    const allowed = preference.level === 'limited_technical' && preference.topics.includes(topic);
    if (!allowed && !explained(text, found[0])) add('unexplained_term', `换成日常说法，或先解释：${explanation}。`, term);
    if (occurrences(opening, term).length && !explained(text, found[0])) add('technical_opening', '开头先说明实际影响，再给必要的技术名称。', term);
  }
  // Even declared expertise only permits limited detail, never jargon dumping.
  const maxTerms = preference.level === 'limited_technical' ? 3 : 2;
  if (distinct > maxTerms || total > maxTerms * 3) add('technical_density', '这段回复技术名称过多；只保留与本次判断直接相关的少量细节。');
  if (/\b(?:BM-\d+|stateRevision|contractRevision|candidateDigest|owner_epoch|unknown_outcome|sha256:[a-f0-9]{12,})\b/i.test(text)) {
    add('internal_bookkeeping', '用可体验结果和实际影响说明进度，不展示内部编号、校验值或状态字段。');
  }
  const claims = text.split(/[。！？\n]/).filter(s => /BOSSmode|审查|review/i.test(s));
  if (claims.some(s => !/不是|不代表|不能|无法|不保证|not |cannot|doesn't/i.test(s)
      && /独立事实认证|保证.{0,8}(?:准确|易懂|无黑话)|强制拦截.{0,8}(?:所有|全部)|independently verified facts|guarantees? (?:accuracy|understanding)|intercepts? all/i.test(s))) {
    add('review_overclaim', '表达审查不是独立事实认证，也不能保证拦住宿主所有输出；请准确说明检查范围。');
  }
  const status = findings.length ? 'needs_revision' : 'passed';
  return { status, reviewVersion: REVIEW_VERSION, kind, textDigest: digest(draft),
    preferenceRevision: preference.revision, level: preference.level, findings,
    selfReview: { ...selfReview, attribution: 'assistant_self_review' },
    ...(status === 'passed' ? { sendText: draft } : {}),
    scope: 'Local wording checks plus disclosed assistant semantic self-review; not independent factual verification, user comprehension proof, or host-wide output interception.',
    instruction: status === 'passed'
      ? 'Send sendText unchanged. Any wording change or communication-preference change requires a new review. Do not add a review badge by default.'
      : 'Rewrite the actual draft, preserve risks and facts, and review it again. Do not show the failed draft or claim it passed.',
  };
}

export function reviewReply(args, { withStore, canonicalWorkspace }) {
  let preference = defaultPreference();
  // First alignment messages can be reviewed before any project is created.
  // A corrupt existing project must never silently fall back to default.
  if (args.workspacePath !== undefined) {
    const workspace = canonicalWorkspace(args.workspacePath);
    if (existsSync(path.join(workspace, '.builder-mode'))) {
      preference = withStore(workspace, store => {
        const project = store.getProject(args.projectId ?? 'main');
        if (!project) throw new Error('Project not found; cannot silently ignore its communication preference');
        return communicationPreference(store, project.id);
      }, { readOnly: true });
    }
  }
  const result = inspectReply(args.draft, { preference, kind: args.kind, selfReview: args.selfReview });
  return { message: result.status === 'passed' ? '这份草稿通过了已列明的表达检查；不代表事实或用户理解已经得到独立验证。' : '这份草稿需要先改写，再发给用户。',
    data: result };
}
