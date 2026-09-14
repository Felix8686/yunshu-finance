import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src');
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function sourceText(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function parse(relativePath: string): ts.SourceFile {
  const fileName = path.join(root, relativePath);
  return ts.createSourceFile(fileName, fs.readFileSync(fileName, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importsOf(sourceFile: ts.SourceFile): string[] {
  const imports: string[] = [];
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) imports.push(node.moduleReference.expression.text);
  });
  return imports;
}

function callCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

const financeV2Files = ts.sys.readDirectory(path.join(srcRoot, 'finance-v2'), ['.ts'], undefined, undefined);
const forbiddenV2Imports = new Set(['../finance', '../finance-command', '../finance-conversation', '../ai', '../index']);
const forbiddenLegacySemanticCalls = [
  'handleFinanceCommandTelegram',
  'handleFinanceConversationTelegram',
  'parseFinanceTextQuery',
  'parseIntake'
];
for (const file of financeV2Files) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const sourceFile = parse(relative);
  for (const imported of importsOf(sourceFile)) {
    if (forbiddenV2Imports.has(imported)) fail(`primary V2 module imports legacy semantic authority: ${relative} -> ${imported}`);
  }
  for (const call of forbiddenLegacySemanticCalls) {
    if (callCount(sourceFile, call) > 0) fail(`primary V2 module calls legacy semantic authority: ${relative} -> ${call}`);
  }
}

const orchestrator = parse('src/finance-v2/orchestrator.ts');
let turnTextAccesses = 0;
let turnTextUserContentAccesses = 0;
let turnTextPresenceChecks = 0;

function isInsideAiRun(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) continue;
    const target = current.expression;
    if (target.name.text === 'run'
      && ts.isPropertyAccessExpression(target.expression)
      && ts.isIdentifier(target.expression.expression)
      && target.expression.expression.text === 'env'
      && target.expression.name.text === 'AI') return true;
  }
  return false;
}
const inspectOrchestrator = (node: ts.Node): void => {
  if (ts.isRegularExpressionLiteral(node)) fail('orchestrator must not contain natural-language regex routing');
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'test') {
    fail('orchestrator must not use RegExp.test for semantic routing');
  }
  if (ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'turn'
    && node.name.text === 'text') {
    turnTextAccesses += 1;
    const parent = node.parent;
    const userContent = ts.isPropertyAssignment(parent)
      && parent.initializer === node
      && ((ts.isIdentifier(parent.name) && parent.name.text === 'content')
        || (ts.isStringLiteral(parent.name) && parent.name.text === 'content'))
      && isInsideAiRun(parent);
    const trimAccess = ts.isPropertyAccessExpression(parent)
      && parent.expression === node
      && parent.name.text === 'trim';
    const trimCall = trimAccess && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
    const presenceCheck = trimCall
      && ts.isPrefixUnaryExpression(parent.parent.parent)
      && parent.parent.parent.operator === ts.SyntaxKind.ExclamationToken;
    if (userContent) turnTextUserContentAccesses += 1;
    else if (presenceCheck) turnTextPresenceChecks += 1;
    else fail('orchestrator may use turn.text only for a fail-closed presence check or as the sole AI user message content');
  }
  ts.forEachChild(node, inspectOrchestrator);
};
inspectOrchestrator(orchestrator);
if (turnTextAccesses !== 2 || turnTextUserContentAccesses !== 1 || turnTextPresenceChecks !== 1) {
  fail(`orchestrator turn.text authority boundary changed: total=${turnTextAccesses}, user_content=${turnTextUserContentAccesses}, presence_check=${turnTextPresenceChecks}`);
}

const app = sourceText('src/app.ts');
const v2Entry = app.indexOf('handleFinanceV2Turn');
const legacyCalls = ['handleFinanceCommandTelegram(', 'handleFinanceConversationTelegram(', 'parseFinanceTextQuery(']
  .map((needle) => ({ needle, index: app.indexOf(needle, v2Entry + 1) }))
  .filter(({ index }) => index >= 0);
if (v2Entry < 0) fail('src/app.ts has no V2 Telegram entry');
for (const legacy of legacyCalls) {
  if (legacy.index < v2Entry) fail(`legacy semantic call appears before V2 entry: ${legacy.needle}`);
}
if (!app.includes("financeV2TelegramActive")) fail('src/app.ts does not expose the runtime V2 route gate');
if (!app.includes("financeV2TelegramShadow")) fail('src/app.ts does not expose the runtime shadow route gate');
if (!app.includes("financeRouteMode === 'draining_v2'")) fail('src/app.ts does not fail closed for finance draining');
if (!app.includes("['draining_v1', 'draining_v2'].includes(receiptRouteMode)")) fail('src/app.ts does not fail closed for receipt draining');
if (!app.includes("FINANCE_RUNTIME_CONTROL_UNAVAILABLE")) fail('src/app.ts does not fail closed when runtime control is unavailable');

const service = parse('src/finance-v2/service.ts');
if (callCount(service, 'interpretFinanceTurn') !== 1) fail('one Finance V2 service turn must have exactly one orchestrator call site');

const rendererImports = importsOf(parse('src/finance-v2/renderer.ts'));
if (rendererImports.some((value) => /executor|finance(?:-command|-conversation)?$/.test(value))) fail('renderer imports a ledger executor or legacy semantic module');
const outboxImports = importsOf(parse('src/finance-v2/outbox.ts'));
if (outboxImports.some((value) => /renderer|executor|finance(?:-command|-conversation)?$/.test(value))) fail('outbox imports renderer, executor, or legacy semantic module');

const mutationPattern = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:transactions|transaction_items)\b/i;
const legacyWriteAllowlist = new Set([
  'src/finance-command.ts',
  'src/receipt-job.ts',
  'src/receipt-job-v2.ts',
  'src/index.ts'
]);
for (const file of ts.sys.readDirectory(srcRoot, ['.ts'], undefined, undefined)) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const text = fs.readFileSync(file, 'utf8');
  if (!mutationPattern.test(text)) continue;
  if (relative !== 'src/finance-v2/executor.ts' && !legacyWriteAllowlist.has(relative)) {
    fail(`ledger mutation SQL outside V2 executor or explicit compatibility allowlist: ${relative}`);
  }
}

const receiptV3 = sourceText('src/receipt-job-v3.ts');
if (mutationPattern.test(receiptV3)) fail('receipt V3 adapter directly mutates ledger tables');

if (failures.length) {
  console.error('Finance architecture guard: FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Finance architecture guard: PASS');
