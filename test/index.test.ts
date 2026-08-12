import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/index'

describe('scaffold', () => {
  it('exports a semver version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
