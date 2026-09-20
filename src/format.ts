/**
 * Numbers in English grouping — `1,000` and `0.2` — whatever the machine's
 * locale, because the interface is written in English. Dates follow the
 * reader's own settings.
 */
export const NUM_LOCALE = 'en-US'

export function formatNumber(value: number): string {
  return value.toLocaleString(NUM_LOCALE)
}

export function formatDecimals(value: number, places: number): string {
  return value.toLocaleString(NUM_LOCALE, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}
