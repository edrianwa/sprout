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

const POOL_SECRET = process.env.POOL_SECRET! || functions.config().xrpl.pool_secret;
const poolWallet = Wallet.fromSeed(POOL_SECRET);
const XRPL_NET = "wss://s.devnet.rippletest.net:51233";
const client = new Client(XRPL_NET);
async function ensureClientConnected() {
    if (!client.isConnected()) await client.connect();
}

export const xummLogin = functions.https.onCall(async (data, context) => {

    const payload = {
        txjson: {
            TransactionType: "SignIn"
        }
    } as any;
    const payloadResponse = await xumm.payload.create(payload);
    if (!payloadResponse) throw new functions.https.HttpsError("internal", "XUMM payload creation failed.");
    const { uuid, next } = payloadResponse;
    return { uuid, url: next.always };
});

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

    const amountDrops = (escrow!.amount * 1_000_000).toString();

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

    const payloadResponse = await xumm.payload.create(payload as any);
    if (!payloadResponse) throw new HttpsError("internal", "XUMM payload creation failed.");

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


export const confirmEscrowPayment = onCall(
    { timeoutSeconds: 60 }, // Short timeout, as we return quickly
    async (request) => {
        const { escrowId } = request.data as any;
        if (!escrowId) throw new HttpsError("invalid-argument", "escrowId is required");

        const escrowRef = admin.firestore().collection("escrows").doc(escrowId);
        const escrowSnap = await escrowRef.get();
        if (!escrowSnap.exists) throw new HttpsError("not-found", "Escrow not found");
        const escrow = escrowSnap.data();
        const uuid = escrow!.paymentPayload?.uuid;

        if (!uuid) throw new HttpsError("failed-precondition", "No payment payload attached to escrow");

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
                const xrpAmountDrops = (escrow!.amount * 1_000_000).toString();
                const usdAmount = escrow!.amount.toString();

                // Call AMM (non-blocking)
                provideLiquidityToAmm(xrpAmountDrops, usdAmount, escrowId).catch((err) => {
                    escrowRef.update({
                        ammProvisionError: (err as Error).message,
                        ammAttemptedAt: admin.firestore.Timestamp.now()
                    });
                });

                // Return fast! Don’t wait for AMM tx to confirm
                return { success: true, txid };
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
    }
);

async function provideLiquidityToAmm(xrpAmountDrops: string, usdAmount: string,escrowId: string) {
    const client = new Client(XRPL_NET);
    await client.connect();

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
    prepared.LastLedgerSequence = (prepared.LastLedgerSequence ?? 0) + 20;
    const signed = poolWallet.sign(prepared);
    const tx = await client.submit(signed.tx_blob);

    const escrowRef = admin.firestore().collection("escrows").doc(escrowId);
    await escrowRef.update({
        ammProvision: {
            txid: tx.result.tx_json.hash || null,
            amountXRP: xrpAmountDrops,
            amountUSD: usdAmount,
            at: admin.firestore.Timestamp.now()
        }
    });
    await client.disconnect();
    return tx;
}


export const withdrawEscrow = onCall(
    { timeoutSeconds: 60 },
    async (request) => {
        const USD_ISSUER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
        const { escrowId } = request.data as any;
        if (!escrowId) throw new HttpsError("invalid-argument", "escrowId is required");

        const escrowRef = admin.firestore().collection("escrows").doc(escrowId);
        const escrowSnap = await escrowRef.get();
        if (!escrowSnap.exists) throw new HttpsError("not-found", "Escrow not found");
        const escrow = escrowSnap.data();

        if (!escrow) throw new HttpsError("not-found", "Escrow not found");
        if (escrow.status !== "funded") throw new HttpsError("failed-precondition", "Escrow not funded yet");

        const now = admin.firestore.Timestamp.now();
        if (now.toMillis() < escrow.unlockAt.toMillis()) {
            throw new HttpsError("failed-precondition", "Escrow is still locked");
        }

        const principal = Number(escrow.amount);
        const lockDays = Number(escrow.lockPeriod) || 0;
        const apy = Number(escrow.yieldRate) || 0.12;
        const yieldEarned = principal * apy * (lockDays / 365);
        const receiverYield = yieldEarned * 0.5;
        const senderYield = yieldEarned * 0.5;
        const receiverPayout = principal + receiverYield;

        const client = new Client(XRPL_NET);
        await client.connect();

        let receiverTxResult, senderTxResult;

        if (escrow.asset === "XRP") {
            // Receiver payout in XRP
            const paymentTx = {
                TransactionType: "Payment" as const,
                Account: poolWallet.classicAddress,
                Destination: escrow.receiverWallet,
                Amount: Math.floor(receiverPayout * 1_000_000).toString(), // drops
                Memos: [
                    {
                        Memo: {
                            MemoType: Buffer.from("escrow_withdraw", "utf8").toString("hex"),
                            MemoData: Buffer.from(escrowId, "utf8").toString("hex")
                        }
                    }
                ]
            };
            const prepared = await client.autofill(paymentTx);
            (prepared as any).LastLedgerSequence = ((prepared as any).LastLedgerSequence ?? 0) + 20;
            const signed = poolWallet.sign(prepared);
            receiverTxResult = await client.submit(signed.tx_blob);
        } else if (escrow.asset === "RLUSD" || escrow.asset === "USD") {
            // Receiver payout in RLUSD/USD
            const paymentTx = {
                TransactionType: "Payment" as const,
                Account: poolWallet.classicAddress,
                Destination: escrow.receiverWallet,
                Amount: {
                    currency: escrow.asset,
                    issuer: USD_ISSUER,
                    value: receiverPayout.toFixed(6)
                },
                Memos: [
                    {
                        Memo: {
                            MemoType: Buffer.from("escrow_withdraw", "utf8").toString("hex"),
                            MemoData: Buffer.from(escrowId, "utf8").toString("hex")
                        }
                    }
                ]
            };
            const prepared = await client.autofill(paymentTx);
            (prepared as any).LastLedgerSequence = ((prepared as any).LastLedgerSequence ?? 0) + 20;
            const signed = poolWallet.sign(prepared);
            receiverTxResult = await client.submit(signed.tx_blob);
        } else {
            await client.disconnect();
            throw new HttpsError("invalid-argument", "Unknown asset type for escrow");
        }

        if (
            senderYield > 0.000001 &&
            escrow.senderWallet &&
            escrow.senderWallet !== escrow.receiverWallet
        ) {
            if (escrow.asset === "XRP") {
                const paymentTx = {
                    TransactionType: "Payment" as const,
                    Account: poolWallet.classicAddress,
                    Destination: escrow.senderWallet,
                    Amount: Math.floor(senderYield * 1_000_000).toString(),
                    Memos: [
                        {
                            Memo: {
                                MemoType: Buffer.from("escrow_yield", "utf8").toString("hex"),
                                MemoData: Buffer.from(escrowId, "utf8").toString("hex")
                            }
                        }
                    ]
                };
                const prepared = await client.autofill(paymentTx);
                (prepared as any).LastLedgerSequence = ((prepared as any).LastLedgerSequence ?? 0) + 20;
                const signed = poolWallet.sign(prepared);
                senderTxResult = await client.submit(signed.tx_blob);
            } else {
                const paymentTx = {
                    TransactionType: "Payment" as const,
                    Account: poolWallet.classicAddress,
                    Destination: escrow.senderWallet,
                    Amount: {
                        currency: escrow.asset,
                        issuer: USD_ISSUER,
                        value: senderYield.toFixed(6)
                    },
                    Memos: [
                        {
                            Memo: {
                                MemoType: Buffer.from("escrow_yield", "utf8").toString("hex"),
                                MemoData: Buffer.from(escrowId, "utf8").toString("hex")
                            }
                        }
                    ]
                };
                const prepared = await client.autofill(paymentTx);
                (prepared as any).LastLedgerSequence = ((prepared as any).LastLedgerSequence ?? 0) + 20;
                const signed = poolWallet.sign(prepared);
                senderTxResult = await client.submit(signed.tx_blob);
            }
        }

        await client.disconnect();

        await escrowRef.update({
            status: "withdrawn",
            withdrawnAt: admin.firestore.Timestamp.now(),
            withdrawalTx: receiverTxResult.result.tx_json.hash || null,
            senderYieldTx: senderTxResult?.result.tx_json.hash || null,
            yieldEarned,
            payoutAmount: receiverPayout,
            yieldSplit: {
                receiverYield,
                senderYield
            }
        });

        return {
            success: true,
            receiverTxid: receiverTxResult.result.tx_json.hash || null,
            senderTxid: senderTxResult?.result.tx_json.hash || null,
            receiverPayout,
            receiverYield,
            senderYield
        };
    }
);
