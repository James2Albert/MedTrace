var MedicalSupplyDonation = artifacts.require("./MedicalSupplyDonation.sol");

module.exports = function(deployer) {
  deployer.deploy(MedicalSupplyDonation);
}