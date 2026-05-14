const SEASON_MONTH: Record<string, number> = {
  spring: 4,  // end of spring term ≈ May
  summer: 8,  // end of summer ≈ August
  fall: 12,   // end of fall term ≈ December
  autumn: 12,
  winter: 2,  // end of winter term ≈ February
};

/**
 * Parses a deadline string into a Date, handling common academic formats:
 * - "January 15, 2026" / "April 23, 2025"
 * - "23/04/2025" / "2025-04-23"
 * - "April 2025" (treated as last day of that month)
 * - "Spring 2025" / "Fall 2025" (treated as end of that academic term)
 * - "2025年4月23日" (Japanese date format)
 * - "2025" alone (year-only — treated as the whole year, expired when year has passed)
 * Returns null for genuinely ambiguous strings ("Open until filled", "Rolling").
 */
function parseDeadline(deadline: string): Date | null {
  const s = deadline.trim();

  // Japanese format: 2025年4月23日 or 2025年4月
  const japaneseMatch = s.match(/(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?/);
  if (japaneseMatch) {
    const [, year, month, day] = japaneseMatch;
    return new Date(
      parseInt(year),
      parseInt(month) - 1,
      day ? parseInt(day) : new Date(parseInt(year), parseInt(month), 0).getDate(),
    );
  }

  // DD/MM/YYYY
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  }

  // Year-only: "2025" — treat end-of-year as the boundary
  if (/^\d{4}$/.test(s)) {
    return new Date(parseInt(s), 11, 31); // Dec 31 of that year
  }

  // Season + year: "Spring 2025", "Fall 2025", etc.
  const seasonMatch = s.match(/\b(spring|summer|fall|autumn|winter)\s+(\d{4})\b/i);
  if (seasonMatch) {
    const month = SEASON_MONTH[seasonMatch[1].toLowerCase()];
    const year = parseInt(seasonMatch[2]);
    return new Date(year, month - 1, 28); // last ~day of that month
  }

  // Month + year only: "April 2025", "January 2026"
  const monthYearMatch = s.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
  );
  if (monthYearMatch) {
    const months: Record<string, number> = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const m = months[monthYearMatch[1].toLowerCase()];
    const y = parseInt(monthYearMatch[2]);
    // Use the last day of that month
    return new Date(y, m + 1, 0);
  }

  // Fall back to native Date parsing for fully specified dates like "January 15, 2026"
  const native = new Date(deadline);
  if (!isNaN(native.getTime())) return native;

  return null; // genuinely ambiguous — keep the job
}

/**
 * Returns true only when a deadline string resolves to a past date.
 * Genuinely ambiguous strings ("Open until filled", "Rolling") return false — keep those jobs.
 * start_date never influences this check — use isStartYearPassed for that separately.
 */
export function isDeadlineExpired(
  deadline: string | null | undefined,
  opts?: { log?: (msg: string) => void; url?: string },
): boolean {
  if (!deadline) return false;
  const parsed = parseDeadline(deadline);
  if (!parsed) return false;
  const expired = parsed < new Date();
  if (expired && opts?.log) {
    opts.log(
      `[deadline] Expired — "${deadline}" → ${parsed.toISOString().slice(0, 10)}` +
        (opts.url ? ` (${opts.url})` : ""),
    );
  }
  return expired;
}

/**
 * Returns true if start_date contains a 4-digit year that has fully passed
 * (i.e. year < current year). A position that started in a prior year is never
 * still open. Returns false for current/future years and for unparseable values.
 */
export function isStartYearPassed(
  startDate: string | null | undefined,
  opts?: { log?: (msg: string) => void; url?: string },
): boolean {
  if (!startDate) return false;
  const match = startDate.match(/\b(20\d{2})\b/);
  if (!match) return false;
  const year = parseInt(match[1]);
  const passed = year < new Date().getFullYear();
  if (passed && opts?.log) {
    opts.log(
      `[deadline] Start year passed — start_date "${startDate}" (year ${year})` +
        (opts.url ? ` (${opts.url})` : ""),
    );
  }
  return passed;
}
