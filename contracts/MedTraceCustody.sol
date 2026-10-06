// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @title MedTrace custody ledger
/// @notice Records the chain of custody for MedTrace shipments.
///         Transactions are submitted by an approved relayer (gas sponsor), but every
///         state change must carry a signature from a registered actor's embedded wallet.
///         The relayer therefore cannot invent custody events, and the state machine
///         below is enforced regardless of what the off-chain backend does.
contract MedTraceCustody {
    enum Role { None, Dispatcher, Facility, Auditor }

    enum State {
        None,
        Created,
        Dispatched,
        InTransit,
        ReceiptPending,
        Received,
        Disputed,
        Investigated,
        Accepted,
        Rejected
    }

    enum Seal { Unchecked, Intact, Damaged, Missing }

    enum Action { Create, Dispatch, Depart, Arrive, Receive, Dispute, Investigate, Accept, Reject }

    struct Actor {
        Role role;
        bytes32 facility;
        bool active;
    }

    struct Shipment {
        bytes32 destination;
        bytes32 manifestHash;
        State state;
        uint64 createdAt;
        uint64 updatedAt;
        uint32 eventCount;
    }

    struct Receipt {
        Seal seal;
        bool conditionOk;
        bool identityOk;
        bytes32 evidenceHash;
        string evidenceCid;
        address receivedBy;
        uint64 at;
    }

    address public owner;
    mapping(address => bool) public relayers;
    mapping(address => Actor) public actors;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => Shipment) public shipments;
    mapping(bytes32 => Receipt) public receipts;
    uint256 public shipmentCount;

    event RelayerSet(address indexed relayer, bool allowed);
    event ActorSet(address indexed actor, Role role, bytes32 facility, bool active);
    event CustodyEvent(
        bytes32 indexed shipmentId,
        uint32 seq,
        Action action,
        State fromState,
        State toState,
        address indexed actor,
        bytes32 ref
    );
    event ReceiptRecorded(
        bytes32 indexed shipmentId,
        Seal seal,
        bool conditionOk,
        bool identityOk,
        bytes32 evidenceHash,
        string evidenceCid,
        address indexed actor
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    modifier onlyRelayer() {
        require(relayers[msg.sender], "Relayer not approved");
        _;
    }

    constructor() {
        owner = msg.sender;
        relayers[msg.sender] = true;
        emit RelayerSet(msg.sender, true);
    }

    // ---------------------------------------------------------------- admin

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setActor(address actor, Role role, bytes32 facility, bool active) external onlyOwner {
        require(actor != address(0), "Zero address");
        require(role != Role.Facility || facility != bytes32(0), "Facility code required");
        actors[actor] = Actor(role, facility, active);
        emit ActorSet(actor, role, facility, active);
    }

    // ---------------------------------------------------------------- custody

    function createShipment(
        bytes32 shipmentId,
        bytes32 destination,
        bytes32 manifestHash,
        address actor,
        bytes calldata signature
    ) external onlyRelayer {
        require(shipments[shipmentId].state == State.None, "Shipment already exists");
        require(destination != bytes32(0), "Destination required");
        require(manifestHash != bytes32(0), "Manifest hash required");
        _requireRole(actor, Role.Dispatcher);
        _verify(actor, shipmentId, Action.Create, keccak256(abi.encode(destination, manifestHash)), signature);

        Shipment storage s = shipments[shipmentId];
        s.destination = destination;
        s.manifestHash = manifestHash;
        s.createdAt = uint64(block.timestamp);
        shipmentCount++;
        _move(shipmentId, Action.Create, State.Created, actor, manifestHash);
    }

    /// @notice Every transition except creation and receipt.
    function transition(
        bytes32 shipmentId,
        Action action,
        bytes32 ref,
        address actor,
        bytes calldata signature
    ) external onlyRelayer {
        Shipment storage s = shipments[shipmentId];
        require(s.state != State.None, "Unknown shipment");
        State current = s.state;
        State next;

        if (action == Action.Dispatch) {
            require(current == State.Created, "Invalid transition");
            _requireRole(actor, Role.Dispatcher);
            next = State.Dispatched;
        } else if (action == Action.Depart) {
            require(current == State.Dispatched, "Invalid transition");
            _requireRole(actor, Role.Dispatcher);
            next = State.InTransit;
        } else if (action == Action.Arrive) {
            require(current == State.InTransit, "Invalid transition");
            _requireDestinationFacility(actor, s.destination);
            next = State.ReceiptPending;
        } else if (action == Action.Dispute) {
            require(current == State.InTransit || current == State.ReceiptPending, "Invalid transition");
            if (actors[actor].role == Role.Auditor) {
                _requireRole(actor, Role.Auditor);
            } else {
                _requireDestinationFacility(actor, s.destination);
            }
            next = State.Disputed;
        } else if (action == Action.Investigate) {
            require(current == State.Disputed, "Invalid transition");
            _requireRole(actor, Role.Auditor);
            next = State.Investigated;
        } else if (action == Action.Accept) {
            require(current == State.Investigated, "Invalid transition");
            _requireRole(actor, Role.Auditor);
            next = State.Accepted;
        } else if (action == Action.Reject) {
            require(current == State.Investigated, "Invalid transition");
            _requireRole(actor, Role.Auditor);
            next = State.Rejected;
        } else {
            revert("Use dedicated function");
        }

        _verify(actor, shipmentId, action, keccak256(abi.encode(ref)), signature);
        _move(shipmentId, action, next, actor, ref);
    }

    /// @notice Records clinic receipt verification. The contract decides the outcome:
    ///         only an intact seal with matching identity and acceptable condition
    ///         becomes Received; anything else becomes Disputed.
    function recordReceipt(
        bytes32 shipmentId,
        Seal seal,
        bool conditionOk,
        bool identityOk,
        bytes32 evidenceHash,
        string calldata evidenceCid,
        address actor,
        bytes calldata signature
    ) external onlyRelayer {
        Shipment storage s = shipments[shipmentId];
        require(s.state == State.ReceiptPending, "Invalid transition");
        require(seal != Seal.Unchecked, "Seal must be checked");
        require(evidenceHash != bytes32(0), "Evidence hash required");
        require(bytes(evidenceCid).length > 0, "Evidence CID required");
        _requireDestinationFacility(actor, s.destination);

        bytes32 payload = keccak256(
            abi.encode(seal, conditionOk, identityOk, evidenceHash, keccak256(bytes(evidenceCid)))
        );
        _verify(actor, shipmentId, Action.Receive, payload, signature);

        receipts[shipmentId] = Receipt(
            seal,
            conditionOk,
            identityOk,
            evidenceHash,
            evidenceCid,
            actor,
            uint64(block.timestamp)
        );

        bool verified = seal == Seal.Intact && conditionOk && identityOk;
        emit ReceiptRecorded(shipmentId, seal, conditionOk, identityOk, evidenceHash, evidenceCid, actor);
        _move(shipmentId, Action.Receive, verified ? State.Received : State.Disputed, actor, evidenceHash);
    }

    // ---------------------------------------------------------------- views

    function digestFor(
        address actor,
        bytes32 shipmentId,
        Action action,
        bytes32 payloadHash
    ) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, shipmentId, action, payloadHash, nonces[actor]));
    }

    // ---------------------------------------------------------------- internal

    function _move(bytes32 shipmentId, Action action, State next, address actor, bytes32 ref) internal {
        Shipment storage s = shipments[shipmentId];
        State previous = s.state;
        s.state = next;
        s.updatedAt = uint64(block.timestamp);
        s.eventCount++;
        emit CustodyEvent(shipmentId, s.eventCount, action, previous, next, actor, ref);
    }

    function _requireRole(address actor, Role role) internal view {
        Actor memory a = actors[actor];
        require(a.active, "Actor not active");
        require(a.role == role, "Actor role not permitted");
    }

    function _requireDestinationFacility(address actor, bytes32 destination) internal view {
        _requireRole(actor, Role.Facility);
        require(actors[actor].facility == destination, "Wrong facility");
    }

    function _verify(
        address actor,
        bytes32 shipmentId,
        Action action,
        bytes32 payloadHash,
        bytes calldata signature
    ) internal {
        bytes32 digest = digestFor(actor, shipmentId, action, payloadHash);
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        require(_recover(ethSigned, signature) == actor, "Bad actor signature");
        nonces[actor]++;
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad signature v");
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "Bad signature s"
        );
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "Bad signature");
        return signer;
    }
}
