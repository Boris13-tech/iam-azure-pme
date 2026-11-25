import { headers } from "next/headers";
import "./globals.css";

// No font is downloaded at build or at run time: a build must not depend on an outside service. The stack is in
// globals.css: the brand's typefaces when the device has them, the system's sans-serif otherwise.
export const metadata = {
  title: "LUXIA Identity",
  description: "Gouvernance des identités et des accès, par LUXIA-IT",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading x-nonce per request switches HTML pages to dynamic rendering so Next.js 15 stamps the fresh
  // middleware CSP nonce onto every framework <script> tag rather than freezing a build-time page.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="fr" data-csp-nonce={nonce ? "present" : undefined}>
      <body className="antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
