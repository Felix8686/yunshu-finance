import type { V3ResolvedDateRange, V3TimeScope } from './protocol';

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shanghaiDate(eventTime: string): string {
  const instant = new Date(eventTime);
  if (Number.isNaN(instant.getTime())) throw new Error('INVALID_EVENT_TIME');
  return ymd(new Date(instant.getTime() + 8 * 60 * 60 * 1000));
}

function shiftDate(dateText: string, days: number): string {
  const [year, month, day] = dateText.split('-').map(Number);
  if (!year || !month || !day) throw new Error('INVALID_DATE');
  return ymd(new Date(Date.UTC(year, month - 1, day + days)));
}

function monthStart(dateText: string, offset: number): string {
  const [year, month] = dateText.split('-').map(Number);
  return ymd(new Date(Date.UTC(year, month - 1 + offset, 1)));
}

function yearStart(dateText: string, offset: number): string {
  const year = Number(dateText.slice(0, 4));
  if (!year) throw new Error('INVALID_DATE');
  return `${year + offset}-01-01`;
}

function normalizeExplicitDate(value: string): string {
  const candidate = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) throw new Error('INVALID_EXPLICIT_DATE');
  return candidate;
}

export function resolveV3TimeScope(scope: V3TimeScope | null | undefined, eventTime: string): V3ResolvedDateRange | null {
  if (!scope) return null;
  if (scope.kind === 'explicit') {
    const from = normalizeExplicitDate(scope.from);
    const to = normalizeExplicitDate(scope.to);
    if (from >= to) throw new Error('INVALID_TIME_RANGE');
    return { from_date: from, to_date: to, timezone: 'Asia/Shanghai', source: 'explicit' };
  }

  const today = shanghaiDate(eventTime);
  const tomorrow = shiftDate(today, 1);
  const thisMonth = monthStart(today, 0);
  const nextMonth = monthStart(today, 1);
  const thisYear = yearStart(today, 0);
  const nextYear = yearStart(today, 1);

  switch (scope.preset) {
    case 'today':
      return { from_date: today, to_date: tomorrow, timezone: 'Asia/Shanghai', source: 'today' };
    case 'yesterday':
      return { from_date: shiftDate(today, -1), to_date: today, timezone: 'Asia/Shanghai', source: 'yesterday' };
    case 'this_month':
      return { from_date: thisMonth, to_date: nextMonth, timezone: 'Asia/Shanghai', source: 'this_month' };
    case 'this_month_to_date':
      return { from_date: thisMonth, to_date: tomorrow, timezone: 'Asia/Shanghai', source: 'this_month_to_date' };
    case 'last_month':
      return { from_date: monthStart(today, -1), to_date: thisMonth, timezone: 'Asia/Shanghai', source: 'last_month' };
    case 'this_year':
      return { from_date: thisYear, to_date: nextYear, timezone: 'Asia/Shanghai', source: 'this_year' };
    case 'last_year':
      return { from_date: yearStart(today, -1), to_date: thisYear, timezone: 'Asia/Shanghai', source: 'last_year' };
    default: {
      const exhaustive: never = scope.preset;
      throw new Error(`UNSUPPORTED_PERIOD_${String(exhaustive)}`);
    }
  }
}
