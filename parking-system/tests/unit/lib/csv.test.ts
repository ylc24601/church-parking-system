import { describe, expect, it } from 'vitest'
import { escapeCsvCell, neutralizeSpreadsheetCell, toSpreadsheetCsv, parseExportFilename } from '@/lib/csv'

describe('escapeCsvCell — CSV syntax', () => {
  it('leaves plain values (incl. CJK) untouched', () => {
    expect(escapeCsvCell('王小明')).toBe('王小明')
    expect(escapeCsvCell('0912345678')).toBe('0912345678')
  })
  it('quotes and doubles internal quotes for comma / quote / CR / LF', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"')
    expect(escapeCsvCell('a"b')).toBe('"a""b"')
    expect(escapeCsvCell('a\nb')).toBe('"a\nb"')
    expect(escapeCsvCell('a\r\nb')).toBe('"a\r\nb"')
  })
})

describe('neutralizeSpreadsheetCell — formula injection', () => {
  it('prefixes a quote when the first char could start a formula', () => {
    for (const v of ['=HYPERLINK("http://x","y")', '+123', '-1+2', '@SUM(A1:A2)', '\t=1', '\r=1', '\n=1']) {
      expect(neutralizeSpreadsheetCell(v)).toBe(`'${v}`)
    }
  })
  it('also neutralizes full-width CJK formula leads (＝＋－＠)', () => {
    for (const v of ['＝1+1', '＋1', '－1', '＠SUM(1)']) {
      expect(neutralizeSpreadsheetCell(v)).toBe(`'${v}`)
    }
  })
  it('leaves safe values alone', () => {
    expect(neutralizeSpreadsheetCell('王小明')).toBe('王小明')
    expect(neutralizeSpreadsheetCell('ABC-1234')).toBe('ABC-1234')
    expect(neutralizeSpreadsheetCell('a=b')).toBe('a=b') // = not leading
  })
})

describe('toSpreadsheetCsv', () => {
  it('BOM + CRLF + neutralized, escaped cells', () => {
    const csv = toSpreadsheetCsv(['姓名', '車牌'], [['=cmd', 'A,B'], ['王', 'C"D']])
    expect(csv.charCodeAt(0)).toBe(0xfeff) // UTF-8 BOM
    // header row, then two data rows, CRLF-joined + trailing CRLF
    expect(csv.slice(1)).toBe('姓名,車牌\r\n' + "'=cmd,\"A,B\"\r\n" + '王,"C""D"\r\n')
  })
  it('empty roster → BOM + header only', () => {
    const csv = toSpreadsheetCsv(['姓名'], [])
    expect(csv).toBe('﻿姓名\r\n')
  })
})

describe('parseExportFilename', () => {
  it('accepts only our own members-YYYYMMDD.csv shape', () => {
    expect(parseExportFilename('attachment; filename="members-20260726.csv"')).toBe('members-20260726.csv')
    expect(parseExportFilename('attachment; filename=members-20260726.csv')).toBe('members-20260726.csv')
  })
  it('falls back to members.csv for anything unexpected or missing', () => {
    expect(parseExportFilename(null)).toBe('members.csv')
    expect(parseExportFilename('attachment; filename="evil.exe"')).toBe('members.csv')
    expect(parseExportFilename('attachment; filename="members-2026.csv"')).toBe('members.csv') // wrong digit count
  })
})
