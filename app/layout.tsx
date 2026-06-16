import "./globals.css";

export const metadata = {
  title: "LUXIA",
  description: "Identity and Access Management",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="antialiased text-slate-900 bg-slate-50 min-h-screen">
        {children}
      </body>
    </html>
  );
}