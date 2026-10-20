/** Read old records and import snapshots with the current commission categories. */
export function normalizeLegacyCategories<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeLegacyCategories) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
      (key === 'category' || key === 'commissionCategory') && field === 'speakers'
        ? 'accessories' : normalizeLegacyCategories(field),
    ])) as T;
  }
  return value;
}
