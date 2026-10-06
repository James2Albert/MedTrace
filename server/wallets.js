const { ethers } = require('ethers')

/**
 * Embedded wallets: each MedTrace user gets a signing key derived from the server's
 * HD seed (m/44'/60'/0'/0/<walletIndex>). Keys never leave the server and users never
 * see addresses, gas or nonces. The keys only sign MedTrace custody actions; they hold
 * no ETH because the relayer pays for every transaction.
 */
class Wallets {
  constructor (mnemonic) {
    this.root = ethers.utils.HDNode.fromMnemonic(mnemonic)
    this.cache = new Map()
  }

  forIndex (index) {
    if (!this.cache.has(index)) {
      const node = this.root.derivePath(`m/44'/60'/0'/0/${index}`)
      this.cache.set(index, new ethers.Wallet(node.privateKey))
    }
    return this.cache.get(index)
  }

  forUser (user) {
    return this.forIndex(user.walletIndex)
  }
}

module.exports = { Wallets }
