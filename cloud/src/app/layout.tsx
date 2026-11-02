import type { ReactNode } from 'react';

export const metadata = {
  title: 'Spire bridge',
  description: 'NetBox ↔ Rhombus bridge for the Spire Condominium',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 24 }}>
        {children}
      </body>
    </html>
  );
}
