/**
 * THE date stamp every generated document carries.
 *
 * Why a module and not `new Date()` at each call site: the stamp went out a
 * DAY AHEAD. `getFullYear/getMonth/getDate` read the HOST's zone, and a
 * machine running UTC rolls over five hours (four in daylight time) before
 * the reader does — so a sheet generated at 9pm Eastern was dated tomorrow.
 * A document dated in the future is not a cosmetic defect: it is the field a
 * reader uses to tell two revisions apart.
 *
 * So the zone is NAMED rather than inherited. `America/New_York` (not a fixed
 * -5) because the offset is -5 in winter and -4 in summer, and pinning the
 * number would put the stamp an hour out for eight months of the year — the
 * IANA zone carries that rule so nothing here has to.
 *
 * `en-CA` for the format: it yields ISO-ordered YYYY-MM-DD, which sorts, and
 * which no reader can misread as day-first or month-first.
 *
 * Pure and DOM-free: it takes the instant, so a test can pin the rollover
 * rather than wait for 8pm.
 */

/** The IANA zone the stamps are read in. */
export const STAMP_ZONE = 'America/New_York';

/**
 * @param {Date} [at] the instant to stamp; defaults to now
 * @returns {string} 'YYYY-MM-DD' as of that instant in STAMP_ZONE
 */
export function dateStamp(at = new Date()){
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STAMP_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(at);
}
