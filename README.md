# 🪴 Sprout – XRPL Escrow & Yield Protocol

**Sprout** is an off-chain escrow and yield platform built on the XRP Ledger (XRPL), powered by Firebase Functions and Firestore.  
Users can deposit XRP or RLUSD, lock funds for a chosen period, and Sprout pools and supplies these funds to XRPL AMMs (Automated Market Makers) for yield—all managed from a central treasury wallet and authenticated with XUMM.

---

## 🚀 Features

- **XUMM wallet QR login & auth**
- **Create offchain escrows** with lock period and metadata
- **Centralized treasury pool** for escrowed funds
- **Confirm funding via XUMM**, then deposit into XRPL AMM for yield
- **Serverless architecture**: Firebase Functions + Firestore
- **Ready for integration** with frontend apps

---

## ⚙️ Requirements

- Node.js 18+
- Firebase CLI ([install guide](https://firebase.google.com/docs/cli))
- XRPL Devnet wallet (used as pool/treasury)
- XUMM developer API key/secret ([get from apps.xumm.dev](https://apps.xumm.dev/))
- Firestore enabled in your Firebase project

---

## 🛠️ Setup & Deployment

### 1. **Clone & Install**

```bash
git clone https://github.com/edrianwa/sprout.git
cd sprout/functions
npm install
```

---

### 2. **Configure Secrets**

**You MUST use Firebase Functions config for all secrets:**

```bash
firebase functions:config:set \
  xumm.key="YOUR_XUMM_API_KEY" \
  xumm.secret="YOUR_XUMM_API_SECRET" \
  xrpl.pool_secret="snXXXXXXXXXXXXXXXXXXXX"
```

> *Check your config at any time with:*
> ```bash
> firebase functions:config:get
> ```

---

### 3. **Deploy Functions**

```bash
firebase deploy --only functions
```

---

### 4. **Recommended Firestore Rules**

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /escrows/{escrowId} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

---

## 🗝️ Key Firebase Functions

| Function               | Purpose                                                  |
|------------------------|----------------------------------------------------------|
| `xummLogin`            | Initiates a XUMM QR wallet login                         |
| `xummGetLoginStatus`   | Polls login status and returns XRPL wallet address       |
| `createEscrow`         | Creates an escrow record in Firestore                    |
| `confirmEscrowPayment` | Verifies XUMM payment, sends funds to XRPL AMM for yield |
| `withdrawEscrow`       | Withdraw escrowed funds after the lock period has ended  |

---

## 🧑‍💻 Example: Loading Secrets in Code

```js
const XUMM_API_KEY = process.env.XUMM_API_KEY || functions.config().xumm?.key;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET || functions.config().xumm?.secret;
const POOL_SECRET = process.env.POOL_SECRET || functions.config().xrpl?.pool_secret;

if (!XUMM_API_KEY || !XUMM_API_SECRET || !POOL_SECRET) {
  throw new Error("Missing API keys/secrets! Check Firebase config.");
}
```

---

## 📚 Further Reading

- [XRPL Devnet Faucet](https://xrpl.org/xrp-testnet-faucet.html?network=devnet)
- [XUMM SDK](https://github.com/XRPL-Labs/XUMM-SDK)
- [xrpl.js AMM](https://xrpl.org/amm.html)
- [XUMM Developer Console](https://apps.xumm.dev/)

---

## 🤝 Contributing

Pull requests and issues are welcome!  
Please include relevant logs and your `firebase functions:config:get` output (redact secrets) if requesting backend help.

---

## 📝 Quickstart Checklist

- [ ] Clone and install dependencies (`npm install` in `functions/`)
- [ ] Create and fund a pool XRPL Devnet wallet, set a USD trustline
- [ ] Set all Firebase function configs as shown above
- [ ] Deploy functions
- [ ] Connect frontend and start building!

---

*Built by [@edrianwa](https://github.com/edrianwa).*
