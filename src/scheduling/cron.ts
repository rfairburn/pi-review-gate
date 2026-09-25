/**
 * Validation-only parser for the standard Unix (Vixie) 5-field cron grammar.
 *
 * Scheduled-task entries (issue #26) store the recurrence as the user's own
 * standard cron expression, interpreted in the host machine's local timezone.
 * This module validates and canonicalizes that expression at configuration and
 * settings time. It also exposes cronMatchesLocalDate, a pure calendar matcher
 * over the host's local components; the runtime scheduler slice
 * (src/scheduling/dispatcher.ts) owns fire-time interpretation — including the
 * daylight-saving behavior that falls out of sampling the actual local wall
 * clock — and never computes next/previous fire times here.
 *
 * Grammar: exactly five whitespace-separated fields — minute (0–59),
 * hour (0–23), day of month (1–31), month (1–12, or jan–dec), day of week
 * (0–7 with 0 and 7 both meaning Sunday, or sun–sat). Each field may be `*`,
 * a single value, a `lo-hi` range, a comma-separated list of those, and any
 * base may carry a `/step` (star-slash-n, `a/n`, `a-b/n`; `a/n` runs from `a`
 * to the field maximum, as in Vixie cron). Reverse ranges and out-of-range
 * values are rejected. No seconds field and no `@`-shorthand forms are accepted.
 */

export interface ParsedCronExpression {
  /** The trimmed, whitespace-collapsed expression as it is stored. */
  expression: string;
  /** Sorted, deduplicated minute values (0–59). */
  minutes: number[];
  /** Sorted, deduplicated hour values (0–23). */
  hours: number[];
  /** Sorted, deduplicated day-of-month values (1–31). */
  daysOfMonth: number[];
  /** Sorted, deduplicated month values (1–12). */
  months: number[];
  /** Sorted, deduplicated day-of-week values (0–6, Sunday as 0). */
  daysOfWeek: number[];
  /**
   * Whether the stored day-of-month field starts with a star (including
   * star-slash-n steps). Used only for the standard Vixie day-matching rule in
   * cronMatchesLocalDate; the value sets above stay authoritative.
   */
  dayOfMonthStar: boolean;
  /** Whether the stored day-of-week field starts with a star (including star-slash-n steps). */
  dayOfWeekStar: boolean;
}

interface CronFieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** 7 is accepted and normalized to 0 (day-of-week only). */
  sevenIsSunday?: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_OF_WEEK_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const CRON_FIELDS: CronFieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day of week", min: 0, max: 7, names: DAY_OF_WEEK_NAMES, sevenIsSunday: true },
];

/**
 * Parse and validate one cron expression. Throws an `Error` naming `field` on
 * any syntax or range problem; the returned value carries only the canonical
 * field sets — the stored string stays the user's own expression.
 */
export function parseCronExpression(value: unknown, field: string): ParsedCronExpression {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty standard 5-field cron expression string`);
  }
  const expression = value.trim().replace(/\s+/g, " ");
  const parts = expression.split(" ");
  if (parts.length !== CRON_FIELDS.length) {
    throw new Error(
      `${field} must be a standard 5-field cron expression (minute hour day-of-month month day-of-week); got ${parts.length} field(s) in "${expression}"`,
    );
  }
  const parsed = parts.map((part, index) => parseCronField(part, CRON_FIELDS[index]!, field));
  return {
    expression,
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
    dayOfMonthStar: parts[2]!.startsWith("*"),
    dayOfWeekStar: parts[4]!.startsWith("*"),
  };
}

/**
 * Whether a local wall-clock instant matches a parsed expression, using the
 * standard Vixie day rule: when BOTH the day-of-month and day-of-week fields
 * are restricted (neither starts with `*`), the date matches when EITHER field
 * matches; otherwise every restricted field must match. This is pure calendar
 * matching over the host's local components — it never computes next/previous
 * fire times, so daylight-saving gaps and repeats fall out of how local wall
 * clock actually advances (see src/scheduling/dispatcher.ts).
 */
export function cronMatchesLocalDate(parsed: ParsedCronExpression, date: Date): boolean {
  if (!parsed.minutes.includes(date.getMinutes())) return false;
  if (!parsed.hours.includes(date.getHours())) return false;
  if (!parsed.months.includes(date.getMonth() + 1)) return false;
  const dayOfMonthMatches = parsed.daysOfMonth.includes(date.getDate());
  const dayOfWeekMatches = parsed.daysOfWeek.includes(date.getDay());
  if (parsed.dayOfMonthStar && parsed.dayOfWeekStar) return true;
  if (parsed.dayOfMonthStar) return dayOfWeekMatches;
  if (parsed.dayOfWeekStar) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function parseCronField(raw: string, spec: CronFieldSpec, field: string): number[] {
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    let base = item;
    let step = 1;
    const slash = item.indexOf("/");
    if (slash >= 0) {
      base = item.slice(0, slash);
      const stepText = item.slice(slash + 1);
      if (!/^\d+$/.test(stepText) || stepText === "0") {
        throw new Error(`${field} has an invalid ${spec.label} step "${stepText}"; use a positive whole number after "/"`);
      }
      step = Number(stepText);
      if (base.length === 0) {
        throw new Error(`${field} has an empty ${spec.label} range before "/"`);
      }
    }
    let lo = spec.min;
    let hi = spec.max;
    if (base !== "*") {
      const dash = base.indexOf("-");
      if (dash >= 0) {
        lo = parseCronValue(base.slice(0, dash), spec, field);
        hi = parseCronValue(base.slice(dash + 1), spec, field);
        if (lo > hi) {
          throw new Error(`${field} has a reversed ${spec.label} range "${base}"`);
        }
      } else {
        lo = parseCronValue(base, spec, field);
        // A bare value with a step runs to the field maximum (Vixie `a/n`).
        hi = slash >= 0 ? spec.max : lo;
      }
      if (lo < spec.min || hi > spec.max) {
        throw new Error(`${field} ${spec.label} value "${base}" is out of range ${spec.min}-${spec.max}`);
      }
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(spec.sevenIsSunday && value === 7 ? 0 : value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function parseCronValue(raw: string, spec: CronFieldSpec, field: string): number {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value < spec.min || value > spec.max) {
      throw new Error(`${field} ${spec.label} value "${raw}" is out of range ${spec.min}-${spec.max}`);
    }
    return value;
  }
  const name = raw.toLowerCase();
  if (spec.names && Object.prototype.hasOwnProperty.call(spec.names, name)) {
    return spec.names[name]!;
  }
  throw new Error(`${field} has an invalid ${spec.label} value "${raw}"`);
}