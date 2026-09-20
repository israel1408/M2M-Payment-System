import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  Hex,
  Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import dotenv from 'dotenv';
import { PaymentAuthorizationPayload } from './x402-facilitator';

dotenv.config();

// ============================================================================
// Protocol & Chain Configuration
// ============================================================================
const CHAIN_ID = Number(process.env.CHAIN_ID) || 84532;
const activeChain = CHAIN_ID === 8453 ? base : baseSepolia;

const USDC_ADDRESSES: Record<number, Address> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base Mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia Testnet
};

const USDC_EIP3009_ABI = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    name: 'receiveWithAuthorization',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export interface QueuedAuthorization {
  id: string;
  payload: PaymentAuthorizationPayload;
  receivedAt: Date;
  status: 'queued' | 'processing' | 'settled' | 'failed';
  attempts: number;
  txHash?: Hex;
  error?: string;
}

// ============================================================================
// Batch Settlement Engine
// ============================================================================
export class BatchSettlementWorker {
  private queue: QueuedAuthorization[] = [];
  private isProcessing = false;
  private publicClient;
  private walletClient;
  private account;

  constructor() {
    const privateKey = (process.env.FACILITATOR_RELAYER_PRIVATE_KEY ||
      '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a6f365932') as Hex;

    this.account = privateKeyToAccount(privateKey);

    this.publicClient = createPublicClient({
      chain: activeChain,
      transport: http(process.env.RPC_URL || undefined),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: activeChain,
      transport: http(process.env.RPC_URL || undefined),
    });
  }

  /**
   * Enqueues a verified authorization payload for on-chain settlement.
   */
  public enqueue(payload: PaymentAuthorizationPayload): string {
    const id = `auth_${Date.now()}_${payload.nonce.slice(0, 8)}`;
    this.queue.push({
      id,
      payload,
      receivedAt: new Date(),
      status: 'queued',
      attempts: 0,
    });
    console.log(`[Batch Worker] Enqueued authorization ${id} (Queue size: ${this.queue.length})`);
    return id;
  }

  /**
   * Starts the background loop that polls and flushes queued items.
   */
  public start(intervalMs = 15000, batchSize = 10): NodeJS.Timeout {
    console.log(`[Batch Worker] Settlement loop started (Polling every ${intervalMs / 1000}s)...`);
    return setInterval(() => {
      this.flushQueue(batchSize).catch((err) =>
        console.error('[Batch Worker] Flush error:', err)
      );
    }, intervalMs);
  }

  /**
   * Processes up to batchSize authorizations in a single execution window.
   */
  public async flushQueue(batchSize = 10): Promise<void> {
    if (this.isProcessing) return;
    
    const pendingItems = this.queue.filter((item) => item.status === 'queued');
    if (pendingItems.length === 0) return;

    this.isProcessing = true;
    const batch = pendingItems.slice(0, batchSize);
    console.log(`[Batch Worker] Processing batch of ${batch.length} authorizations on ${activeChain.name}...`);

    for (const item of batch) {
      item.status = 'processing';
      item.attempts += 1;

      try {
        const txHash = await this.settleOnChain(item.payload);
        item.status = 'settled';
        item.txHash = txHash;
        console.log(`[Batch Worker] Settled ${item.id} | Tx: ${txHash}`);
      } catch (error: any) {
        item.status = item.attempts >= 3 ? 'failed' : 'queued';
        item.error = error.message;
        console.error(`[Batch Worker] Failed settling ${item.id} (Attempt ${item.attempts}):`, error.message);
      }
    }

    // Clean up settled items from memory queue
    this.queue = this.queue.filter((item) => item.status !== 'settled');
    this.isProcessing = false;
  }

  /**
   * Submits an individual EIP-3009 authorization payload to Base L2 USDC.
   */
  private async settleOnChain(payload: PaymentAuthorizationPayload): Promise<Hex> {
    const tokenAddress = USDC_ADDRESSES[CHAIN_ID];

    // Deconstruct EIP-712 signature into r, s, v components
    const sig = parseSignature(payload.signature);
    const v = sig.v ? Number(sig.v) : 27;

    // Simulate contract execution to validate state transition before spending gas
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: tokenAddress,
      abi: USDC_EIP3009_ABI,
      functionName: 'receiveWithAuthorization',
      args: [
        payload.from,
        payload.to,
        BigInt(payload.value),
        BigInt(payload.validAfter),
        BigInt(payload.validBefore),
        payload.nonce,
        v,
        sig.r,
        sig.s,
      ],
    });

    // Execute on-chain write transaction
    const txHash = await this.walletClient.writeContract(request);

    // Await 1 block confirmation on Base L2
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  public getQueueStats() {
    return {
      totalQueued: this.queue.length,
      processing: this.queue.filter((i) => i.status === 'processing').length,
      failed: this.queue.filter((i) => i.status === 'failed').length,
    };
  }
}

// Global Worker Instance
export const batchWorker = new BatchSettlementWorker();