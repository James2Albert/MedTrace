// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

contract MedicalSupplyDonation {
    uint public donationCount = 0;
    uint public userCount = 0;
    
    enum UserRole { Donor, NGO, HealthcareFacility }
    enum DonationStatus { Created, InTransit, Received, Distributed, Completed }
    
    struct User {
        uint id;
        address userAddress;
        string name;
        string organization;
        UserRole role;
        bool isRegistered;
        uint registrationDate;
    }
    
    struct Donation {
        uint id;
        uint donorId;
        uint recipientId;
        string itemName;
        string itemDescription;
        uint quantity;
        string unit;
        DonationStatus status;
        uint createdAt;
        uint updatedAt;
        string location;
        string notes;
    }
    
    mapping(uint => User) public users;
    mapping(address => uint) public addressToUserId;
    mapping(uint => Donation) public donations;
    mapping(uint => uint[]) public userDonations; // userId => donationIds
    
    event UserRegistered(uint indexed userId, address indexed userAddress, string name, UserRole role);
    event DonationCreated(uint indexed donationId, uint indexed donorId, string itemName, uint quantity);
    event DonationStatusUpdated(uint indexed donationId, DonationStatus oldStatus, DonationStatus newStatus);
    event DonationTransferred(uint indexed donationId, uint indexed fromUserId, uint indexed toUserId);
    
    modifier onlyRegistered() {
        require(addressToUserId[msg.sender] > 0, "User not registered");
        _;
    }
    
    modifier onlyDonor(uint _userId) {
        require(users[_userId].role == UserRole.Donor, "Only donors can perform this action");
        _;
    }
    
    modifier onlyNGO(uint _userId) {
        require(users[_userId].role == UserRole.NGO, "Only NGOs can perform this action");
        _;
    }
    
    function registerUser(
        string memory _name,
        string memory _organization,
        UserRole _role
    ) public {
        require(addressToUserId[msg.sender] == 0, "User already registered");
        require(bytes(_name).length > 0, "Name cannot be empty");
        require(bytes(_organization).length > 0, "Organization cannot be empty");
        
        userCount++;
        users[userCount] = User({
            id: userCount,
            userAddress: msg.sender,
            name: _name,
            organization: _organization,
            role: _role,
            isRegistered: true,
            registrationDate: block.timestamp
        });
        
        addressToUserId[msg.sender] = userCount;
        
        emit UserRegistered(userCount, msg.sender, _name, _role);
    }
    
    function createDonation(
        uint _recipientId,
        string memory _itemName,
        string memory _itemDescription,
        uint _quantity,
        string memory _unit,
        string memory _location,
        string memory _notes
    ) public onlyRegistered {
        uint donorId = addressToUserId[msg.sender];
        require(users[donorId].role == UserRole.Donor, "Only donors can create donations");
        require(users[_recipientId].isRegistered, "Recipient not registered");
        require(users[_recipientId].role != UserRole.Donor, "Recipient cannot be a donor");
        require(_quantity > 0, "Quantity must be greater than 0");
        require(bytes(_itemName).length > 0, "Item name cannot be empty");
        
        donationCount++;
        donations[donationCount] = Donation({
            id: donationCount,
            donorId: donorId,
            recipientId: _recipientId,
            itemName: _itemName,
            itemDescription: _itemDescription,
            quantity: _quantity,
            unit: _unit,
            status: DonationStatus.Created,
            createdAt: block.timestamp,
            updatedAt: block.timestamp,
            location: _location,
            notes: _notes
        });
        
        userDonations[donorId].push(donationCount);
        userDonations[_recipientId].push(donationCount);
        
        emit DonationCreated(donationCount, donorId, _itemName, _quantity);
    }
    
    function updateDonationStatus(
        uint _donationId,
        DonationStatus _newStatus
    ) public onlyRegistered {
        Donation storage donation = donations[_donationId];
        require(donation.id > 0, "Donation does not exist");
        
        uint userId = addressToUserId[msg.sender];
        require(
            donation.donorId == userId || 
            donation.recipientId == userId ||
            users[userId].role == UserRole.NGO,
            "Not authorized to update this donation"
        );
        
        DonationStatus oldStatus = donation.status;
        
        // Validate status transitions
        if (oldStatus == DonationStatus.Created) {
            require(_newStatus == DonationStatus.InTransit, "Invalid status transition");
        } else if (oldStatus == DonationStatus.InTransit) {
            require(_newStatus == DonationStatus.Received, "Invalid status transition");
        } else if (oldStatus == DonationStatus.Received) {
            require(_newStatus == DonationStatus.Distributed || _newStatus == DonationStatus.Completed, "Invalid status transition");
        } else if (oldStatus == DonationStatus.Distributed) {
            require(_newStatus == DonationStatus.Completed, "Invalid status transition");
        }
        
        donation.status = _newStatus;
        donation.updatedAt = block.timestamp;
        
        emit DonationStatusUpdated(_donationId, oldStatus, _newStatus);
    }
    
    function transferDonation(
        uint _donationId,
        uint _newRecipientId
    ) public onlyRegistered {
        Donation storage donation = donations[_donationId];
        require(donation.id > 0, "Donation does not exist");
        require(donation.status == DonationStatus.Received || donation.status == DonationStatus.InTransit, "Donation cannot be transferred in current status");
        
        uint userId = addressToUserId[msg.sender];
        require(
            donation.recipientId == userId || users[userId].role == UserRole.NGO,
            "Not authorized to transfer this donation"
        );
        require(users[_newRecipientId].isRegistered, "New recipient not registered");
        require(users[_newRecipientId].role == UserRole.HealthcareFacility || users[_newRecipientId].role == UserRole.NGO, "Invalid recipient role");
        
        uint oldRecipientId = donation.recipientId;
        donation.recipientId = _newRecipientId;
        donation.status = DonationStatus.InTransit;
        donation.updatedAt = block.timestamp;
        
        userDonations[_newRecipientId].push(_donationId);
        
        emit DonationTransferred(_donationId, oldRecipientId, _newRecipientId);
    }
    
    function updateDonationLocation(
        uint _donationId,
        string memory _location
    ) public onlyRegistered {
        Donation storage donation = donations[_donationId];
        require(donation.id > 0, "Donation does not exist");
        
        uint userId = addressToUserId[msg.sender];
        require(
            donation.donorId == userId || 
            donation.recipientId == userId ||
            users[userId].role == UserRole.NGO,
            "Not authorized to update this donation"
        );
        
        donation.location = _location;
        donation.updatedAt = block.timestamp;
    }
    
    function getUserDonations(uint _userId) public view returns (uint[] memory) {
        return userDonations[_userId];
    }
    
    function getDonation(uint _donationId) public view returns (
        uint id,
        uint donorId,
        uint recipientId,
        string memory itemName,
        string memory itemDescription,
        uint quantity,
        string memory unit,
        uint8 status,
        uint createdAt,
        uint updatedAt,
        string memory location,
        string memory notes
    ) {
        Donation memory donation = donations[_donationId];
        return (
            donation.id,
            donation.donorId,
            donation.recipientId,
            donation.itemName,
            donation.itemDescription,
            donation.quantity,
            donation.unit,
            uint8(donation.status),
            donation.createdAt,
            donation.updatedAt,
            donation.location,
            donation.notes
        );
    }
    
    function getUser(uint _userId) public view returns (
        uint id,
        address userAddress,
        string memory name,
        string memory organization,
        uint8 role,
        bool isRegistered,
        uint registrationDate
    ) {
        User memory user = users[_userId];
        return (
            user.id,
            user.userAddress,
            user.name,
            user.organization,
            uint8(user.role),
            user.isRegistered,
            user.registrationDate
        );
    }
}
