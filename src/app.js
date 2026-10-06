App = {
  loading: false,
  web3: null,
  account: null,
  previousAccount: null,
  medicalSupplyDonation: null,
  contractAddress: null,
  currentUser: null,
  allUsers: [],

  // Ganache configuration
  GANACHE_RPC_URL: 'http://127.0.0.1:7545',
  GANACHE_CHAIN_ID: '0x539',       // 1337
  GANACHE_NETWORK_ID: '5777',      // Truffle network ID

  load: async () => {
    console.log("🚀 Loading MedTrace donor ledger (legacy module)...")

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
        showLoadError(
          "Web3 could not be loaded.",
          "Install MetaMask or check the browser console for errors (e.g. Content Security Policy blocking eval)."
        )
        return
      }

      await App.loadAccount()

      if (!App.account) {
        console.log("⚠️ No account available, showing connection needed message")
        App.setLoading(false)
        $('#content').html(
          '<div class="alert alert-warning">Please connect your MetaMask wallet</div>'
        )
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
      showLoadError(
        "An error occurred during loading.",
        error.message || String(error)
      )
    }
  },

  loadWeb3: async () => {
    if (window.ethereum) {
      App.web3 = new Web3(window.ethereum)

      try {
        await window.ethereum.request({
          method: 'eth_requestAccounts'
        })

        console.log("✅ MetaMask connected!")

        const initialAccounts = await window.ethereum.request({
          method: 'eth_accounts'
        })

        if (initialAccounts && initialAccounts.length > 0) {
          App.previousAccount = initialAccounts[0].toLowerCase()
          App.account = initialAccounts[0]
          console.log("📝 Initial account:", App.previousAccount)
        }

        // Prevent attaching multiple listeners which can cause MaxListeners warnings.
        if (!App._ethereumListenersAttached) {
          window.ethereum.on('accountsChanged', async (accounts) => {
            console.log("🔄 Account change detected via MetaMask")

            if (accounts && accounts.length > 0) {
              const newAccount = accounts[0].toLowerCase()

              if (newAccount !== App.previousAccount) {
                console.log(
                  `🔄 Switching from ${App.previousAccount} to ${newAccount}`
                )

                App.previousAccount = newAccount
                App.account = accounts[0]
                App.currentUser = null
                App.allUsers = []

                try {
                  App.setLoading(true)

                  await App.checkRegistration()
                  await App.loadUsers()
                  await App.render()

                } catch (error) {
                  console.error(
                    "❌ Error handling account change:",
                    error
                  )

                  App.currentUser = null
                  $('#registrationSection').show()
                  $('#userInfoSection').hide()

                } finally {
                  App.setLoading(false)
                }
              }

            } else {
              console.log("⚠️ No accounts connected")

              App.previousAccount = null
              App.account = null
              App.currentUser = null

              App.render()
            }
          })

          window.ethereum.on('chainChanged', (chainId) => {
            console.log("🔄 Network changed:", chainId)
            window.location.reload()
          })

          App._ethereumListenersAttached = true
        }

      } catch (error) {
        console.error("❌ User denied account access:", error)

        alert("Please connect to MetaMask to use this DApp")

        return false
      }

    } else if (window.web3) {

      App.web3 = new Web3(window.web3.currentProvider)

      console.log("⚠️ Legacy web3 detected")

    } else {

      console.log('❌ No Ethereum browser detected')

      alert(
        "Please install MetaMask to use this DApp!\n\nVisit: https://metamask.io"
      )

      return false
    }

    return true
  },

  loadAccount: async () => {
    try {
      if (!App.web3) {
        throw new Error("Web3 not initialized")
      }

      let accounts = []

      if (window.ethereum) {
        accounts = await window.ethereum.request({
          method: 'eth_accounts'
        })
      } else {
        accounts = await App.web3.eth.getAccounts()
      }

      if (accounts && accounts.length > 0) {
        App.account = accounts[0]

        if (!App.previousAccount) {
          App.previousAccount = App.account.toLowerCase()
        }

        console.log(
          "👤 Account loaded:",
          App.account.substring(0, 10) + "..."
        )

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

      let contractJson

      const contractPaths = [
        '/contracts/MedicalSupplyDonation.json',
        'MedicalSupplyDonation.json',
        '../build/contracts/MedicalSupplyDonation.json'
      ]

      let lastError

      for (const path of contractPaths) {
        try {
          const response = await fetch(path)

          if (!response.ok) {
            continue
          }

          contractJson = await response.json()

          if (contractJson && contractJson.abi) {
            console.log(
              "✅ Contract JSON loaded from",
              path
            )
            break
          }

        } catch (e) {
          lastError = e
        }
      }

      if (!contractJson || !contractJson.abi) {
        console.error(
          "❌ Contract JSON not found in any location",
          lastError
        )

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

      const networkId = await App.web3.eth.net.getId()

      console.log(
        "🌐 Current network ID:",
        networkId
      )

      console.log(
        "🌐 Expected Ganache network ID:",
        App.GANACHE_NETWORK_ID
      )

      const deployedNetwork = contractJson.networks[networkId]

      if (!deployedNetwork) {

        const availableNetworks =
          Object.keys(contractJson.networks)

        if (availableNetworks.length === 0) {

          console.error(
            "❌ Contract not deployed on any network"
          )

          $('#networkWarning').show()

          $('#networkWarningMessage').html(`
            <strong>Contract not deployed!</strong><br><br>
            Run: <code>truffle migrate</code> to deploy the contract to your local network.
          `)

          return false
        }

        console.log(
          "⚠️ Contract not on current network. Available networks:",
          availableNetworks
        )

        const networkList = availableNetworks
          .map(id => {
            const addr =
              contractJson.networks[id].address

            return `
              <li>
                Network ID: <code>${id}</code>
                (Address: <code>${addr.substring(0, 10)}...</code>)
              </li>
            `
          })
          .join('')

        $('#networkWarningMessage').html(`
          <strong>⚠️ Network Mismatch Detected</strong><br><br>

          <strong>Current Network ID:</strong>
          <code>${networkId}</code><br>

          <strong>Contract deployed on:</strong>
          <ul>${networkList}</ul>

          <strong>This happens when Ganache was restarted with a different network state.</strong>
          The contract addresses above are from previous Ganache runs.<br><br>

          <strong>Quick Fix (recommended):</strong><br>
          1. Open your terminal in the project folder<br>
          2. Run: <code>truffle migrate --reset --network development</code><br>
          3. Refresh this page<br><br>

          <strong>If you're on the wrong chain</strong>
          (e.g. Mainnet instead of Ganache), use the button below
          to switch to Ganache Local.
          If you're already on Ganache, the network ID must match
          the deployed contract.
        `)

        $('#networkWarning').show()

        return false
      }

      App.contractAddress = deployedNetwork.address

      console.log(
        "✅ Contract address:",
        App.contractAddress
      )

      App.medicalSupplyDonation =
        new App.web3.eth.Contract(
          contractJson.abi,
          App.contractAddress
        )

      console.log(
        "✅ Contract instance created"
      )

      $('#networkWarning').hide()

      return true

    } catch (error) {

      console.error(
        "❌ Error loading contract:",
        error
      )

      $('#networkWarning').show()

      $('#networkWarningMessage').html(`
        <strong>Error loading contract:</strong><br>
        ${error.message}<br><br>

        Make sure:<br>
        1. Ganache is running<br>
        2. Contract is compiled: <code>truffle compile</code><br>
        3. Contract is deployed: <code>truffle migrate</code><br>
        4. MetaMask is connected to Ganache Local
      `)

      return false
    }
  },

  checkRegistration: async () => {
    try {
      if (!App.medicalSupplyDonation || !App.account) {
        console.log(
          "⚠️ Contract or account not loaded"
        )

        App.currentUser = null

        $('#registrationSection').show()
        $('#userInfoSection').hide()

        return
      }

      console.log(
        "🔍 Checking registration for:",
        App.account
      )

      const userId =
        await App.medicalSupplyDonation.methods
          .addressToUserId(App.account)
          .call({ from: App.account })
          .catch(err => {
            console.log(
              "ℹ️ User not registered or contract call failed:",
              err.message
            )

            return "0"
          })

      console.log(
        "🔍 User ID result:",
        userId
      )

      let userIdNum

      if (typeof userId === 'string') {
        userIdNum = parseInt(userId, 10)

      } else if (
        typeof userId === 'object' &&
        userId.toString
      ) {
        userIdNum = parseInt(
          userId.toString(),
          10
        )

      } else {
        userIdNum = parseInt(
          userId,
          10
        )
      }

      if (userIdNum > 0) {

        console.log(
          "✅ User is registered, fetching details..."
        )

        const user =
          await App.medicalSupplyDonation.methods
            .getUser(userIdNum)
            .call({ from: App.account })
            .catch(err => {
              console.error(
                "❌ Error fetching user:",
                err
              )

              return null
            })

        if (user) {

          App.currentUser = {
            id: userIdNum,
            name: user.name || user[2],
            organization:
              user.organization || user[3],
            role: parseInt(
              user.role || user[4]
            ),
            isActive:
              user.isRegistered !== undefined
                ? user.isRegistered
                : user[5],
            userAddress:
              user.userAddress || user[1]
          }

          console.log(
            "✅ User details loaded:",
            App.currentUser
          )

          $('#registrationSection').hide()
          $('#userInfoSection').show()

        } else {

          App.currentUser = null

          $('#registrationSection').show()
          $('#userInfoSection').hide()
        }

      } else {

        console.log(
          "ℹ️ User not registered"
        )

        App.currentUser = null

        $('#registrationSection').show()
        $('#userInfoSection').hide()
      }

    } catch (error) {

      console.error(
        "❌ Error checking registration:",
        error
      )

      App.currentUser = null

      $('#registrationSection').show()
      $('#userInfoSection').hide()
    }
  },

  loadUsers: async () => {
    try {
      if (!App.medicalSupplyDonation || !App.account) {
        console.log(
          "⚠️ Cannot load users - contract or account not ready"
        )
        return
      }

      console.log(
        "👥 Loading all users..."
      )

      const userCountResult =
        await App.medicalSupplyDonation.methods
          .userCount()
          .call({ from: App.account })
          .catch(err => {
            console.error(
              "❌ Error getting user count:",
              err
            )

            return "0"
          })

      const count =
        parseInt(
          userCountResult.toString(),
          10
        )

      console.log(
        `📊 Total users to load: ${count}`
      )

      App.allUsers = []

      for (let i = 1; i <= count; i++) {

        try {

          const user =
            await App.medicalSupplyDonation.methods
              .getUser(i)
              .call({ from: App.account })

          if (user) {

            const userData = {
              id: i,
              name: user.name || user[2],
              organization:
                user.organization || user[3],
              role: parseInt(
                user.role || user[4]
              ),
              isActive:
                user.isRegistered !== undefined
                  ? user.isRegistered
                  : user[5],
              userAddress:
                user.userAddress || user[1]
            }

            App.allUsers.push(userData)
          }

        } catch (err) {

          console.error(
            `❌ Error loading user ${i}:`,
            err
          )
        }
      }

      console.log(
        `✅ Loaded ${App.allUsers.length} users`
      )

    } catch (error) {

      console.error(
        "❌ Error loading users:",
        error
      )

      App.allUsers = []
    }
  },

  registerUser: async () => {
    try {

      App.setLoading(true)

      const name =
        $('#userName').val()

      const organization =
        $('#userOrganization').val()

      const role =
        $('#userRole').val()

      if (!name || !organization || role === '') {
        alert(
          'Please fill in all fields'
        )

        App.setLoading(false)
        return
      }

      console.log(
        '📝 Registering user:',
        {
          name,
          organization,
          role
        }
      )

      await App.medicalSupplyDonation.methods
        .registerUser(
          name,
          organization,
          parseInt(role)
        )
        .send({
          from: App.account
        })

      console.log(
        '✅ User registered successfully!'
      )

      alert(
        'Registration successful!'
      )

      $('#registrationForm')[0].reset()

      await App.checkRegistration()
      await App.loadUsers()
      await App.render()

    } catch (error) {

      console.error(
        '❌ Error registering user:',
        error
      )

      alert(
        'Error registering user: ' +
        error.message
      )

    } finally {

      App.setLoading(false)
    }
  },

  createDonation: async () => {
    try {

      App.setLoading(true)

      const itemName =
        $('#itemName').val()

      const quantity =
        $('#itemQuantity').val()

      const unit =
        $('#itemUnit').val()

      const recipientId =
        $('#recipientId').val()

      const location =
        $('#donationLocation').val()

      const description =
        $('#itemDescription').val()

      const notes =
        $('#donationNotes').val()

      if (
        !itemName ||
        !quantity ||
        !unit ||
        !recipientId ||
        !location
      ) {

        alert(
          'Please fill in all required fields'
        )

        App.setLoading(false)
        return
      }

      console.log(
        '📦 Creating donation...'
      )

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
        .send({
          from: App.account
        })

      console.log(
        '✅ Donation created successfully!'
      )

      alert(
        'Donation created successfully!'
      )

      $('#donationForm')[0].reset()

      await App.render()

    } catch (error) {

      console.error(
        '❌ Error creating donation:',
        error
      )

      alert(
        'Error creating donation: ' +
        error.message
      )

    } finally {

      App.setLoading(false)
    }
  },

  updateDonationStatus: async () => {
    try {

      App.setLoading(true)

      const donationId =
        $('#statusDonationId').val()

      const newStatus =
        $('#newStatus').val()

      if (
        !donationId ||
        newStatus === ''
      ) {

        alert(
          'Please select a status'
        )

        App.setLoading(false)
        return
      }

      console.log(
        '🔄 Updating donation status...'
      )

      await App.medicalSupplyDonation.methods
        .updateDonationStatus(
          parseInt(donationId),
          parseInt(newStatus)
        )
        .send({
          from: App.account
        })

      console.log(
        '✅ Status updated successfully!'
      )

      alert(
        'Status updated successfully!'
      )

      const modal =
        bootstrap.Modal.getInstance(
          document.getElementById(
            'statusModal'
          )
        )

      modal.hide()

      await App.render()

    } catch (error) {

      console.error(
        '❌ Error updating status:',
        error
      )

      alert(
        'Error updating status: ' +
        error.message
      )

    } finally {

      App.setLoading(false)
    }
  },

  transferDonation: async () => {
    try {

      App.setLoading(true)

      const donationId =
        $('#transferDonationId').val()

      const recipientId =
        $('#transferRecipientId').val()

      if (
        !donationId ||
        !recipientId
      ) {

        alert(
          'Please select a recipient'
        )

        App.setLoading(false)
        return
      }

      console.log(
        '🔄 Transferring donation...'
      )

      await App.medicalSupplyDonation.methods
        .transferDonation(
          parseInt(donationId),
          parseInt(recipientId)
        )
        .send({
          from: App.account
        })

      console.log(
        '✅ Donation transferred successfully!'
      )

      alert(
        'Donation transferred successfully!'
      )

      const modal =
        bootstrap.Modal.getInstance(
          document.getElementById(
            'transferModal'
          )
        )

      modal.hide()

      await App.render()

    } catch (error) {

      console.error(
        '❌ Error transferring donation:',
        error
      )

      alert(
        'Error transferring donation: ' +
        error.message
      )

    } finally {

      App.setLoading(false)
    }
  },

  render: async () => {
    try {

      console.log(
        '🎨 Rendering UI...'
      )

      if (App.account) {

        const shortAccount =
          App.account.substring(0, 6) +
          '...' +
          App.account.substring(38)

        $('#account').text(
          shortAccount
        )

      } else {

        $('#account').text(
          'Not connected'
        )
      }

      if (!App.medicalSupplyDonation) {

        console.log(
          '⚠️ Contract not loaded, showing limited UI'
        )

        $('#registrationSection').hide()
        $('#userInfoSection').hide()
        $('#createDonationSection').hide()

        $('#donationsList').html(
          '<div class="alert alert-warning">' +
          'Please fix the network issue above to use the application.' +
          '</div>'
        )

        return
      }

      if (App.currentUser) {

        const roleNames = [
          'Donor',
          'NGO',
          'Healthcare Facility'
        ]

        const roleTips = {
          0: 'Donors create and track medical supply shipments through the network.',
          1: 'NGOs coordinate distribution and transfer donations to facilities and partners.',
          2: 'Healthcare facilities receive donations and confirm treatment readiness.'
        }

        const roleChipClass = App.getRoleChipClass(App.currentUser.role)

        const userInfoHtml = `
          <div class="user-card-shell">
            <div class="user-avatar">${App.currentUser.name.charAt(0).toUpperCase()}</div>
            <div class="user-meta">
              <div class="user-topline">
                <h5>${App.currentUser.name}</h5>
                <span class="role-chip ${roleChipClass}">${roleNames[App.currentUser.role]}</span>
              </div>
              <div class="user-org">${App.currentUser.organization}</div>
              <div class="user-address mono">${App.currentUser.userAddress}</div>
              <div class="user-tip"><i class="bi bi-info-circle"></i> ${roleTips[App.currentUser.role] || 'Role details available on the network.'}</div>
            </div>
          </div>
        `

        $('#userInfoContent').html(
          userInfoHtml
        )

        if (App.currentUser.role === 0) {
          $('#createDonationSection').show()
        } else {
          $('#createDonationSection').hide()
        }
      }

      const recipients =
        App.allUsers.filter(
          u => u.role === 1 || u.role === 2
        )

      const recipientOptions =
        recipients.map(r =>
          `<option value="${r.id}">
            ${r.name} (${r.organization})
          </option>`
        ).join('')

      $('#recipientId').html(
        '<option value="">Select Recipient</option>' +
        recipientOptions
      )

      $('#transferRecipientId').html(
        '<option value="">Select Recipient</option>' +
        recipientOptions
      )

      await App.renderDonations()

      console.log(
        '✅ UI rendered successfully'
      )

    } catch (error) {

      console.error(
        '❌ Error rendering UI:',
        error
      )
    }
  },

  renderDonations: async () => {
    try {

      if (
        !App.medicalSupplyDonation ||
        !App.account
      ) {

        console.log(
          "⚠️ Cannot render donations - contract or account not ready"
        )

        $('#noDonations').show()

        return
      }

      console.log(
        '📋 Loading donations...'
      )

      const donationCountResult =
        await App.medicalSupplyDonation.methods
          .donationCount()
          .call({
            from: App.account
          })
          .catch(err => {

            console.error(
              "❌ Error getting donation count:",
              err
            )

            return "0"
          })

      const count =
        parseInt(
          donationCountResult.toString(),
          10
        )

      console.log(
        `📊 Total donations: ${count}`
      )

      let donationsHtml = ''

      let totalDonations = 0
      let completedDonations = 0
      let inTransitDonations = 0
      let myDonations = 0

      const statusNames = [
        'Created',
        'In Transit',
        'Received',
        'Distributed',
        'Completed'
      ]

      const statusClasses = [
        'created',
        'intransit',
        'received',
        'distributed',
        'completed'
      ]

      const progressNames = [
        'Created',
        'In Transit',
        'Received',
        'Distributed',
        'Completed'
      ]

      for (
        let i = 1;
        i <= count;
        i++
      ) {

        try {

          const donation =
            await App.medicalSupplyDonation.methods
              .getDonation(i)
              .call({
                from: App.account
              })

          if (donation) {

            totalDonations++

            const donationData = {
              id: i,

              itemName:
                donation.itemName ||
                donation[3],

              quantity:
                parseInt(
                  donation.quantity ||
                  donation[5],
                  10
                ),

              unit:
                donation.unit ||
                donation[6],

              donorId:
                parseInt(
                  donation.donorId ||
                  donation[1],
                  10
                ),

              currentHolderId:
                parseInt(
                  donation.recipientId ||
                  donation[2],
                  10
                ),

              recipientId:
                parseInt(
                  donation.recipientId ||
                  donation[2],
                  10
                ),

              status:
                parseInt(
                  donation.status ||
                  donation[7],
                  10
                ),

              location:
                donation.location ||
                donation[10],

              description:
                donation.itemDescription ||
                donation[4],

              notes:
                donation.notes ||
                donation[11],

              timestamp:
                parseInt(
                  donation.createdAt ||
                  donation[8],
                  10
                )
            }

            const donor =
              App.allUsers.find(
                u => u.id === donationData.donorId
              )

            const donorName =
              donor ? donor.name : 'Unknown'

            const holder =
              App.allUsers.find(
                u =>
                  u.id ===
                  donationData.currentHolderId
              )

            const holderName =
              holder ? holder.name : 'Unknown'

            const recipient =
              App.allUsers.find(
                u =>
                  u.id ===
                  donationData.recipientId
              )

            const recipientName =
              recipient ? recipient.name : 'Unknown'

            if (
              donationData.status === 4
            ) {
              completedDonations++
            }

            if (
              donationData.status === 1
            ) {
              inTransitDonations++
            }

            if (
              App.currentUser &&
              donationData.donorId ===
              App.currentUser.id
            ) {
              myDonations++
            }

            const canUpdate =
              App.currentUser &&
              (
                donationData.currentHolderId ===
                  App.currentUser.id ||

                donationData.donorId ===
                  App.currentUser.id ||

                App.currentUser.role === 1
              )

            const date =
              new Date(
                donationData.timestamp * 1000
              ).toLocaleDateString()

            const relativeTime = App.formatRelativeTime(
              donationData.timestamp
            )

            const statusBadgeClass = `status-${statusClasses[donationData.status]}`
            const stepMarkup = progressNames.map((step, stepIndex) => {
              const isComplete = stepIndex < donationData.status
              const isCurrent = stepIndex === donationData.status

              return `
                <div class="status-step ${isComplete ? 'is-complete' : ''} ${isCurrent ? 'is-current' : ''}">
                  <span class="step-dot"></span>
                  <strong>${step}</strong>
                </div>
              `
            }).join('')

            donationsHtml += `
              <article class="donation-card status-${statusClasses[donationData.status]}">
                <div class="donation-body">
                  <div class="donation-header">
                    <div class="donation-title-wrap">
                      <span class="item-badge"><i class="bi ${App.getStatusIcon(donationData.status)}"></i></span>
                      <div>
                        <h5>${donationData.itemName}</h5>
                        <div class="donation-id mono">#${donationData.id}</div>
                      </div>
                    </div>
                    <span class="status-badge ${statusBadgeClass}">
                      <i class="bi ${App.getStatusIcon(donationData.status)}"></i>
                      ${statusNames[donationData.status]}
                    </span>
                  </div>

                  <div class="progress-tracker" aria-label="Donation status trace">
                    ${stepMarkup}
                  </div>

                  <div class="donation-meta">
                    <div class="meta-block">
                      <span class="meta-icon"><i class="bi bi-person-fill"></i></span>
                      <div class="meta-copy">
                        <span>Donor</span>
                        <strong>${donorName}</strong>
                      </div>
                    </div>

                    <div class="meta-block">
                      <span class="meta-icon"><i class="bi bi-building"></i></span>
                      <div class="meta-copy">
                        <span>Recipient</span>
                        <strong>${recipientName}</strong>
                      </div>
                    </div>

                    <div class="meta-block">
                      <span class="meta-icon"><i class="bi bi-bag-check"></i></span>
                      <div class="meta-copy">
                        <span>Quantity</span>
                        <strong>${donationData.quantity} ${donationData.unit}</strong>
                      </div>
                    </div>

                    <div class="meta-block">
                      <span class="meta-icon"><i class="bi bi-geo-alt-fill"></i></span>
                      <div class="meta-copy">
                        <span>Location</span>
                        <strong>${donationData.location}</strong>
                      </div>
                    </div>
                  </div>

                  ${
                    donationData.description
                      ? `
                        <div class="meta-block" style="margin-bottom:12px;">
                          <span class="meta-icon"><i class="bi bi-clipboard-data"></i></span>
                          <div class="meta-copy">
                            <span>Description</span>
                            <strong>${donationData.description}</strong>
                          </div>
                        </div>
                      `
                      : ''
                  }

                  ${
                    donationData.notes
                      ? `
                        <div class="meta-block" style="margin-bottom:12px;">
                          <span class="meta-icon"><i class="bi bi-sticky"></i></span>
                          <div class="meta-copy">
                            <span>Notes</span>
                            <strong>${donationData.notes}</strong>
                          </div>
                        </div>
                      `
                      : ''
                  }

                  <div class="meta-row">
                    <div class="donor-recipient">
                      <span class="role-chip donor">${donorName}</span>
                      <i class="bi bi-arrow-right-short text-muted"></i>
                      <span class="role-chip ${App.getRoleChipClass(recipient ? recipient.role : 0)}">${recipientName}</span>
                    </div>
                    <div class="relative-time" title="${date}">${relativeTime}</div>
                  </div>

                  ${
                    canUpdate
                      ? `
                        <div class="donation-actions mt-3">
                          <button class="btn btn-primary btn-sm" onclick="App.openStatusModal(${i}, ${donationData.status})">
                            <i class="bi bi-arrow-repeat"></i> Update Status
                          </button>

                          ${
                            App.currentUser.role === 1
                              ? `
                                <button class="btn btn-outline-secondary btn-sm" onclick="App.openTransferModal(${i})">
                                  <i class="bi bi-arrow-left-right"></i> Transfer
                                </button>
                              `
                              : ''
                          }
                        </div>
                      `
                      : ''
                  }
                </div>
              </article>
            `
          }

        } catch (err) {

          console.error(
            `❌ Error loading donation ${i}:`,
            err
          )
        }
      }

      App.animateStatCount(
        'totalDonations',
        totalDonations
      )

      App.animateStatCount(
        'completedDonations',
        completedDonations
      )

      App.animateStatCount(
        'inTransitDonations',
        inTransitDonations
      )

      App.animateStatCount(
        'myDonations',
        myDonations
      )

      if (donationsHtml) {

        $('#donationsList').html(
          donationsHtml
        )

        $('#noDonations').hide()

      } else {

        $('#donationsList').html('')

        $('#noDonations').show()
      }

      console.log(
        '✅ Donations rendered successfully'
      )

    } catch (error) {

      console.error(
        '❌ Error rendering donations:',
        error
      )

      $('#noDonations').show()
    }
  },

  openStatusModal: (
    donationId,
    currentStatus
  ) => {

    $('#statusDonationId').val(
      donationId
    )

    const statusNames = [
      'Created',
      'In Transit',
      'Received',
      'Distributed',
      'Completed'
    ]

    $('#currentStatus').val(
      statusNames[currentStatus]
    )

    const allowedNext = {
      0: [1],
      1: [2],
      2: [3, 4],
      3: [4]
    }

    const nextStatuses =
      allowedNext[currentStatus] || []

    let statusOptions = ''

    nextStatuses.forEach(i => {

      statusOptions +=
        `<option value="${i}">
          ${statusNames[i]}
        </option>`
    })

    $('#newStatus').html(
      statusOptions ||
      '<option value="">No next status</option>'
    )

    const modal =
      new bootstrap.Modal(
        document.getElementById(
          'statusModal'
        )
      )

    modal.show()
  },

  openTransferModal: (
    donationId
  ) => {

    $('#transferDonationId').val(
      donationId
    )

    const modal =
      new bootstrap.Modal(
        document.getElementById(
          'transferModal'
        )
      )

    modal.show()
  },

  getAvailableNetworks: async () => {
    try {

      const paths = [
        '/contracts/MedicalSupplyDonation.json',
        'MedicalSupplyDonation.json',
        '../build/contracts/MedicalSupplyDonation.json'
      ]

      let contractJson

      for (const path of paths) {

        try {

          const response =
            await fetch(path)

          if (response.ok) {

            contractJson =
              await response.json()

            if (
              contractJson &&
              contractJson.networks
            ) {
              break
            }
          }

        } catch (e) {
          // Try next path
        }
      }

      if (
        !contractJson ||
        !contractJson.networks
      ) {
        return []
      }

      const networkIds =
        Object.keys(
          contractJson.networks
        )

      console.log(
        "📋 Available networks from contract:",
        networkIds
      )

      return networkIds.map(id => ({
        networkId: id,

        // Ganache chain ID is 1337 / 0x539
        chainId:
          App.GANACHE_CHAIN_ID,

        address:
          contractJson.networks[id].address
      }))

    } catch (error) {

      console.error(
        "❌ Error getting available networks:",
        error
      )

      return []
    }
  },

  switchToAvailableNetwork:
    async (targetNetworkId) => {

      try {

        if (!window.ethereum) {

          console.log(
            "⚠️ No MetaMask detected"
          )

          alert(
            "Please install MetaMask to use this application"
          )

          return false
        }

        console.log(
          `🔄 Attempting to switch to network ${targetNetworkId}...`
        )

        const targetChainId =
          App.GANACHE_CHAIN_ID

        const currentChainId =
          await window.ethereum.request({
            method: 'eth_chainId'
          })

        if (
          currentChainId.toLowerCase() ===
          targetChainId.toLowerCase()
        ) {

          console.log(
            "✅ Already on Ganache network"
          )

          window.location.reload()

          return true
        }

        try {

          await window.ethereum.request({
            method:
              'wallet_switchEthereumChain',

            params: [
              {
                chainId:
                  targetChainId
              }
            ]
          })

          console.log(
            "✅ Successfully switched to Ganache network"
          )

          setTimeout(
            () =>
              window.location.reload(),
            1000
          )

          return true

        } catch (switchError) {

          console.error(
            "Switch error:",
            switchError
          )

          if (
            switchError.code === 4902
          ) {

            console.log(
              "➕ Ganache network not in MetaMask, adding it..."
            )

            try {

              await window.ethereum.request({
                method:
                  'wallet_addEthereumChain',

                params: [
                  {
                    chainId:
                      targetChainId,

                    chainName:
                      'Ganache Local',

                    nativeCurrency: {
                      name: 'ETH',
                      symbol: 'ETH',
                      decimals: 18
                    },

                    rpcUrls: [
                      App.GANACHE_RPC_URL
                    ]
                  }
                ]
              })

              console.log(
                "✅ Ganache network added successfully"
              )

              setTimeout(
                () =>
                  window.location.reload(),
                1000
              )

              return true

            } catch (addError) {

              console.error(
                "❌ Failed to add Ganache network:",
                addError
              )

              alert(
                "Failed to add Ganache network. Please add it manually in MetaMask:\n\n" +
                "Network Name: Ganache Local\n" +
                "RPC URL: " +
                App.GANACHE_RPC_URL +
                "\n" +
                "Chain ID: 1337\n" +
                "Currency Symbol: ETH"
              )

              return false
            }

          } else if (
            switchError.code === 4001
          ) {

            console.log(
              "👤 User rejected network switch"
            )

            return false

          } else {

            console.error(
              "❌ Failed to switch network:",
              switchError
            )

            alert(
              "Failed to switch network. Please switch manually in MetaMask to Ganache Local."
            )

            return false
          }
        }

      } catch (error) {

        console.error(
          "❌ Error in switchToAvailableNetwork:",
          error
        )

        return false
      }
    },

  ensureCorrectNetwork:
    async () => {

      try {

        if (!window.ethereum) {

          console.log(
            "⚠️ No MetaMask detected"
          )

          return false
        }

        let currentChainId
        let currentNetworkId

        try {

          currentChainId =
            await window.ethereum.request({
              method: 'eth_chainId'
            })

          currentNetworkId =
            await App.web3.eth.net.getId()

          console.log(
            "🔗 Current network - Chain ID:",
            currentChainId,
            "Network ID:",
            currentNetworkId
          )

        } catch (error) {

          console.error(
            "❌ Error getting current network:",
            error
          )

          return false
        }

        const availableNetworks =
          await App.getAvailableNetworks()

        if (
          availableNetworks.length === 0
        ) {

          console.error(
            "❌ No networks found in contract JSON"
          )

          return false
        }

        const isOnGanacheChainId =
          currentChainId.toLowerCase() ===
          App.GANACHE_CHAIN_ID.toLowerCase()

        const matchingNetwork =
          availableNetworks.find(
            net =>
              net.networkId ===
              currentNetworkId.toString()
          )

        if (
          isOnGanacheChainId &&
          matchingNetwork
        ) {

          console.log(
            "✅ Already on correct Ganache network"
          )

          $('#networkWarning').hide()

          return true
        }

        if (
          isOnGanacheChainId &&
          !matchingNetwork
        ) {

          console.log(
            "⚠️ On Ganache chain but wrong network ID"
          )

          console.log(
            `Current network ID: ${currentNetworkId}`
          )

          console.log(
            `Contract deployed on: ${
              availableNetworks
                .map(n => n.networkId)
                .join(', ')
            }`
          )

          alert(
            `⚠️ Network ID Mismatch\n\n` +
            `You're on Ganache (Chain ID 1337) ` +
            `but the network ID doesn't match.\n\n` +
            `Current Network ID: ${currentNetworkId}\n` +
            `Contract deployed on: ${
              availableNetworks
                .map(n => n.networkId)
                .join(', ')
            }\n\n` +
            `Run:\n` +
            `truffle migrate --reset --network development`
          )

          return false
        }

        console.log(
          "⚠️ Not on Ganache network, attempting to switch..."
        )

        console.log(
          "📋 Available networks:",
          availableNetworks
            .map(
              n =>
                `${n.networkId} (${n.chainId})`
            )
            .join(', ')
        )

        const targetChainId =
          App.GANACHE_CHAIN_ID

        console.log(
          `🔄 Attempting to switch to Ganache network (Chain ID: ${targetChainId})...`
        )

        try {

          await window.ethereum.request({
            method:
              'wallet_switchEthereumChain',

            params: [
              {
                chainId:
                  targetChainId
              }
            ]
          })

          console.log(
            "✅ Successfully switched to Ganache network"
          )

          setTimeout(
            () =>
              window.location.reload(),
            1500
          )

          return true

        } catch (switchError) {

          if (
            switchError.code === 4902
          ) {

            console.log(
              "➕ Ganache network not in MetaMask, adding it..."
            )

            try {

              await window.ethereum.request({
                method:
                  'wallet_addEthereumChain',

                params: [
                  {
                    chainId:
                      targetChainId,

                    chainName:
                      'Ganache Local',

                    nativeCurrency: {
                      name: 'ETH',
                      symbol: 'ETH',
                      decimals: 18
                    },

                    rpcUrls: [
                      App.GANACHE_RPC_URL
                    ]
                  }
                ]
              })

              console.log(
                "✅ Ganache network added and switched"
              )

              setTimeout(
                () =>
                  window.location.reload(),
                1500
              )

              return true

            } catch (addError) {

              console.log(
                "❌ Failed to add Ganache network:",
                addError.message
              )

              if (
                addError.code === 4001
              ) {

                console.log(
                  "👤 User rejected network addition"
                )
              }

              return false
            }

          } else if (
            switchError.code === -32002
          ) {

            console.log(
              "⏳ Network switch request already pending, waiting..."
            )

            await new Promise(
              resolve =>
                setTimeout(
                  resolve,
                  2000
                )
            )

            try {

              await window.ethereum.request({
                method:
                  'wallet_switchEthereumChain',

                params: [
                  {
                    chainId:
                      targetChainId
                  }
                ]
              })

              setTimeout(
                () =>
                  window.location.reload(),
                1500
              )

              return true

            } catch (retryError) {

              console.log(
                "❌ Retry also failed:",
                retryError.message
              )

              return false
            }

          } else if (
            switchError.code === 4001
          ) {

            console.log(
              "👤 User rejected network switch"
            )

            return false

          } else {

            console.log(
              "❌ Failed to switch to Ganache network:",
              switchError.message
            )

            return false
          }
        }

      } catch (error) {

        console.error(
          "❌ Error in ensureCorrectNetwork:",
          error
        )

        return false
      }
    },

  switchToGanache:
    async () => {

      console.log(
        "🔄 Manual network switch requested..."
      )

      const result =
        await App.ensureCorrectNetwork()

      if (result) {

        console.log(
          "✅ Network switch successful"
        )

      } else {

        console.log(
          "❌ Network switch failed or was cancelled"
        )

        alert(
          "Could not switch to local network. Please switch manually in MetaMask:\n\n" +
          "1. Click MetaMask extension\n" +
          "2. Click network dropdown\n" +
          "3. Select 'Ganache Local'\n" +
          "4. If not available, add it with:\n\n" +
          "RPC URL: " +
          App.GANACHE_RPC_URL +
          "\n" +
          "Chain ID: 1337\n" +
          "Currency Symbol: ETH"
        )
      }
    },

  switchToLocalNetwork:
    async () => {
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
  },

  getRoleChipClass: (role) => {
    const roleMap = {
      0: 'donor',
      1: 'ngo',
      2: 'healthcare'
    }

    return roleMap[role] || 'donor'
  },

  getStatusIcon: (status) => {
    const icons = [
      'bi-file-earmark-plus',
      'bi-truck',
      'bi-box-seam',
      'bi-people',
      'bi-patch-check-fill'
    ]

    return icons[status] || 'bi-circle'
  },

  formatRelativeTime: (timestamp) => {
    if (!timestamp) return 'just now'

    const diffMs = Date.now() - (Number(timestamp) * 1000)
    const diffMinutes = Math.max(0, Math.round(diffMs / 60000))

    if (diffMinutes < 1) return 'just now'
    if (diffMinutes < 60) return `${diffMinutes} min ago`

    const diffHours = Math.round(diffMinutes / 60)
    if (diffHours < 24) return `${diffHours} hr ago`

    const diffDays = Math.round(diffHours / 24)
    if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`

    return new Date(Number(timestamp) * 1000).toLocaleDateString()
  },

  animateStatCount: (elementId, value) => {
    const element = document.getElementById(elementId)

    if (!element) return

    const finalValue = Number(value) || 0

    const startValue = 0
    const durationMs = 600
    const startTime = performance.now()

    const update = (time) => {
      const progress = Math.min((time - startTime) / durationMs, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = Math.round(startValue + (finalValue - startValue) * eased)

      element.textContent = current

      if (progress < 1) {
        requestAnimationFrame(update)
      }
    }

    requestAnimationFrame(update)
  },

  applyTheme: (theme) => {
    try {
      document.documentElement.setAttribute('data-theme', theme)
      localStorage.setItem('medtrace-theme', theme)

      const themeIcon = document.getElementById('themeToggle')
      if (themeIcon) {
        themeIcon.innerHTML = theme === 'dark'
          ? '<i class="bi bi-sun-fill"></i>'
          : '<i class="bi bi-moon-stars-fill"></i>'
        themeIcon.setAttribute(
          'aria-label',
          theme === 'dark'
            ? 'Switch to light mode'
            : 'Switch to dark mode'
        )
      }
    } catch (error) {
      console.warn('Theme persistence unavailable:', error)
    }
  },

  initThemeControls: () => {
    try {
      const storedTheme = localStorage.getItem('medtrace-theme')
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      const initialTheme = storedTheme || (prefersDark ? 'dark' : 'light')

      App.applyTheme(initialTheme)
    } catch (error) {
      App.applyTheme('light')
    }

    $('#themeToggle').off('click').on('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      App.applyTheme(currentTheme)
    })

    $('#account').off('click').on('click', async () => {
      const accountText = $('#account').text().trim()

      if (!accountText || accountText === 'Not Connected') {
        return
      }

      try {
        await navigator.clipboard.writeText(accountText)
        const original = $('#account').text()
        $('#account').text('Copied!')

        setTimeout(() => {
          $('#account').text(original)
        }, 1200)
      } catch (error) {
        console.warn('Clipboard copy unavailable:', error)
      }
    })
  }
}


// Initialize when DOM is ready
$(document).ready(() => {

  console.log(
    "📱 DOM Ready - Initializing app..."
  )

  App.initThemeControls()

  const roleDescriptionMap = {
    '': 'Choose a role to see how it participates in the donation flow.',
    '0': 'Donors can create donations and help fulfill supply requests.',
    '1': 'NGOs can receive donations and transfer them to partners or facilities.',
    '2': 'Healthcare facilities receive donated supplies for patient care.'
  }

  $('#userRole').on('change', (event) => {
    const selectedRole = $(event.target).val()
    $('#roleDescription').text(roleDescriptionMap[selectedRole] || roleDescriptionMap[''])
  })

  // Form handlers

  $('#registrationForm').on(
    'submit',
    (e) => {

      e.preventDefault()

      App.registerUser()

      return false
    }
  )

  $('#donationForm').on(
    'submit',
    (e) => {

      e.preventDefault()

      App.createDonation()

      return false
    }
  )

  $('#statusForm').on(
    'submit',
    (e) => {

      e.preventDefault()

      App.updateDonationStatus()

      return false
    }
  )

  $('#transferForm').on(
    'submit',
    (e) => {

      e.preventDefault()

      App.transferDonation()

      return false
    }
  )


  // Network switch button

  $('#switchToLocalNetwork').on(
    'click',
    (e) => {

      e.preventDefault()

      App.switchToGanache()

      return false
    }
  )


  // Refresh account button

  $('#refreshAccount').on(
    'click',
    async (e) => {

      e.preventDefault()

      console.log(
        "🔄 Manual refresh triggered"
      )

      try {

        App.setLoading(true)

        if (window.ethereum) {

          await window.ethereum.request({
            method:
              'eth_requestAccounts'
          })
        }

        await App.loadAccount()

        await App.checkRegistration()

        await App.loadUsers()

        await App.render()

        console.log(
          "✅ Account refreshed successfully"
        )

      } catch (error) {

        console.error(
          "❌ Error refreshing account:",
          error
        )

      } finally {

        App.setLoading(false)
      }

      return false
    }
  )


  // Prevent loader from sticking

  const LOAD_TIMEOUT_MS =
    25000

  const loadTimeoutId =
    setTimeout(() => {

      if (App.loading) {

        console.error(
          "⏱️ Load timeout – showing error"
        )

        App.setLoading(false)

        $('#content').html(
          '<div class="alert alert-danger">' +
          '<strong>Loading timed out</strong><br>' +
          'The DApp did not finish loading. Common causes: Content Security Policy blocking scripts, or Ganache/MetaMask not ready.<br>' +
          'Check the browser console for errors, then ' +
          '<button type="button" class="btn btn-primary mt-2" onclick="window.location.reload()">Reload page</button>' +
          '</div>'
        )

        $('#content').show()
      }

    }, LOAD_TIMEOUT_MS)


  window.addEventListener(
    'unhandledrejection',
    (event) => {

      console.error(
        "Unhandled promise rejection:",
        event.reason
      )

      if (App.loading) {

        App.setLoading(false)

        $('#content').html(
          '<div class="alert alert-danger">' +
          '<strong>Script error</strong><br>' +
          (
            event.reason &&
            event.reason.message
              ? event.reason.message
              : String(event.reason)
          ) +
          '<br><button type="button" class="btn btn-primary mt-2" onclick="window.location.reload()">Reload page</button>' +
          '</div>'
        )

        $('#content').show()
      }
    }
  )


  // Start application

  App.load()
    .then(() => {
      clearTimeout(
        loadTimeoutId
      )
    })
    .catch(() => {
      clearTimeout(
        loadTimeoutId
      )
    })
})


