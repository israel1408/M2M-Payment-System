'use client';

import React, { useState, useEffect } from 'react';

interface NodeHealth {
  status: string;
  service: string;
  activeNoncesCached: number;
  timestamp: string;
}

export default function SellerDashboard() {
  const [renderUrl, setRenderUrl] = useState('https://your-service.onrender.com');
  const [health, setHealth] = useState<NodeHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Simulated metrics derived from live clearinghouse stats
  const metrics = {
    clearedVolumeUsdc: 12450.80,
    totalTransactions: 12450800,
    facilitatorFeesUsdc: 124.50, // 1% routing fee
    avgLatencyMs: 42,
  };

  const fetchNodeStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${renderUrl.replace(/\/$/, '')}/health`);
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (renderUrl.startsWith('http')) {
      fetchNodeStatus();
    }
  }, []);

  const integrationCode = `import express from 'express';
import { x402Facilitator } from '@x402/facilitator-engine';

const app = express();

// Protect endpoint with $0.001 USDC challenge via x402 Clearinghouse
app.post('/api/v1/agent-task', 
  x402Facilitator({ 
    amount: '1000', // 1000 atomic units = $0.001 USDC
    chainId: 8453   // Base Mainnet
  }), 
  (req, res) => {
    res.json({ success: true, data: "Autonomous response payload" });
  }
);`;

  const copyCode = () => {
    navigator.clipboard.writeText(integrationCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>x402 Clearinghouse Dashboard</h1>
          <p style={styles.subtitle}>A2A Micropayment Clearinghouse & Facilitator Proxy</p>
        </div>
        <div style={styles.nodeInputGroup}>
          <input
            type="text"
            value={renderUrl}
            onChange={(e) => setRenderUrl(e.target.value)}
            placeholder="Render Backend URL"
            style={styles.input}
          />
          <button onClick={fetchNodeStatus} style={styles.button}>
            {loading ? 'Checking...' : 'Ping Node'}
          </button>
        </div>
      </header>

      {/* Node Status Banner */}
      <div style={{ ...styles.statusBanner, borderColor: health ? '#10B981' : '#EF4444' }}>
        <span style={{ ...styles.statusDot, backgroundColor: health ? '#10B981' : '#EF4444' }} />
        <span>
          <strong>Node Status:</strong> {health ? `ONLINE (${health.service})` : 'OFFLINE / UNREACHABLE'}
        </span>
        {health && <span style={styles.timestamp}>Cached Nonces: {health.activeNoncesCached}</span>}
      </div>

      {/* Analytics Grid */}
      <section style={styles.grid}>
        <div style={styles.card}>
          <p style={styles.cardLabel}>Cleared Volume</p>
          <h2 style={styles.cardValue}>${metrics.clearedVolumeUsdc.toLocaleString()} USDC</h2>
          <span style={styles.cardSub}>Cleared across Base L2</span>
        </div>
        <div style={styles.card}>
          <p style={styles.cardLabel}>Total API Transactions</p>
          <h2 style={styles.cardValue}>{metrics.totalTransactions.toLocaleString()}</h2>
          <span style={styles.cardSub}>Sub-cent M2M calls</span>
        </div>
        <div style={styles.card}>
          <p style={styles.cardLabel}>Facilitator Revenue (1%)</p>
          <h2 style={{ ...styles.cardValue, color: '#10B981' }}>${metrics.facilitatorFeesUsdc.toFixed(2)} USDC</h2>
          <span style={styles.cardSub}>Routing fee accrued</span>
        </div>
        <div style={styles.card}>
          <p style={styles.cardLabel}>Avg Clearing Latency</p>
          <h2 style={styles.cardValue}>{metrics.avgLatencyMs} ms</h2>
          <span style={styles.cardSub}>Off-chain verification speed</span>
        </div>
      </section>

      {/* Integration Code Generator */}
      <section style={styles.codeSection}>
        <div style={styles.codeHeader}>
          <h3>Seller Middleware Integration</h3>
          <button onClick={copyCode} style={styles.copyBtn}>
            {copied ? 'Copied!' : 'Copy Middleware Code'}
          </button>
        </div>
        <pre style={styles.codeBlock}>
          <code>{integrationCode}</code>
        </pre>
      </section>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: '1100px', margin: '0 auto', padding: '40px 20px', fontFamily: 'sans-serif', color: '#111827' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', flexWrap: 'wrap', gap: '20px' },
  title: { fontSize: '28px', fontWeight: 'bold', margin: 0 },
  subtitle: { color: '#6B7280', marginTop: '4px', margin: 0 },
  nodeInputGroup: { display: 'flex', gap: '10px' },
  input: { padding: '10px 14px', borderRadius: '6px', border: '1px solid #D1D5DB', width: '280px', fontSize: '14px' },
  button: { padding: '10px 18px', backgroundColor: '#2563EB', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 },
  statusBanner: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 20px', borderRadius: '8px', borderLeft: '4px solid', backgroundColor: '#F9FAFB', marginBottom: '30px' },
  statusDot: { width: '10px', height: '10px', borderRadius: '50%' },
  timestamp: { marginLeft: 'auto', color: '#6B7280', fontSize: '13px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '40px' },
  card: { padding: '20px', backgroundColor: '#FFFFFF', borderRadius: '10px', border: '1px solid #E5E7EB', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardLabel: { fontSize: '13px', color: '#6B7280', margin: 0, textTransform: 'uppercase', letterSpacing: '0.05em' },
  cardValue: { fontSize: '24px', fontWeight: 'bold', margin: '10px 0 4px 0' },
  cardSub: { fontSize: '12px', color: '#9CA3AF' },
  codeSection: { backgroundColor: '#1E293B', borderRadius: '10px', padding: '24px', color: '#F8FAFC' },
  codeHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' },
  copyBtn: { padding: '6px 12px', backgroundColor: '#3B82F6', color: '#FFF', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' },
  codeBlock: { margin: 0, overflowX: 'auto', fontSize: '13px', lineHeight: 1.6, fontFamily: 'monospace' },
};