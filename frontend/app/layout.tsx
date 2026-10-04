import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Neighbourhood Flex",
  description: "Transformer-level flexibility coordination dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
