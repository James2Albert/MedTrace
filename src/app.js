App = {
  loading: false,
  web3: null,
  account: null,
  previousAccount: null,
  medicalSupplyDonation: null,
  contractAddress: null,
  currentUser: null,
  allUsers: [],

  load: async () => {
    console.log("🚀 Loading Medical Supply Donation DApp...")
    
    const showLoadError = (msg, detail) => {
      App.setLoading(false)
      $('#content').html(
        '<div class="alert alert-danger">' +
        '<strong>Failed to load DApp</strong><br>' + msg +
        (detail ? '<br><small class="text-muted">' + detail + '</small>' : '') +
        '<br><button type="button" class="btn btn-primary mt-2" onclick="window.location.reload()">Reload page</button>' +
        '</div>'
      )
      $('#content').show()
    }

    try {
      App.setLoading(true)
      
      const web3Loaded = await App.loadWeb3()
      if (!web3Loaded) {
        console.log("❌ Web3 not loaded, stopping initialization")
        showLoadError("Web3 could not be loaded.", "Install MetaMask or check the browser console for errors (e.g. Content Security Policy blocking eval).")
        return
      }
      
      await App.loadAccount()
      
      if (!App.account) {
        console.log("⚠️ No account available, showing connection needed message")
        App.setLoading(false)
        $('#content').html('<div class="alert alert-warning">Please connect your MetaMask wallet</div>')
        $('#content').show()
        return
      }
      
      await App.loadContract()
      
      if (!App.medicalSupplyDonation) {
        console.log("⚠️ Contract not loaded, showing network error")
        App.setLoading(false)
        $('#content').show()
        return
      }
      
      await App.checkRegistration()
      await App.loadUsers()
      await App.render()
      
      App.setLoading(false)
      $('#content').show()
      
    } catch (error) {
      console.error("❌ Error during initialization:", error)
      showLoadError("An error occurred during loading.", error.message || String(error))
    }
  },

  loadWeb3: async () => {
    if (window.ethereum) {
      App.web3 = new Web3(window.ethereum)
      
      try {
        // Request accounts first
        await window.ethereum.request({ method: 'eth_requestAccounts' })
        console.log("✅ MetaMask connected!")
        
        // Get initial account
        const initialAccounts = await window.ethereum.request({ method: 'eth_accounts' })
        if (initialAccounts && initialAccounts.length > 0) {
          App.previousAccount = initialAccounts[0].toLowerCase()
          App.account = initialAccounts[0]
          console.log("📝 Initial account:", App.previousAccount)
        }
        
        // Listen for account changes
        window.ethereum.on('accountsChanged', async (accounts) => {
          console.log("🔄 Account change detected via MetaMask")
          if (accounts && accounts.length > 0) {
            const newAccount = accounts[0].toLowerCase()
            if (newAccount !== App.previousAccount) {
              console.log(`🔄 Switching from ${App.previousAccount} to ${newAccount}`)
              App.previousAccount = newAccount
              App.account = accounts[0]
              App.currentUser = null
              App.allUsers = []
              
              // Force reload of all data
              try {
                App.setLoading(true)
                await App.checkRegistration()
                await App.loadUsers()
                await App.render()
              } catch (error) {
                console.error("❌ Error handling account change:", error)
                // Reset and show registration on error
                App.currentUser = null
                $('#registrationSection').show()
                $('#userInfoSection').hide()
              } finally {
                App.setLoading(false)
              }
            }
          } else {
            // No accounts connected
            console.log("⚠️ No accounts connected")
            App.previousAccount = null
            App.account = null
            App.currentUser = null
            App.render()
          }
        })
        
        // Listen for network changes
        window.ethereum.on('chainChanged', (chainId) => {
          console.log("🔄 Network changed:", chainId)
          // Reload entire page for network changes
          window.location.reload()
        })
        
      } catch (error) {
        console.error("❌ User denied account access:", error)
        alert("Please connect to MetaMask to use this DApp")
        return false
      }
    }
    else if (window.web3) {
      App.web3 = new Web3(window.web3.currentProvider)
      console.log("⚠️ Legacy web3 detected")
    }
    else {
      console.log('❌ No Ethereum browser detected')
      alert("Please install MetaMask to use this DApp!\n\nVisit: https://metamask.io")
      return false
    }
    
    return true
  },

  loadAccount: async () => {
    try {
      if (!App.web3) {
        throw new Error("Web3 not initialized")
      }
      
      // Get current account from MetaMask
      let accounts = []
      if (window.ethereum) {
        accounts = await window.ethereum.request({ method: 'eth_accounts' })
      } else {
        accounts = await App.web3.eth.getAccounts()
      }
      
      if (accounts && accounts.length > 0) {
        App.account = accounts[0]
        if (!App.previousAccount) {
          App.previousAccount = App.account.toLowerCase()
        }
        console.log("👤 Account loaded:", App.account.substring(0, 10) + "...")
      } else {
        console.log("⚠️ No accounts available")
        App.account = null
      }
      
    } catch (error) {
      console.error("❌ Error loading account:", error)
      App.account = null
    }
  },

  loadContract: async () => {
    try {
      console.log("📄 Loading contract...")
      
      // Try to load contract ABI — prefer build artifact (updated by truffle migrate) so
      // we always get the current network ID and address after Ganache restarts.
      let contractJson
      const contractPaths = [
        '/contracts/MedicalSupplyDonation.json',  // lite-server route → build/contracts (canonical)
        'MedicalSupplyDonation.json',             // src copy (fallback)
        '../build/contracts/MedicalSupplyDonation.json'
      ]
      let lastError
      for (const path of contractPaths) {
        try {
          const response = await fetch(path)
          if (!response.ok) continue
          contractJson = await response.json()
          if (contractJson && contractJson.abi) {
            console.log("✅ Contract JSON loaded from", path)
            break
          }
        } catch (e) {
          lastError = e
        }
      }
      if (!contractJson || !contractJson.abi) {
        console.error("❌ Contract JSON not found in any location", lastError)
        $('#networkWarning').show()
        $('#networkWarningMessage').html(`
          <strong>Contract JSON file not found!</strong><br><br>
          Make sure to:<br>
          1. Compile the contract: <code>truffle compile</code><br>
          2. Deploy the contract: <code>truffle migrate</code><br>
          3. Run the app with <code>npm run dev</code> so the build artifact is served.
        `)
        return false
      }
      
      // Get network ID
      const networkId = await App.web3.eth.net.getId()
      console.log("🌐 Current network ID:", networkId)
      
      // Check if contract is deployed on this network
      const deployedNetwork = contractJson.networks[networkId]
      
      if (!deployedNetwork) {
        // Check all available networks
        const availableNetworks = Object.keys(contractJson.networks)
        if (availableNetworks.length === 0) {
          console.error("❌ Contract not deployed on any network")
          $('#networkWarning').show()
          $('#networkWarningMessage').html(`
            <strong>Contract not deployed!</strong><br><br>
            Run: <code>truffle migrate</code> to deploy the contract to your local network.
          `)
          return false
        }
        
        console.log("⚠️ Contract not on current network. Available networks:", availableNetworks)
        
        // Show network warning with available networks and solutions
        const networkList = availableNetworks.map(id => {
          const addr = contractJson.networks[id].address
          return `<li>Network ID: <code>${id}</code> (Address: <code>${addr.substring(0, 10)}...</code>)</li>`
        }).join('')
        
        $('#networkWarningMessage').html(`
          <strong>⚠️ Network Mismatch Detected</strong><br><br>
          <strong>Current Network ID:</strong> <code>${networkId}</code><br>
          <strong>Contract deployed on:</strong>
          <ul>${networkList}</ul>
          
          <strong>This happens when Ganache was restarted with a new network ID.</strong> The contract addresses above are from previous Ganache runs.<br><br>
          
          <strong>Quick Fix (recommended):</strong><br>
          1. Open your terminal in the project folder<br>
          2. Run: <code>truffle migrate --reset</code><br>
          3. Refresh this page<br><br>
          
          <strong>If you're on the wrong chain</strong> (e.g. Mainnet instead of Ganache), use the button below to switch to Localhost 8545. If you're already on Ganache, the fix above is required.
        `)
        $('#networkWarning').show()
        
        return false
      }
      
      App.contractAddress = deployedNetwork.address
      console.log("✅ Contract address:", App.contractAddress)
      
      // Create contract instance
      App.medicalSupplyDonation = new App.web3.eth.Contract(
        contractJson.abi,
        App.contractAddress
      )
      
      console.log("✅ Contract instance created")
      
      // Hide network warning
      $('#networkWarning').hide()
      
      return true
      
    } catch (error) {
      console.error("❌ Error loading contract:", error)
      
      $('#networkWarning').show()
      $('#networkWarningMessage').html(`
        <strong>Error loading contract:</strong><br>
        ${error.message}<br><br>
        Make sure:<br>
        1. Ganache is running<br>
        2. Contract is compiled: <code>truffle compile</code><br>
        3. Contract is deployed: <code>truffle migrate</code><br>
        4. MetaMask is connected to localhost
      `)
      
      return false
    }
  },

  checkRegistration: async () => {
    try {
      if (!App.medicalSupplyDonation || !App.account) {
        console.log("⚠️ Contract or account not loaded")
        App.currentUser = null
        $('#registrationSection').show()
        $('#userInfoSection').hide()
        return
      }
      
      console.log("🔍 Checking registration for:", App.account)
      
      // Call contract method with proper error handling
      const userId = await App.medicalSupplyDonation.methods
        .addressToUserId(App.account)
        .call({ from: App.account })
        .catch(err => {
          console.log("ℹ️ User not registered or contract call failed:", err.message)
          return "0"
        })
      
      console.log("🔍 User ID result:", userId)
      
      // Parse userId safely
      let userIdNum
      if (typeof userId === 'string') {
        userIdNum = parseInt(userId, 10)
      } else if (typeof userId === 'object' && userId.toString) {
        userIdNum = parseInt(userId.toString(), 10)
      } else {
        userIdNum = parseInt(userId, 10)
      }
      
      if (userIdNum > 0) {
        console.log("✅ User is registered, fetching details...")
        
        const user = await App.medicalSupplyDonation.methods
          .getUser(userIdNum)
          .call({ from: App.account })
          .catch(err => {
            console.error("❌ Error fetching user:", err)
            return null
          })
        
        if (user) {
          App.currentUser = {
            id: userIdNum,
            name: user.name || user[2],
            organization: user.organization || user[3],
            role: parseInt(user.role || user[4]),
            isActive: user.isRegistered !== undefined ? user.isRegistered : user[5],
            userAddress: user.userAddress || user[1]
          }
          
          console.log("✅ User details loaded:", App.currentUser)
          
          $('#registrationSection').hide()
          $('#userInfoSection').show()
        } else {
          App.currentUser = null
          $('#registrationSection').show()
          $('#userInfoSection').hide()
        }
      } else {
        console.log("ℹ️ User not registered")
        App.currentUser = null
        $('#registrationSection').show()
        $('#userInfoSection').hide()
      }
      
    } catch (error) {
      console.error("❌ Error checking registration:", error)
      App.currentUser = null
      $('#registrationSection').show()
      $('#userInfoSection').hide()
    }
  },

  loadUsers: async () => {
    try {
      if (!App.medicalSupplyDonation || !App.account) {
        console.log("⚠️ Cannot load users - contract or account not ready")
        return
      }
      
      console.log("👥 Loading all users...")
      
      const userCountResult = await App.medicalSupplyDonation.methods
        .userCount()
        .call({ from: App.account })
        .catch(err => {
          console.error("❌ Error getting user count:", err)
          return "0"
        })
      
      const count = parseInt(userCountResult.toString(), 10)
      console.log(`📊 Total users to load: ${count}`)
      
      App.allUsers = []
      
      for (let i = 1; i <= count; i++) {
        try {
          const user = await App.medicalSupplyDonation.methods
            .getUser(i)
            .call({ from: App.account })
          
          if (user) {
            const userData = {
              id: i,
              name: user.name || user[2],
              organization: user.organization || user[3],
              role: parseInt(user.role || user[4]),
              isActive: user.isRegistered !== undefined ? user.isRegistered : user[5],
              userAddress: user.userAddress || user[1]
            }
            
            App.allUsers.push(userData)
          }
        } catch (err) {
          console.error(`❌ Error loading user ${i}:`, err)
        }
      }
      
      console.log(`✅ Loaded ${App.allUsers.length} users`)
      
    } catch (error) {
      console.error("❌ Error loading users:", error)
      App.allUsers = []
    }
  },

  registerUser: async () => {
    try {
      App.setLoading(true)
      
      const name = $('#userName').val()
      const organization = $('#userOrganization').val()
      const role = $('#userRole').val()
      
      if (!name || !organization || role === '') {
        alert('Please fill in all fields')
        App.setLoading(false)
        return
      }
      
      console.log('📝 Registering user:', { name, organization, role })
      
      await App.medicalSupplyDonation.methods
        .registerUser(name, organization, parseInt(role))
        .send({ from: App.account })
      
      console.log('✅ User registered successfully!')
      alert('Registration successful!')
      
      // Clear form
      $('#registrationForm')[0].reset()
      
      // Reload data
      await App.checkRegistration()
      await App.loadUsers()
      await App.render()
      
    } catch (error) {
      console.error('❌ Error registering user:', error)
      alert('Error registering user: ' + error.message)
    } finally {
      App.setLoading(false)
    }
  },

  createDonation: async () => {
    try {
      App.setLoading(true)
      
      const itemName = $('#itemName').val()
      const quantity = $('#itemQuantity').val()
      const unit = $('#itemUnit').val()
      const recipientId = $('#recipientId').val()
      const location = $('#donationLocation').val()
      const description = $('#itemDescription').val()
      const notes = $('#donationNotes').val()
      
      if (!itemName || !quantity || !unit || !recipientId || !location) {
        alert('Please fill in all required fields')
        App.setLoading(false)
        return
      }
      
      console.log('📦 Creating donation...')
      
      // Contract order: recipientId, itemName, itemDescription, quantity, unit, location, notes
      await App.medicalSupplyDonation.methods
        .createDonation(
          parseInt(recipientId, 10),
          itemName.trim(),
          (description || '').trim(),
          parseInt(quantity, 10),
          unit.trim(),
          location.trim(),
          (notes || '').trim()
        )
        .send({ from: App.account })
      
      console.log('✅ Donation created successfully!')
      alert('Donation created successfully!')
      
      // Clear form
      $('#donationForm')[0].reset()
      
      // Reload data
      await App.render()
      
    } catch (error) {
      console.error('❌ Error creating donation:', error)
      alert('Error creating donation: ' + error.message)
    } finally {
      App.setLoading(false)
    }
  },

  updateDonationStatus: async () => {
    try {
      App.setLoading(true)
      
      const donationId = $('#statusDonationId').val()
      const newStatus = $('#newStatus').val()
      
      if (!donationId || newStatus === '') {
        alert('Please select a status')
        App.setLoading(false)
        return
      }
      
      console.log('🔄 Updating donation status...')
      
      await App.medicalSupplyDonation.methods
        .updateDonationStatus(parseInt(donationId), parseInt(newStatus))
        .send({ from: App.account })
      
      console.log('✅ Status updated successfully!')
      alert('Status updated successfully!')
      
      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('statusModal'))
      modal.hide()
      
      // Reload data
      await App.render()
      
    } catch (error) {
      console.error('❌ Error updating status:', error)
      alert('Error updating status: ' + error.message)
    } finally {
      App.setLoading(false)
    }
  },

  transferDonation: async () => {
    try {
      App.setLoading(true)
      
      const donationId = $('#transferDonationId').val()
      const recipientId = $('#transferRecipientId').val()
      
      if (!donationId || !recipientId) {
        alert('Please select a recipient')
        App.setLoading(false)
        return
      }
      
      console.log('🔄 Transferring donation...')
      
      await App.medicalSupplyDonation.methods
        .transferDonation(parseInt(donationId), parseInt(recipientId))
        .send({ from: App.account })
      
      console.log('✅ Donation transferred successfully!')
      alert('Donation transferred successfully!')
      
      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('transferModal'))
      modal.hide()
      
      // Reload data
      await App.render()
      
    } catch (error) {
      console.error('❌ Error transferring donation:', error)
      alert('Error transferring donation: ' + error.message)
    } finally {
      App.setLoading(false)
    }
  },

  render: async () => {
    try {
      console.log('🎨 Rendering UI...')
      
      // Update account display
      if (App.account) {
        const shortAccount = App.account.substring(0, 6) + '...' + App.account.substring(38)
        $('#account').text(shortAccount)
      } else {
        $('#account').text('Not connected')
      }
      
      // If contract not loaded, show limited UI
      if (!App.medicalSupplyDonation) {
        console.log('⚠️ Contract not loaded, showing limited UI')
        $('#registrationSection').hide()
        $('#userInfoSection').hide()
        $('#createDonationSection').hide()
        $('#donationsList').html('<div class="alert alert-warning">Please fix the network issue above to use the application.</div>')
        return
      }
      
      // Update user info
      if (App.currentUser) {
        const roleNames = ['Donor', 'NGO', 'Healthcare Facility']
        const userInfoHtml = `
          <p class="mb-1"><strong>Name:</strong> ${App.currentUser.name}</p>
          <p class="mb-1"><strong>Organization:</strong> ${App.currentUser.organization}</p>
          <p class="mb-1"><strong>Role:</strong> ${roleNames[App.currentUser.role]}</p>
          <p class="mb-0"><strong>Address:</strong> <code>${App.currentUser.userAddress}</code></p>
        `
        $('#userInfoContent').html(userInfoHtml)
        
        // Show create donation section for donors
        if (App.currentUser.role === 0) {
          $('#createDonationSection').show()
        } else {
          $('#createDonationSection').hide()
        }
      }
      
      // Populate recipient dropdowns
      const recipients = App.allUsers.filter(u => u.role === 1 || u.role === 2)
      const recipientOptions = recipients.map(r => 
        `<option value="${r.id}">${r.name} (${r.organization})</option>`
      ).join('')
      
      $('#recipientId').html('<option value="">Select Recipient</option>' + recipientOptions)
      $('#transferRecipientId').html('<option value="">Select Recipient</option>' + recipientOptions)
      
      // Load and display donations
      await App.renderDonations()
      
      console.log('✅ UI rendered successfully')
      
    } catch (error) {
      console.error('❌ Error rendering UI:', error)
    }
  },

  renderDonations: async () => {
    try {
      if (!App.medicalSupplyDonation || !App.account) {
        console.log("⚠️ Cannot render donations - contract or account not ready")
        $('#noDonations').show()
        return
      }
      
      console.log('📋 Loading donations...')
      
      const donationCountResult = await App.medicalSupplyDonation.methods
        .donationCount()
        .call({ from: App.account })
        .catch(err => {
          console.error("❌ Error getting donation count:", err)
          return "0"
        })
      
      const count = parseInt(donationCountResult.toString(), 10)
      console.log(`📊 Total donations: ${count}`)
      
      let donationsHtml = ''
      let totalDonations = 0
      let completedDonations = 0
      let inTransitDonations = 0
      let myDonations = 0
      
      const statusNames = ['Created', 'In Transit', 'Received', 'Distributed', 'Completed']
      const statusClasses = ['created', 'intransit', 'received', 'distributed', 'completed']
      
      for (let i = 1; i <= count; i++) {
        try {
          const donation = await App.medicalSupplyDonation.methods
            .getDonation(i)
            .call({ from: App.account })
          
          if (donation) {
            totalDonations++
            
            // Contract getDonation returns: id, donorId, recipientId, itemName, itemDescription, quantity, unit, status, createdAt, updatedAt, location, notes (indices 0-11)
            // Contract has no currentHolderId; use recipientId for display
            const donationData = {
              id: i,
              itemName: donation.itemName || donation[3],
              quantity: parseInt(donation.quantity || donation[5], 10),
              unit: donation.unit || donation[6],
              donorId: parseInt(donation.donorId || donation[1], 10),
              currentHolderId: parseInt(donation.recipientId || donation[2], 10),
              recipientId: parseInt(donation.recipientId || donation[2], 10),
              status: parseInt(donation.status || donation[7], 10),
              location: donation.location || donation[10],
              description: donation.itemDescription || donation[4],
              notes: donation.notes || donation[11],
              timestamp: parseInt(donation.createdAt || donation[8], 10)
            }
            
            // Get donor info
            const donor = App.allUsers.find(u => u.id === donationData.donorId)
            const donorName = donor ? donor.name : 'Unknown'
            
            // Get current holder info
            const holder = App.allUsers.find(u => u.id === donationData.currentHolderId)
            const holderName = holder ? holder.name : 'Unknown'
            
            // Get recipient info
            const recipient = App.allUsers.find(u => u.id === donationData.recipientId)
            const recipientName = recipient ? recipient.name : 'Unknown'
            
            // Update statistics
            if (donationData.status === 4) completedDonations++
            if (donationData.status === 1) inTransitDonations++
            if (App.currentUser && donationData.donorId === App.currentUser.id) myDonations++
            
            // Check if current user can update this donation
            const canUpdate = App.currentUser && 
              (donationData.currentHolderId === App.currentUser.id || 
               donationData.donorId === App.currentUser.id ||
               App.currentUser.role === 1) // NGO can update any donation
            
            const date = new Date(donationData.timestamp * 1000).toLocaleDateString()
            
            donationsHtml += `
              <div class="donation-card card ${statusClasses[donationData.status]}">
                <div class="card-body">
                  <div class="row">
                    <div class="col-md-8">
                      <h5 class="card-title mb-2">
                        <i class="bi bi-box-seam"></i> ${donationData.itemName}
                      </h5>
                      <p class="mb-1"><strong>Quantity:</strong> ${donationData.quantity} ${donationData.unit}</p>
                      <p class="mb-1"><strong>Donor:</strong> ${donorName}</p>
                      <p class="mb-1"><strong>Current Holder:</strong> ${holderName}</p>
                      <p class="mb-1"><strong>Recipient:</strong> ${recipientName}</p>
                      <p class="mb-1"><strong>Location:</strong> ${donationData.location}</p>
                      ${donationData.description ? `<p class="mb-1"><strong>Description:</strong> ${donationData.description}</p>` : ''}
                      ${donationData.notes ? `<p class="mb-1"><strong>Notes:</strong> ${donationData.notes}</p>` : ''}
                      <p class="mb-0"><small class="text-muted"><i class="bi bi-calendar"></i> ${date}</small></p>
                    </div>
                    <div class="col-md-4 text-end">
                      <span class="status-badge status-${statusClasses[donationData.status]} mb-3 d-inline-block">
                        ${statusNames[donationData.status]}
                      </span>
                      ${canUpdate ? `
                        <div class="mt-3">
                          <button class="btn btn-sm btn-primary mb-2" onclick="App.openStatusModal(${i}, ${donationData.status})">
                            <i class="bi bi-arrow-repeat"></i> Update Status
                          </button>
                          ${App.currentUser.role === 1 ? `
                            <button class="btn btn-sm btn-warning" onclick="App.openTransferModal(${i})">
                              <i class="bi bi-arrow-left-right"></i> Transfer
                            </button>
                          ` : ''}
                        </div>
                      ` : ''}
                    </div>
                  </div>
                </div>
              </div>
            `
          }
        } catch (err) {
          console.error(`❌ Error loading donation ${i}:`, err)
        }
      }
      
      // Update statistics
      $('#totalDonations').text(totalDonations)
      $('#completedDonations').text(completedDonations)
      $('#inTransitDonations').text(inTransitDonations)
      $('#myDonations').text(myDonations)
      
      if (donationsHtml) {
        $('#donationsList').html(donationsHtml)
        $('#noDonations').hide()
      } else {
        $('#donationsList').html('')
        $('#noDonations').show()
      }
      
      console.log('✅ Donations rendered successfully')
      
    } catch (error) {
      console.error('❌ Error rendering donations:', error)
      $('#noDonations').show()
    }
  },

  openStatusModal: (donationId, currentStatus) => {
    $('#statusDonationId').val(donationId)
    
    const statusNames = ['Created', 'In Transit', 'Received', 'Distributed', 'Completed']
    $('#currentStatus').val(statusNames[currentStatus])
    
    // Only allow transitions the contract permits: Created→InTransit, InTransit→Received, Received→Distributed|Completed, Distributed→Completed
    const allowedNext = {
      0: [1],           // Created → InTransit only
      1: [2],           // InTransit → Received only
      2: [3, 4],        // Received → Distributed or Completed
      3: [4]            // Distributed → Completed only
    }
    const nextStatuses = allowedNext[currentStatus] || []
    let statusOptions = ''
    nextStatuses.forEach(i => {
      statusOptions += `<option value="${i}">${statusNames[i]}</option>`
    })
    $('#newStatus').html(statusOptions || '<option value="">No next status</option>')
    
    const modal = new bootstrap.Modal(document.getElementById('statusModal'))
    modal.show()
  },

  openTransferModal: (donationId) => {
    $('#transferDonationId').val(donationId)
    
    const modal = new bootstrap.Modal(document.getElementById('transferModal'))
    modal.show()
  },

  getAvailableNetworks: async () => {
    try {
      const paths = ['/contracts/MedicalSupplyDonation.json', 'MedicalSupplyDonation.json', '../build/contracts/MedicalSupplyDonation.json']
      let contractJson
      for (const path of paths) {
        try {
          const response = await fetch(path)
          if (response.ok) {
            contractJson = await response.json()
            if (contractJson && contractJson.networks) break
          }
        } catch (e) { /* try next */ }
      }
      if (!contractJson || !contractJson.networks) return []
      const networkIds = Object.keys(contractJson.networks)
      console.log("📋 Available networks from contract:", networkIds)
      return networkIds.map(id => ({
        networkId: id,
        chainId: '0x539',
        address: contractJson.networks[id].address
      }))
    } catch (error) {
      console.error("❌ Error getting available networks:", error)
      return []
    }
  },

  // New method to switch to a specific available network
  switchToAvailableNetwork: async (targetNetworkId) => {
    try {
      if (!window.ethereum) {
        console.log("⚠️ No MetaMask detected")
        alert("Please install MetaMask to use this application")
        return false
      }

      console.log(`🔄 Attempting to switch to network ${targetNetworkId}...`)
      
      // For Ganache, the chain ID is always 1337 (0x539)
      const targetChainId = '0x539'
      
      // First check if we need to add the network
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' })
      
      if (currentChainId.toLowerCase() === targetChainId.toLowerCase()) {
        console.log("✅ Already on Ganache network")
        // Just reload to pick up the contract
        window.location.reload()
        return true
      }
      
      try {
        // Try to switch to Ganache network
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetChainId }],
        })
        console.log(`✅ Successfully switched to Ganache network`)
        // Reload to reinitialize everything
        setTimeout(() => window.location.reload(), 1000)
        return true
      } catch (switchError) {
        console.error("Switch error:", switchError)
        
        // Error 4902 means the chain hasn't been added to MetaMask
        if (switchError.code === 4902) {
          console.log(`➕ Ganache network not in MetaMask, adding it...`)
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: targetChainId,
                chainName: 'Ganache Local',
                nativeCurrency: {
                  name: 'ETH',
                  symbol: 'ETH',
                  decimals: 18
                },
                rpcUrls: ['http://127.0.0.1:8545'],
                blockExplorerUrls: null
              }],
            })
            console.log(`✅ Ganache network added successfully`)
            setTimeout(() => window.location.reload(), 1000)
            return true
          } catch (addError) {
            console.error(`❌ Failed to add Ganache network:`, addError)
            alert("Failed to add Ganache network. Please add it manually in MetaMask:\n\nNetwork Name: Ganache Local\nRPC URL: http://127.0.0.1:8545\nChain ID: 1337\nCurrency Symbol: ETH")
            return false
          }
        } else if (switchError.code === 4001) {
          // User rejected the request
          console.log("👤 User rejected network switch")
          return false
        } else {
          console.error(`❌ Failed to switch network:`, switchError)
          alert("Failed to switch network. Please switch manually in MetaMask to Ganache/Localhost 8545")
          return false
        }
      }
    } catch (error) {
      console.error("❌ Error in switchToAvailableNetwork:", error)
      return false
    }
  },

  // Robust network switching that tries all available networks
  ensureCorrectNetwork: async () => {
    try {
      if (!window.ethereum) {
        console.log("⚠️ No MetaMask detected")
        return false
      }

      // Get current network
      let currentChainId, currentNetworkId
      try {
        currentChainId = await window.ethereum.request({ method: 'eth_chainId' })
        currentNetworkId = await App.web3.eth.net.getId()
        console.log("🔗 Current network - Chain ID:", currentChainId, "Network ID:", currentNetworkId)
      } catch (error) {
        console.error("❌ Error getting current network:", error)
        return false
      }

      // Get available networks from contract
      const availableNetworks = await App.getAvailableNetworks()
      if (availableNetworks.length === 0) {
        console.error("❌ No networks found in contract JSON")
        return false
      }

      // Check if we're already on a valid network
      // For Ganache, check chain ID (1337/0x539) first
      const isOnGanacheChainId = currentChainId.toLowerCase() === '0x539'
      
      // Also check if network ID matches any deployed network
      const matchingNetwork = availableNetworks.find(net => 
        net.networkId === currentNetworkId.toString()
      )

      if (isOnGanacheChainId && matchingNetwork) {
        console.log("✅ Already on correct Ganache network")
        $('#networkWarning').hide()
        return true
      }

      if (isOnGanacheChainId && !matchingNetwork) {
        console.log("⚠️ On Ganache chain but wrong network ID")
        console.log(`Current network ID: ${currentNetworkId}`)
        console.log(`Contract deployed on: ${availableNetworks.map(n => n.networkId).join(', ')}`)
        
        // Show helpful message
        alert(`⚠️ Network ID Mismatch\n\nYou're on Ganache (Chain ID 1337) but the network ID doesn't match.\n\nCurrent Network ID: ${currentNetworkId}\nContract deployed on: ${availableNetworks.map(n => n.networkId).join(', ')}\n\nThis usually happens when Ganache was restarted.\n\nSolutions:\n1. Run 'truffle migrate --reset' to redeploy\n2. Or restart Ganache to restore the previous network state`)
        
        return false
      }

      console.log("⚠️ Not on Ganache network, attempting to switch...")
      console.log("📋 Available networks:", availableNetworks.map(n => `${n.networkId} (${n.chainId})`).join(', '))

      // Try to switch to Ganache (chain ID 0x539)
      const targetChainId = '0x539'
      console.log(`🔄 Attempting to switch to Ganache network (Chain ID: ${targetChainId})...`)
      
      try {
        // Try to switch to Ganache network
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: targetChainId }],
        })
        console.log(`✅ Successfully switched to Ganache network`)
        // Wait a bit then reload to ensure network change is processed
        setTimeout(() => window.location.reload(), 1500)
        return true
      } catch (switchError) {
        // Error 4902 means the chain hasn't been added to MetaMask
        if (switchError.code === 4902) {
          console.log(`➕ Ganache network not in MetaMask, adding it...`)
          try {
            await window.ethereum.request({
              method: 'wallet_addEthereumChain',
              params: [{
                chainId: targetChainId,
                chainName: 'Ganache Local',
                nativeCurrency: {
                  name: 'ETH',
                  symbol: 'ETH',
                  decimals: 18
                },
                rpcUrls: ['http://127.0.0.1:8545'],
                blockExplorerUrls: null
              }],
            })
            console.log(`✅ Ganache network added and switched`)
            setTimeout(() => window.location.reload(), 1500)
            return true
          } catch (addError) {
            console.log(`❌ Failed to add Ganache network:`, addError.message)
            if (addError.code === 4001) {
              console.log("👤 User rejected network addition")
              return false
            }
            return false
          }
        } else if (switchError.code === -32002) {
          // Request already pending - wait and retry
          console.log("⏳ Network switch request already pending, waiting...")
          await new Promise(resolve => setTimeout(resolve, 2000))
          try {
            await window.ethereum.request({
              method: 'wallet_switchEthereumChain',
              params: [{ chainId: targetChainId }],
            })
            setTimeout(() => window.location.reload(), 1500)
            return true
          } catch (retryError) {
            console.log("❌ Retry also failed:", retryError.message)
            return false
          }
        } else if (switchError.code === 4001) {
          // User rejected the request
          console.log("👤 User rejected network switch")
          return false
        } else {
          console.log(`❌ Failed to switch to Ganache network:`, switchError.message)
          return false
        }
      }
    } catch (error) {
      console.error("❌ Error in ensureCorrectNetwork:", error)
      return false
    }
  },

  switchToGanache: async () => {
    console.log("🔄 Manual network switch requested...")
    const result = await App.ensureCorrectNetwork()
    if (result) {
      console.log("✅ Network switch successful")
      // Page will reload automatically
    } else {
      console.log("❌ Network switch failed or was cancelled")
      alert("Could not switch to local network. Please switch manually in MetaMask:\n\n1. Click MetaMask extension\n2. Click network dropdown\n3. Select 'Localhost 8545' or 'Ganache Local'\n4. If not available, add it with RPC URL: http://127.0.0.1:8545 and Chain ID: 1337")
    }
  },

  switchToLocalNetwork: async () => {
    return App.switchToGanache()
  },

  setLoading: (boolean) => {
    App.loading = boolean
    if (boolean) {
      $('#loader').show()
      $('#content').hide()
    } else {
      $('#loader').hide()
      $('#content').show()
    }
  }
}

// Initialize when DOM is ready
$(document).ready(() => {
  console.log("📱 DOM Ready - Initializing app...")
  
  // Form handlers
  $('#registrationForm').on('submit', (e) => {
    e.preventDefault()
    App.registerUser()
    return false
  })
  
  $('#donationForm').on('submit', (e) => {
    e.preventDefault()
    App.createDonation()
    return false
  })
  
  $('#statusForm').on('submit', (e) => {
    e.preventDefault()
    App.updateDonationStatus()
    return false
  })
  
  $('#transferForm').on('submit', (e) => {
    e.preventDefault()
    App.transferDonation()
    return false
  })
  
  // Network switch button
  $('#switchToLocalNetwork').on('click', (e) => {
    e.preventDefault()
    App.switchToGanache()
    return false
  })
  
  // Refresh account button
  $('#refreshAccount').on('click', async (e) => {
    e.preventDefault()
    console.log("🔄 Manual refresh triggered")
    try {
      App.setLoading(true)
      
      // Force account refresh
      if (window.ethereum) {
        await window.ethereum.request({ method: 'eth_requestAccounts' })
      }
      
      await App.loadAccount()
      await App.checkRegistration()
      await App.loadUsers()
      await App.render()
      
      console.log("✅ Account refreshed successfully")
    } catch (error) {
      console.error("❌ Error refreshing account:", error)
    } finally {
      App.setLoading(false)
    }
    return false
  })
  
  // Prevent loader from sticking: timeout and unhandled rejection
  const LOAD_TIMEOUT_MS = 25000
  const loadTimeoutId = setTimeout(() => {
    if (App.loading) {
      console.error("⏱️ Load timeout – showing error")
      App.setLoading(false)
      $('#content').html(
        '<div class="alert alert-danger">' +
        '<strong>Loading timed out</strong><br>' +
        'The DApp did not finish loading. Common causes: Content Security Policy blocking scripts, or Ganache/MetaMask not ready.<br>' +
        'Check the browser console for errors, then <button type="button" class="btn btn-primary mt-2" onclick="window.location.reload()">Reload page</button>' +
        '</div>'
      )
      $('#content').show()
    }
  }, LOAD_TIMEOUT_MS)

  window.addEventListener('unhandledrejection', (event) => {
    console.error("Unhandled promise rejection:", event.reason)
    if (App.loading) {
      App.setLoading(false)
      $('#content').html(
        '<div class="alert alert-danger">' +
        '<strong>Script error</strong><br>' + (event.reason && event.reason.message ? event.reason.message : String(event.reason)) +
        '<br><button type="button" class="btn btn-primary mt-2" onclick="window.location.reload()">Reload page</button>' +
        '</div>'
      )
      $('#content').show()
    }
  })

  // Start the app (clear timeout on success – load() now calls setLoading(false) when done)
  App.load().then(() => {
    clearTimeout(loadTimeoutId)
  }).catch(() => {
    clearTimeout(loadTimeoutId)
  })
})