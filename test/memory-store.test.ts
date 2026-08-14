import { MemoryStore } from '../src/index'
import { defineStoreContract } from './contract'

defineStoreContract('memory', () => new MemoryStore())
