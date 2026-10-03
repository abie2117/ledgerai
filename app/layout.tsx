import "./globals.css";

export const metadata = {
  title: "LedgerAI",
  description: "Transaction Review System",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-50 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
 