const MedicalSupplyDonation = artifacts.require("MedicalSupplyDonation");

module.exports = function (deployer) {
  deployer.deploy(MedicalSupplyDonation);
};
