import { createRequire } from 'node:module'
const require = createRequire('C:/Users/olhad/pumpswap/package.json')
const w3 = require('@solana/web3.js')
const { PublicKey, Connection } = w3
const PROG = new PublicKey('BYc1mF65g1JNr44BWefhnhKdPLDWbxcdUoKxcoDeZMWs')
const c = new Connection(process.env.RPC || 'https://api.devnet.solana.com', 'confirmed')
const bs58 = require('bs58').default

console.log('--- PublicKey class sanity ---')
console.log('new PublicKey().toBase58():', new PublicKey('11111111111111111111111111111111').toBase58())
console.log('PublicKey.default.toBase58():', PublicKey.default.toBase58())

c.getAccountInfo(PROG, 'confirmed').then((i) => {
  const o = i.owner
  console.log('\n--- account owner object ---')
  console.log('constructor.name:', o.constructor.name)
  console.log('constructor === PublicKey:', o.constructor === PublicKey)
  console.log('proto names:', Object.getOwnPropertyNames(Object.getPrototypeOf(o)).join(','))
  const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(o), 'toBase58')
  console.log('descriptor toBase58:', d ? `value=${typeof d.value} get=${typeof d.get}` : 'ABSENT')
  console.log('o.toBase58 typeof:', typeof o.toBase58)
  console.log('proto call:', (() => { try { return Object.getPrototypeOf(o).toBase58.call(o) } catch (e) { return 'THREW ' + e.message } })())
  console.log('bs58(toBuffer()):', bs58.encode(new Uint8Array(o.toBuffer())))
  console.log('toJSON:', typeof o.toJSON === 'function' ? o.toJSON() : 'n/a')
}).catch((e) => console.log('ERR', e.message))