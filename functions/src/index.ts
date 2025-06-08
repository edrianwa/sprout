import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import { XummSdk } from "xumm-sdk";
import { Client,Wallet,AMMDeposit } from "xrpl";
import * as dotenv from "dotenv";
dotenv.config();
admin.initializeApp();

const XUMM_API_KEY = process.env.XUMM_API_KEY || functions.config().xumm?.key;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET || functions.config().xumm?.secret;

const xumm = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET);
const TREASURY_ADDRESS = "rpwJg3JHCX7dnaj4fBdVDvtZYyJQwZnvDG";
// const USD_ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
// const USD_CURRENCY = "USD";

const POOL_SECRET = process.env.POOL_SECRET! || functions.config().xrpl.pool_secret;
const poolWallet = Wallet.fromSeed(POOL_SECRET);
const XRPL_NET = "wss://s.devnet.rippletest.net:51233";
const client = new Client(XRPL_NET);
async function ensureClientConnected() {
    if (!client.isConnected()) await client.connect();
}

export const xummLogin = functions.https.onCall(async (data, context) => {
    // Create a SignIn payload (no transaction, just proof of wallet ownership)
    const payload = {
        txjson: {
            TransactionType: "SignIn"
        }
    } as any;
    const payloadResponse = await xumm.payload.create(payload);
    if (!payloadResponse) throw new functions.https.HttpsError("internal", "XUMM payload creation failed.");
    const { uuid, next } = payloadResponse;
    // next.always is the QR/sign URL. uuid can be used to poll for status.
    return { uuid, url: next.always };
});

// Optional: add a callable to check login status and get the user wallet address
export const xummGetLoginStatus = onCall(async (request) => {
    const uuid = typeof request.data?.uuid === "string" ? request.data.uuid : "";
    if (!uuid) {
        throw new HttpsError("invalid-argument", "UUID is required");
    }
    try {
        const payload = await xumm.payload.get(uuid);
        if (!payload || !payload.meta || !payload.response?.account) {
            return { signed: false, address: null };
        }

        const address = payload.response.account;
        // Connect to devnet (will not reconnect if already connected)
        await ensureClientConnected();

        // Fetch balances
        let xrpBalance = "0.00";
        let rlusdBalance = "0.00";
        try {
            const acctInfo = await client.request({
                command: "account_info",
                account: address,
                ledger_index: "validated",
            });
            xrpBalance = (parseFloat(acctInfo.result.account_data.Balance) / 1_000_000).toFixed(6); // XRP is in drops

            // Optionally, get RLUSD trustline balance
            const lines = await client.request({
                command: "account_lines",
                account: address,
            });
            const rlusdLine = lines.result.lines.find(
                (l: any) => l.currency === "RLUSD"
            );
            if (rlusdLine) rlusdBalance = rlusdLine.balance;
        } catch (balanceErr) {
            // ignore, return zeros
        }

        return {
            signed: !!payload.meta.signed,
            address,
            balances: {
                xrp: xrpBalance,
                rlusd: rlusdBalance,
            },
        };
    } catch (error) {
        return {
            signed: false,
            address: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
});

const SUPPORTED_ASSETS = ["XRP", "RLUSD"];

export const createEscrow = onCall(async (request) => {
    const { asset, amount, lockPeriod, receiverWallet, senderWallet, title } = request.data as any;

    if (
        !asset ||
        !SUPPORTED_ASSETS.includes(asset.toUpperCase()) ||
        typeof amount !== "number" ||
        amount <= 0 ||
        typeof lockPeriod !== "number" ||
        lockPeriod <= 0 ||
        typeof receiverWallet !== "string" ||
        typeof senderWallet !== "string" ||
        typeof title !== "string" ||
        !receiverWallet.match(/^r[1-9A-HJ-NP-Za-km-z]{25,34}$/) ||
        !senderWallet.match(/^r[1-9A-HJ-NP-Za-km-z]{25,34}$/)
    ) {
        throw new HttpsError("invalid-argument", "Invalid input.");
    }

    const createdAt = admin.firestore.Timestamp.now();
    const unlockAt = admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + lockPeriod * 24 * 60 * 60 * 1000)
    );

    const escrow = {
        asset: asset.toUpperCase(),
        amount,
        lockPeriod,
        receiverWallet,
        senderWallet,
        title,
        status: "pending_payment",
        createdAt,
        unlockAt,
        yieldRate: 0.12,
        deposits: [],
        withdrawals: [],
        auditTrail: [{ action: "created", at: createdAt, by: senderWallet }]
    };

    const ref = await admin.firestore().collection("escrows").add(escrow);

    return { success: true, id: ref.id, escrow };
});


export const requestEscrowPayment = onCall(async (request) => {
    const { escrowId } = request.data as any;
    if (!escrowId) throw new HttpsError("invalid-argument", "escrowId is required");

    // Fetch the escrow record
    const escrowRef = admin.firestore().collection("escrows").doc(escrowId);
    const escrowSnap = await escrowRef.get();
    if (!escrowSnap.exists) throw new HttpsError("not-found", "Escrow not found");
    const escrow = escrowSnap.data();

    if (escrow!.status !== "pending_payment") throw new HttpsError("failed-precondition", "Escrow already funded or not in pending_payment status");

    // Prepare payment (XRP only; for RLUSD, handle IOU logic)
    const amountDrops = (escrow!.amount * 1_000_000).toString();

    // Prepare a memo for traceability
    const MemoType = Buffer.from("ESCROW_ID", "utf8").toString("hex");
    const MemoData = Buffer.from(escrowId, "utf8").toString("hex");

    const payload = {
        txjson: {
            TransactionType: "Payment",
            Account: escrow!.senderWallet,
            Destination: TREASURY_ADDRESS,
            Amount: amountDrops,
            Memos: [
                {
                    Memo: {
                        MemoType,
                        MemoData,
                    },
                },
            ],
        }
    };

    // Create the XUMM payload
    const payloadResponse = await xumm.payload.create(payload as any);
    if (!payloadResponse) throw new HttpsError("internal", "XUMM payload creation failed.");

    // Save the payment request to escrow for future reconciliation (optional)
    await escrowRef.update({
        paymentPayload: {
            uuid: payloadResponse.uuid,
            url: payloadResponse.next.always,
            createdAt: admin.firestore.Timestamp.now(),
            status: "pending"
        },
        auditTrail: admin.firestore.FieldValue.arrayUnion({
            action: "payment_requested",
            at: admin.firestore.Timestamp.now(),
            by: escrow!.senderWallet,
            payloadUuid: payloadResponse.uuid
        })
    });

    return {
        uuid: payloadResponse.uuid,
        url: payloadResponse.next.always,
    };
});

export const confirmEscrowPayment = onCall(async (request) => {
    const { escrowId } = request.data as any;
    if (!escrowId) throw new HttpsError("invalid-argument", "escrowId is required");

    // Get escrow record and paymentPayload UUID
    const escrowRef = admin.firestore().collection("escrows").doc(escrowId);
    const escrowSnap = await escrowRef.get();
    if (!escrowSnap.exists) throw new HttpsError("not-found", "Escrow not found");
    const escrow = escrowSnap.data();
    const uuid = escrow!.paymentPayload?.uuid;

    if (!uuid) throw new HttpsError("failed-precondition", "No payment payload attached to escrow");

    // Check status with XUMM
    const payload = await xumm.payload.get(uuid);
    const txid = payload!.response?.txid;

    if (payload!.meta.signed && txid) {
        await escrowRef.update({
            status: "funded",
            "paymentPayload.status": "signed",
            "paymentPayload.txid": txid,
            fundedAt: admin.firestore.Timestamp.now(),
            auditTrail: admin.firestore.FieldValue.arrayUnion({
                action: "funded",
                at: admin.firestore.Timestamp.now(),
                by: escrow!.senderWallet,
                txid
            })
        });
        try {
            const xrpAmountDrops = (escrow!.amount * 1_000_000).toString(); // Convert XRP to drops
            const usdAmount = escrow!.amount.toString();

            const ammTx = await provideLiquidityToAmm(xrpAmountDrops, usdAmount);

            await escrowRef.update({
                ammProvision: {
                    txid: ammTx.result.hash,
                    ledger: ammTx.result.ledger_index,
                    amountXRP: escrow!.amount,
                    amountUSD: usdAmount,
                    at: admin.firestore.Timestamp.now()
                }
            });
            return { success: true, txid, ammTx: ammTx.result.hash };
        } catch (err) {
            await escrowRef.update({
                ammProvisionError: (err as Error).message,
                ammAttemptedAt: admin.firestore.Timestamp.now()
            });
            return { success: true, txid, ammError: (err as Error).message };
        }
    } else {
        return { success: false, signed: false };
    }
});

async function provideLiquidityToAmm(xrpAmountDrops: string, usdAmount: string) {
    const client = new Client(XRPL_NET);
    await client.connect();

    // const usdCurrency: Currency = {
    //     currency: USD_CURRENCY,
    //     issuer: USD_ISSUER
    // };
    //
    // const xrpCurrency: Currency = { currency: "XRP" };

    // const amount2 = {
    //     currency: USD_CURRENCY,
    //     issuer: USD_ISSUER,
    //     value: usdAmount.toString()
    // };

    // AMMDeposit
    const ammDeposit:AMMDeposit = {
        TransactionType: "AMMDeposit" as const,
        Account: poolWallet.classicAddress,
        Asset: { currency: "XRP" },
        Asset2: { currency: "USD", issuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe" },
        Amount: xrpAmountDrops.toString(),
        Amount2: {
            currency: "USD",
            issuer: "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe",
            value: usdAmount
        }
    };

    const prepared = await client.autofill(ammDeposit);
    prepared.LastLedgerSequence = prepared!.LastLedgerSequence! + 10; // Give extra ledgers for safety
    const signed = poolWallet.sign(prepared);
    const tx = await client.submitAndWait(signed.tx_blob);

    await client.disconnect();
    return tx;
}
