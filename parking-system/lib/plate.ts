// Single source of plate normalization, kept identical across three places:
//   - this TS util (server precheck + client search/dedupe)
//   - the DB generated column vehicles.license_plate_normalized (0001)
//   - the walk_in unique index expression (0009)
// Rule: uppercase, strip every non-alphanumeric character. 'ABC-1234' === 'abc1234'.
export function normalizePlate(plate: string): string {
  return plate.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export interface PlateMatch {
  before: string
  match: string
  after: string
}

// Highlight the substring of a RAW plate (e.g. 'ABC-1234') that matched a query under
// normalizePlate() semantics. Cannot index into the raw string using normalized offsets —
// stripped characters (like '-') shift every position after them. Instead this walks the
// raw string once, records where each surviving (normalized) character came from, and maps
// the normalized match window back through that record. Match test stays single-source:
// normalizePlate(plate).includes(normalizePlate(query)) is the only definition of "matches".
export function highlightPlateMatch(rawPlate: string, query: string): PlateMatch {
  const normalizedPlate = normalizePlate(rawPlate)
  const normalizedQuery = normalizePlate(query)
  if (!normalizedQuery) return { before: rawPlate, match: '', after: '' }

  const start = normalizedPlate.indexOf(normalizedQuery)
  if (start === -1) return { before: rawPlate, match: '', after: '' }
  const end = start + normalizedQuery.length // exclusive, in normalized-index space

  // rawIndexOfNormalizedIndex[i] = index in rawPlate of the i-th surviving character.
  const rawIndexOfNormalizedIndex: number[] = []
  for (let i = 0; i < rawPlate.length; i++) {
    if (/[A-Z0-9]/.test(rawPlate[i].toUpperCase())) rawIndexOfNormalizedIndex.push(i)
  }

  // The loop above is a SECOND implementation of "which characters survive
  // normalization" — normalizePlate() uppercases the whole string, this uppercases one
  // character at a time. They disagree wherever toUpperCase() is one-to-many:
  // 'ß' → 'SS' contributes two characters to normalizedPlate but one index here, and
  // every index after it is then off by one. Without this guard the caller renders
  // `${before}${match}${after}` from a NaN slice and the plate visibly changes
  // ('ß-1234' searched for '1234' rendered as 'ß-1ß-1234').
  //
  // Taiwanese plates are [A-Z0-9-], so this is unreachable with real data — but the
  // failure is silent, so it fails closed instead: no highlight, plate intact.
  if (rawIndexOfNormalizedIndex.length !== normalizedPlate.length) {
    return { before: rawPlate, match: '', after: '' }
  }

  const rawStart = rawIndexOfNormalizedIndex[start]
  const rawEnd = rawIndexOfNormalizedIndex[end - 1] + 1 // exclusive, in raw-index space
  return {
    before: rawPlate.slice(0, rawStart),
    match: rawPlate.slice(rawStart, rawEnd),
    after: rawPlate.slice(rawEnd),
  }
}
