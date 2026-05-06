import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'domain check',
  description: 'Check domain availability and price via AWS Route 53.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
