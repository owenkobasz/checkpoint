import { describe, it, expect } from 'vitest'
import { cityTokenSet, isDuplicate, labelWithCity } from './scan'

const philly = cityTokenSet('Philadelphia')

describe('isDuplicate', () => {
  it('matches ampersand vs "and" spellings', () => {
    expect(isDuplicate('broad and girard', 'Broad & Girard')).toBe(true)
  })

  it('matches a typed intersection against its city-suffixed scan label', () => {
    expect(isDuplicate('Broad & Girard', 'Broad & Girard, Philadelphia', philly)).toBe(true)
  })

  it('does NOT merge distinct checkpoints on the same street with city suffixes', () => {
    expect(
      isDuplicate('Broad & Girard, Philadelphia', 'Broad & Master, Philadelphia', philly)
    ).toBe(false)
  })

  it('does not match different cross streets', () => {
    expect(isDuplicate('2nd & Poplar', '4th & Poplar')).toBe(false)
  })

  it('requires exact equality for single-token names', () => {
    expect(isDuplicate('Girard', 'Front & Girard')).toBe(false)
    expect(isDuplicate('Girard', 'Girard Ave')).toBe(true)
  })

  it('strips street suffixes', () => {
    expect(isDuplicate('Broad St & Girard Ave', 'Broad & Girard')).toBe(true)
  })

  it('never matches stopword-only or empty strings', () => {
    expect(isDuplicate('', 'Broad & Girard')).toBe(false)
    expect(isDuplicate('and the', 'Broad & Girard')).toBe(false)
    expect(isDuplicate('', '')).toBe(false)
  })

  it('matches named places against their city-suffixed labels', () => {
    expect(isDuplicate('Tattooed Mom', 'Tattooed Mom, Philadelphia', philly)).toBe(true)
  })

  it('does not merge different named places in the same city', () => {
    expect(
      isDuplicate('Tattooed Mom, Philadelphia', "Pat's Steaks, Philadelphia", philly)
    ).toBe(false)
  })

  it('accepted false negative: numeric vs spelled ordinals do not match', () => {
    expect(isDuplicate('2nd & Poplar', 'Second & Poplar')).toBe(false)
  })
})

describe('cityTokenSet', () => {
  it('is empty for null', () => {
    expect(cityTokenSet(null).size).toBe(0)
  })

  it('tokenizes multi-word cities', () => {
    const tokens = cityTokenSet('Fishtown, Philadelphia')
    expect(tokens.has('fishtown')).toBe(true)
    expect(tokens.has('philadelphia')).toBe(true)
  })
})

describe('labelWithCity', () => {
  it('appends the city when absent', () => {
    expect(labelWithCity('Broad & Girard', 'Philadelphia')).toBe('Broad & Girard, Philadelphia')
  })

  it('does not append when the name already contains the city', () => {
    expect(labelWithCity('Liberty Bell, Philadelphia', 'Philadelphia')).toBe(
      'Liberty Bell, Philadelphia'
    )
  })

  it('passes through when no city was detected', () => {
    expect(labelWithCity('Broad & Girard', null)).toBe('Broad & Girard')
  })
})
