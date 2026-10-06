/**
 * Truffle configuration for MedTrace
 */

module.exports = {
  networks: {
    /**
     * Local Ganache development network
     *
     * Start Ganache with:
     * ganache --host 127.0.0.1 --port 7545 --chain.networkId 5777 --chain.chainId 5777
     */
    development: {
      host: "127.0.0.1",
      port: 7545,
      network_id: "5777",
      networkCheckTimeout: 10000
    }
  },

  // Mocha test configuration
  mocha: {
    timeout: 100000
  },

  // Solidity compiler configuration
compilers: {
  solc: {
    version: "0.8.20",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: false,
        runs: 200
      }
    }
  }
}
};
