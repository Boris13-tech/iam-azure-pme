import "./globals.css";
import { Inter_Tight, Roboto } from "next/font/google";

// The brand's typefaces (luxia-it.com): Roboto for text, Inter Tight for titles. next/font downloads them at
// build time and serves them from this application: no request to Google from the browser.
const roboto = Roboto({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "700"], variable: "--font-text", display: "swap" });
const interTight = Inter_Tight({ subsets: ["latin", "latin-ext"], weight: ["500", "600", "700"], variable: "--font-display", display: "swap" });

export const metadata = {
  title: "LUXIA Identity",
  description: "Gouvernance des identités et des accès, par LUXIA-IT",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${roboto.variable} ${interTight.variable}`}>
      <body className="antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
