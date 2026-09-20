import { createWalletClient, http, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// Protocol & Schema Definitions
// ============================================================================
const HEADERS = {
  PAYMENT_REQUIRED: 'PAYMENT-REQUIRED',
  PAYMENT_SIGNATURE: 'PAYMENT-SIGNATURE',
  PAYMENT_RESPONSE: 'PAYMENT-RESPONSE',
} as const;

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

export interface PaymentRequirement {
  scheme: 'exact' | 'max';
  network: string;
  chainId: number;
  tokenAddress: `0x${string}`;
  payTo: `0x${string}`;
  amount: string;
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

// ============================================================================
// Autonomous Agent x402 Client Interceptor
// ============================================================================
export class X402AgentClient {
  private account;
  private walletClient;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
    this.walletClient = createWalletClient({
      account: this.account,
      chain: baseSepolia,
      transport: http(),
    });
  }

  /**
   * Transparent fetch wrapper that handles 402 payment challenges autonomously.
   */
  public async fetch(url: string, init?: RequestInit): Promise<Response> {
    // 1. Initial Unauthenticated Attempt
    const initialResponse = await fetch(url, init);

    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    // 2. Decode 402 Payment Challenge Header
    const paymentHeader = initialResponse.headers.get(HEADERS.PAYMENT_REQUIRED);
    if (!paymentHeader) {
      throw new Error('Received 402 HTTP status but missing PAYMENT-REQUIRED header.');
    }

    const requirement: PaymentRequirement = JSON.parse(
      Buffer.from(paymentHeader, 'base64').toString('utf-8')
    );

    // 3. Sign EIP-3009 Off-Chain Payment Payload
    const authorizationPayload = await this.signPaymentAuthorization(requirement);

    // 4. Encode Payload into PAYMENT-SIGNATURE Header
    const encodedAuthHeader = Buffer.from(
      JSON.stringify(authorizationPayload)
    ).toString('base64');

    const authenticatedHeaders = new Headers(init?.headers);
    authenticatedHeaders.set(HEADERS.PAYMENT_SIGNATURE, encodedAuthHeader);

    // 5. Re-send Request with Payment Authorization Attached
    const signedResponse = await fetch(url, {
      ...init,
      headers: authenticatedHeaders,
    });

    // 6. Decode Facilitator Receipt Header
    const paymentResult = signedResponse.headers.get(HEADERS.PAYMENT_RESPONSE);
    if (paymentResult) {
      const decodedReceipt = JSON.parse(
        Buffer.from(paymentResult, 'base64').toString('utf-8')
      );
      console.log('\n[x402 Agent Client] Settlement Cleared by Facilitator Node:');
      console.dir(decodedReceipt, { depth: null });
    }

    return signedResponse;
  }

  private async signPaymentAuthorization(
    req: PaymentRequirement
  ): Promise<PaymentAuthorizationPayload> {
    const now = Math.floor(Date.now() / 1000);
    const validAfter = now - 60; // 1-minute buffer for clock skew
    const validBefore = now + (req.timeoutSeconds || 300);
    const nonce = `0x${crypto.randomBytes(32).toString('hex')}` as Hex;

    const domain = {
      name: req.assetName,
      version: req.assetVersion,
      chainId: req.chainId,
      verifyingContract: req.tokenAddress,
    } as const;

    const message = {
      from: this.account.address,
      to: req.payTo,
      value: BigInt(req.amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    } as const;

    const signature = await this.walletClient.signTypedData({
      domain,
      types: EIP3009_TYPES,
      primaryType: 'ReceiveWithAuthorization',
      message,
    });

    return {
      from: this.account.address,
      to: req.payTo,
      value: req.amount,
      validAfter,
      validBefore,
      nonce,
      signature,
    };
  }
}

// ============================================================================
// Execution Test Runner
// ============================================================================
async function runAgentSimulation() {
  // Uses key from .env or fallback test private key
  const testPrivateKey = (process.env.TEST_AGENT_PRIVATE_KEY ||
    '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a6f365932') as Hex;

  // Set RENDER_SERVICE_URL in environment or pass your Render HTTPS domain here
  const targetHost = process.env.RENDER_SERVICE_URL || 'http://localhost:3000';
  const endpoint = `${targetHost.replace(/\/$/, '')}/api/v1/inference`;

  console.log(`[x402 Agent Client] Initializing autonomous agent request...`);
  console.log(`[x402 Agent Client] Target Endpoint: ${endpoint}`);

  const agent = new X402AgentClient(testPrivateKey);

  try {
    const response = await agent.fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Execute sub-cent sentiment analysis.' }),
    });

    const data = await response.json();
    console.log(`\n[x402 Agent Client] HTTP Status Code: ${response.status}`);
    console.log('[x402 Agent Client] Returned API Payload:', data);
  } catch (error) {
    console.error('[x402 Agent Client] Execution Error:', error);
  }
}

if (require.main === module) {
  runAgentSimulation();
}