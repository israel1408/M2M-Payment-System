import React from 'react';

export const metadata = {
  title: 'x402 Clearinghouse Dashboard',
  description: 'A2A Micropayment Clearinghouse & Facilitator Proxy',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, backgroundColor: '#F9FAFB' }}>
        {children}
      </body>
    </html>
  );
}