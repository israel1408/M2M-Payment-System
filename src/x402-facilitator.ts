import express, { Request, Response, NextFunction } from 'express';
import { verifyTypedData, Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import dotenv from 'dotenv';
// Add this import at the top of src/x402-facilitator.ts
import { batchWorker } from './x402-batch-worker';

// Inside the x402Facilitator middleware function, right after verifyTypedData passes:
// ---------------------------------------------------------------------------
// Enqueue authorization for background on-chain settlement on Base L2
batchWorker.enqueue(payload);
// ---------------------------------------------------------------------------

// At the bottom of src/x402-facilitator.ts, update the app.listen callback:
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[x402 Facilitator Engine] Server active on port ${PORT}`);
  
  // Start the background batch settlement worker (polls every 15s, max 10/batch)
  batchWorker.start(15000, 10);
});

dotenv.config();

// ============================================================================
// Protocol & Environment Constants
// ============================================================================
const PORT = process.env.PORT || 3000;
const FACILITATOR_FEE_PERCENT = 0.01; // 1% clearinghouse routing fee

// Supported x402 Header Specification
const HEADERS = {
  PAYMENT_REQUIRED: 'PAYMENT-REQUIRED',
  PAYMENT_SIGNATURE: 'PAYMENT-SIGNATURE',
  PAYMENT_RESPONSE: 'PAYMENT-RESPONSE',
} as const;

// EIP-3009 ReceiveWithAuthorization Typed Data Schema
const EIP3009_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Default USDC Contract Addresses
const USDC_ADDRESSES: Record<number, `0x${string}`> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia Testnet
};

export interface PaymentRequirement {
  scheme: 'exact' | 'max';
  network: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  payTo: `0x${string}`;
  amount: string; // Price in atomic units (e.g., "1000" = $0.001 USDC)
  assetName: string;
  assetVersion: string;
  timeoutSeconds?: number;
}

export interface PaymentAuthorizationPayload {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: number;
  validBefore: number;
  nonce: `0x${string}`;
  signature: Hex;
}

// Memory cache for nonces to prevent replay attacks on active node instances
const processedNonces = new Set<string>();

// ============================================================================
// Core Facilitator & Verification Middleware
// ============================================================================

/**
 * Express middleware that enforces HTTP 402 Payment Required challenges
 * and validates off-chain EIP-3009 authorization signatures.
 */
export function x402Facilitator(requirementConfig: Partial<PaymentRequirement> = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Build payment requirement specification for this endpoint
    const chainId = requirementConfig.chainId || Number(process.env.CHAIN_ID) || 84532;
    const requirement: PaymentRequirement = {
      scheme: 'exact',
      network: chainId === 8453 ? 'base' : 'base-sepolia',
      chainId,
      tokenAddress: requirementConfig.tokenAddress || USDC_ADDRESSES[chainId],
      payTo: (requirementConfig.payTo || process.env.CLEARINGHOUSE_PAY_TO_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
      amount: requirementConfig.amount || '1000', // Default: 1,000 atomic units = $0.001 USDC
      assetName: requirementConfig.assetName || 'USD Coin',
      assetVersion: requirementConfig.assetVersion || '2',
      timeoutSeconds: requirementConfig.timeoutSeconds || 300,
    };

    const clientAuthHeader = req.header(HEADERS.PAYMENT_SIGNATURE);

    // 2. Challenge Phase: Return 402 if PAYMENT-SIGNATURE is missing
    if (!clientAuthHeader) {
      const encodedRequirement = Buffer.from(JSON.stringify(requirement)).toString('base64');
      res.status(402)
        .header(HEADERS.PAYMENT_REQUIRED, encodedRequirement)
        .json({
          error: 'Payment Required',
          message: 'An off-chain x402 payment authorization payload is required to access this resource.',
          requirement,
        });
      return;
    }

    // 3. Verification Phase: Decode and validate signature
    try {
      const payload: PaymentAuthorizationPayload = JSON.parse(
        Buffer.from(clientAuthHeader, 'base64').toString('utf-8')
      );

      // Replay check
      if (processedNonces.has(payload.nonce)) {
        res.status(400).json({ error: 'Replay Attack Prevention', message: 'Nonce already processed.' });
        return;
      }

      // Timestamp validity window check
      const now = Math.floor(Date.now() / 1000);
      if (now < payload.validAfter || now > payload.validBefore) {
        res.status(400).json({ error: 'Expired Authorization', message: 'Payment authorization timeframe invalid.' });
        return;
      }

      // Amount verification
      if (BigInt(payload.value) < BigInt(requirement.amount)) {
        res.status(402).json({ error: 'Insufficient Payment', message: 'Provided authorization value is below required amount.' });
        return;
      }

      // Cryptographic EIP-712 Signature Verification
      const isValidSignature = await verifyTypedData({
        address: payload.from,
        domain: {
          name: requirement.assetName,
          version: requirement.assetVersion,
          chainId: requirement.chainId,
          verifyingContract: requirement.tokenAddress,
        },
        types: EIP3009_TYPES,
        primaryType: 'ReceiveWithAuthorization',
        message: {
          from: payload.from,
          to: payload.to,
          value: BigInt(payload.value),
          validAfter: BigInt(payload.validAfter),
          validBefore: BigInt(payload.validBefore),
          nonce: payload.nonce,
        },
        signature: payload.signature,
      });

      if (!isValidSignature) {
        res.status(401).json({ error: 'Invalid Signature', message: 'Cryptographic signature verification failed.' });
        return;
      }

      // Mark nonce as spent
      processedNonces.add(payload.nonce);

      // 4. Calculate Facilitator Routing Fee Split
      const grossAmount = BigInt(payload.value);
      const facilitatorFee = (grossAmount * BigInt(Math.floor(FACILITATOR_FEE_PERCENT * 10000))) / BigInt(10000);
      const sellerAmount = grossAmount - facilitatorFee;

      // 5. Attach Settlement Proof Header
      const settlementReceipt = {
        status: 'cleared',
        transactionType: 'EIP-3009 Authorization',
        payer: payload.from,
        grossAmount: grossAmount.toString(),
        sellerAmount: sellerAmount.toString(),
        facilitatorFee: facilitatorFee.toString(),
        clearedAt: new Date().toISOString(),
      };

      const encodedReceipt = Buffer.from(JSON.stringify(settlementReceipt)).toString('base64');
      res.setHeader(HEADERS.PAYMENT_RESPONSE, encodedReceipt);

      // Attach settlement object to request for downstream API handlers
      (req as any).x402Settlement = settlementReceipt;

      next();
    } catch (error: any) {
      res.status(400).json({ error: 'Malformed Payload', details: error.message });
    }
  };
}

// ============================================================================
// Server Application Setup
// ============================================================================
const app = express();
app.use(express.json());

// Enable CORS for cross-origin agent requests and Vercel frontend dashboards
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', `Origin, X-Requested-With, Content-Type, Accept, ${HEADERS.PAYMENT_SIGNATURE}`);
  res.header('Access-Control-Expose-Headers', `${HEADERS.PAYMENT_REQUIRED}, ${HEADERS.PAYMENT_RESPONSE}`);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// Health check endpoint (Used by Render for automated zero-downtime health monitoring)
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'online',
    service: 'x402 Facilitator Node',
    activeNoncesCached: processedNonces.size,
    timestamp: new Date().toISOString(),
  });
});

// Example Monetized AI Agent Endpoint ($0.001 USDC / call)
app.post('/api/v1/inference', x402Facilitator({ amount: '1000' }), (req: Request, res: Response) => {
  const settlement = (req as any).x402Settlement;

  res.status(200).json({
    success: true,
    result: {
      sentiment: 'positive',
      confidence: 0.98,
      tokensUsed: 42,
    },
    clearinghouseReceipt: settlement,
  });
});

// Start Express Listener on all interfaces (Required for Render)
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[x402 Facilitator Engine] Server active on port ${PORT}`);
  console.log(`[x402 Facilitator Engine] Health check live at http://0.0.0.0:${PORT}/health`);
});